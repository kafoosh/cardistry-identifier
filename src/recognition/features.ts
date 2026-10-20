import { detectActiveHands } from '../recording/activeHands'
import type { Frame, Handedness, Point3 } from '../tracking/types'

/** Resampling rate for matching. Halves the work of 30 fps input, and DTW absorbs speed differences anyway. */
export const FEATURE_FPS = 15
const MAX_GAP_FRAMES = 5
const SECONDARY_WEIGHT = 0.5
/** Feature length per frame: 2 hands × 20 points × 3, 2 × (cos, sin) orientation, inter-hand vector (2). */
export const FEATURE_DIM = 2 * 60 + 4 + 2

export interface FeatureSequence {
  /** Row-major, length = frames × FEATURE_DIM. */
  data: Float32Array
  frames: number
  durationMs: number
}

type MaybeHand = { landmarks: Point3[]; handedness: Handedness } | null

/** Fills short dropouts (≤ 5 frames) per hand slot by linear interpolation. */
export function fillGaps(frames: Frame[]): MaybeHand[][] {
  const slots: MaybeHand[][] = [[], []]
  for (const slot of [0, 1] as const) {
    const track = frames.map((f) => {
      const h = f.hands.find((x) => x.slot === slot)
      return h ? { landmarks: h.landmarks, handedness: h.handedness } : null
    })
    let last = -1
    for (let i = 0; i < track.length; i++) {
      if (!track[i]) continue
      const gap = i - last - 1
      if (last >= 0 && gap > 0 && gap <= MAX_GAP_FRAMES) {
        const a = track[last]!
        const b = track[i]!
        const ta = frames[last].t
        const span = frames[i].t - ta
        for (let k = last + 1; k < i; k++) {
          const u = span > 0 ? (frames[k].t - ta) / span : 0.5
          track[k] = {
            handedness: a.handedness,
            landmarks: a.landmarks.map((p, j) => {
              const q = b.landmarks[j]
              return [p[0] + (q[0] - p[0]) * u, p[1] + (q[1] - p[1]) * u, p[2] + (q[2] - p[2]) * u] as Point3
            }),
          }
        }
      }
      last = i
    }
    slots[slot] = track
  }
  return slots
}

/**
 * Normalises one hand: wrist at the origin, scaled by the wrist to middle
 * knuckle length, rotated so that line points up, and left hands mirrored
 * so they compare with right hands. Writes 60 values (20 points × 3) into
 * out at offset, scaled by weight, and returns the hand's image-plane angle.
 */
function normaliseHand(lm: Point3[], mirror: boolean, aspect: number, out: Float32Array, offset: number, weight: number) {
  const ox = lm[0][0] * aspect
  const oy = lm[0][1]
  const oz = lm[0][2]
  const vx = lm[9][0] * aspect - ox
  const vy = lm[9][1] - oy
  const scale = Math.hypot(vx, vy) || 1e-3
  const theta = Math.atan2(vy, vx)
  // Rotate so (vx, vy) maps to straight up, (0, -1).
  const phi = -Math.PI / 2 - theta
  const c = Math.cos(phi)
  const s = Math.sin(phi)
  for (let i = 1; i < 21; i++) {
    const px = lm[i][0] * aspect - ox
    const py = lm[i][1] - oy
    let x = (px * c - py * s) / scale
    const y = (px * s + py * c) / scale
    const z = (lm[i][2] - oz) / scale
    if (mirror) x = -x
    const o = offset + (i - 1) * 3
    out[o] = x * weight
    out[o + 1] = y * weight
    out[o + 2] = z * weight * 0.5
  }
  return mirror ? Math.PI - theta : theta
}

const LABEL_RADIUS = 7

/** For each frame, whether most tracked frames within ±7 of it say this hand is a left hand. */
function localLeftMajority(track: MaybeHand[]): boolean[] {
  const out: boolean[] = new Array(track.length).fill(false)
  let left = 0
  let total = 0
  const add = (k: number, d: number) => {
    const h = track[k]
    if (!h) return
    total += d
    if (h.handedness === 'Left') left += d
  }
  for (let k = 0; k < Math.min(LABEL_RADIUS, track.length); k++) add(k, 1)
  for (let i = 0; i < track.length; i++) {
    if (i + LABEL_RADIUS < track.length) add(i + LABEL_RADIUS, 1)
    if (i - LABEL_RADIUS - 1 >= 0) add(i - LABEL_RADIUS - 1, -1)
    out[i] = total > 0 && left * 2 > total
  }
  return out
}

