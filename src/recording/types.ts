import type { CameraFacing, Frame } from '../tracking/types'

export type CameraView = 'front' | 'top-down' | 'side'
export type DominantHand = 'right' | 'left'

export const STARTER_MOVES = [
  'Charlier cut',
  'Revolution cut',
  'Swing cut',
  'L cuts',
  'Sybil',
  'Spring',
  'Molecule spin',
] as const

/** A recording kept on this device (IndexedDB). Mirrors the planned server `recordings` row plus its frames. */
export interface LocalRecording {
  id: string
  moveName: string
  createdAt: number
  /** Frames with `t` in ms since the recording started. Landmarks are raw, never mirrored. */
  frames: Frame[]
  fps: number
  frameCount: number
  durationMs: number
  camera: CameraFacing
  cameraView: CameraView
  dominantHand: DominantHand
  device: string
  videoWidth: number
  videoHeight: number
  /** Share of frames with at least one hand found, times mean hand confidence. 0..1. */
  qualityScore: number
  /** Longest mid-recording hand dropout, ms (0 if none). */
  longestGapMs?: number
  /** Whether a video clip is stored alongside (in the `videos` store). */
  hasVideo: boolean
  videoMimeType?: string
}

export type RecordingSummary = Omit<LocalRecording, 'frames'>
