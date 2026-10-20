import type { HandLandmarker } from '@mediapipe/tasks-vision'
import type { CardTracker } from '../cards/cardTracker'
import type { Packet } from '../cards/types'
import { drawCards, drawHands } from './draw'
import { HandIdentity } from './handIdentity'
import { RollingStats } from './stats'
import type { Frame } from './types'

type FrameListener = (frame: Frame) => void

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number
  cancelVideoFrameCallback?: (id: number) => void
}

/**
 * Runs the landmarker on every new video frame, keeps hand slots stable,
 * draws the overlay and hands each frame to listeners (the recorder will
 * subscribe here in milestone 2). Lives outside React so a 30-60 fps loop
 * never triggers re-renders.
 */
export class TrackingLoop {
  readonly stats = new RollingStats()
  private identity = new HandIdentity()
  private listeners = new Set<FrameListener>()
  private running = false
  private handle = 0
  private startTime = 0
  private lastVideoTime = -1
  private lastTimestamp = 0
  private video: VideoWithRvfc
  private ctx: CanvasRenderingContext2D
  private landmarker: HandLandmarker
  /** Card tracking, when switched on. Runs every other frame; frames in between reuse the last packets. */
  cards: CardTracker | null = null
  showCards = true
  private cardTick = 0
  private lastPackets: Packet[] = []

  constructor(video: HTMLVideoElement, canvas: HTMLCanvasElement, landmarker: HandLandmarker) {
    this.video = video
    this.landmarker = landmarker
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D is not available')
    this.ctx = ctx
  }

  start() {
    if (this.running) return
    this.running = true
    this.startTime = performance.now()
    this.identity.reset()
    this.stats.reset()
    this.schedule()
  }

  stop() {
    this.running = false
    if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.handle)
    else cancelAnimationFrame(this.handle)
    this.ctx.clearRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height)
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private schedule() {
    if (!this.running) return
    if (this.video.requestVideoFrameCallback) {
      this.handle = this.video.requestVideoFrameCallback(() => this.tick())
    } else {
      this.handle = requestAnimationFrame(() => this.tick())
    }
  }

  private tick() {
    if (!this.running) return
    const v = this.video
    if (v.readyState >= 2 && v.videoWidth > 0 && v.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = v.currentTime
      const canvas = this.ctx.canvas
      if (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight) {
        canvas.width = v.videoWidth
        canvas.height = v.videoHeight
      }
      // detectForVideo needs strictly increasing timestamps.
      const now = Math.max(performance.now(), this.lastTimestamp + 1)
      this.lastTimestamp = now
      const t0 = performance.now()
      const result = this.landmarker.detectForVideo(v, now)
      const inferenceMs = performance.now() - t0
      const t = now - this.startTime
      const frame: Frame = { t, hands: this.identity.assign(result, t) }
      if (this.cards) {
        if (this.cardTick++ % 2 === 0 || !frame.hands.length) this.lastPackets = this.cards.process(v, frame.hands)
        frame.cards = this.lastPackets
      }
      drawHands(this.ctx, frame.hands)
      if (frame.cards && this.showCards) drawCards(this.ctx, frame.cards)
      this.stats.push(frame, inferenceMs)
      for (const l of this.listeners) l(frame)
    }
    this.schedule()
  }
}
