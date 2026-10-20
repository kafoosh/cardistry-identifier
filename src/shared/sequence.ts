// Wire format for a shared recording's landmark sequence. Shared by the app
// (encode before upload, decode on replay) and the API (validate on upload).
// Kept dependency-free so both bundles can import it.

/** [slot 0|1, handedness 0 = Left / 1 = Right, score, ...21 × (x, y, z)] */
export type WireHand = [number, number, number, ...number[]]
/** [id, hand slot (-1 when loose), cx, cy, angle, length, width, skew] */
export type WirePacket = [number, number, number, number, number, number, number, number]
/** [id, hand slot (-1 when loose), hx, hy, from, to, radius] */
export type WireFan = [number, number, number, number, number, number, number]
/**
 * [t in ms, hands] or, when cards were tracked, [t in ms, hands, [packets, fans]].
 * Readers that predate cards ignore the third element.
 */
export type WireFrame = [number, WireHand[]] | [number, WireHand[], [WirePacket[], WireFan[]]]

export interface WireSequence {
  v: 1
  frames: WireFrame[]
}

export const LANDMARKS = 21
export const MAX_DURATION_MS = 11_000
export const MAX_FRAMES = 700
export const MIN_FRAMES = 10
const MAX_PACKETS = 8
const MAX_FANS = 4

interface HandLike {
  slot: 0 | 1
  handedness: 'Left' | 'Right'
  score: number
  landmarks: [number, number, number][]
}
interface PacketLike {
  id: number
  cx: number
  cy: number
  angle: number
  length: number
  width: number
  skew?: number
  hand: 0 | 1 | null
}
interface FanLike {
  id: number
  hx: number
  hy: number
  from: number
  to: number
  radius: number
  hand: 0 | 1 | null
}
interface FrameLike {
  t: number
  hands: HandLike[]
  cards?: PacketLike[]
  fans?: FanLike[]
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4

const wireSlot = (hand: 0 | 1 | null) => (hand === null ? -1 : hand)
const TAU = Math.PI * 2
/** Angle in [0, period), so tracked angles that have wound round still validate. */
const wrap = (a: number, period: number) => ((a % period) + period) % period
const readSlot = (n: number) => (n === -1 ? null : (n as 0 | 1))

export function encodeSequence(frames: FrameLike[]): WireSequence {
  return {
    v: 1,
    frames: frames.map((f) => {
      const hands = f.hands.map((h) => [
        h.slot,
        h.handedness === 'Left' ? 0 : 1,
        Math.round(h.score * 1000) / 1000,
        ...h.landmarks.flatMap((p) => [r4(p[0]), r4(p[1]), r4(p[2])]),
      ]) as WireHand[]
      // Frames from a take without card tracking carry no card element at all, so
      // matching can tell "no cards tracked" from "tracked, none in view".
      if (f.cards === undefined && f.fans === undefined) return [Math.round(f.t), hands]
      const packets = (f.cards ?? [])
        .slice(0, MAX_PACKETS)
        // A packet looks the same turned half a turn, so its angle wraps at pi.
        .map(
          (p): WirePacket => [
            p.id,
            wireSlot(p.hand),
            r4(p.cx),
            r4(p.cy),
            r4(wrap(p.angle, Math.PI)),
            r4(p.length),
            r4(p.width),
            r4(p.skew ?? 0),
          ],
        )
      const fans = (f.fans ?? []).slice(0, MAX_FANS).map((q): WireFan => {
        const from = wrap(q.from, TAU)
        return [q.id, wireSlot(q.hand), r4(q.hx), r4(q.hy), r4(from), r4(from + wrap(q.to - q.from, TAU)), r4(q.radius)]
      })
      return [Math.round(f.t), hands, [packets, fans]]
    }),
  }
}

export function decodeSequence(seq: WireSequence): FrameLike[] {
  return seq.frames.map(([t, hands, cards]) => {
    const frame: FrameLike = {
      t,
      hands: hands.map((h) => {
        const landmarks: [number, number, number][] = []
        for (let i = 0; i < LANDMARKS; i++) landmarks.push([h[3 + i * 3], h[4 + i * 3], h[5 + i * 3]])
        return {
          slot: h[0] as 0 | 1,
          handedness: h[1] === 0 ? 'Left' : 'Right',
          score: h[2],
          landmarks,
        }
      }),
    }
    if (cards) {
      frame.cards = cards[0].map(([id, hand, cx, cy, angle, length, width, skew]) => ({
        id,
        hand: readSlot(hand),
        cx,
        cy,
        angle,
        length,
        width,
        ...(skew ? { skew } : {}),
      }))
      frame.fans = cards[1].map(([id, hand, hx, hy, from, to, radius]) => ({
        id,
        hand: readSlot(hand),
        hx,
        hy,
        from,
        to,
        radius,
      }))
    }
    return frame
  })
}

const finiteIn = (n: unknown, lo: number, hi: number) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi

const validSlot = (n: unknown) => n === -1 || n === 0 || n === 1

/** Packets and fans of one frame: ids, slots, positions near the frame, angles and sizes in sane ranges. */
function validateCards(cards: unknown): string | null {
  if (!Array.isArray(cards) || cards.length !== 2) return 'bad cards'
  const [packets, fans] = cards as unknown[]
  if (!Array.isArray(packets) || packets.length > MAX_PACKETS) return 'bad packets'
  if (!Array.isArray(fans) || fans.length > MAX_FANS) return 'bad fans'
  for (const p of packets) {
    if (!Array.isArray(p) || p.length !== 8) return 'bad packet'
    const [id, hand, cx, cy, angle, length, width, skew] = p
    if (!Number.isInteger(id) || !validSlot(hand)) return 'bad packet'
    if (!finiteIn(cx, -1, 2) || !finiteIn(cy, -1, 2) || !finiteIn(angle, 0, 4) || !finiteIn(skew, -2, 2))
      return 'packet out of range'
    if (!finiteIn(length, 0, 3) || !finiteIn(width, 0, 3)) return 'packet out of range'
  }
  for (const q of fans) {
    if (!Array.isArray(q) || q.length !== 7) return 'bad fan'
    const [id, hand, hx, hy, from, to, radius] = q
    if (!Number.isInteger(id) || !validSlot(hand)) return 'bad fan'
    if (!finiteIn(hx, -1, 2) || !finiteIn(hy, -1, 2) || !finiteIn(from, 0, 7) || !finiteIn(to, 0, 13)) return 'fan out of range'
    if (!finiteIn(radius, 0, 3)) return 'fan out of range'
  }
  return null
}

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
    if (!Array.isArray(f) || (f.length !== 2 && f.length !== 3)) return 'bad frame'
    const [t, hands, cards] = f
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
    if (f.length === 3) {
      const err = validateCards(cards)
      if (err) return err
    }
  }
  if (withHands < MIN_FRAMES) return 'too few frames with hands'
  return null
}
