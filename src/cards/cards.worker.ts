import { CardTracker, type CalibrationState } from './cardTracker'
import type { DeckModel } from './deckModel'
import type { TrackedHand } from '../tracking/types'
import type { Fan, Packet } from './types'

export type CardsRequest =
  | { type: 'init'; deck: DeckModel | null; borderless: boolean }
  | { type: 'frame'; id: number; px: ArrayBuffer; w: number; h: number; hands: TrackedHand[] }
  | { type: 'startCalibration' }
  | { type: 'stopCalibration' }
  | { type: 'borderless'; value: boolean }

export interface CardsResult {
  id: number
  packets: Packet[]
  fans: Fan[]
  calibration: CalibrationState
  calibrating: boolean
  deck: DeckModel | null
  ms: number
}

let tracker = new CardTracker(null)

self.onmessage = (e: MessageEvent<CardsRequest>) => {
  const m = e.data
  switch (m.type) {
    case 'init':
      tracker = new CardTracker(m.deck)
      tracker.borderless = m.borderless
      break
    case 'startCalibration':
      tracker.startCalibration()
      break
    case 'stopCalibration':
      tracker.stopCalibration()
      break
    case 'borderless':
      tracker.borderless = m.value
      break
    case 'frame': {
      const t0 = performance.now()
      const packets = tracker.processPixels(new Uint8ClampedArray(m.px), m.hands, m.w, m.h)
      const out: CardsResult = {
        id: m.id,
        packets,
        fans: tracker.fans,
        calibration: tracker.calibration,
        calibrating: tracker.isCalibrating,
        deck: tracker.deckModel,
        ms: performance.now() - t0,
      }
      self.postMessage(out)
      break
    }
  }
}
