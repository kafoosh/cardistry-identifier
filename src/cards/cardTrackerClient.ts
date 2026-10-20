import { CardTracker, WORK_W, type CalibrationState } from './cardTracker'
import type { CardTracking } from './cardTracking'
import { saveDeck, type DeckModel } from './deckModel'
import type { CardsRequest, CardsResult } from './cards.worker'
import type { TrackedHand } from '../tracking/types'
import type { Fan, Packet } from './types'

/**
 * Card tracking in a Web Worker, so the 20-40 ms of edge and shape work per
 * frame doesn't hold up hand tracking and the preview. This thread only
 * shrinks the frame to the working size and hands the pixels over; the
 * answer for a frame arrives a little later and is used until the next one.
 */
export class CardTrackerClient implements CardTracking {
  private worker: Worker
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private w = 0
  private h = 0
  private nextId = 1
  private inFlight = 0
  private packets: Packet[] = []
  private deck: DeckModel | null
  private calibrating = false
  private borderlessValue = false
  fans: Fan[] = []
  /** Time this thread spends per frame: shrinking it and handing it over. */
  ms = 0
  /** The worker's processing time for the last frame, ms. */
  workerMs = 0
  calibration: CalibrationState = { phase: 'waiting', progress: 0, hint: '' }

  constructor(deck: DeckModel | null) {
    this.deck = deck
    this.worker = new Worker(new URL('./cards.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<CardsResult>) => this.receive(e.data)
    this.post({ type: 'init', deck, borderless: this.borderlessValue })
  }

  private post(m: CardsRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(m, transfer)
  }

  private receive(r: CardsResult) {
    this.inFlight = 0
    // The deck just locked in the worker.
    if (this.calibrating && !r.calibrating && r.calibration.phase === 'done') this.calibrating = false
    // A result from before the last calibration started or stopped describes the wrong state.
    else if (r.calibrating !== this.calibrating) return
    this.packets = r.packets
    this.fans = r.fans
    this.calibration = r.calibration
    if (r.deck && r.deck !== this.deck && JSON.stringify(r.deck) !== JSON.stringify(this.deck)) {
      this.deck = r.deck
      saveDeck(r.deck)
    }
    this.workerMs = r.ms
  }

  get borderless() {
    return this.borderlessValue
  }

  set borderless(v: boolean) {
    this.borderlessValue = v
    this.post({ type: 'borderless', value: v })
  }

  get ready() {
    return this.deck !== null && !this.calibrating
  }

  get hasDeck() {
    return this.deck !== null
  }

  get isCalibrating() {
    return this.calibrating
  }

  startCalibration() {
    this.calibrating = true
    this.packets = []
    this.fans = []
    this.calibration = { phase: 'waiting', progress: 0, hint: 'Hold your deck sideways in the box, back to the camera' }
    this.post({ type: 'startCalibration' })
  }

  stopCalibration() {
    this.calibrating = false
    this.post({ type: 'stopCalibration' })
  }

  /** Sends this frame to the worker when it is free, and returns the latest packets it has sent back. */
  process(video: HTMLVideoElement, hands: TrackedHand[]): Packet[] {
    if (!this.inFlight) {
      const t0 = performance.now()
      const px = this.grab(video)
      this.ms = performance.now() - t0
      if (px) {
        const id = this.nextId++
        this.inFlight = id
        const buffer = px.buffer as ArrayBuffer
        this.post({ type: 'frame', id, px: buffer, w: this.w, h: this.h, hands }, [buffer])
      }
    }
    return this.packets
  }

  private grab(video: HTMLVideoElement): Uint8ClampedArray | null {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return null
    const w = WORK_W
    const h = Math.max(1, Math.round((WORK_W * vh) / vw))
    if (!this.canvas || !this.ctx) {
      this.canvas = document.createElement('canvas')
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
      if (!this.ctx) return null
    }
    if (w !== this.w || h !== this.h) {
      this.w = this.canvas.width = w
      this.h = this.canvas.height = h
    }
    this.ctx.drawImage(video, 0, 0, w, h)
    return this.ctx.getImageData(0, 0, w, h).data
  }
}

/** Card tracking in a worker where workers are available, otherwise on this thread. */
export function createCardTracking(deck: DeckModel | null): CardTracking {
  try {
    if (typeof Worker !== 'undefined') return new CardTrackerClient(deck)
  } catch (err) {
    console.warn('Card tracking worker unavailable, tracking on the main thread', err)
  }
  return new CardTracker(deck)
}
