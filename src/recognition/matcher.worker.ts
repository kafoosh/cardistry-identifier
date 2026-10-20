/// <reference lib="webworker" />
import { findOutliers, matchLive, selfTest, type Template } from './recognizer'
import type { FeatureSequence } from './features'

export type MatcherRequest =
  | { type: 'templates'; id: number; templates: Template[] }
  | { type: 'match'; id: number; windows: FeatureSequence[]; threshold: number }
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
    const scores = matchLive(msg.windows, templates, msg.threshold)
    self.postMessage({ type: 'match', id: msg.id, scores, ms: performance.now() - t0 })
  } else if (msg.type === 'selftest') {
    self.postMessage({ type: 'selftest', id: msg.id, result: selfTest(templates) })
  }
}
