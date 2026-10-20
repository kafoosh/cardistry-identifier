import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import type { Delegate } from './types'

const base = import.meta.env.BASE_URL
const WASM_PATH = `${base}mediapipe/wasm`
const MODEL_PATH = `${base}models/hand_landmarker.task`

export interface LoadedTracker {
  landmarker: HandLandmarker
  delegate: Delegate
}

/**
 * Loads the MediaPipe Hand Landmarker in VIDEO mode for two hands.
 * Tries the GPU delegate first and falls back to CPU (some phones and
 * browsers fail to create a WebGL context for it).
 */
export async function loadHandTracker(preferGpu = true): Promise<LoadedTracker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH)
  const delegates: Delegate[] = preferGpu ? ['GPU', 'CPU'] : ['CPU']
  let lastError: unknown
  for (const delegate of delegates) {
    try {
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_PATH, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        // Lenient, so the second hand (often half hidden behind the deck) is picked up and kept.
        minHandDetectionConfidence: 0.3,
        minHandPresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      })
      return { landmarker, delegate }
    } catch (err) {
      console.warn(`Hand Landmarker failed on ${delegate}`, err)
      lastError = err
    }
  }
  throw lastError
}

export const HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS
