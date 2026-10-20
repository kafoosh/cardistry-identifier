import type { Frame, Point3 } from '../tracking/types'

/**
 * Finger motion, not hand drift: each hand's landmarks are taken relative
 * to its wrist and scaled by palm size, lightly smoothed to remove tracker
 * jitter, and their mean speed (palm lengths per second) is the energy.
 * Wrist rotation still counts (cuts rotate the hand); sliding the whole
 * hand around the frame does not.
 */
export const MOTION_ON = 1.4
export const MOTION_OFF = 0.8
/** How long energy must stay under MOTION_OFF before the hands count as idle. */
const IDLE_AFTER_MS = 600
/** Consecutive frames over MOTION_ON needed to start, so a single twitch doesn't. */
const ON_FRAMES = 3
const SMOOTH = 0.5
const ENERGY_SMOOTH = 0.35

function relative(lm: Point3[]): Point3[] {
  const [wx, wy] = lm[0]
  const palm = Math.hypot(lm[9][0] - wx, lm[9][1] - wy) || 1e-3
  return lm.map(([x, y]) => [(x - wx) / palm, (y - wy) / palm, 0] as Point3)
}

export interface MotionSample {
  t: number
  /** Smoothed finger energy, palm lengths per second. */
  energy: number
  /** In a motion episode (stays true for a moment after motion stops, so short pauses don't split a move). */
  active: boolean
  /** Actually moving on this frame: active and above the idle level. Use it to find where a move ends. */
  moving: boolean
}

/** Incremental motion state with hysteresis; feed it frames in order. */
export class MotionTracker {
  private smoothed: (Point3[] | null)[] = [null, null]
  private lastT: number | null = null
  private energy = 0
  private active = false
  private overCount = 0
  private underSince: number | null = null

  push(f: Frame): MotionSample {
    const dt = this.lastT === null ? 0 : (f.t - this.lastT) / 1000
    this.lastT = f.t
    let raw = 0
    for (const slot of [0, 1] as const) {
      const h = f.hands.find((x) => x.slot === slot)
      if (!h) {
        this.smoothed[slot] = null
        continue
      }
      const rel = relative(h.landmarks)
      const prev = this.smoothed[slot]
      if (!prev) {
        this.smoothed[slot] = rel
        continue
      }
      const next = rel.map((p, i) => [prev[i][0] + (p[0] - prev[i][0]) * SMOOTH, prev[i][1] + (p[1] - prev[i][1]) * SMOOTH, 0] as Point3)
      if (dt > 0) {
        let sum = 0
        for (let i = 1; i < 21; i++) sum += Math.hypot(next[i][0] - prev[i][0], next[i][1] - prev[i][1])
        raw = Math.max(raw, sum / 20 / dt)
      }
      this.smoothed[slot] = next
    }
    this.energy += (raw - this.energy) * ENERGY_SMOOTH

    if (!this.active) {
      this.overCount = this.energy > MOTION_ON ? this.overCount + 1 : 0
      if (this.overCount >= ON_FRAMES) {
        this.active = true
        this.underSince = null
      }
    } else if (this.energy < MOTION_OFF) {
      this.underSince ??= f.t
      if (f.t - this.underSince >= IDLE_AFTER_MS) {
        this.active = false
        this.overCount = 0
      }
    } else {
      this.underSince = null
    }
    return { t: f.t, energy: this.energy, active: this.active, moving: this.active && this.energy >= MOTION_OFF }
  }
}

/** Margin kept before the motion starts and after it ends when trimming. */
const LEAD_MS = 400
const TAIL_MS = 300

/**
 * The part of a recording where the hands are actually doing something,
 * padded slightly. Returns null if there's no clear motion (nothing to trim).
 */
export function activeSpan(frames: Frame[]): { startMs: number; endMs: number } | null {
  const tracker = new MotionTracker()
  let first: number | null = null
  let last: number | null = null
  for (const f of frames) {
    const s = tracker.push(f)
    if (s.active) first ??= f.t
    if (s.moving) last = f.t
  }
  if (first === null || last === null || frames.length < 2) return null
  const t0 = frames[0].t
  const t1 = frames[frames.length - 1].t
  // Onset is detected a few frames late; reach back a little further.
  return { startMs: Math.max(t0, first - LEAD_MS - 150), endMs: Math.min(t1, last + TAIL_MS) }
}

/** Cuts idle time off both ends and rebases times to start at 0. Returns the trimmed frames and how much was cut from the start. */
export function trimIdle(frames: Frame[]): { frames: Frame[]; cutStartMs: number } {
  const span = activeSpan(frames)
  if (!span) return { frames, cutStartMs: 0 }
  const kept = frames.filter((f) => f.t >= span.startMs && f.t <= span.endMs)
  if (kept.length < 10) return { frames, cutStartMs: 0 }
  const base = kept[0].t
  return { frames: kept.map((f) => ({ t: f.t - base, hands: f.hands })), cutStartMs: base - frames[0].t }
}
