// Builds the shared library's matching model (src/recognition/model.ts) and
// uploads it, so Identify downloads one small file instead of every take and
// skips the slow build. Run by .github/workflows/build-model.yml whenever the
// library may have changed; does nothing when the model on the server
// already covers the library's approved takes.
//
//   API_BASE=https://… ADMIN_TOKEN=… node build-model.mjs [--force]
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { buildModel, MODEL_FORMAT } from '../src/recognition/model'
import type { Template } from '../src/recognition/recognizer'
import { templateFeatures } from '../src/recognition/templateFeatures'
import { decodeSequence, type WireSequence } from '../src/shared/sequence'
import type { Frame } from '../src/tracking/types'

const API = (process.env.API_BASE ?? '').replace(/\/+$/, '')
const TOKEN = process.env.ADMIN_TOKEN ?? ''
if (!API) throw new Error('API_BASE is required')
if (!TOKEN) {
  // The ADMIN_TOKEN repo secret is not set yet; nothing can be uploaded, and that is not a failure here.
  console.log('ADMIN_TOKEN is not set, so no model was built. Add the repository secret to enable this.')
  process.exit(0)
}
const force = process.argv.includes('--force')

interface LibraryRecording {
  id: string
  moveName: string
  width: number | null
  height: number | null
  status: string
}

async function get(path: string) {
  const res = await fetch(API + path)
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
  return res
}

// No device id, so only approved takes: what every visitor matches against.
const { recordings } = (await (await get('/api/library')).json()) as { recordings: LibraryRecording[] }
const approved = recordings.filter((r) => r.status === 'approved').sort((a, b) => a.id.localeCompare(b.id))
const version = createHash('sha256')
  .update(`${MODEL_FORMAT}\n${approved.map((r) => `${r.id} ${r.moveName}`).join('\n')}`)
  .digest('hex')
  .slice(0, 32)

const current = await fetch(`${API}/api/model/version`)
const live = current.ok ? ((await current.json()) as { version: string | null }).version : null
if (live === version && !force) {
  console.log(`Model ${version} is up to date (${approved.length} takes).`)
  process.exit(0)
}

const templates: Template[] = []
for (let i = 0; i < approved.length; i += 8) {
  const batch = await Promise.all(
    approved.slice(i, i + 8).map(async (r) => {
      const gz = Buffer.from(await (await get(`/api/recordings/${r.id}/data`)).arrayBuffer())
      const frames = decodeSequence(JSON.parse(gunzipSync(gz).toString()) as WireSequence) as Frame[]
      const f = templateFeatures(frames, r.width && r.height ? r.width / r.height : 4 / 3)
      // Same ids as the app gives library takes, so it can tell which takes the model covers.
      return f ? ({ id: `shared:${r.id}`, moveName: r.moveName, ...f, source: 'shared' } as Template) : null
    }),
  )
  for (const t of batch) if (t) templates.push(t)
}

const started = performance.now()
const model = buildModel(templates)
const ms = Math.round(performance.now() - started)
// Every approved take counts as covered, including ones too short to use, so they don't trigger rebuilds on phones.
model.takeIds = approved.map((r) => `shared:${r.id}`)
const gz = gzipSync(JSON.stringify(model))

const res = await fetch(`${API}/api/admin/model`, {
  method: 'PUT',
  headers: { 'X-Admin-Token': TOKEN, 'X-Model-Version': version, 'Content-Type': 'application/gzip' },
  body: gz,
})
if (res.status === 503) {
  // The Worker has not received the admin token yet (it is handed over by the next API deploy).
  console.log(`Model built (${Math.round(gz.length / 1024)} kB) but not uploaded: ${await res.text()}`)
  process.exit(0)
}
if (!res.ok) throw new Error(`Upload failed: ${res.status} ${await res.text()}`)
const moves = new Set(model.templates.map((t) => t.moveName)).size
console.log(
  `Model ${version}: ${model.templates.length} takes of ${moves} moves (${model.outliers.length} left out), built in ${ms} ms, ${Math.round(gz.length / 1024)} kB.`,
)
