import { dtw, subsequenceDtw } from './dtw'
import type { FeatureSequence } from './features'

export interface Template {
  id: string
  moveName: string
  features: FeatureSequence
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
}

/** Used until there are enough recordings to estimate a threshold from data. */
export const DEFAULT_THRESHOLD = 1.6

/** Best distance per move, sorted best first. */
function rankMoves(entries: { t: Template; distance: number; startedAgoMs?: number }[], threshold: number): MoveScore[] {
  const best = new Map<string, MoveScore>()
  for (const { t, distance, startedAgoMs } of entries) {
    if (!Number.isFinite(distance)) continue
    const prev = best.get(t.moveName)
    if (!prev || distance < prev.distance) {
      best.set(t.moveName, {
        moveName: t.moveName,
        distance,
        strength: Math.max(0, Math.min(1, 1 - distance / threshold)),
        templateId: t.id,
        startedAgoMs,
      })
    }
  }
  return [...best.values()].sort((a, b) => a.distance - b.distance)
}

/** Compares a whole recording against every template. */
export function classify(query: FeatureSequence, templates: Template[], threshold: number, excludeId?: string): MoveScore[] {
  return rankMoves(
    templates.filter((t) => t.id !== excludeId).map((t) => ({ t, distance: dtw(query, t.features) })),
    threshold,
  )
}

/**
 * Matches templates against the end of a live window. Several encodings of
 * the same window can be passed (e.g. with each hand as the primary one);
 * each template keeps its best.
 */
export function matchLive(windows: FeatureSequence[], templates: Template[], threshold: number): MoveScore[] {
  return rankMoves(
    templates.map((t) => {
      let best = { t, distance: Infinity, startedAgoMs: 0 }
      for (const w of windows) {
        const m = subsequenceDtw(w, t.features)
        if (m.distance < best.distance) {
          const msPerFrame = w.frames > 1 ? w.durationMs / (w.frames - 1) : 0
          best = { t, distance: m.distance, startedAgoMs: (w.frames - 1 - m.start) * msPerFrame }
        }
      }
      return best
    }),
    threshold,
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
