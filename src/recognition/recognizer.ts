import { bothHaveCards, subsequenceDtw } from './dtw'
import { mirrorFeatures, type FeatureSequence } from './features'
import { identity, type Project } from './projection'

export interface Template {
  id: string
  moveName: string
  features: FeatureSequence
  /** One-hand moves are matched against each hand on its own; two-hand moves against both together. */
  hands: 1 | 2
  /**
   * The take as Identify's other kind of matching would also see it: both
   * hands together for a one-hand take, each moving hand alone for a
   * two-hand take. Only used to learn what this move must not be mistaken
   * for (a one-hand Charlier read as a two-hand Revolution cut).
   */
  alt?: FeatureSequence[]
  source: 'mine' | 'shared'
}

export interface MoveScore {
  moveName: string
  distance: number
  /** 0..1, how far under the move's match threshold the distance is; MIN_STRENGTH at its acceptance limit. */
  strength: number
  /** Template that matched best. */
  templateId: string
  /** For live matches: how long ago the match started, ms. */
  startedAgoMs?: number
  /** The confidence combines finger and card tracking (both sides had card data). */
  withCards?: boolean
}

/** Used until there are enough takes to estimate a threshold from data. */
export const DEFAULT_THRESHOLD = 1.6

/**
 * Best distance per move, strongest first. Each move's distance is turned
 * into a strength on that move's own scale (see calibration.ts). With `support`, a move with
 * several takes is scored on its two closest takes rather than its single
 * closest: one odd take that happens to resemble the window is not evidence
 * that the move was done, two agreeing takes are.
 */
function rankMoves(
  entries: { t: Template; distance: number; startedAgoMs?: number; withCards?: boolean }[],
  scaleFor: (moveName: string) => number,
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
      strength: Math.max(0, Math.min(1, 1 - distance / scaleFor(moveName))),
      templateId: first.t.id,
      startedAgoMs: first.startedAgoMs,
      withCards: first.withCards,
    })
  }
  return scores.sort((a, b) => b.strength - a.strength || a.distance - b.distance)
}

/**
 * Matches templates against the end of a live window. Several encodings of
 * the same window can be passed (e.g. with each hand as the primary one);
 * each is also tried mirrored, so the move is found in either hand, and
 * each template keeps its best. Templates must already be in `project`'s encoding.
 */
export function matchLive(
  windows: FeatureSequence[],
  templates: Template[],
  scaleFor: (moveName: string) => number,
  project: Project = identity,
): MoveScore[] {
  const eitherHand = windows.flatMap((w) => [project(w), project(mirrorFeatures(w))])
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
    scaleFor,
    true,
  )
}
