import { fetchLibrary, fetchModel, fetchRecordingFrames } from '../api/client'
import { sharingEnabled } from '../config'
import { listRecordings, loadRecording } from '../storage/db'
import { Matcher } from './matcher'
import { loadModel } from './model'
import { templateFeatures } from './templateFeatures'
import type { Template } from './recognizer'

/** Builds matching templates from the recordings saved on this device. */
export async function loadLocalTemplates(): Promise<{
  templates: Template[]
  sharedIds: Set<string>
  /** Per local template: the id of its shared copy, when it was shared. */
  sharedIdOf: Map<string, string>
}> {
  const summaries = await listRecordings()
  const out: Template[] = []
  const sharedIds = new Set<string>()
  const sharedIdOf = new Map<string, string>()
  for (const s of summaries) {
    const rec = await loadRecording(s.id)
    if (!rec) continue
    if (rec.sharedId) {
      sharedIds.add(rec.sharedId)
      sharedIdOf.set(rec.id, rec.sharedId)
    }
    const f = templateFeatures(rec.frames, rec.videoWidth / rec.videoHeight || 4 / 3)
    if (f) out.push({ id: rec.id, moveName: rec.moveName, ...f, source: 'mine' })
  }
  return { templates: out, sharedIds, sharedIdOf }
}

/** Templates from the shared library: approved takes plus this browser's own pending ones. */
export async function loadSharedTemplates(skip: Set<string>): Promise<Template[]> {
  if (!sharingEnabled()) return []
  // One request lists every take worth matching: approved ones and this browser's own pending ones.
  const { recordings } = await fetchLibrary()
  const recs = recordings.filter((r) => !skip.has(r.id)).map((r) => ({ r, name: r.moveName }))
  const out: Template[] = []
  // A few downloads at a time keeps phones responsive.
  for (let i = 0; i < recs.length; i += 6) {
    const batch = await Promise.all(
      recs.slice(i, i + 6).map(async ({ r, name }) => {
        try {
          const frames = await fetchRecordingFrames(r.id)
          const f = templateFeatures(frames, r.width && r.height ? r.width / r.height : 4 / 3)
          return f ? ({ id: `shared:${r.id}`, moveName: name, ...f, source: 'shared' } as Template) : null
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

export interface LoadedMatcher {
  /** The templates matched against (outliers included). */
  templates: Template[]
  outliers: Set<string>
  sharedError: boolean
}

/**
 * Gets the matcher ready for Identify. When the library has a prebuilt model
 * that covers everything this device would match against, that is all it
 * loads: one small download, ready at once. When this device has takes the
 * model lacks (its own unshared ones, or ones shared since the model was
 * built), Identify starts on the model and the full set is built in the
 * background, on a separate worker so live matching carries on; `onUpgrade`
 * hears when it is swapped in.
 */
export async function loadMatcher(matcher: Matcher, onUpgrade: (l: LoadedMatcher) => void): Promise<LoadedMatcher> {
  const full = async (): Promise<LoadedMatcher> => {
    const { templates, sharedError } = await loadTemplates()
    return { templates, outliers: new Set(await matcher.setTemplates(templates)), sharedError }
  }
  if (!sharingEnabled()) return full()
  const [local, model, library] = await Promise.all([
    loadLocalTemplates(),
    fetchModel().catch(() => null),
    fetchLibrary().catch(() => null),
  ])
  if (!model) return full()

  const outliers = new Set(await matcher.setModel(model))
  const loaded: LoadedMatcher = { templates: loadModel(model).templates, outliers, sharedError: !library }
  const inModel = new Set(model.takeIds)
  const shared = (id: string) => inModel.has(`shared:${id}`)
  const missing =
    local.templates.some((t) => !shared(local.sharedIdOf.get(t.id) ?? '')) ||
    (library?.recordings.some((r) => !shared(r.id)) ?? false)
  if (missing)
    void (async () => {
      const { templates, sharedError } = await loadTemplates()
      const builder = new Matcher()
      try {
        const rebuilt = await builder.build(templates)
        const ids = new Set(await matcher.setModel(rebuilt))
        onUpgrade({ templates, outliers: ids, sharedError })
      } finally {
        builder.terminate()
      }
    })().catch(() => {
      // Keep matching on the library's model.
    })
  return loaded
}
