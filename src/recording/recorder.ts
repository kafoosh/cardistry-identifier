import type { TrackingLoop } from '../tracking/trackingLoop'
import type { Frame } from '../tracking/types'

export const MAX_RECORDING_MS = 10_000

export interface Capture {
  frames: Frame[]
  durationMs: number
  video: Blob | null
}

function pickVideoMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const type of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(type)) return type
  }
  return undefined
}

export const canRecordVideo = () => pickVideoMime() !== undefined

/**
 * Captures landmark frames from the tracking loop, and optionally a video
 * clip of the same stream. Frame times are rebased so the first captured
 * frame is t = 0. Stops on its own at MAX_RECORDING_MS.
 */
export class Recorder {
  private frames: Frame[] = []
  private t0: number | null = null
  private unsubscribe: (() => void) | null = null
  private media: MediaRecorder | null = null
  private chunks: Blob[] = []
  private resolveStop: ((c: Capture) => void) | null = null
  private timer = 0

  private loop: TrackingLoop
  private stream: MediaStream
  private onAutoStop: () => void

  constructor(loop: TrackingLoop, stream: MediaStream, onAutoStop: () => void) {
    this.loop = loop
    this.stream = stream
    this.onAutoStop = onAutoStop
  }

  get elapsedMs() {
    const n = this.frames.length
    return n ? this.frames[n - 1].t : 0
  }

  start(withVideo: boolean) {
    this.frames = []
    this.t0 = null
    this.unsubscribe = this.loop.onFrame((f) => {
      if (this.t0 === null) this.t0 = f.t
      const t = f.t - this.t0
      this.frames.push({ t, hands: f.hands })
      if (t >= MAX_RECORDING_MS) this.onAutoStop()
    })
    const mimeType = withVideo ? pickVideoMime() : undefined
    if (mimeType) {
      this.chunks = []
      this.media = new MediaRecorder(this.stream, { mimeType, videoBitsPerSecond: 2_500_000 })
      this.media.ondataavailable = (e) => e.data.size && this.chunks.push(e.data)
      this.media.start()
    }
    // Safety net in case frames stop arriving (camera froze, tab hidden).
    this.timer = window.setTimeout(() => this.onAutoStop(), MAX_RECORDING_MS + 2000)
  }

  stop(): Promise<Capture> {
    clearTimeout(this.timer)
    this.unsubscribe?.()
    this.unsubscribe = null
    const frames = this.frames
    const durationMs = frames.length ? frames[frames.length - 1].t : 0
    const media = this.media
    this.media = null
    if (!media || media.state === 'inactive') return Promise.resolve({ frames, durationMs, video: null })
    return new Promise((resolve) => {
      this.resolveStop = resolve
      media.onstop = () => {
        const video = this.chunks.length ? new Blob(this.chunks, { type: media.mimeType }) : null
        this.resolveStop?.({ frames, durationMs, video })
        this.resolveStop = null
      }
      media.stop()
    })
  }

  cancel() {
    clearTimeout(this.timer)
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.media && this.media.state !== 'inactive') this.media.stop()
    this.media = null
  }
}

/** Share of frames with a hand found, weighted by mean confidence. */
export function qualityScore(frames: Frame[]): number {
  if (!frames.length) return 0
  let withHand = 0
  let score = 0
  let n = 0
  for (const f of frames) {
    if (f.hands.length) withHand++
    for (const h of f.hands) {
      score += h.score
      n++
    }
  }
  return (withHand / frames.length) * (n ? score / n : 0)
}

/**
 * Longest time a hand was lost mid-recording (missing between two frames
 * where it was tracked), in ms. Short gaps get interpolated before
 * recognition; long ones mean the cards hid the hand for too long.
 */
export function longestGapMs(frames: Frame[]): number {
  let longest = 0
  for (const slot of [0, 1] as const) {
    let lastSeen: number | null = null
    for (const f of frames) {
      if (f.hands.some((h) => h.slot === slot)) {
        if (lastSeen !== null) longest = Math.max(longest, f.t - lastSeen)
        lastSeen = f.t
      }
    }
  }
  // A gap between consecutive frames is just the frame interval, not a drop.
  const interval = frames.length > 1 ? (frames[frames.length - 1].t - frames[0].t) / (frames.length - 1) : 0
  return longest > interval * 1.5 ? longest : 0
}

export function describeDevice(): string {
  const ua = navigator.userAgent
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other'
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Other'
  return `${os} ${browser}`
}
