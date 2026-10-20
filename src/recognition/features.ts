import { detectActiveHands } from '../recording/activeHands'
import type { Packet } from '../cards/types'
import type { Frame, Handedness, Point3 } from '../tracking/types'

/** Resampling rate for matching. Halves the work of 30 fps input, and DTW absorbs speed differences anyway. */
export const FEATURE_FPS = 15
const MAX_GAP_FRAMES = 5
const SECONDARY_WEIGHT = 0.5
/** Hand part of a frame's features: 2 hands × 20 points × 3, 2 × (cos, sin) orientation, inter-hand vector (2). */
export const HAND_DIM = 2 * 60 + 4 + 2
/** Card part: per hand (primary, secondary) 7 values for the packets it holds, plus the total packet count. */
const CARD_PER_HAND = 7
export const CARD_DIM = 2 * CARD_PER_HAND + 1
/** Feature length per frame. The card part is zero for recordings made without card tracking. */
export const FEATURE_DIM = HAND_DIM + CARD_DIM
/** Card features count for this much against the hand features. */
const CARD_WEIGHT = 1

export interface FeatureSequence {
  /** Row-major, length = frames × FEATURE_DIM. */
  data: Float32Array
  frames: number
  durationMs: number
  /** Whether card tracking was on for (nearly) all of it, so the card part means something. */
  hasCards: boolean
  /** Values per frame, and how many of them are the hand part, when projected (see projection.ts). */
  dim?: number
  handDim?: number
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
 * Normalises one hand into its own 3D frame, so the same finger motion reads
 * the same from any camera angle: wrist at the origin, scaled by the wrist to
 * middle knuckle length, turned so that line points up (-y), the line across
 * the knuckles (pinky to index) lies along x, and z is out of the palm. The
 * tracker's depth (z, in the same units as x) makes this possible from one
 * camera. Writes 60 values (20 points × 3) into out at offset, scaled by
 * weight, and returns the hand's image-plane angle (kept separately: how the
 * hand is turned to the camera matters for some moves). Which hand it is
 * doesn't matter here: matching tries the mirror image too (see
 * mirrorFeatures).
 */
function normaliseHand(lm: Point3[], aspect: number, out: Float32Array, offset: number, weight: number) {
  // Scalars throughout: this runs for every hand in every frame of the live window, several times a second.
  const ox = lm[0][0] * aspect
  const oy = lm[0][1]
  const oz = lm[0][2] * aspect
  const upx = lm[9][0] * aspect - ox
  const upy = lm[9][1] - oy
  const upz = lm[9][2] * aspect - oz
  const scale = Math.hypot(upx, upy, upz) || 1e-3
  const ux = upx / scale
  const uy = upy / scale
  const uz = upz / scale
  // Across the knuckles (pinky to index), made square to u.
  let vx = (lm[5][0] - lm[17][0]) * aspect
  let vy = lm[5][1] - lm[17][1]
  let vz = (lm[5][2] - lm[17][2]) * aspect
  const k = vx * ux + vy * uy + vz * uz
  vx -= k * ux
  vy -= k * uy
  vz -= k * uz
  const vl = Math.hypot(vx, vy, vz)
  if (vl > 1e-6) {
    vx /= vl
    vy /= vl
    vz /= vl
  } else [vx, vy, vz] = [1, 0, 0]
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  for (let i = 1; i < 21; i++) {
    const dx = lm[i][0] * aspect - ox
    const dy = lm[i][1] - oy
    const dz = lm[i][2] * aspect - oz
    const at = offset + (i - 1) * 3
    out[at] = ((dx * vx + dy * vy + dz * vz) / scale) * weight
    out[at + 1] = (-(dx * ux + dy * uy + dz * uz) / scale) * weight
    // Depth is the tracker's least certain value, so out-of-palm motion counts half.
    out[at + 2] = ((dx * nx + dy * ny + dz * nz) / scale) * weight * 0.5
  }
  return Math.atan2(upy, upx)
}

/**
 * The packets one hand holds, in that hand's own frame (wrist origin, palm
 * length scale, rotated so the palm points up), so a
 * move reads the same from any camera angle: how many packets, where the
 * biggest sits relative to the palm, its angle relative to the palm (on the
 * doubled circle, since a packet turned 180° looks the same), how thin it
 * looks (edge-on or face-on), and its size relative to the hand.
 */
