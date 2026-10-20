import type { TrackingLoop } from '../tracking/trackingLoop'
import type { Frame } from '../tracking/types'
import { extractFeatures, motionEnergy } from './features'
import type { Matcher } from './matcher'
import type { MoveScore, Template } from './recognizer'

/** Below this (palm lengths per second) the hands count as still and nothing is matched. */
const STILL_MOTION = 0.6
const INTERVAL_MS = 400
const HOLD_MS = 2500

export interface IdentifyState {
  status: 'still' | 'matching' | 'no-templates'
  scores: MoveScore[]
  /** Last confident match, kept on screen for a moment after the move ends. */
  last: { moveName: string; at: number; strength: number } | null
  /** Whether `last` is recent enough to show as the current answer. */
  showLast: boolean
  matchMs: number
}

/**
 * Live identification: keeps a rolling window of frames slightly longer
 * than the longest template, and a few times a second (when the hands are
 * moving) asks the matcher which move just finished.
 */
export class Identifier {
  private frames: Frame[] = []
  private unsubscribe: () => void
  private timer: number
  private busy = false
  private windowMs: number
  private aspect: () => number
  private matcher: Matcher
  private threshold: () => number
  private onUpdate: (s: IdentifyState) => void
  private state: IdentifyState

  constructor(
    loop: TrackingLoop,
    matcher: Matcher,
    templates: Template[],
    aspect: () => number,
    threshold: () => number,
    onUpdate: (s: IdentifyState) => void,
  ) {
    this.matcher = matcher
    this.aspect = aspect
    this.threshold = threshold
    this.onUpdate = onUpdate
    const longest = Math.max(1000, ...templates.map((t) => t.features.durationMs))
    this.windowMs = Math.min(12_000, longest * 1.6)
    this.state = { status: templates.length ? 'still' : 'no-templates', scores: [], last: null, showLast: false, matchMs: 0 }
    this.unsubscribe = loop.onFrame((f) => {
      this.frames.push(f)
      const cutoff = f.t - this.windowMs
      while (this.frames.length && this.frames[0].t < cutoff) this.frames.shift()
    })
    this.timer = window.setInterval(() => void this.tick(), INTERVAL_MS)
    onUpdate(this.state)
  }

  stop() {
    this.unsubscribe()
    clearInterval(this.timer)
  }

  private async tick() {
    if (this.busy || this.state.status === 'no-templates' || this.frames.length < 8) return
    const now = this.frames[this.frames.length - 1].t
    const recent = this.frames.filter((f) => f.t >= now - 1000)
    if (motionEnergy(recent) < STILL_MOTION) {
      this.emit({ ...this.state, status: 'still', scores: [] })
      return
    }
    // Try each hand as the primary one; which hand is "doing the move" is
    // ambiguous over a window that may include idle time before it.
    const twoSlots = [0, 1].every((s) => this.frames.some((f) => f.hands.some((h) => h.slot === s)))
    const windows = (twoSlots ? ([0, 1] as const) : ([undefined] as const))
      .map((p) => extractFeatures(this.frames, this.aspect(), p))
      .filter((w) => w !== null)
    if (!windows.length) return
    this.busy = true
    try {
      const { scores, ms } = await this.matcher.match(windows, this.threshold())
      const top = scores[0]
      const last = top && top.strength > 0 ? { moveName: top.moveName, at: Date.now(), strength: top.strength } : this.state.last
      this.emit({ status: 'matching', scores: scores.slice(0, 3), last, showLast: false, matchMs: ms })
    } finally {
      this.busy = false
    }
  }

  private emit(s: IdentifyState) {
    s.showLast = s.last !== null && Date.now() - s.last.at < HOLD_MS
    this.state = s
    this.onUpdate(s)
  }
}
