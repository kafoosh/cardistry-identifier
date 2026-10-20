import { CARD_DIM, FEATURE_DIM, HAND_DIM, type FeatureSequence } from './features'

/**
 * Matching cost grows with the number of values per frame, and the 126 hand
 * values move together (fingers bend as units), so a few directions carry
 * nearly all of the variation. The hand part is projected onto those
 * directions (principal components of the takes' frames), which keeps
 * distances nearly unchanged at a fraction of the cost; the card part is kept
 * as it is.
 */
export type Project = (seq: FeatureSequence) => FeatureSequence

/** Keep enough components for this share of the hand variation. */
const VARIANCE_KEPT = 0.98
const MIN_COMPONENTS = 12
const MAX_COMPONENTS = 40
/** Frames sampled for fitting; plenty for a 126-value covariance. */
const MAX_SAMPLES = 6000

export const identity: Project = (seq) => seq

/** Eigen-decomposition of a symmetric matrix (cyclic Jacobi). Returns eigenvalues and eigenvectors as rows. */
function symmetricEigen(a: Float64Array, n: number): { values: Float64Array; vectors: Float64Array } {
  const v = new Float64Array(n * n)
  for (let i = 0; i < n; i++) v[i * n + i] = 1
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] * a[p * n + q]
    if (off < 1e-18) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]
        if (Math.abs(apq) < 1e-15) continue
        const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p]
          const akq = a[k * n + q]
          a[k * n + p] = c * akp - s * akq
          a[k * n + q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k]
          const aqk = a[q * n + k]
          a[p * n + k] = c * apk - s * aqk
          a[q * n + k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vpk = v[p * n + k]
          const vqk = v[q * n + k]
          v[p * n + k] = c * vpk - s * vqk
          v[q * n + k] = s * vpk + c * vqk
        }
      }
    }
  }
  const values = new Float64Array(n)
  for (let i = 0; i < n; i++) values[i] = a[i * n + i]
  return { values, vectors: v }
}

/**
 * Fits the projection on the given sequences (mirrored copies included by
 * the caller, so either hand is covered). Falls back to no projection when
 * there is too little data to fit.
 */
export function fitProjection(seqs: FeatureSequence[]): Project {
  const total = seqs.reduce((s, q) => s + q.frames, 0)
  if (total < HAND_DIM * 2) return identity
  const step = Math.max(1, Math.ceil(total / MAX_SAMPLES))
  const n = HAND_DIM
  const mean = new Float64Array(n)
  const cov = new Float64Array(n * n)
  let count = 0
  let k = 0
  for (const q of seqs) {
    for (let f = 0; f < q.frames; f++, k++) {
      if (k % step) continue
      const o = f * FEATURE_DIM
      for (let i = 0; i < n; i++) mean[i] += q.data[o + i]
      for (let i = 0; i < n; i++) {
        const x = q.data[o + i]
        for (let j = i; j < n; j++) cov[i * n + j] += x * q.data[o + j]
      }
      count++
    }
  }
  for (let i = 0; i < n; i++) mean[i] /= count
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const c = cov[i * n + j] / count - mean[i] * mean[j]
      cov[i * n + j] = c
      cov[j * n + i] = c
    }
  }
  const { values, vectors } = symmetricEigen(cov, n)
  const order = [...values.keys()].sort((a, b) => values[b] - values[a])
  const sum = values.reduce((s, x) => s + Math.max(0, x), 0)
  if (sum <= 0) return identity
  let kept = 0
  let acc = 0
  while (kept < MAX_COMPONENTS && (kept < MIN_COMPONENTS || acc < sum * VARIANCE_KEPT))
    acc += Math.max(0, values[order[kept++]])
  const basis = new Float32Array(kept * n)
  order.slice(0, kept).forEach((r, c) => basis.set(vectors.subarray(r * n, r * n + n), c * n))
  const dim = kept + CARD_DIM

  return (seq) => {
    const data = new Float32Array(seq.frames * dim)
    for (let f = 0; f < seq.frames; f++) {
      const o = f * FEATURE_DIM
      const p = f * dim
      for (let c = 0; c < kept; c++) {
        let s = 0
        const b = c * n
        for (let i = 0; i < n; i++) s += seq.data[o + i] * basis[b + i]
        data[p + c] = s
      }
      for (let i = 0; i < CARD_DIM; i++) data[p + kept + i] = seq.data[o + HAND_DIM + i]
    }
    return { ...seq, data, dim, handDim: kept }
  }
}
