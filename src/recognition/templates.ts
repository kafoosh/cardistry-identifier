import { listRecordings, loadRecording } from '../storage/db'
import { extractFeatures } from './features'
import type { Template } from './recognizer'

/** Builds matching templates from the recordings saved on this device. */
export async function loadLocalTemplates(): Promise<Template[]> {
  const summaries = await listRecordings()
  const out: Template[] = []
  for (const s of summaries) {
    const rec = await loadRecording(s.id)
    if (!rec) continue
    const features = extractFeatures(rec.frames, rec.videoWidth / rec.videoHeight || 4 / 3)
    if (features && features.frames >= 4) out.push({ id: rec.id, moveName: rec.moveName, features, source: 'mine' })
  }
  return out
}
