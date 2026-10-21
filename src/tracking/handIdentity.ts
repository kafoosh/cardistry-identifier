import type { HandLandmarkerResult } from '@mediapipe/tasks-vision'
import type { Handedness, Point3, TrackedHand } from './types'

/** How long a slot remembers its last position after its hand disappears. */
const MEMORY_MS = 600
/**
 * Each slot keeps a running vote on its label (Left positive), built from
 * MediaPipe's label weighted by its confidence. Older evidence fades at this
 * rate per frame, and the vote is capped, so a label changes only after
 * several frames of confident evidence the other way.
 */
const VOTE_DECAY = 0.9
const VOTE_CAP = 4
/**
 * MediaPipe sometimes finds one hand twice: a second, partial skeleton laid
 * over the first one's fingers. A second hand with at least this share of
 * its landmarks sitting on the other hand's is that duplicate, not a hand.
 */
const DUPLICATE_SHARE = 0.5

interface SlotMemory {
  x: number
  y: number
  t: number
  vote: number
  /** Last smoothed landmarks, so the next frame's can be eased from them. */
  landmarks?: Point3[]
}

/** Eases landmarks towards each new frame: still hands stop shimmering, while a fast move follows at once. */
function smoothLandmarks(prev: Point3[] | undefined, next: Point3[]): Point3[] {
  if (!prev) return next
  let d = 0
  for (let i = 0; i < next.length; i++) d += Math.hypot(next[i][0] - prev[i][0], next[i][1] - prev[i][1])
  d /= next.length
  // Jitter moves a landmark a few thousandths of the frame; a deliberate move is several times that.
  const a = Math.min(1, 0.3 + d / 0.015)
  return next.map((p, i) => [
    prev[i][0] + (p[0] - prev[i][0]) * a,
    prev[i][1] + (p[1] - prev[i][1]) * a,
    prev[i][2] + (p[2] - prev[i][2]) * a,
  ])
}

/** Palm centre: mean of wrist and the four finger base knuckles. */
function palmCentre(lm: Point3[]): [number, number] {
  const ids = [0, 5, 9, 13, 17]
  let x = 0
  let y = 0
  for (const i of ids) {
    x += lm[i][0]
    y += lm[i][1]
  }
  return [x / ids.length, y / ids.length]
}

/** Whether one of two detections is the other hand found again; if so, which one to drop (the smaller, partial one). */
function duplicateOf(a: Point3[], b: Point3[]): 0 | 1 | null {
  const size = (lm: Point3[]) => Math.hypot(lm[9][0] - lm[0][0], lm[9][1] - lm[0][1])
  const [big, small] = size(a) >= size(b) ? [a, b] : [b, a]
  const reach = size(big) * 0.25
  let on = 0
  for (const p of small) if (big.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < reach)) on++
  if (on < small.length * DUPLICATE_SHARE) return null
  return small === a ? 0 : 1
}

function dist2(a: [number, number], b: SlotMemory) {
  return (a[0] - b.x) ** 2 + (a[1] - b.y) ** 2
}

/**
 * Keeps each hand in the same slot from frame to frame by position
 * continuity. MediaPipe's left/right label can flip when hands overlap
 * (common in cardistry), so the label is kept for display only and the
 * slot is what later stages use to follow a hand through a move. The label
 * is smoothed per slot, and two hands are never given the same one.
 */
export class HandIdentity {
  private slots: (SlotMemory | null)[] = [null, null]

  reset() {
    this.slots = [null, null]
  }

