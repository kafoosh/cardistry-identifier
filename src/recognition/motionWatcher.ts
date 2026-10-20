import type { TrackingLoop } from '../tracking/trackingLoop'
import type { Frame } from '../tracking/types'
import { MOTION_OFF, MOTION_ON, MotionTracker, type MotionSample } from './motion'

const BUFFER_MS = 1500

type Listener = (sample: MotionSample, frame: Frame) => void

/**
 * Follows finger motion on the live stream for auto-start recording,
 * Identify gating and the motion meter. Keeps the last 1.5 s of frames so
 * a recording that starts on motion can include the moment just before.
 */
export class MotionWatcher {
  latest: MotionSample = { t: 0, energy: 0, active: false, moving: false, on: MOTION_ON, off: MOTION_OFF }
  private tracker = new MotionTracker()
  private buffer: Frame[] = []
  private listeners = new Set<Listener>()
  private unsubscribe: () => void

  constructor(loop: TrackingLoop) {
    this.unsubscribe = loop.onFrame((f) => {
      this.latest = this.tracker.push(f)
      this.buffer.push(f)
      while (this.buffer.length && this.buffer[0].t < f.t - BUFFER_MS) this.buffer.shift()
      for (const l of this.listeners) l(this.latest, f)
    })
  }

  /** Frames from the last `ms` milliseconds. */
  recent(ms: number): Frame[] {
    const end = this.buffer.length ? this.buffer[this.buffer.length - 1].t : 0
    return this.buffer.filter((f) => f.t >= end - ms)
  }

  onSample(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  stop() {
    this.unsubscribe()
    this.listeners.clear()
  }
}
