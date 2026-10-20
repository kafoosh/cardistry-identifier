/**
 * One packet of cards seen in a frame, in the same raw (unmirrored)
 * normalised image space as the hand landmarks: x and y in 0..1 of the
 * frame's width and height.
 */
export interface Packet {
  /** Stable across frames while the packet stays in view. */
  id: number
  cx: number
  cy: number
  /** Long axis direction in radians, measured in pixel space (a packet looks the same turned 180°). */
  angle: number
  /** Long and short side, as a share of the frame height. */
  length: number
  width: number
  /** Which hand slot holds it (nearest hand), or null when it isn't near either. */
  hand: 0 | 1 | null
}
