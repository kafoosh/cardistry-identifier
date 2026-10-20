import type { CameraView, DominantHand } from './types'

export interface RecordSetupValue {
  moveName: string
  cameraView: CameraView
  dominantHand: DominantHand
}

const KEY = 'cardistry.recordSetup'

export function loadRecordSetup(): RecordSetupValue {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<RecordSetupValue>
    return { moveName: v.moveName ?? '', cameraView: v.cameraView ?? 'front', dominantHand: v.dominantHand ?? 'right' }
  } catch {
    return { moveName: '', cameraView: 'front', dominantHand: 'right' }
  }
}

export function saveRecordSetup(v: RecordSetupValue) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v))
  } catch {
    // Not remembered in private mode.
  }
}
