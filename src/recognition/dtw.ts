import { FEATURE_DIM, type FeatureSequence } from './features'

function frameDist(a: Float32Array, i: number, b: Float32Array, j: number): number {
  let s = 0
  const oa = i * FEATURE_DIM
  const ob = j * FEATURE_DIM
  for (let d = 0; d < FEATURE_DIM; d++) {
    const x = a[oa + d] - b[ob + d]
    s += x * x
  }
  return Math.sqrt(s)
}

/**
 * Dynamic Time Warping distance between two whole sequences, with a
 * Sakoe-Chiba band, normalised by the warping path length so short and
 * long moves compare fairly.
 */
export function dtw(a: FeatureSequence, b: FeatureSequence, bandRatio = 0.4): number {
  const n = a.frames
  const m = b.frames
  const band = Math.max(Math.ceil(Math.max(n, m) * bandRatio), Math.abs(n - m) + 1)
  let prev = new Float64Array(m).fill(Infinity)
  let prevLen = new Float64Array(m)
  let cur = new Float64Array(m)
  let curLen = new Float64Array(m)
  for (let i = 0; i < n; i++) {
    cur.fill(Infinity)
    const centre = Math.round((i * (m - 1)) / Math.max(1, n - 1))
    const lo = Math.max(0, centre - band)
    const hi = Math.min(m - 1, centre + band)
    for (let j = lo; j <= hi; j++) {
      const d = frameDist(a.data, i, b.data, j)
      if (i === 0 && j === 0) {
        cur[j] = d
        curLen[j] = 1
        continue
      }
      let best = Infinity
      let len = 0
      if (i > 0 && j > 0 && prev[j - 1] < best) {
        best = prev[j - 1]
        len = prevLen[j - 1]
      }
      if (i > 0 && prev[j] < best) {
        best = prev[j]
        len = prevLen[j]
      }
      if (j > 0 && cur[j - 1] < best) {
        best = cur[j - 1]
        len = curLen[j - 1]
      }
      cur[j] = best + d
      curLen[j] = len + 1
    }
    ;[prev, cur] = [cur, prev]
    ;[prevLen, curLen] = [curLen, prevLen]
  }
  return prev[m - 1] / prevLen[m - 1]
}

export interface SubsequenceMatch {
  distance: number
  /** Query frame index where the match starts; it always ends at the last query frame. */
  start: number
}

/**
 * Subsequence DTW: finds where the template best matches the query when the
 * match must end at the query's last frame but may start anywhere. This is
 * what live identification needs ("did that move just finish?"). Matches
 * spanning less than half or more than twice the template's length are
 * rejected, so a single pose can't match a whole move.
 */
export function subsequenceDtw(query: FeatureSequence, template: FeatureSequence): SubsequenceMatch {
  const n = query.frames
  const m = template.frames
  let prev = new Float64Array(m)
  let prevLen = new Float64Array(m)
  let prevStart = new Int32Array(m)
  let cur = new Float64Array(m)
  let curLen = new Float64Array(m)
  let curStart = new Int32Array(m)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const d = frameDist(query.data, i, template.data, j)
      if (j === 0) {
        // Free start anywhere in the query.
        cur[0] = d
        curLen[0] = 1
        curStart[0] = i
        continue
      }
      let best = cur[j - 1]
      let len = curLen[j - 1]
      let start = curStart[j - 1]
      if (i > 0) {
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
  if (span < m * 0.5 || span > m * 2) return { distance: Infinity, start }
  return { distance: prev[m - 1] / prevLen[m - 1], start }
}
