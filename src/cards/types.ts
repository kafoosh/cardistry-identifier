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
  /**
   * How far the short sides lean off square, in radians, when the packet is tilted towards or away
   * from the camera (its face then looks like a parallelogram). Absent when square.
   */
  skew?: number
  /** Which hand slot holds it (nearest hand), or null when it isn't near either. */
  hand: 0 | 1 | null
}

/**
 * A spread of cards fanned around a hinge (where the thumb holds the
 * corners), in the same normalised image space as a Packet.
 */
export interface Fan {
  id: number
  /** The hinge, in 0..1 of the frame's width and height. */
  hx: number
  hy: number
  /** The sector the cards sweep, in pixel-space radians, counter-clockwise from `from` to `to`. */
  from: number
  to: number
  /** How far the cards reach from the hinge, as a share of the frame height. */
  radius: number
  hand: 0 | 1 | null
}
