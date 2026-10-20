import { FEATURE_DIM, HAND_DIM, type FeatureSequence } from './features'

/**
 * When only one side has card data, the card part can't be compared; the
 * hand part is scaled up a little instead, so card-aware comparisons aren't
 * unfairly penalised next to hands-only ones: a matching card track is
 * worth more than the card part it adds to the distance.
 */
const NO_CARDS_FACTOR = 1.35

function frameDist(
  a: Float32Array,
  i: number,
  b: Float32Array,
  j: number,
  stride: number,
  dims: number,
  withCards: boolean,
): number {
  let s = 0
  const oa = i * stride
  const ob = j * stride
  for (let d = 0; d < dims; d++) {
    const x = a[oa + d] - b[ob + d]
    s += x * x
  }
  return withCards ? Math.sqrt(s) : Math.sqrt(s) * NO_CARDS_FACTOR
}

/** Whether two sequences can be compared on cards as well as hands. */
export const bothHaveCards = (a: FeatureSequence, b: FeatureSequence) => a.hasCards && b.hasCards

export interface SubsequenceMatch {
  distance: number
  /** Query frame index where the match starts; it always ends at the last query frame. */
  start: number
}

/**
 * Subsequence DTW: finds where the template best matches the query when the
 * match must end at the query's last frame but may start anywhere. This is
 * what live identification needs ("did that move just finish?"). Matches
 * spanning less than three quarters or more than 1.8× the template's length are
 * never considered, so a single pose can't match a whole move: starts too
 * late are not allowed, and query frames before the longest allowed span are
 * skipped (on a long live window that is most of the work).
 */
const MIN_SPAN = 0.75
const MAX_SPAN = 1.8
export function subsequenceDtw(query: FeatureSequence, template: FeatureSequence): SubsequenceMatch {
  const n = query.frames
  const m = template.frames
  const withCards = bothHaveCards(query, template)
  const stride = query.dim ?? FEATURE_DIM
  if ((template.dim ?? FEATURE_DIM) !== stride) throw new Error('Sequences encoded differently')
  const dims = withCards ? stride : (query.handDim ?? HAND_DIM)
  let prev = new Float64Array(m)
  let prevLen = new Float64Array(m)
  let prevStart = new Int32Array(m)
  let cur = new Float64Array(m)
  let curLen = new Float64Array(m)
  let curStart = new Int32Array(m)
  const first = Math.max(0, n - Math.floor(m * MAX_SPAN))
  // Latest start that still leaves the match most of the template's time.
  // Without it the cheapest path squeezes the whole template onto the last
  // few frames, fails the span check, and a move that did play out scores
  // nothing at all.
  const lastStart = n - Math.ceil(m * MIN_SPAN)
  for (let i = first; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const d = frameDist(query.data, i, template.data, j, stride, dims, withCards)
      if (j === 0) {
        // Free start anywhere early enough; later, keep holding the template's first frame.
        if (i <= lastStart || i === first) {
          cur[0] = d
          curLen[0] = 1
          curStart[0] = i
        } else {
          cur[0] = prev[0] + d
          curLen[0] = prevLen[0] + 1
          curStart[0] = prevStart[0]
        }
        continue
      }
      let best = cur[j - 1]
      let len = curLen[j - 1]
      let start = curStart[j - 1]
      if (i > first) {
        if (prev[j - 1] <= best) {
          best = prev[j - 1]
          len = prevLen[j - 1]
          start = prevStart[j - 1]
        }
        if (prev[j] < best) {
          best = prev[j]
          len = prevLen[j]
          start = prevStart[j]
        }
      }
      cur[j] = best + d
      curLen[j] = len + 1
      curStart[j] = start
    }
    ;[prev, cur] = [cur, prev]
    ;[prevLen, curLen] = [curLen, prevLen]
    ;[prevStart, curStart] = [curStart, prevStart]
  }
  const start = prevStart[m - 1]
  const span = n - start
  // A match must have taken most of the template's time: a fast fragment of a move isn't the move.
  if (span < m * MIN_SPAN || span > m * MAX_SPAN) return { distance: Infinity, start }
  return { distance: prev[m - 1] / prevLen[m - 1], start }
}
