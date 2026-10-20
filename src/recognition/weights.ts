import { FEATURE_DIM, HAND_DIM, type FeatureSequence } from './features'

/**
 * What makes a move that move: for each value in the (projected) features,
 * how consistent it is across the move's own takes and how differently the
 * moves it is most often confused with do it. Matching a move then weights
 * the values its takes agree on and its look-alikes don't, and turns down
 * the rest (an idle finger, a hand position people vary), so one move's
 * defining motion counts for more than its incidental motion.
 */

/** Weights stay within this range before normalising, so no single value takes over or vanishes. */
const MIN_WEIGHT = 0.3
const MAX_WEIGHT = 3
/** Only the look-alike takes closest to the move shape its weights: those are the ones it gets confused with. */
export const IMPOSTORS = 6
/** A move with few takes has noisy statistics, so its weights are pulled toward 1 (n takes keep (n-1)/(n+1) of the change). */
const shrink = (takes: number) => (takes - 1) / (takes + 1)

export type Weights = Float32Array

/**
 * Full DTW alignment of `seq` onto `ref`: the pairs of frames (seq, ref) on
 * the cheapest warping path. Used offline when fitting weights, not live.
 */
export function align(
  seq: FeatureSequence,
  ref: FeatureSequence,
  dims: number,
): { path: [number, number][]; cost: number } {
  const n = seq.frames
  const m = ref.frames
  const stride = seq.dim ?? FEATURE_DIM
  const cost = new Float64Array(n * m)
  const step = new Uint8Array(n * m)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      let s = 0
      for (let d = 0; d < dims; d++) {
        const x = seq.data[i * stride + d] - ref.data[j * stride + d]
        s += x * x
      }
      const d = Math.sqrt(s)
      if (i === 0 && j === 0) {
        cost[0] = d
        continue
      }
      let best = Infinity
      let dir = 0
      if (i > 0 && j > 0 && cost[(i - 1) * m + j - 1] < best) [best, dir] = [cost[(i - 1) * m + j - 1], 0]
      if (i > 0 && cost[(i - 1) * m + j] < best) [best, dir] = [cost[(i - 1) * m + j], 1]
      if (j > 0 && cost[i * m + j - 1] < best) [best, dir] = [cost[i * m + j - 1], 2]
      cost[i * m + j] = best + d
      step[i * m + j] = dir
    }
  }
  const path: [number, number][] = []
  let i = n - 1
  let j = m - 1
  for (;;) {
    path.push([i, j])
    if (i === 0 && j === 0) break
    const dir = step[i * m + j]
    if (dir === 0) {
      i--
      j--
    } else if (dir === 1) i--
    else j--
  }
  return { path, cost: cost[n * m - 1] / path.length }
}

/** A take as it was done, and mirrored (projected after mirroring); whichever lines up with the reference is used. */
export interface Sided {
  seq: FeatureSequence
  mirrored: FeatureSequence
}

function alignEitherHand(s: Sided, ref: FeatureSequence, dims: number) {
  const a = align(s.seq, ref, dims)
  const b = align(s.mirrored, ref, dims)
  return a.cost <= b.cost ? { seq: s.seq, path: a.path } : { seq: s.mirrored, path: b.path }
}

export interface WeightInput {
  /** The move's own takes, projected; the first is the move's most typical take (its medoid). */
  takes: Sided[]
  /** Other moves' takes closest to this move, projected. */
  impostors: Sided[]
}

/** Per-value weights for one move, or null when there is too little to learn from. */
export function fitWeights({ takes, impostors }: WeightInput): Weights | null {
  if (takes.length < 2 || !impostors.length) return null
  const ref = takes[0].seq
  const stride = ref.dim ?? FEATURE_DIM
  const handDim = ref.handDim ?? HAND_DIM
  // Card values only count when every take of the move has cards; otherwise they stay at 1.
  const withCards = takes.every((t) => t.seq.hasCards)
  const dims = withCards ? stride : handDim
  const m = ref.frames

  // The move's mean path: each take aligned to the medoid, averaged frame by frame.
  const aligned = takes.map((t) => alignEitherHand(t, ref, handDim))
  const mean = new Float64Array(m * stride)
  const count = new Float64Array(m)
  for (const { seq, path } of aligned) {
    for (const [i, j] of path) {
      for (let d = 0; d < dims; d++) mean[j * stride + d] += seq.data[i * stride + d]
      count[j]++
    }
  }
  for (let j = 0; j < m; j++) for (let d = 0; d < dims; d++) mean[j * stride + d] /= count[j] || 1

  // Spread around the mean path: within the move, and for each look-alike.
  const spread = (seq: FeatureSequence, path: [number, number][]) => {
    const out = new Float64Array(dims)
    for (const [i, j] of path) {
      for (let d = 0; d < dims; d++) {
        const x = seq.data[i * stride + d] - mean[j * stride + d]
        out[d] += x * x
      }
    }
    for (let d = 0; d < dims; d++) out[d] /= path.length
    return out
  }
  const within = new Float64Array(dims)
  for (const { seq, path } of aligned) spread(seq, path).forEach((v, d) => (within[d] += v / takes.length))
  const between = new Float64Array(dims)
  for (const imp of impostors) {
    const { seq, path } = alignEitherHand(imp, ref, handDim)
    spread(seq, path).forEach((v, d) => (between[d] += v / impostors.length))
  }

  // A value's weight: how much further look-alikes stray on it than the move's own takes do.
  const floor = within.reduce((s, v) => s + v, 0) / dims / 10 + 1e-9
  const keep = shrink(takes.length)
  const w = new Float32Array(stride).fill(1)
  for (let d = 0; d < dims; d++) {
    const raw = Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Math.sqrt(between[d] / (within[d] + floor))))
    w[d] = 1 + (raw - 1) * keep
  }
  // Normalise over the hand values so the overall distance scale stays put (card values are scaled with them).
  let sq = 0
  for (let d = 0; d < handDim; d++) sq += w[d] * w[d]
  const norm = Math.sqrt(handDim / sq)
  for (let d = 0; d < dims; d++) w[d] *= norm
  return w
}

/** The sequence with each value scaled by its weight, so plain distances become weighted ones. */
export function applyWeights(seq: FeatureSequence, w: Weights | null | undefined): FeatureSequence {
  if (!w) return seq
  const stride = seq.dim ?? FEATURE_DIM
  const data = new Float32Array(seq.data.length)
  for (let f = 0; f < seq.frames; f++)
    for (let d = 0; d < stride; d++) data[f * stride + d] = seq.data[f * stride + d] * w[d]
  return { ...seq, data }
}
