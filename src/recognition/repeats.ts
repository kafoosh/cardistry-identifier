import { extractFeatures, FEATURE_DIM, type FeatureSequence } from './features'
import type { Frame } from '../tracking/types'

/** Shortest and longest single repetition considered. */
const MIN_PERIOD_MS = 700
const MAX_PERIOD_MS = 5000
/** How much closer a frame must be to itself one period later than to a random other frame. */
const MAX_PERIOD_RATIO = 0.55
/** How much worse a shorter dip may be and still count as the real repetition when the deeper one is two or three of them. */
const HARMONIC_SLACK = 1.5

export interface RepeatResult {
  /** Each repetition, in ms on the input frames' clock. */
  segments: { startMs: number; endMs: number }[]
  periodMs: number
  /** 0 to 1: how alike the repetitions are. */
  strength: number
  /** Other plausible repetition lengths (ms, shortest first), for "longer" and "shorter" in the review. */
  options: number[]
  /** Which of `options` this result uses. */
  choice: number
}

function dist(f: FeatureSequence, i: number, j: number): number {
  const a = i * FEATURE_DIM
  const b = j * FEATURE_DIM
  let s = 0
  for (let d = 0; d < FEATURE_DIM; d++) {
    const x = f.data[a + d] - f.data[b + d]
    s += x * x
  }
  return Math.sqrt(s)
}

/**
 * Finds a move performed several times back to back. The repetition length
 * is the lag at which the motion best matches a shifted copy of itself; cut
 * points then land on the same pose in every repetition (searched near each
 * expected boundary, so speed drifting between repetitions is fine).
 * Partial repetitions at either end are dropped. Returns null when the take
 * doesn't repeat clearly at least twice.
 */
export function findRepeats(frames: Frame[], aspect: number, preferred?: number): RepeatResult | null {
  const f = extractFeatures(frames, aspect)
  if (!f || f.frames < 10) return null
  const n = f.frames
  const dt = f.durationMs / (n - 1)
  const t0 = frames[0].t

  // Typical distance between unrelated frames, for scale.
  let base = 0
  let count = 0
  const stride = Math.max(1, Math.floor(n / 40))
  for (let i = 0; i < n; i += stride) {
    for (let j = i + stride * 3; j < n; j += stride) {
      base += dist(f, i, j)
      count++
    }
  }
  if (!count || base === 0) return null
  base /= count

  const minLag = Math.max(2, Math.round(MIN_PERIOD_MS / dt))
  const maxLag = Math.min(Math.round(MAX_PERIOD_MS / dt), Math.floor(n / 2))
  if (maxLag <= minLag) return null
  const ratios: number[] = []
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0
    for (let i = 0; i + lag < n; i++) s += dist(f, i, i + lag)
    ratios.push(s / (n - lag) / base)
  }
  // Candidate repetition lengths: each dip where the motion lines up with a
  // shifted copy of itself. The deepest dip is the starting point. Two or
  // three repetitions together also line up (often slightly better, as fewer
  // frames overlap), so a dip at a half or a third of the deepest one wins
  // when it's nearly as deep. A part of a move that resembles another part
  // (half a cut) lines up clearly worse, so it doesn't.
  const candidates: { lag: number; ratio: number }[] = []
  ratios.forEach((r, k) => {
    if (r <= MAX_PERIOD_RATIO && (k === 0 || r <= ratios[k - 1]) && (k === ratios.length - 1 || r <= ratios[k + 1]))
      candidates.push({ lag: minLag + k, ratio: r })
  })
  if (!candidates.length) return null
  const segmentsFor = (period: number) => cutsFor(f, base, period)
  const usable = candidates.map((c) => ({ ...c, cuts: segmentsFor(c.lag) })).filter((c) => c.cuts.length >= 3)
  if (!usable.length) return null
  let choice = usable.reduce((bi, c, i) => (c.ratio < usable[bi].ratio ? i : bi), 0)
  const deepest = usable[choice]
  for (let i = 0; i < choice; i++) {
    const c = usable[i]
    const k = Math.round(deepest.lag / c.lag)
    const harmonic = k >= 2 && Math.abs(deepest.lag / c.lag - k) <= 0.12 * k
    if (harmonic && c.ratio <= deepest.ratio * HARMONIC_SLACK + 0.03) {
      choice = i
      break
    }
  }
  if (preferred !== undefined) choice = Math.max(0, Math.min(usable.length - 1, preferred))
  const picked = usable[choice]
  const cuts = picked.cuts
  const segments = []
  for (let k = 0; k + 1 < cuts.length; k++) segments.push({ startMs: t0 + cuts[k] * dt, endMs: t0 + cuts[k + 1] * dt })
  return {
    segments,
    periodMs: picked.lag * dt,
    strength: Math.max(0, Math.min(1, 1 - picked.ratio)),
    options: usable.map((c) => c.lag * dt),
    choice,
  }
}

/** Cut points (feature frame indices) for a given repetition length; fewer than 3 means under two whole repetitions. */
function cutsFor(f: FeatureSequence, base: number, period: number): number[] {
  const n = f.frames
  // Try every starting pose in the first repetition and keep the one whose
  // chain of cuts is longest and most alike; ties go to stiller poses, since
  // cuts between repetitions are cleaner where the hands pause.
  const speed = (i: number) => (i + 1 < n ? dist(f, i, i + 1) : Infinity)
  const window = Math.max(1, Math.round(period * 0.25))
  const chain = (anchor: number) => {
    const cuts = [anchor]
    let total = 0
    for (;;) {
      const prev = cuts[cuts.length - 1]
      const expected = prev + period
      let bestJ = -1
      let bestD = Infinity
      for (let j = Math.max(prev + Math.round(period * 0.6), expected - window); j <= Math.min(n - 1, expected + window); j++) {
        const d = dist(f, anchor, j)
        if (d < bestD) {
          bestD = d
          bestJ = j
        }
      }
      if (bestJ < 0 || bestD / base > 0.8) break
      cuts.push(bestJ)
      total += bestD
    }
    const score = cuts.length > 1 ? total / (cuts.length - 1) / base + (speed(anchor) / base) * 0.5 : Infinity
    return { cuts, score }
  }
  let best_ = chain(0)
  for (let a = 1; a < Math.min(period, n - 1); a++) {
    const c = chain(a)
    if (c.cuts.length > best_.cuts.length || (c.cuts.length === best_.cuts.length && c.score < best_.score)) best_ = c
  }
  return best_.cuts
}
