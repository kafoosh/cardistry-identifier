/// <reference lib="webworker" />
import { findOutliers, matchLive, selfTest, type MoveScore, type Template } from './recognizer'
import type { FeatureSequence } from './features'

/** A live window encoded both ways: each moving hand alone, and both hands together. */
export interface MatchQuery {
  /** Both hands, once with each as the primary hand. Empty when only one hand is in view. */
  both: FeatureSequence[]
  single: { slot: 0 | 1; window: FeatureSequence }[]
}

export interface MatchResult {
  /** Two-hand moves. */
  both: MoveScore[]
  /** One-hand moves, per moving hand. */
  single: { slot: 0 | 1; scores: MoveScore[] }[]
}

export type MatcherRequest =
  | { type: 'templates'; id: number; templates: Template[] }
  | { type: 'match'; id: number; query: MatchQuery; threshold: number }
  | { type: 'selftest'; id: number }

let templates: Template[] = []

self.onmessage = (e: MessageEvent<MatcherRequest>) => {
  const msg = e.data
  if (msg.type === 'templates') {
    // Takes that don't look like the rest of their move are left out of matching.
    const outliers = findOutliers(msg.templates)
    templates = msg.templates.filter((t) => !outliers.has(t.id))
    self.postMessage({ type: 'templates', id: msg.id, outliers: [...outliers] })
  } else if (msg.type === 'match') {
    const t0 = performance.now()
    const one = templates.filter((t) => t.hands === 1)
    const two = templates.filter((t) => t.hands === 2)
    const result: MatchResult = {
      both: msg.query.both.length && two.length ? matchLive(msg.query.both, two, msg.threshold) : [],
      single: msg.query.single.map(({ slot, window }) => ({ slot, scores: one.length ? matchLive([window], one, msg.threshold) : [] })),
    }
    self.postMessage({ type: 'match', id: msg.id, match: result, ms: performance.now() - t0 })
  } else if (msg.type === 'selftest') {
    self.postMessage({ type: 'selftest', id: msg.id, result: selfTest(templates) })
  }
}
