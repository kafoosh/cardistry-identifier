import type { CalibrationState } from './cardTracker'
import type { TrackedHand } from '../tracking/types'
import type { Fan, Packet } from './types'

/** What the tracking loop and the app need from card tracking, whether it runs here or in a worker. */
export interface CardTracking {
  borderless: boolean
  calibration: CalibrationState
  fans: Fan[]
  /** Last processing time on this thread, ms. */
  ms: number
  readonly ready: boolean
  readonly hasDeck: boolean
  readonly isCalibrating: boolean
  startCalibration(): void
  stopCalibration(): void
  process(video: HTMLVideoElement, hands: TrackedHand[]): Packet[]
}
