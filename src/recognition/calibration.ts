import { chooseAnswer, MIN_STRENGTH } from './decide'
import { subsequenceDtw } from './dtw'
import { FEATURE_DIM, mirrorFeatures, type FeatureSequence } from './features'
import { fitBasis, projectWith, type Basis, type Project } from './projection'
import { DEFAULT_THRESHOLD, type MoveScore, type Template } from './recognizer'
import { applyWeights, fitWeights, IMPOSTORS, type Weights } from './weights'

/**
 * Per-move acceptance limits learned from the takes themselves, and the
 * leave-one-out test that measures them.
 *
 * Each take is run through the live matcher against every other take, the
 * way Identify would see it: its own encoding (one hand, or both hands),
 * and the encoding Identify would also try on it (both hands for a
 * one-hand take, each hand alone for a two-hand take). From that, each move
 * gets:
 * - how far its own takes are from it (genuine), and
 * - how far takes of every other move come to it (impostors).
 * A move is only accepted at distances its own takes typically reach and
 * that no other move's takes reach, so a move that loosely resembles
 * everything stops being announced for everything.
 *
 * Distances to a move are weighted by what defines that move (weights.ts):
 * the parts of the hand and card motion its takes agree on and its closest
 * look-alikes don't.
 */

/** One encoding of a take, as the live matcher would see it. */
interface Query {
  take: number
  /** Matched against one-hand or two-hand moves. */
  group: 1 | 2
  /** The take's own encoding (a genuine example of its move). */
  own: boolean
  features: FeatureSequence
}

export interface Calibration {
  /** Per move: the distance at which its strength reaches zero. */
  scale: Map<string, number>
  /** Fallback scale for moves that couldn't be calibrated. */
  global: number
}

export interface SelfTestResult {
  /** Takes whose move was announced correctly. */
  correct: number
  /** Takes announced as a different move: the false positives. */
  wrong: number
  /** Takes where nothing was announced. */
  unsure: number
  total: number
  /** Moves with at least two takes (only those can be tested). */
  testedMoves: number
  /** Per true move: how often it was announced as each move ("(not sure)" when nothing was). */
  confusion: Record<string, Record<string, number>>
  /** Fallback threshold estimated from the data (for moves with a single take). */
  threshold: number
}

/** Genuine distances: the nearest-rank 90th percentile, so with two takes it is the larger one. */
const GENUINE_QUANTILE = 0.9
/** Slack over that, since a live window is a little rougher than a trimmed take. */
const GENUINE_SLACK = 1.1
/** A wrong announcement costs this many missed ones: the limit trades misses for wrong guesses at this rate. */
const FALSE_POSITIVE_COST = 3
/** A take this many times further from its siblings than is typical gets left out. */
const OUTLIER_RATIO = 1.6
const MIN_TAKES_FOR_OUTLIERS = 4

const liveDistance = (q: FeatureSequence, qm: FeatureSequence, t: FeatureSequence) =>
  Math.min(subsequenceDtw(q, t).distance, subsequenceDtw(qm, t).distance)

/** Projection fitted on the takes and their mirror images, so it covers moves done in either hand. */
export const fitTakes = (templates: Template[]): Basis | null =>
  fitBasis(templates.flatMap((t) => [t.features, mirrorFeatures(t.features)]))

/**
 * Live windows always have some time before the move in them; a trimmed
 * take doesn't, so a quick take couldn't match a slower take of the same
 * move at all (matches must span most of the template). Holding the first
 * pose for a while before the take gives it the same lead-in a live window
 * has.
 */
function withLeadIn(seq: FeatureSequence, frames: number): FeatureSequence {
  if (frames <= 0) return seq
  const stride = seq.dim ?? FEATURE_DIM
  const data = new Float32Array((seq.frames + frames) * stride)
  for (let f = 0; f < frames; f++) data.set(seq.data.subarray(0, stride), f * stride)
  data.set(seq.data, frames * stride)
  const msPerFrame = seq.frames > 1 ? seq.durationMs / (seq.frames - 1) : 0
  return { ...seq, data, frames: seq.frames + frames, durationMs: seq.durationMs + frames * msPerFrame }
}

/**
 * The distance up to which a move is accepted, from its own takes'
 * distances (genuine) and other moves' takes' distances (impostors), both
 * sorted. With both, it is the cut that misses the fewest genuine takes
 * while letting through the fewest impostors, an impostor counting
 * FALSE_POSITIVE_COST times; within the best range, the middle.
 */
