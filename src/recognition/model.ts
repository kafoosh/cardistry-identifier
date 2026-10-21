import { TakeSet, type Calibration } from './calibration'
import type { FeatureSequence } from './features'
import { projectWith, type Project } from './projection'
import type { Template } from './recognizer'
import { applyWeights, type Weights } from './weights'

/**
 * Everything live matching needs, built once from a set of takes: the
 * projection, each move's weights and acceptance limit, and the takes
 * themselves already projected and weighted. Building it compares every take
 * with every other (seconds on a phone, growing with the square of the take
 * count), so the library's model is built on the server whenever the library
 * changes and Identify just loads it.
 */
export interface MatchModel {
  /** Bumped whenever the features or matching change, so older models are rebuilt rather than misread. */
  format: number
  /** Every take it was built from, outliers included. */
  takeIds: string[]
  basis: { kept: number; vectors: string } | null
  /** Per move: its weights. */
  weights: Record<string, string>
  /** Per move: the distance at which its strength reaches zero. */
  scale: Record<string, number>
  global: number
  /** Takes left out of matching. */
  outliers: string[]
  /** The takes used for matching, projected and weighted for their move. */
  templates: {
    id: string
    moveName: string
    hands: 1 | 2
    source: Template['source']
    frames: number
    durationMs: number
    hasCards: boolean
    dim?: number
    handDim?: number
    data: string
  }[]
}

export const MODEL_FORMAT = 1

/** Half-precision is plenty for features and halves the download. */
function toHalf(x: number): number {
  const f = new Float32Array([x])
  const u = new Uint32Array(f.buffer)[0]
  const sign = (u >>> 16) & 0x8000
  const exp = ((u >>> 23) & 0xff) - 127 + 15
  const mant = u & 0x7fffff
  if (exp <= 0) return sign
  if (exp >= 31) return sign | 0x7c00
  // Round to nearest.
  const h = sign | (exp << 10) | (mant >> 13)
  return mant & 0x1000 ? h + 1 : h
}

function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >> 10) & 0x1f
  const mant = h & 0x3ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 31) return mant ? NaN : sign * Infinity
  return sign * (1 + mant / 1024) * 2 ** (exp - 15)
}

function pack(values: Float32Array): string {
  const half = new Uint16Array(values.length)
  for (let i = 0; i < values.length; i++) half[i] = toHalf(values[i])
  const bytes = new Uint8Array(half.buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function unpack(text: string): Float32Array {
  const s = atob(text)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  const half = new Uint16Array(bytes.buffer)
  const out = new Float32Array(half.length)
  for (let i = 0; i < half.length; i++) out[i] = fromHalf(half[i])
  return out
}

/** Builds the model from takes (the slow part). */
export function buildModel(templates: Template[]): MatchModel {
  const takes = new TakeSet(templates)
  const cal = takes.calibrate()
  return {
    format: MODEL_FORMAT,
    takeIds: templates.map((t) => t.id),
    basis: takes.basis && { kept: takes.basis.kept, vectors: pack(takes.basis.vectors) },
    weights: Object.fromEntries([...takes.weights].map(([move, w]) => [move, pack(w)])),
    scale: Object.fromEntries(cal.scale),
    global: cal.global,
    outliers: [...takes.outliers].map((i) => templates[i].id),
    templates: takes.kept.map((t) => ({
      id: t.id,
      moveName: t.moveName,
      hands: t.hands,
      source: t.source,
      frames: t.features.frames,
      durationMs: t.features.durationMs,
      hasCards: t.features.hasCards,
      dim: t.features.dim,
      handDim: t.features.handDim,
      data: pack(t.features.data),
    })),
  }
}

export interface LoadedModel {
  templates: Template[]
  calibration: Calibration
  project: Project
  /** A live window encoded for one move: projected first, then weighted like that move's takes. */
  weigh: (seq: FeatureSequence, move: string) => FeatureSequence
}

/** Turns a model back into what the matcher runs on (fast). */
export function loadModel(model: MatchModel): LoadedModel {
  const weights = new Map<string, Weights>(Object.entries(model.weights).map(([move, w]) => [move, unpack(w)]))
  return {
    templates: model.templates.map(({ data, frames, durationMs, hasCards, dim, handDim, ...t }) => ({
      ...t,
      features: { data: unpack(data), frames, durationMs, hasCards, dim, handDim },
    })),
    calibration: { scale: new Map(Object.entries(model.scale)), global: model.global },
    project: projectWith(model.basis && { kept: model.basis.kept, vectors: unpack(model.basis.vectors) }),
    weigh: (seq, move) => applyWeights(seq, weights.get(move)),
  }
}