/**
 * Turns raw frames into a matching-ready feature sequence: fills gaps,
 * orders hands by activity (primary = the busiest hand, unless
 * primarySlot is given), mirrors left hands onto right, normalises each hand, adds hand
 * orientation and the inter-hand vector, then resamples to FEATURE_FPS
 * and smooths lightly.
 */
export function extractFeatures(frames: Frame[], aspect: number, primarySlot?: 0 | 1): FeatureSequence | null {
  if (frames.length < 2) return null
  const filled = fillGaps(frames)
  let primary: 0 | 1
  if (primarySlot !== undefined) primary = primarySlot
  else {
    const activity = detectActiveHands(frames)
    primary = activity[1].motion > activity[0].motion ? 1 : 0
  }
  const secondary = primary === 0 ? 1 : 0
  // A slot can hold different hands over a long window, and MediaPipe's label
  // flickers, so mirror by the majority label of nearby frames.
  const leftNearby = [0, 1].map((slot) => localLeftMajority(filled[slot]))
  const mirrorAt = (slot: number, i: number) => leftNearby[slot][i]

  const raw = new Float32Array(frames.length * FEATURE_DIM)
  for (let i = 0; i < frames.length; i++) {
    const base = i * FEATURE_DIM
    const p = filled[primary][i]
    const q = filled[secondary][i]
    if (p) {
      const a = normaliseHand(p.landmarks, mirrorAt(primary, i), aspect, raw, base, 1)
      raw[base + 120] = Math.cos(a)
      raw[base + 121] = Math.sin(a)
    }
    if (q) {
      const a = normaliseHand(q.landmarks, mirrorAt(secondary, i), aspect, raw, base + 60, SECONDARY_WEIGHT)
      raw[base + 122] = Math.cos(a) * SECONDARY_WEIGHT
      raw[base + 123] = Math.sin(a) * SECONDARY_WEIGHT
    }
    if (p && q) {
      const scale = Math.hypot((p.landmarks[9][0] - p.landmarks[0][0]) * aspect, p.landmarks[9][1] - p.landmarks[0][1]) || 1e-3
      let dx = ((q.landmarks[0][0] - p.landmarks[0][0]) * aspect) / scale
      if (mirrorAt(primary, i)) dx = -dx
      raw[base + 124] = dx * 0.25
      raw[base + 125] = ((q.landmarks[0][1] - p.landmarks[0][1]) / scale) * 0.25
    }
  }

  // Resample to a uniform grid.
  const t0 = frames[0].t
  const durationMs = frames[frames.length - 1].t - t0
  const n = Math.max(2, Math.round((durationMs / 1000) * FEATURE_FPS) + 1)
  const data = new Float32Array(n * FEATURE_DIM)
  let j = 0
  for (let k = 0; k < n; k++) {
    const t = t0 + (k * durationMs) / (n - 1)
    while (j < frames.length - 2 && frames[j + 1].t < t) j++
    const ta = frames[j].t
    const tb = frames[j + 1].t
    const u = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0
    for (let d = 0; d < FEATURE_DIM; d++) {
      const a = raw[j * FEATURE_DIM + d]
      const b = raw[(j + 1) * FEATURE_DIM + d]
      data[k * FEATURE_DIM + d] = a + (b - a) * u
    }
  }

  // Light 3-tap smoothing.
  const out = new Float32Array(data.length)
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1)
    const b = Math.min(n - 1, k + 1)
    for (let d = 0; d < FEATURE_DIM; d++) {
      out[k * FEATURE_DIM + d] = (data[a * FEATURE_DIM + d] + 2 * data[k * FEATURE_DIM + d] + data[b * FEATURE_DIM + d]) / 4
    }
  }
  return { data: out, frames: n, durationMs }
}

/** Mean landmark speed of the busiest hand over the frames, in palm lengths per second. */
export function motionEnergy(frames: Frame[]): number {
  return Math.max(0, ...detectActiveHands(frames).map((h) => h.motion))
}