function acceptLimit(genuine: number[], impostor: number[]): number {
  // A move with a single take shows nothing of how its takes vary, so nothing says how close is close enough: it
  // isn't named until it has a second take. (Tiny rather than zero, so strengths stay numbers.)
  if (!genuine.length) return 1e-9
  const loose = genuine[Math.ceil(genuine.length * GENUINE_QUANTILE) - 1] * GENUINE_SLACK
  if (!impostor.length) return loose
  // Candidate cuts just above each distance; cost = share of genuine missed + weighted share of impostors let in.
  const cuts = [...genuine, ...impostor].filter((d) => d <= loose).sort((a, b) => a - b)
  const costAt = (t: number) =>
    genuine.filter((d) => d > t).length / genuine.length +
    (FALSE_POSITIVE_COST * impostor.filter((d) => d <= t).length) / impostor.length
  let best = costAt(0)
  let lo = 0
  let hi = cuts.length ? cuts[0] : loose
  cuts.forEach((t, k) => {
    const c = costAt(t)
    const next = k + 1 < cuts.length ? cuts[k + 1] : loose
    if (c < best - 1e-9) [best, lo, hi] = [c, t, next]
  })
  return (lo + hi) / 2
}

function median(xs: number[]) {
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

export class TakeSet {
  readonly templates: Template[]
  /** The projection matching uses, and the directions it projects onto. */
  readonly project: Project
  readonly basis: Basis | null
  /** Per move: how much each projected value counts (missing: all count the same). */
  readonly weights = new Map<string, Weights>()
  private projected: FeatureSequence[]
  private mirrored: FeatureSequence[]
  private queries: Query[] = []
  /** Each query projected, as done and mirrored. */
  private encoded: { seq: FeatureSequence; mirrored: FeatureSequence }[] = []
  /** dist[q][t]: weighted live distance of query q against template t (Infinity across groups, or for the query's own take). */
  private dist: Float64Array[] = []
  /** Takes left out of matching. */
  readonly outliers = new Set<number>()

  constructor(templates: Template[], { weighted = true } = {}) {
    this.templates = templates
    this.basis = fitTakes(templates)
    this.project = projectWith(this.basis)
    this.projected = templates.map((t) => this.project(t.features))
    this.mirrored = templates.map((t) => this.project(mirrorFeatures(t.features)))
    templates.forEach((t, take) => {
      this.queries.push({ take, group: t.hands, own: true, features: t.features })
      for (const features of t.alt ?? [])
        this.queries.push({ take, group: t.hands === 1 ? 2 : 1, own: false, features })
    })
    const longest = (group: 1 | 2) =>
      Math.max(0, ...templates.filter((t) => t.hands === group).map((t) => t.features.frames))
    const lead = { 1: longest(1), 2: longest(2) }
    this.encoded = this.queries.map((q) => {
      const pad = Math.ceil(lead[q.group] * 0.9) - q.features.frames
      const seq = q.own ? this.projected[q.take] : this.project(q.features)
      const mirrored = q.own ? this.mirrored[q.take] : this.project(mirrorFeatures(q.features))
      return { seq: withLeadIn(seq, pad), mirrored: withLeadIn(mirrored, pad) }
    })
    // Unweighted first: outliers, and each move's most typical take and closest look-alikes, come from these.
    this.dist = this.queries.map((_, q) => this.row(q))
    this.findOutliers()
    if (weighted) {
      for (const move of new Set(templates.map((t) => t.moveName))) {
        const w = this.fitMove(move, this.outliers)
        if (w) this.weights.set(move, w)
      }
      this.dist = this.queries.map((_, q) => this.row(q))
    }
  }

  /** Distances of one query to every template, each weighted for the template's move. */
  private row(q: number, weights = this.weights, only?: string): Float64Array {
    const query = this.queries[q]
    const out = new Float64Array(this.templates.length).fill(Infinity)
    const byMove = new Map<
      string,
      { seq: FeatureSequence; mirrored: FeatureSequence; t: (s: FeatureSequence) => FeatureSequence }
    >()
    this.templates.forEach((t, i) => {
      if (i === query.take || t.hands !== query.group || (only && t.moveName !== only)) return
      let enc = byMove.get(t.moveName)
      if (!enc) {
        const w = weights.get(t.moveName)
        const e = this.encoded[q]
        enc = { seq: applyWeights(e.seq, w), mirrored: applyWeights(e.mirrored, w), t: (s) => applyWeights(s, w) }
        byMove.set(t.moveName, enc)
      }
      out[i] = liveDistance(enc.seq, enc.mirrored, enc.t(this.projected[i]))
    })
    return out
  }

  /** The row of a take's own query. */
  private ownRow(take: number, dist = this.dist) {
    return dist[this.queries.findIndex((q) => q.own && q.take === take)]
  }

  /**
   * Weights for one move from its takes (minus `skip`): its most typical
   * take as the reference, its other takes, and the other moves' takes that
   * came closest to it.
   */
  private fitMove(move: string, skip: Set<number>): Weights | null {
    const all = this.templates.map((t, i) => ({ t, i })).filter(({ t, i }) => t.moveName === move && !skip.has(i))
    if (all.length < 2) return null
    // Takes done the way most of this move's takes are (one hand or both).
    const ones = all.filter(({ t }) => t.hands === 1)
    const group = ones.length * 2 >= all.length ? 1 : 2
    const own = all.filter(({ t }) => t.hands === group).map(({ i }) => i)
    if (own.length < 2) return null
    const rows = own.map((i) => this.ownRow(i))
    const sums = rows.map((r) => own.reduce((s, j) => s + (Number.isFinite(r[j]) ? r[j] : 1e3), 0))
    const medoid = own[sums.indexOf(Math.min(...sums))]
    const others = this.templates
      .map((t, i) => ({ t, i }))
      .filter(({ t, i }) => t.moveName !== move && t.hands === group && !skip.has(i))
      .map(({ i }) => ({ i, d: Math.min(...rows.map((r) => r[i])) }))
      .filter(({ d }) => Number.isFinite(d))
      .sort((a, b) => a.d - b.d)
      .slice(0, IMPOSTORS)
    const sided = (i: number) => ({ seq: this.projected[i], mirrored: this.mirrored[i] })
    return fitWeights({
      takes: [medoid, ...own.filter((i) => i !== medoid)].map(sided),
      impostors: others.map(({ i }) => sided(i)),
    })
  }

  /** A template's features as live matching uses them: projected and weighted for its move. */
  encode(seq: FeatureSequence, move: string): FeatureSequence {
    return applyWeights(seq, this.weights.get(move))
  }

  /** Templates still used for matching, with their features projected. */
  get kept(): Template[] {
    return this.templates
      .map((t, i) => ({ ...t, features: this.encode(this.projected[i], t.moveName), alt: undefined }))
      .filter((_, i) => !this.outliers.has(i))
  }

  /**
   * Takes that don't look like the other takes of the same move (a fumble,
   * the wrong move, hands out of frame): their median distance to the
   * move's other takes is far above the move's typical median.
   */
  private findOutliers() {
    const own = this.queries.map((q, i) => ({ q, i })).filter(({ q }) => q.own)
    const byMove = new Map<string, number[]>()
    this.templates.forEach((t, i) => byMove.set(t.moveName, [...(byMove.get(t.moveName) ?? []), i]))
    for (const takes of byMove.values()) {
      const same = takes.filter((i) => this.templates[i].hands === this.templates[takes[0]].hands)
      if (same.length < MIN_TAKES_FOR_OUTLIERS) continue
      const medians = same.map((a) => {
        const row = this.dist[own.find(({ q }) => q.take === a)!.i]
        return median(same.filter((b) => b !== a).map((b) => row[b]))
      })
      const typical = median(medians)
      same.forEach((a, k) => {
        if (medians[k] > typical * OUTLIER_RATIO) this.outliers.add(a)
      })
    }
  }

  /** A move's distance on a query: the mean of its two closest takes (one odd take resembling the window isn't evidence). */
  private moveDistance(q: number, move: string, skip: Set<number>, dist = this.dist): number {
    const row = dist[q]
    let a = Infinity
    let b = Infinity
    this.templates.forEach((t, i) => {
      // The query's own take is already Infinity in its row.
      if (t.moveName !== move || skip.has(i)) return
      const d = row[i]
      if (d < a) [a, b] = [d, a]
      else if (d < b) b = d
    })
    return Number.isFinite(b) ? (a + b) / 2 : a
  }

  /** Acceptance scales for every move, learned without the takes in `leaveOut`. */
  calibrate(leaveOut: Set<number> = new Set(), dist = this.dist): Calibration {
    const skip = new Set([...this.outliers, ...leaveOut])
    const moves = new Map<string, Set<1 | 2>>()
    this.templates.forEach((t, i) => {
      if (!skip.has(i)) moves.set(t.moveName, (moves.get(t.moveName) ?? new Set()).add(t.hands))
    })
    const limits: { move: string; genuine: number[]; impostor: number[] }[] = []
    const allGenuine: number[] = []
    for (const [move, groups] of moves) {
      const genuine: number[] = []
      const impostor: number[] = []
      this.queries.forEach((q, qi) => {
        if (skip.has(q.take) || !groups.has(q.group)) return
        const d = this.moveDistance(qi, move, skip, dist)
        if (!Number.isFinite(d)) return
        if (this.templates[q.take].moveName !== move) impostor.push(d)
        else if (q.own) genuine.push(d)
      })
      allGenuine.push(...genuine)
      limits.push({ move, genuine, impostor })
    }
    allGenuine.sort((a, b) => a - b)
    const global =
      allGenuine.length >= 3
        ? allGenuine[Math.ceil(allGenuine.length * GENUINE_QUANTILE) - 1] * 1.25
        : DEFAULT_THRESHOLD
    const scale = new Map<string, number>()
    for (const { move, genuine, impostor } of limits) {
      genuine.sort((a, b) => a - b)
      impostor.sort((a, b) => a - b)
      scale.set(move, acceptLimit(genuine, impostor) / (1 - MIN_STRENGTH))
    }
    return { scale, global }
  }

  /** Ranked scores for one query, the way the live matcher would rank them. */
  private rank(q: number, cal: Calibration, skip: Set<number>, dist = this.dist): MoveScore[] {
    const moves = new Set(
      this.templates.filter((t, i) => !skip.has(i) && t.hands === this.queries[q].group).map((t) => t.moveName),
    )
    const out: MoveScore[] = []
    for (const moveName of moves) {
      const distance = this.moveDistance(q, moveName, skip, dist)
      if (!Number.isFinite(distance)) continue
      const s = cal.scale.get(moveName) ?? cal.global
      out.push({ moveName, distance, strength: Math.max(0, Math.min(1, 1 - distance / s)), templateId: '' })
    }
    return out.sort((a, b) => b.strength - a.strength || a.distance - b.distance)
  }

  /** The distance matrix with one move's weights refitted without the takes in `skip`. */
  private refitWithout(move: string, skip: Set<number>): Float64Array[] {
    if (!this.weights.has(move)) return this.dist
    const weights = new Map(this.weights)
    const w = this.fitMove(move, skip)
    if (w) weights.set(move, w)
    else weights.delete(move)
    return this.dist.map((r, q) => {
      const fresh = this.row(q, weights, move)
      return r.map((d, i) => (this.templates[i].moveName === move ? fresh[i] : d))
    })
  }

  /**
   * Leave-one-out test: each take is held out, its move's weights and every
   * move's limits are learned from the rest, and the take is run through
   * the same decision Identify makes. (Other moves' weights keep the held-out
   * take among their look-alikes; refitting all of them per take costs a
   * full rebuild for little change.)
   */
  selfTest(): SelfTestResult {
    const counts = new Map<string, number>()
    this.templates.forEach((t, i) => {
      if (!this.outliers.has(i)) counts.set(t.moveName, (counts.get(t.moveName) ?? 0) + 1)
    })
    const result: SelfTestResult = {
      correct: 0,
      wrong: 0,
      unsure: 0,
      total: 0,
      testedMoves: [...counts.values()].filter((c) => c >= 2).length,
      confusion: {},
      threshold: this.calibrate().global,
    }
    this.templates.forEach((t, take) => {
      if (this.outliers.has(take) || (counts.get(t.moveName) ?? 0) < 2) return
      const leaveOut = new Set([take])
      const skip = new Set([...this.outliers, take])
      const dist = this.refitWithout(t.moveName, skip)
      const cal = this.calibrate(leaveOut, dist)
      const mine = this.queries.map((q, i) => ({ q, i })).filter(({ q }) => q.take === take)
      const both = mine.filter(({ q }) => q.group === 2).map(({ i }) => this.rank(i, cal, skip, dist))
      const singles = mine
        .filter(({ q }) => q.group === 1)
        .map(({ i }) => ({ slot: i, scores: this.rank(i, cal, skip, dist) }))
      // Both-hand encodings are merged per move, as live matching keeps each template's best encoding.
      const bothScores = both.flat().sort((a, b) => b.strength - a.strength)
      const seen = new Set<string>()
      const answer = chooseAnswer(
        bothScores.filter((s) => !seen.has(s.moveName) && seen.add(s.moveName)),
        singles,
      )
      const names = 'both' in answer ? [answer.both.moveName] : answer.singles.map((s) => s.top.moveName)
      const wrongName = names.find((n) => n !== t.moveName)
      const guess = wrongName ?? (names.length ? t.moveName : '(not sure)')
      result.total++
      if (wrongName) result.wrong++
      else if (names.length) result.correct++
      else result.unsure++
      result.confusion[t.moveName] ??= {}
      result.confusion[t.moveName][guess] = (result.confusion[t.moveName][guess] ?? 0) + 1
    })
    return result
  }
}
