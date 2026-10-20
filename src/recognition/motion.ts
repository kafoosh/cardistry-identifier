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
/**
 * Resting jitter differs by camera, light and distance, so the thresholds
 * sit above this person's own noise floor: the low end of their energy
 * while idle. ON/OFF never drop below the fixed values above.
 */
const FLOOR_SAMPLES = 300
const FLOOR_PERCENTILE = 0.3
const FLOOR_ON = 2.2
const FLOOR_OFF = 1.6
/** Ceiling on the learned floor, so someone who never rests can still trigger motion. */
const MAX_FLOOR = 1
/** After this long "active" without a break, keep learning the floor anyway (constant jitter can hold it on). */
const STUCK_ACTIVE_MS = 8000

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
  /** Thresholds in use on this frame (they adapt to resting jitter). */
  on: number
  off: number
}

/** Incremental motion state with hysteresis; feed it frames in order. */
export class MotionTracker {
  private smoothed: (Point3[] | null)[] = [null, null]
  private lastT: number | null = null
  private energy = 0
  private active = false
  private overCount = 0
  private underSince: number | null = null
  private activeSince = 0
  private idleEnergy: number[] = []
  private floor = 0

  /** Current start and stop thresholds, raised above this person's resting jitter. */
  get thresholds() {
    return { on: Math.max(MOTION_ON, this.floor * FLOOR_ON), off: Math.max(MOTION_OFF, this.floor * FLOOR_OFF) }
  }

  private learnFloor(energy: number) {
    this.idleEnergy.push(energy)
    if (this.idleEnergy.length > FLOOR_SAMPLES) this.idleEnergy.shift()
    if (this.idleEnergy.length >= 20 && this.idleEnergy.length % 5 === 0) {
      const sorted = [...this.idleEnergy].sort((a, b) => a - b)
      this.floor = Math.min(MAX_FLOOR, sorted[Math.floor((sorted.length - 1) * FLOOR_PERCENTILE)])
    }
  }

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
      const next = rel.map(
        (p, i) => [prev[i][0] + (p[0] - prev[i][0]) * SMOOTH, prev[i][1] + (p[1] - prev[i][1]) * SMOOTH, 0] as Point3,
      )
      if (dt > 0) {
        let sum = 0
        for (let i = 1; i < 21; i++) sum += Math.hypot(next[i][0] - prev[i][0], next[i][1] - prev[i][1])
        raw = Math.max(raw, sum / 20 / dt)
      }
      this.smoothed[slot] = next
    }
    this.energy += (raw - this.energy) * ENERGY_SMOOTH

    const { on, off } = this.thresholds
    if (!this.active || f.t - this.activeSince > STUCK_ACTIVE_MS) this.learnFloor(this.energy)
    if (!this.active) {
      this.overCount = this.energy > on ? this.overCount + 1 : 0
      if (this.overCount >= ON_FRAMES) {
        this.active = true
        this.activeSince = f.t
        this.underSince = null
      }
    } else if (this.energy < off) {
      this.underSince ??= f.t
      if (f.t - this.underSince >= IDLE_AFTER_MS) {
        this.active = false
        this.overCount = 0
      }
    } else {
      this.underSince = null
    }
    return { t: f.t, energy: this.energy, active: this.active, moving: this.active && this.energy >= off, on, off }
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

/** Frames between startMs and endMs, with times rebased so the first is 0. */
export function sliceFrames(frames: Frame[], startMs: number, endMs: number): Frame[] {
  const kept = frames.filter((f) => f.t >= startMs && f.t <= endMs)
  const base = kept.length ? kept[0].t : 0
  return kept.map((f) => ({ ...f, t: f.t - base }))
}

/** Cuts idle time off both ends and rebases times to start at 0. Returns the trimmed frames and how much was cut from the start. */
export function trimIdle(frames: Frame[]): { frames: Frame[]; cutStartMs: number } {
  const span = activeSpan(frames)
  if (!span) return { frames, cutStartMs: 0 }
  const kept = frames.filter((f) => f.t >= span.startMs && f.t <= span.endMs)
  if (kept.length < 10) return { frames, cutStartMs: 0 }
  const base = kept[0].t
  return { frames: kept.map((f) => ({ ...f, t: f.t - base })), cutStartMs: base - frames[0].t }
}
