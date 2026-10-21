/// <reference lib="webworker" />
import { TakeSet, type Calibration } from './calibration'
import { buildModel, loadModel, type MatchModel } from './model'
import { identity, type Project } from './projection'
import { matchLive, type MoveScore, type Template } from './recognizer'
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
  | { type: 'build'; id: number; templates: Template[] }
  | { type: 'model'; id: number; model: MatchModel }
  | { type: 'match'; id: number; query: MatchQuery; threshold: number }
  | { type: 'selftest'; id: number }

let takes: TakeSet | null = null
let templates: Template[] = []
let calibration: Calibration = { scale: new Map(), global: 1 }
let project: Project = identity
let weigh = (seq: FeatureSequence, move: string) => takes?.encode(seq, move) ?? seq

self.onmessage = (e: MessageEvent<MatcherRequest>) => {
  const msg = e.data
  if (msg.type === 'templates') {
    // Takes that don't look like the rest of their move are left out of
    // matching, and each move's acceptance limit is learned from the rest.
    const set = new TakeSet(msg.templates)
    takes = set
    templates = set.kept
    project = set.project
    calibration = set.calibrate()
    weigh = (seq, move) => set.encode(seq, move)
    self.postMessage({
      type: 'templates',
      id: msg.id,
      outliers: [...set.outliers].map((i) => msg.templates[i].id),
      threshold: calibration.global,
    })
  } else if (msg.type === 'build') {
    // Only builds: the result is loaded into the matcher that runs live, so matching never waits on a build.
    self.postMessage({ type: 'build', id: msg.id, model: buildModel(msg.templates) })
  } else if (msg.type === 'model') {
    const loaded = loadModel(msg.model)
    takes = null
    templates = loaded.templates
    project = loaded.project
    calibration = loaded.calibration
    weigh = loaded.weigh
    self.postMessage({ type: 'model', id: msg.id, outliers: msg.model.outliers, threshold: calibration.global })
  } else if (msg.type === 'match') {
    const t0 = performance.now()
    // The threshold sent is the global one times the sensitivity setting; apply the same sensitivity to each move's own scale.
    const sensitivity = msg.threshold / calibration.global
    const scaleFor = (move: string) => (calibration.scale.get(move) ?? calibration.global) * sensitivity
    const one = templates.filter((t) => t.hands === 1)
    const two = templates.filter((t) => t.hands === 2)
    const result: MatchResult = {
      both: msg.query.both.length && two.length ? matchLive(msg.query.both, two, scaleFor, project, weigh) : [],
      single: msg.query.single.map(({ slot, window }) => ({
        slot,
        scores: one.length ? matchLive([window], one, scaleFor, project, weigh) : [],
      })),
    }
    self.postMessage({ type: 'match', id: msg.id, match: result, ms: performance.now() - t0 })
  } else if (msg.type === 'selftest') {
    self.postMessage({ type: 'selftest', id: msg.id, result: takes ? takes.selfTest() : emptyTest() })
  }
}

const emptyTest = () => ({ correct: 0, wrong: 0, unsure: 0, total: 0, testedMoves: 0, confusion: {}, threshold: 1 })
