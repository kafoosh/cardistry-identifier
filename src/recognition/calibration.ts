import { chooseAnswer, MIN_STRENGTH } from './decide'
import { subsequenceDtw } from './dtw'
import { mirrorFeatures, type FeatureSequence } from './features'
import { fitProjection, type Project } from './projection'
import { DEFAULT_THRESHOLD, type MoveScore, type Template } from './recognizer'

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
/** Stay this far under the closest any other move's take came, so near-misses stay misses. */
const IMPOSTOR_MARGIN = 0.9
/** A take this many times further from its siblings than is typical gets left out. */
const OUTLIER_RATIO = 1.6
const MIN_TAKES_FOR_OUTLIERS = 4

const liveDistance = (q: FeatureSequence, qm: FeatureSequence, t: FeatureSequence) =>
  Math.min(subsequenceDtw(q, t).distance, subsequenceDtw(qm, t).distance)

/** Projection fitted on the takes and their mirror images, so it covers moves done in either hand. */
export const fitTakes = (templates: Template[]): Project =>
  fitProjection(templates.flatMap((t) => [t.features, mirrorFeatures(t.features)]))

function median(xs: number[]) {
  const a = [...xs].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

export class TakeSet {
  readonly templates: Template[]
  /** The projection matching uses; templates' features in it are in `projected`. */
  readonly project: Project
  readonly projected: FeatureSequence[]
  private queries: Query[] = []
  /** dist[q][t]: live distance of query q against template t (Infinity across groups, or for the query's own take). */
  private dist: Float64Array[] = []
  /** Takes left out of matching. */
  readonly outliers = new Set<number>()

  constructor(templates: Template[]) {
    this.templates = templates
    this.project = fitTakes(templates)
    this.projected = templates.map((t) => this.project(t.features))
    templates.forEach((t, take) => {
      this.queries.push({ take, group: t.hands, own: true, features: t.features })
      for (const features of t.alt ?? [])
        this.queries.push({ take, group: t.hands === 1 ? 2 : 1, own: false, features })
    })
    for (const q of this.queries) {
      const row = new Float64Array(templates.length).fill(Infinity)
      const p = this.project(q.features)
      const mirrored = this.project(mirrorFeatures(q.features))
      templates.forEach((t, i) => {
        if (i !== q.take && t.hands === q.group) row[i] = liveDistance(p, mirrored, this.projected[i])
      })
      this.dist.push(row)
    }
    this.findOutliers()
  }

  /** Templates still used for matching, with their features projected. */
  get kept(): Template[] {
    return this.templates
      .map((t, i) => ({ ...t, features: this.projected[i], alt: undefined }))
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
  private moveDistance(q: number, move: string, skip: Set<number>): number {
    const row = this.dist[q]
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
  calibrate(leaveOut: Set<number> = new Set()): Calibration {
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
        const d = this.moveDistance(qi, move, skip)
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
      let limit = genuine.length
        ? genuine[Math.ceil(genuine.length * GENUINE_QUANTILE) - 1] * GENUINE_SLACK
        : global * (1 - MIN_STRENGTH)
      // The closest other moves came; with many impostors, ignore the very closest few.
      if (impostor.length) {
        const low = impostor.length >= 20 ? impostor[Math.floor(impostor.length * 0.05)] : impostor[0]
        limit = Math.min(limit, low * IMPOSTOR_MARGIN)
      }
      scale.set(move, limit / (1 - MIN_STRENGTH))
    }
    return { scale, global }
  }

  /** Ranked scores for one query, the way the live matcher would rank them. */
  private rank(q: number, cal: Calibration, skip: Set<number>): MoveScore[] {
    const moves = new Set(
      this.templates.filter((t, i) => !skip.has(i) && t.hands === this.queries[q].group).map((t) => t.moveName),
    )
    const out: MoveScore[] = []
    for (const moveName of moves) {
      const distance = this.moveDistance(q, moveName, skip)
      if (!Number.isFinite(distance)) continue
      const s = cal.scale.get(moveName) ?? cal.global
      out.push({ moveName, distance, strength: Math.max(0, Math.min(1, 1 - distance / s)), templateId: '' })
    }
    return out.sort((a, b) => b.strength - a.strength || a.distance - b.distance)
  }

  /**
   * Leave-one-out test: each take is held out, the limits are learned from
   * the rest, and the take is run through the same decision Identify makes.
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
      const cal = this.calibrate(leaveOut)
      const skip = new Set([...this.outliers, take])
      const mine = this.queries.map((q, i) => ({ q, i })).filter(({ q }) => q.take === take)
      const both = mine.filter(({ q }) => q.group === 2).map(({ i }) => this.rank(i, cal, skip))
      const singles = mine
        .filter(({ q }) => q.group === 1)
        .map(({ i }) => ({ slot: i, scores: this.rank(i, cal, skip) }))
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
