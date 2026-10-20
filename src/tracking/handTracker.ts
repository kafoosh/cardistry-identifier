import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import type { Delegate } from './types'

const base = import.meta.env.BASE_URL
const WASM_PATH = `${base}mediapipe/wasm`
const MODEL_PATH = `${base}models/hand_landmarker.task`
/**
 * The same palm detector with MediaPipe's lite landmark model: about a third
 * less work per hand, a little less precise. Built from hand_landmark_lite.tflite
 * with the full model's metadata copied in.
 */
const LITE_MODEL_PATH = `${base}models/hand_landmarker_lite.task`

export interface LoadedTracker {
  landmarker: HandLandmarker
  delegate: Delegate
}

/**
 * Loads the MediaPipe Hand Landmarker in VIDEO mode for two hands.
 * Tries the GPU delegate first and falls back to CPU (some phones and
 * browsers fail to create a WebGL context for it).
 */
export async function loadHandTracker(preferGpu = true, lite = false): Promise<LoadedTracker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH)
  const delegates: Delegate[] = preferGpu ? ['GPU', 'CPU'] : ['CPU']
  let lastError: unknown
  for (const delegate of delegates) {
    try {
      const landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: lite ? LITE_MODEL_PATH : MODEL_PATH, delegate },
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
