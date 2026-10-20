import { API_BASE } from '../config'
import { adminToken } from './admin'
import type { LocalRecording } from '../recording/types'
import { decodeSequence, encodeSequence, type WireSequence } from '../shared/sequence'
import type { Frame } from '../tracking/types'

export interface SharedMove {
  id: string
  name: string
  slug: string
  aliases: string[]
  category: string | null
  description: string | null
  creditedTo: string | null
  status: 'approved' | 'proposed'
  recordingCount: number
}

export interface SharedRecording {
  id: string
  moveId: string
  nickname: string | null
  fps: number
  frameCount: number
  durationMs: number
  handedness: string | null
  cameraView: string | null
  camera: 'user' | 'environment' | null
  device: string | null
  width: number | null
  height: number | null
  qualityScore: number
  longestGapMs: number | null
  status: 'approved' | 'pending'
  createdAt: number
  mine: boolean
}

// ---------- anonymous identity ----------

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode: the id lasts for this visit only.
  }
}

let sessionDeviceId: string | null = null

/** Random id created on first visit; ties uploads to this browser without an account. */
export function deviceId(): string {
  let id = storageGet('cardistry.deviceId') ?? sessionDeviceId
  if (!id) {
    id = crypto.randomUUID()
    storageSet('cardistry.deviceId', id)
  }
  sessionDeviceId = id
  return id
}

function deleteKeys(): Record<string, string> {
  try {
    return JSON.parse(storageGet('cardistry.deleteKeys') ?? '{}')
  } catch {
    return {}
  }
}

export const hasDeleteKey = (id: string) => id in deleteKeys()

// ---------- requests ----------

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    // The admin token, when this browser has one, lifts the per-move share cap.
    headers: { 'X-Device-Id': deviceId(), ...(adminToken() ? { 'X-Admin-Token': adminToken() } : {}), ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      message = ((await res.json()) as { error?: string }).error ?? message
    } catch {
      // Not JSON.
    }
    throw new Error(message)
  }
  return res.json() as Promise<T>
}

// Always revalidate: counts change as soon as anyone shares.
export const fetchMoves = () => call<{ moves: SharedMove[] }>('/api/moves', { cache: 'no-cache' }).then((r) => r.moves)

export const fetchMove = (slug: string) =>
  call<{ move: SharedMove; recordings: SharedRecording[] }>(`/api/moves/${encodeURIComponent(slug)}`, { cache: 'no-cache' })

const frameCache = new Map<string, Promise<Frame[]>>()

export function fetchRecordingFrames(id: string): Promise<Frame[]> {
  let p = frameCache.get(id)
  if (!p) {
    p = (async () => {
      const res = await fetch(`${API_BASE}/api/recordings/${id}/data`)
      if (!res.ok) throw new Error(`Couldn't load recording (${res.status})`)
      const stream = res.body!.pipeThrough(new DecompressionStream('gzip'))
      const seq = (await new Response(stream).json()) as WireSequence
      return decodeSequence(seq) as Frame[]
    })()
    p.catch(() => frameCache.delete(id))
    frameCache.set(id, p)
  }
  return p
}

export interface UploadResult {
  id: string
  status: 'approved' | 'pending'
  /** True when identical landmark data was already in the library, so nothing new was stored. */
  duplicate: boolean
  move: { id: string; name: string; slug: string; status: string }
}

export type BatchItemResult = ({ ok: true } & UploadResult) | { ok: false; error: string }

function uploadItem(rec: LocalRecording) {
  return {
    moveName: rec.moveName,
    meta: {
      cameraView: rec.cameraView,
      handedness: rec.dominantHand === 'left' ? 'left-dominant' : 'right-dominant',
      camera: rec.camera,
      device: rec.device,
      width: rec.videoWidth,
      height: rec.videoHeight,
    },
    sequence: encodeSequence(rec.frames),
  }
}

/** Only the uploader's browser keeps delete keys; the server stores their hashes. */
function rememberDeleteKeys(pairs: [string, string][]) {
  if (pairs.length) storageSet('cardistry.deleteKeys', JSON.stringify({ ...deleteKeys(), ...Object.fromEntries(pairs) }))
}

type Uploaded = UploadResult & { deleteKey?: string }

const stripKey = ({ deleteKey: _key, ...rest }: Uploaded): UploadResult => rest

export async function uploadRecording(rec: LocalRecording, nickname: string, turnstileToken: string): Promise<UploadResult> {
  const out = await call<Uploaded>('/api/recordings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstileToken, deviceId: deviceId(), nickname: nickname || undefined, ...uploadItem(rec) }),
  })
  if (out.deleteKey) rememberDeleteKeys([[out.id, out.deleteKey]])
  return stripKey(out)
}

export const MAX_BATCH = 20

/** Shares up to MAX_BATCH recordings behind one captcha token. Results line up with the input. */
export async function uploadBatch(recs: LocalRecording[], nickname: string, turnstileToken: string): Promise<BatchItemResult[]> {
  const out = await call<{ results: (({ ok: true } & Uploaded) | { ok: false; error: string })[] }>('/api/recordings/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstileToken, deviceId: deviceId(), nickname: nickname || undefined, items: recs.map(uploadItem) }),
  })
  rememberDeleteKeys(out.results.flatMap((r) => (r.ok && r.deleteKey ? [[r.id, r.deleteKey] as [string, string]] : [])))
  // The server stops early when the daily limit is hit; mark the rest as not sent.
  return recs.map((_, i) => {
    const r = out.results[i]
    if (!r) return { ok: false, error: 'Not sent (daily limit reached)' }
    return r.ok ? { ok: true, ...stripKey(r) } : r
  })
}

export async function deleteSharedRecording(id: string) {
  const key = deleteKeys()[id]
  if (!key) throw new Error("This browser doesn't have the delete key for that recording.")
  await call(`/api/recordings/${id}`, { method: 'DELETE', headers: { 'X-Delete-Key': key } })
  const keys = deleteKeys()
  delete keys[id]
  storageSet('cardistry.deleteKeys', JSON.stringify(keys))
}
