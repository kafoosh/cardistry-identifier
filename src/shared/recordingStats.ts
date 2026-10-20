// What the library records about a take, computed from the landmark data
// itself rather than trusted from the client. Shared by the API's upload path
// and the seeding script, so the two can't drift apart.
import type { WireSequence } from './sequence'

/** A take at or above this quality is listed straight away; below it waits for review. */
export const QUALITY_APPROVED = 0.6

export const CAMERA_VIEWS = new Set(['front', 'top-down', 'side'])
export const HANDEDNESS = new Set(['right-dominant', 'left-dominant'])
export const CAMERAS = new Set(['user', 'environment'])

export interface RecordingStats {
  fps: number
  frameCount: number
  durationMs: number
  /** Share of frames with a hand, times the mean hand score. */
  quality: number
  /** Longest time a tracked hand was missing, ms, or 0 when no gap was longer than a frame and a half. */
  longestGap: number
  status: 'approved' | 'pending'
}

export function recordingStats(seq: WireSequence): RecordingStats {
  const frames = seq.frames
  const durationMs = frames[frames.length - 1][0] - frames[0][0]
  const fps = durationMs > 0 ? ((frames.length - 1) * 1000) / durationMs : 0
  let withHand = 0
  let scoreSum = 0
  let handCount = 0
  for (const [, hands] of frames) {
    if (hands.length) withHand++
    for (const h of hands) {
      scoreSum += h[2]
      handCount++
    }
  }
  const quality = (withHand / frames.length) * (handCount ? scoreSum / handCount : 0)
  let longestGap = 0
  for (const slot of [0, 1]) {
    let last: number | null = null
    for (const [t, hands] of frames) {
      if (hands.some((h) => h[0] === slot)) {
        if (last !== null) longestGap = Math.max(longestGap, t - last)
        last = t
      }
    }
  }
  const interval = frames.length > 1 ? durationMs / (frames.length - 1) : 0
  if (longestGap <= interval * 1.5) longestGap = 0
  return {
    fps: Math.round(fps * 10) / 10,
    frameCount: frames.length,
    durationMs,
    quality: Math.round(quality * 1000) / 1000,
    longestGap,
    status: quality >= QUALITY_APPROVED ? 'approved' : 'pending',
  }
}

export function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

/** Trims user text, strips control characters and caps its length. */
export const cleanText = (s: unknown, max: number) =>
  typeof s === 'string'
    ? [...s]
        .filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
        .join('')
        .trim()
        .slice(0, max)
    : ''

/** The optional details sent with a take, with anything unexpected dropped. */
export function cleanMeta(meta: Record<string, unknown> | undefined) {
  const m = meta ?? {}
  const pick = (set: Set<string>, v: unknown) => (typeof v === 'string' && set.has(v) ? v : null)
  const size = (v: unknown) =>
    Number.isInteger(v) && (v as number) > 0 && (v as number) <= 8192 ? (v as number) : null
  return {
    cameraView: pick(CAMERA_VIEWS, m.cameraView),
    handedness: pick(HANDEDNESS, m.handedness),
    camera: pick(CAMERAS, m.camera),
    device: cleanText(m.device, 40) || null,
    width: size(m.width),
    height: size(m.height),
  }
}