  assign(result: HandLandmarkerResult, t: number): TrackedHand[] {
    for (let s = 0; s < 2; s++) {
      const m = this.slots[s]
      if (m && t - m.t > MEMORY_MS) this.slots[s] = null
    }

    let raw = result.landmarks.map((lms, i) => {
      const cat = result.handedness[i]?.[0]
      // Checked on a raw (unmirrored) photo: the label names the person's own hand.
      const label: Handedness = cat?.categoryName === 'Left' ? 'Left' : 'Right'
      const landmarks: Point3[] = lms.map((p) => [p.x, p.y, p.z])
      return { landmarks, handedness: label, score: cat?.score ?? 0, centre: palmCentre(landmarks) }
    })
    if (raw.length === 2) {
      const drop = duplicateOf(raw[0].landmarks, raw[1].landmarks)
      if (drop !== null) raw = [raw[1 - drop]]
    }

    const slotsFor = this.match(
      raw.map((h) => h.centre),
      raw.map((h) => h.handedness),
    )
    const votes = raw.map((h, i) => {
      const prev = this.slots[slotsFor[i]]?.vote ?? 0
      const v = prev * VOTE_DECAY + (h.handedness === 'Left' ? h.score : -h.score)
      return Math.max(-VOTE_CAP, Math.min(VOTE_CAP, v))
    })
    const labels = this.label(
      votes,
      raw.map((h) => h.handedness),
      raw.map((h) => h.centre),
    )
    const hands: TrackedHand[] = raw.map((h, i) => ({
      slot: slotsFor[i],
      handedness: labels[i],
      score: h.score,
      landmarks: smoothLandmarks(this.slots[slotsFor[i]]?.landmarks, h.landmarks),
    }))
    hands.forEach((h, i) => {
      const c = palmCentre(h.landmarks)
      this.slots[h.slot] = { x: c[0], y: c[1], t, vote: votes[i], landmarks: h.landmarks }
    })
    return hands.sort((a, b) => a.slot - b.slot)
  }

  /**
   * Labels from the slots' votes rather than this frame's guess alone, so a
   * hand keeps its label through a frame where MediaPipe wavers. A person has
   * one hand of each, so two hands always get opposite labels: the hand whose
   * vote leans further to Left is the left one.
   */
  private label(votes: number[], raw: Handedness[], centres: [number, number][]): Handedness[] {
    const side = (v: number, fallback: Handedness): Handedness => (v > 0 ? 'Left' : v < 0 ? 'Right' : fallback)
    if (votes.length < 2) return votes.map((v, i) => side(v, raw[i]))
    if (votes[0] !== votes[1]) return votes[0] > votes[1] ? ['Left', 'Right'] : ['Right', 'Left']
    if (raw[0] !== raw[1]) return raw
    // No evidence either way: facing the camera, the person's left hand is on the right of the picture.
    return centres[0][0] >= centres[1][0] ? ['Left', 'Right'] : ['Right', 'Left']
  }

  private match(centres: [number, number][], labels: Handedness[]): (0 | 1)[] {
    const fallback = (l: Handedness): 0 | 1 => (l === 'Left' ? 0 : 1)
    const [m0, m1] = this.slots

    if (centres.length === 0) return []
    if (centres.length === 1) {
      const c = centres[0]
      if (m0 && m1) return [dist2(c, m0) <= dist2(c, m1) ? 0 : 1]
      if (m0) return [m0 && dist2(c, m0) < 0.04 ? 0 : 1]
      if (m1) return [m1 && dist2(c, m1) < 0.04 ? 1 : 0]
      return [fallback(labels[0])]
    }

    // Two hands: pick whichever of the two pairings moves the hands least.
    if (m0 || m1) {
      const cost = (a: [number, number], b: [number, number]) => (m0 ? dist2(a, m0) : 0) + (m1 ? dist2(b, m1) : 0)
      return cost(centres[0], centres[1]) <= cost(centres[1], centres[0]) ? [0, 1] : [1, 0]
    }
    // No history: trust the labels if they disagree, otherwise split by screen position.
    if (labels[0] !== labels[1]) return [fallback(labels[0]), fallback(labels[1])]
    return centres[0][0] >= centres[1][0] ? [0, 1] : [1, 0]
  }
}
