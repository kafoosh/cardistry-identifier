import { fetchMove, fetchMoves, fetchRecordingFrames } from '../api/client'
import { sharingEnabled } from '../config'
import { listRecordings, loadRecording } from '../storage/db'
import { extractFeatures } from './features'
import type { Template } from './recognizer'

/** Builds matching templates from the recordings saved on this device. */
export async function loadLocalTemplates(): Promise<{ templates: Template[]; sharedIds: Set<string> }> {
  const summaries = await listRecordings()
  const out: Template[] = []
  const sharedIds = new Set<string>()
  for (const s of summaries) {
    const rec = await loadRecording(s.id)
    if (!rec) continue
    if (rec.sharedId) sharedIds.add(rec.sharedId)
    const features = extractFeatures(rec.frames, rec.videoWidth / rec.videoHeight || 4 / 3)
    if (features && features.frames >= 4) out.push({ id: rec.id, moveName: rec.moveName, features, source: 'mine' })
  }
  return { templates: out, sharedIds }
}

/** Templates from the shared library: approved takes plus this browser's own pending ones. */
export async function loadSharedTemplates(skip: Set<string>): Promise<Template[]> {
  if (!sharingEnabled()) return []
  const moves = (await fetchMoves()).filter((m) => m.recordingCount > 0)
  const details = await Promise.all(moves.map((m) => fetchMove(m.slug).catch(() => null)))
  const recs = details.flatMap((d) =>
    d ? d.recordings.filter((r) => (r.status === 'approved' || r.mine) && !skip.has(r.id)).map((r) => ({ r, name: d.move.name })) : [],
  )
  const out: Template[] = []
  // A few downloads at a time keeps phones responsive.
  for (let i = 0; i < recs.length; i += 6) {
    const batch = await Promise.all(
      recs.slice(i, i + 6).map(async ({ r, name }) => {
        try {
          const frames = await fetchRecordingFrames(r.id)
          const features = extractFeatures(frames, r.width && r.height ? r.width / r.height : 4 / 3)
          return features && features.frames >= 4 ? ({ id: `shared:${r.id}`, moveName: name, features, source: 'shared' } as Template) : null
        } catch {
          return null
        }
      }),
    )
    for (const t of batch) if (t) out.push(t)
  }
  return out
}

/** Everything Identify can match against. Takes already uploaded from here count once. */
export async function loadTemplates(): Promise<{ templates: Template[]; sharedError: boolean }> {
  const local = await loadLocalTemplates()
  try {
    const shared = await loadSharedTemplates(local.sharedIds)
    return { templates: [...local.templates, ...shared], sharedError: false }
  } catch {
    return { templates: local.templates, sharedError: true }
  }
}