function cardFeatures(
  cards: Packet[],
  slot: 0 | 1,
  lm: Point3[],
  aspect: number,
  out: Float32Array,
  offset: number,
  weight: number,
) {
  const owned = cards.filter((c) => c.hand === slot).sort((a, b) => b.length * b.width - a.length * a.width)
  out[offset] = (Math.min(owned.length, 3) / 3) * weight
  const top = owned[0]
  if (!top) return
  const ox = lm[0][0] * aspect
  const oy = lm[0][1]
  const vx = lm[9][0] * aspect - ox
  const vy = lm[9][1] - oy
  const scale = Math.hypot(vx, vy) || 1e-3
  const phi = -Math.PI / 2 - Math.atan2(vy, vx)
  const c = Math.cos(phi)
  const s = Math.sin(phi)
  const px = top.cx * aspect - ox
  const py = top.cy - oy
  const x = (px * c - py * s) / scale
  const y = (px * s + py * c) / scale
  const rel = top.angle + phi
  out[offset + 1] = x * 0.3 * weight
  out[offset + 2] = y * 0.3 * weight
  out[offset + 3] = Math.cos(2 * rel) * 0.5 * weight
  out[offset + 4] = Math.sin(2 * rel) * 0.5 * weight
  out[offset + 5] = (top.length > 0 ? top.width / top.length : 0) * 0.5 * weight
  out[offset + 6] = Math.min(4, top.length / scale) * 0.3 * weight
}

/**
 * Turns raw frames into a matching-ready feature sequence: fills gaps,
 * orders hands by activity (primary = the busiest hand, unless
 * primarySlot is given), normalises each hand, adds hand orientation and
 * the inter-hand vector, then resamples to FEATURE_FPS and smooths lightly.
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

  const cardFrames = frames.filter((f) => f.cards !== undefined).length >= frames.length * 0.8
  const raw = new Float32Array(frames.length * FEATURE_DIM)
  for (let i = 0; i < frames.length; i++) {
    const base = i * FEATURE_DIM
    const p = filled[primary][i]
    const q = filled[secondary][i]
    if (p) {
      const a = normaliseHand(p.landmarks, aspect, raw, base, 1)
      raw[base + 120] = Math.cos(a)
      raw[base + 121] = Math.sin(a)
    }
    if (q) {
      const a = normaliseHand(q.landmarks, aspect, raw, base + 60, SECONDARY_WEIGHT)
      raw[base + 122] = Math.cos(a) * SECONDARY_WEIGHT
      raw[base + 123] = Math.sin(a) * SECONDARY_WEIGHT
    }
    if (cardFrames && frames[i].cards) {
      const cards = frames[i].cards!
      if (p) cardFeatures(cards, primary, p.landmarks, aspect, raw, base + HAND_DIM, CARD_WEIGHT)
      if (q)
        cardFeatures(
          cards,
          secondary,
          q.landmarks,
          aspect,
          raw,
          base + HAND_DIM + CARD_PER_HAND,
          CARD_WEIGHT * SECONDARY_WEIGHT,
        )
      raw[base + HAND_DIM + 2 * CARD_PER_HAND] = (Math.min(cards.length, 4) / 4) * CARD_WEIGHT
    }
    if (p && q) {
      const scale =
        Math.hypot((p.landmarks[9][0] - p.landmarks[0][0]) * aspect, p.landmarks[9][1] - p.landmarks[0][1]) || 1e-3
      raw[base + 124] = (((q.landmarks[0][0] - p.landmarks[0][0]) * aspect) / scale) * 0.25
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
      out[k * FEATURE_DIM + d] =
        (data[a * FEATURE_DIM + d] + 2 * data[k * FEATURE_DIM + d] + data[b * FEATURE_DIM + d]) / 4
    }
  }
  return { data: out, frames: n, durationMs, hasCards: cardFrames }
}

/**
 * The same sequence done with the other hand: everything reflected across
 * the vertical axis. Matching tries a window both ways, so a move recorded
 * in one hand is found in either, without trusting the tracker's left/right
 * label (which flickers, and swaps between the front and back cameras).
 */
export function mirrorFeatures(seq: FeatureSequence): FeatureSequence {
  const data = new Float32Array(seq.data)
  for (let k = 0; k < seq.frames; k++) {
    const b = k * FEATURE_DIM
    // Landmarks are in each hand's own frame, where a mirror image only turns the palm side over: flip z.
    for (let i = 0; i < 40; i++) data[b + i * 3 + 2] = -data[b + i * 3 + 2]
    // Orientation angle θ → π − θ: cos flips, sin stays.
    data[b + 120] = -data[b + 120]
    data[b + 122] = -data[b + 122]
    // Inter-hand x.
    data[b + 124] = -data[b + 124]
    // Packet x, and its doubled angle's sine, for each hand's card block.
    for (const off of [HAND_DIM, HAND_DIM + CARD_PER_HAND]) {
      data[b + off + 1] = -data[b + off + 1]
      data[b + off + 4] = -data[b + off + 4]
    }
  }
  return { ...seq, data }
}

/** Mean landmark speed of the busiest hand over the frames, in palm lengths per second. */
export function motionEnergy(frames: Frame[]): number {
  return Math.max(0, ...detectActiveHands(frames).map((h) => h.motion))
}
