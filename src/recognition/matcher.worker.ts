/// <reference lib="webworker" />
import { matchLive, selfTest, type Template } from './recognizer'
import type { FeatureSequence } from './features'

export type MatcherRequest =
  | { type: 'templates'; templates: Template[] }
  | { type: 'match'; id: number; windows: FeatureSequence[]; threshold: number }
  | { type: 'selftest'; id: number }

let templates: Template[] = []

self.onmessage = (e: MessageEvent<MatcherRequest>) => {
  const msg = e.data
  if (msg.type === 'templates') {
    templates = msg.templates
  } else if (msg.type === 'match') {
    const t0 = performance.now()
    const scores = matchLive(msg.windows, templates, msg.threshold)
    self.postMessage({ type: 'match', id: msg.id, scores, ms: performance.now() - t0 })
  } else if (msg.type === 'selftest') {
    self.postMessage({ type: 'selftest', id: msg.id, result: selfTest(templates) })
  }
}
