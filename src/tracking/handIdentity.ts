import type { HandLandmarkerResult } from '@mediapipe/tasks-vision'
import type { Handedness, Point3, TrackedHand } from './types'

/** How long a slot remembers its last position after its hand disappears. */
const MEMORY_MS = 600

interface SlotMemory {
  x: number
  y: number
  t: number
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

function dist2(a: [number, number], b: SlotMemory) {
  return (a[0] - b.x) ** 2 + (a[1] - b.y) ** 2
}

/**
 * Keeps each hand in the same slot from frame to frame by position
 * continuity. MediaPipe's left/right label can flip when hands overlap
 * (common in cardistry), so the label is kept for display only and the
 * slot is what later stages use to follow a hand through a move.
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

    const raw = result.landmarks.map((lms, i) => {
      const cat = result.handedness[i]?.[0]
      // Checked on a raw (unmirrored) photo: the label names the person's own hand.
      const label: Handedness = cat?.categoryName === 'Left' ? 'Left' : 'Right'
      const landmarks: Point3[] = lms.map((p) => [p.x, p.y, p.z])
      return { landmarks, handedness: label, score: cat?.score ?? 0, centre: palmCentre(landmarks) }
    })

    const slotsFor = this.match(raw.map((h) => h.centre), raw.map((h) => h.handedness))
    const hands: TrackedHand[] = raw.map((h, i) => ({
      slot: slotsFor[i],
      handedness: h.handedness,
      score: h.score,
      landmarks: h.landmarks,
    }))
    for (const h of raw.map((r, i) => ({ c: r.centre, slot: slotsFor[i] }))) {
      this.slots[h.slot] = { x: h.c[0], y: h.c[1], t }
    }
    return hands.sort((a, b) => a.slot - b.slot)
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
      const cost = (a: [number, number], b: [number, number]) =>
        (m0 ? dist2(a, m0) : 0) + (m1 ? dist2(b, m1) : 0)
      return cost(centres[0], centres[1]) <= cost(centres[1], centres[0]) ? [0, 1] : [1, 0]
    }
    // No history: trust the labels if they disagree, otherwise split by screen position.
    if (labels[0] !== labels[1]) return [fallback(labels[0]), fallback(labels[1])]
    return centres[0][0] >= centres[1][0] ? [0, 1] : [1, 0]
  }
}
