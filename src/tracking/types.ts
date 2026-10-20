import type { Fan, Packet } from '../cards/types'

/** One landmark in normalised image coordinates (x, y in 0..1, z relative depth). */
export type Point3 = [number, number, number]

export type Handedness = 'Left' | 'Right'

export interface TrackedHand {
  /** Stable slot (0 or 1) kept by position continuity, not by MediaPipe's label. */
  slot: 0 | 1
  /** MediaPipe's handedness guess (the performer's own hand). Can swap when hands overlap. */
  handedness: Handedness
  /** Handedness classifier confidence, 0..1. */
  score: number
  /** 21 landmarks, raw (never mirrored), normalised image coordinates. */
  landmarks: Point3[]
}

/** One captured frame. This is the unit the recorder (milestone 2) will store. */
export interface Frame {
  /** Milliseconds since the stream started. */
  t: number
  hands: TrackedHand[]
  /** Card packets, when card tracking ran on this frame (undefined: tracking off, or an older recording). */
  cards?: Packet[]
  /** Fanned spreads, when card tracking is on. */
  fans?: Fan[]
}

export type CameraFacing = 'user' | 'environment'
export type Delegate = 'GPU' | 'CPU'
