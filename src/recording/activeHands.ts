import type { Frame, Handedness, Point3 } from '../tracking/types'

export interface HandActivity {
  slot: 0 | 1
  /** Most common handedness label for this slot during the recording. */
  handedness: Handedness | null
  /** Share of frames this hand was tracked in, 0..1. */
  presence: number
  /** Mean landmark speed in palm-lengths per second. */
  motion: number
  active: boolean
}

/** A hand moving less than this share of the busiest hand counts as idle. */
const RELATIVE_IDLE = 0.3

const dist = (a: Point3, b: Point3) => Math.hypot(a[0] - b[0], a[1] - b[1])

/**
 * Works out which hands are actually doing the move. Each hand's motion is
 * its landmarks' average speed, scaled by palm size so distance from the
 * camera doesn't matter. A hand far quieter than the busiest one (resting,
 * or just holding still) is marked idle and can be dropped from the
 * recording.
 */
export function detectActiveHands(frames: Frame[]): HandActivity[] {
  const out: HandActivity[] = []
  for (const slot of [0, 1] as const) {
    let present = 0
    let travel = 0
    let time = 0
    const labels = { Left: 0, Right: 0 }
    let prev: { t: number; lm: Point3[] } | null = null
    for (const f of frames) {
      const h = f.hands.find((x) => x.slot === slot)
      if (!h) {
        prev = null
        continue
      }
      present++
      labels[h.handedness]++
      if (prev) {
        const palm = Math.max(dist(h.landmarks[0], h.landmarks[9]), 1e-3)
        let sum = 0
        for (let i = 0; i < h.landmarks.length; i++) sum += dist(h.landmarks[i], prev.lm[i])
        travel += sum / h.landmarks.length / palm
        time += (f.t - prev.t) / 1000
      }
      prev = { t: f.t, lm: h.landmarks }
    }
    out.push({
      slot,
      handedness: present ? (labels.Left >= labels.Right ? 'Left' : 'Right') : null,
      presence: frames.length ? present / frames.length : 0,
      motion: time > 0 ? travel / time : 0,
      active: present > 0,
    })
  }
  const busiest = Math.max(...out.map((h) => h.motion))
  if (busiest > 0) for (const h of out) h.active = h.active && h.motion >= busiest * RELATIVE_IDLE
  return out
}

/** Copy of the frames with only the given hand slots kept. */
export function keepHands(frames: Frame[], slots: Set<number>): Frame[] {
  return frames.map((f) => ({ t: f.t, hands: f.hands.filter((h) => slots.has(h.slot)) }))
}
