// Wire format for a shared recording's landmark sequence. Shared by the app
// (encode before upload, decode on replay) and the API (validate on upload).
// Kept dependency-free so both bundles can import it.

/** [slot 0|1, handedness 0 = Left / 1 = Right, score, ...21 × (x, y, z)] */
export type WireHand = [number, number, number, ...number[]]
/** [t in ms, hands] */
export type WireFrame = [number, WireHand[]]

export interface WireSequence {
  v: 1
  frames: WireFrame[]
}

export const LANDMARKS = 21
export const MAX_DURATION_MS = 11_000
export const MAX_FRAMES = 700
export const MIN_FRAMES = 10

interface HandLike {
  slot: 0 | 1
  handedness: 'Left' | 'Right'
  score: number
  landmarks: [number, number, number][]
}
interface FrameLike {
  t: number
  hands: HandLike[]
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4

export function encodeSequence(frames: FrameLike[]): WireSequence {
  return {
    v: 1,
    frames: frames.map((f) => [
      Math.round(f.t),
      f.hands.map((h) => [
        h.slot,
        h.handedness === 'Left' ? 0 : 1,
        Math.round(h.score * 1000) / 1000,
        ...h.landmarks.flatMap((p) => [r4(p[0]), r4(p[1]), r4(p[2])]),
      ]) as WireHand[],
    ]),
  }
}

export function decodeSequence(seq: WireSequence): FrameLike[] {
  return seq.frames.map(([t, hands]) => ({
    t,
    hands: hands.map((h) => {
      const landmarks: [number, number, number][] = []
      for (let i = 0; i < LANDMARKS; i++) landmarks.push([h[3 + i * 3], h[4 + i * 3], h[5 + i * 3]])
      return { slot: h[0] as 0 | 1, handedness: h[1] === 0 ? 'Left' : 'Right', score: h[2], landmarks }
    }),
  }))
}

const finiteIn = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi

/** Returns an error message, or null if the sequence is well formed and within limits. */
export function validateSequence(seq: unknown): string | null {
  if (!seq || typeof seq !== 'object') return 'sequence missing'
  const s = seq as Partial<WireSequence>
  if (s.v !== 1) return 'unsupported sequence version'
  if (!Array.isArray(s.frames)) return 'frames missing'
  if (s.frames.length < MIN_FRAMES) return 'recording too short'
  if (s.frames.length > MAX_FRAMES) return 'too many frames'
  let lastT = -1
  let withHands = 0
  for (const f of s.frames) {
    if (!Array.isArray(f) || f.length !== 2) return 'bad frame'
    const [t, hands] = f
    if (!finiteIn(t, 0, MAX_DURATION_MS) || t <= lastT) return 'frame times must increase and stay under 11 s'
    lastT = t
    if (!Array.isArray(hands) || hands.length > 2) return 'bad hands'
    if (hands.length) withHands++
    const slots = new Set<number>()
    for (const h of hands) {
      if (!Array.isArray(h) || h.length !== 3 + LANDMARKS * 3) return 'bad hand'
      if (h[0] !== 0 && h[0] !== 1) return 'bad hand slot'
      if (slots.has(h[0])) return 'duplicate hand slot'
      slots.add(h[0])
      if (h[1] !== 0 && h[1] !== 1) return 'bad handedness'
      if (!finiteIn(h[2], 0, 1)) return 'bad score'
      for (let i = 3; i < h.length; i++) if (!finiteIn(h[i], -3, 4)) return 'landmark out of range'
    }
  }
  if (withHands < MIN_FRAMES) return 'too few frames with hands'
  return null
}
