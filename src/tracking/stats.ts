import type { Frame } from './types'

const WINDOW_MS = 5000

export interface TrackingStats {
  /** Frames tracked per second over the last few seconds. */
  fps: number
  /** Mean time the landmarker took per frame, ms. */
  inferenceMs: number
  /** Share of recent frames in which each slot's hand was found, 0..1. */
  presence: [number, number]
  /** Mean handedness confidence per slot over frames where it was found. */
  confidence: [number, number]
  /** Number of times a slot's hand was lost and found again in the window. */
  dropouts: [number, number]
}

interface Sample {
  t: number
  ms: number
  present: [boolean, boolean]
  score: [number, number]
}

/**
 * Rolling stats over the last five seconds. Presence and dropouts are the
 * milestone 1 risk check: they show how often cards hide the hands.
 */
export class RollingStats {
  private samples: Sample[] = []

  push(frame: Frame, inferenceMs: number) {
    const present: [boolean, boolean] = [false, false]
    const score: [number, number] = [0, 0]
    for (const h of frame.hands) {
      present[h.slot] = true
      score[h.slot] = h.score
    }
    this.samples.push({ t: frame.t, ms: inferenceMs, present, score })
    const cutoff = frame.t - WINDOW_MS
    while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift()
  }

  reset() {
    this.samples = []
  }

  read(): TrackingStats {
    const s = this.samples
    const n = s.length
    if (n < 2) {
      return { fps: 0, inferenceMs: 0, presence: [0, 0], confidence: [0, 0], dropouts: [0, 0] }
    }
    const span = (s[n - 1].t - s[0].t) / 1000
    const presence: [number, number] = [0, 0]
    const confidence: [number, number] = [0, 0]
    const dropouts: [number, number] = [0, 0]
    let ms = 0
    for (let i = 0; i < n; i++) {
      ms += s[i].ms
      for (const slot of [0, 1] as const) {
        if (s[i].present[slot]) {
          presence[slot]++
          confidence[slot] += s[i].score[slot]
          if (i > 0 && !s[i - 1].present[slot]) dropouts[slot]++
        }
      }
    }
    return {
      fps: span > 0 ? (n - 1) / span : 0,
      inferenceMs: ms / n,
      presence: [presence[0] / n, presence[1] / n],
      confidence: [
        presence[0] ? confidence[0] / presence[0] : 0,
        presence[1] ? confidence[1] / presence[1] : 0,
      ],
      dropouts,
    }
  }
}
