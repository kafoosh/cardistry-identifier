import { bothHaveCards, dtw, subsequenceDtw } from './dtw'
import { mirrorFeatures, type FeatureSequence } from './features'

export interface Template {
  id: string
  moveName: string
  features: FeatureSequence
  /** One-hand moves are matched against each hand on its own; two-hand moves against both together. */
  hands: 1 | 2
  source: 'mine' | 'shared'
}

export interface MoveScore {
  moveName: string
  distance: number
  /** 0..1, how far under the match threshold the distance is. */
  strength: number
  /** Template that matched best. */
  templateId: string
  /** For live matches: how long ago the match started, ms. */
  startedAgoMs?: number
  /** The confidence combines finger and card tracking (both sides had card data). */
  withCards?: boolean
}

/** Used until there are enough recordings to estimate a threshold from data. */
export const DEFAULT_THRESHOLD = 1.6

/**
 * Best distance per move, sorted best first. With `support`, a move with
 * several takes is scored on its two closest takes rather than its single
 * closest: one odd take that happens to resemble the window is not evidence
 * that the move was done, two agreeing takes are.
 */
function rankMoves(
  entries: { t: Template; distance: number; startedAgoMs?: number; withCards?: boolean }[],
  threshold: number,
  support = false,
): MoveScore[] {
  const byMove = new Map<string, typeof entries>()
  for (const e of entries) {
    if (!Number.isFinite(e.distance)) continue
    const list = byMove.get(e.t.moveName) ?? []
    list.push(e)
    byMove.set(e.t.moveName, list)
  }
  const scores: MoveScore[] = []
  for (const [moveName, list] of byMove) {
    list.sort((a, b) => a.distance - b.distance)
    const [first, second] = list
    const distance = support && second ? (first.distance + second.distance) / 2 : first.distance
    scores.push({
      moveName,
      distance,
      strength: Math.max(0, Math.min(1, 1 - distance / threshold)),
      templateId: first.t.id,
      startedAgoMs: first.startedAgoMs,
      withCards: first.withCards,
    })
  }
  return scores.sort((a, b) => a.distance - b.distance)
}

/** Distance between two whole sequences, done with either hand. */
export function dtwEitherHand(a: FeatureSequence, b: FeatureSequence): number {
  return Math.min(dtw(a, b), dtw(mirrorFeatures(a), b))
}

/** Compares a whole recording against every template. */
export function classify(
  query: FeatureSequence,
  templates: Template[],
  threshold: number,
  excludeId?: string,
): MoveScore[] {
  return rankMoves(
    templates.filter((t) => t.id !== excludeId).map((t) => ({ t, distance: dtwEitherHand(query, t.features) })),
    threshold,
  )
}

/**
 * Matches templates against the end of a live window. Several encodings of
 * the same window can be passed (e.g. with each hand as the primary one);
 * each is also tried mirrored, so the move is found in either hand, and
 * each template keeps its best.
 */
export function matchLive(windows: FeatureSequence[], templates: Template[], threshold: number): MoveScore[] {
  const eitherHand = windows.flatMap((w) => [w, mirrorFeatures(w)])
  return rankMoves(
    templates.map((t) => {
      let best = { t, distance: Infinity, startedAgoMs: 0, withCards: false }
      for (const w of eitherHand) {
        const m = subsequenceDtw(w, t.features)
        if (m.distance < best.distance) {
          const msPerFrame = w.frames > 1 ? w.durationMs / (w.frames - 1) : 0
          best = {
            t,
            distance: m.distance,
            startedAgoMs: (w.frames - 1 - m.start) * msPerFrame,
            withCards: bothHaveCards(w, t.features),
          }
        }
      }
      return best
    }),
    threshold,
    true,
  )
}

export interface SelfTestResult {
  /** Recordings whose nearest other recording is the same move. */
  correct: number
  total: number
  /** Moves with at least two recordings (only those can be tested). */
  testedMoves: number
  /** Per true move: how often it was guessed as each move. */
  confusion: Record<string, Record<string, number>>
  /** Threshold estimated from the data. */
  threshold: number
}

/**
 * Leave-one-out test over the templates: each recording is classified
 * against all the others. Also estimates a match threshold from how far
 * recordings of the same move are from each other.
 */
export function selfTest(templates: Template[]): SelfTestResult {
  const counts = new Map<string, number>()
  for (const t of templates) counts.set(t.moveName, (counts.get(t.moveName) ?? 0) + 1)
  const testable = templates.filter((t) => (counts.get(t.moveName) ?? 0) >= 2)
  const confusion: SelfTestResult['confusion'] = {}
  const sameMove: number[] = []
  let correct = 0
  for (const t of testable) {
    const ranked = classify(t.features, templates, DEFAULT_THRESHOLD, t.id)
    const guess = ranked[0]?.moveName ?? '(none)'
    confusion[t.moveName] ??= {}
    confusion[t.moveName][guess] = (confusion[t.moveName][guess] ?? 0) + 1
    if (guess === t.moveName) correct++
    const own = ranked.find((r) => r.moveName === t.moveName)
    if (own) sameMove.push(own.distance)
  }
  sameMove.sort((a, b) => a - b)
  // Most same-move pairs should fall under the threshold: take the 90th percentile, padded.
  const threshold = sameMove.length >= 3 ? sameMove[Math.floor((sameMove.length - 1) * 0.9)] * 1.25 : DEFAULT_THRESHOLD
  return {
    correct,
    total: testable.length,
    testedMoves: [...counts.values()].filter((c) => c >= 2).length,
    confusion,
    threshold,
  }
}

/** A move's take that is this many times further from its siblings than is typical gets left out. */
const OUTLIER_RATIO = 1.6
const MIN_TAKES_FOR_OUTLIERS = 4

/**
 * Finds takes that don't look like the other takes of the same move (a
 * fumble, the wrong move, hands out of frame). For each take: its median
 * DTW distance to the move's other takes. A take whose median is far above
 * the move's typical median is an outlier. Needs a few takes per move.
 */
export function findOutliers(templates: Template[]): Set<string> {
  const byMove = new Map<string, Template[]>()
  for (const t of templates) byMove.set(t.moveName, [...(byMove.get(t.moveName) ?? []), t])
  const out = new Set<string>()
  const median = (xs: number[]) => {
    const a = [...xs].sort((x, y) => x - y)
    const m = a.length >> 1
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
  }
  for (const takes of byMove.values()) {
    if (takes.length < MIN_TAKES_FOR_OUTLIERS) continue
    const d = takes.map(() => new Array<number>(takes.length).fill(0))
    for (let i = 0; i < takes.length; i++) {
      for (let j = i + 1; j < takes.length; j++) d[i][j] = d[j][i] = dtwEitherHand(takes[i].features, takes[j].features)
    }
    const medians = takes.map((_, i) => median(d[i].filter((_, j) => j !== i)))
    const typical = median(medians)
    takes.forEach((t, i) => {
      if (medians[i] > typical * OUTLIER_RATIO) out.add(t.id)
    })
  }
  return out
}
