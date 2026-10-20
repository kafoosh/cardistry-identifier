import type { TrackingLoop } from '../tracking/trackingLoop'
import type { Frame } from '../tracking/types'
import { detectActiveHands, keepHands } from '../recording/activeHands'
import { extractFeatures, type FeatureSequence } from './features'
import type { MotionWatcher } from './motionWatcher'
import type { Matcher } from './matcher'
import type { MatchQuery, MatchResult } from './matcher.worker'
import type { MoveScore, Template } from './recognizer'

const INTERVAL_MS = 400
const HOLD_MS = 2500

/** Who a guess is about: one hand (by its tracked label), or both hands together. */
export type HandLabel = 'Left' | 'Right' | 'Both'

export interface HandGuess {
  hand: HandLabel
  moveName: string
  strength: number
}

export interface IdentifyState {
  status: 'still' | 'matching' | 'no-templates'
  /** Top candidates for each hand (or both hands), best group first. */
  groups: { hand: HandLabel; scores: MoveScore[] }[]
  /** Last confident answer: one move for both hands, or one per hand. Kept on screen for a moment after the move ends. */
  last: { guesses: HandGuess[]; at: number } | null
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
  private watcher: MotionWatcher
  /** Frame time of the last frame with intentional motion. */
  private lastActiveT = -Infinity
  /** lastActiveT already given a final match after the hands went idle. */
  private settledT = -Infinity

  constructor(
    loop: TrackingLoop,
    watcher: MotionWatcher,
    matcher: Matcher,
    templates: Template[],
    aspect: () => number,
    threshold: () => number,
    onUpdate: (s: IdentifyState) => void,
  ) {
    this.matcher = matcher
    this.watcher = watcher
    this.aspect = aspect
    this.threshold = threshold
    this.onUpdate = onUpdate
    const longest = Math.max(1000, ...templates.map((t) => t.features.durationMs))
    this.windowMs = Math.min(12_000, longest * 1.6)
    this.state = { status: templates.length ? 'still' : 'no-templates', groups: [], last: null, showLast: false, matchMs: 0 }
    this.unsubscribe = loop.onFrame((f) => {
      this.frames.push(f)
      if (this.watcher.latest.moving) this.lastActiveT = f.t
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
    // Only match while the fingers are moving intentionally, plus once more
    // right after they stop, on the window ending where the motion ended.
    let frames = this.frames
    if (!this.watcher.latest.active) {
      if (this.lastActiveT <= this.settledT) {
        if (this.state.status !== 'still' || this.state.showLast) this.emit({ ...this.state, status: 'still', groups: [] })
        return
      }
      this.settledT = this.lastActiveT
      frames = frames.filter((f) => f.t <= this.lastActiveT + 300)
      if (frames.length < 8) return
    }

    const aspect = this.aspect()
    const activity = detectActiveHands(frames)
    const present = activity.filter((h) => h.presence >= 0.3)
    const moving = present.filter((h) => h.active)
    const label = (slot: 0 | 1): HandLabel => activity[slot].handedness ?? (slot ? 'Right' : 'Left')
    const query: MatchQuery = {
      // Two-hand moves: both hands, trying each as the primary one, since
      // which hand leads is ambiguous over a window with idle time in it.
      both:
        present.length === 2
          ? ([0, 1] as const).map((p) => extractFeatures(frames, aspect, p)).filter((w) => w !== null)
          : [],
      // One-hand moves: each moving hand on its own, so different moves in
      // each hand are told apart.
      single: moving
        .map((h) => ({ slot: h.slot, window: extractFeatures(keepHands(frames, new Set([h.slot])), aspect, h.slot) }))
        .filter((x): x is { slot: 0 | 1; window: FeatureSequence } => x.window !== null),
    }
    if (!query.both.length && !query.single.length) return
    this.busy = true
    try {
      const { result, ms } = await this.matcher.match(query, this.threshold())
      const groups: IdentifyState['groups'] = []
      if (result.both.length) groups.push({ hand: 'Both', scores: result.both.slice(0, 3) })
      for (const s of result.single) if (s.scores.length) groups.push({ hand: label(s.slot), scores: s.scores.slice(0, 3) })
      const guesses = pickGuesses(result, label)
      groups.sort((a, b) => (b.scores[0]?.strength ?? 0) - (a.scores[0]?.strength ?? 0))
      const last = guesses.length ? { guesses, at: Date.now() } : this.state.last
      this.emit({ status: 'matching', groups, last, showLast: false, matchMs: ms })
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

/**
 * The answer to show: a two-hand move when it fits about as well as the
 * best one-hand move (it explains both hands at once), otherwise the confident one-hand move in each hand.
 */
function pickGuesses(result: MatchResult, label: (slot: 0 | 1) => HandLabel): HandGuess[] {
  const both = result.both[0]
  const singles = result.single
    .map((s) => ({ slot: s.slot, top: s.scores[0] }))
    .filter((s) => s.top && s.top.strength > 0)
  const bestSingle = Math.max(0, ...singles.map((s) => s.top.strength))
  if (both && both.strength > 0 && both.strength >= bestSingle * 0.9) return [{ hand: 'Both', moveName: both.moveName, strength: both.strength }]
  return singles.map((s) => ({ hand: label(s.slot), moveName: s.top.moveName, strength: s.top.strength }))
}
