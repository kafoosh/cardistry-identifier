import { MAX_DURATION_MS, validateSequence, type WireSequence } from '../../src/shared/sequence'
import { cleanMeta, cleanText, recordingStats, slugify } from '../../src/shared/recordingStats'

export interface Env {
  DB: D1Database
  ALLOWED_ORIGINS: string
  DAILY_UPLOAD_LIMIT: string
  TURNSTILE_SECRET?: string
}

const MAX_BODY_BYTES = 1_500_000

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---------- helpers ----------

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
  if (!allowed.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Delete-Key, X-Device-Id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

async function sha256Hex(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function randomKey(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

async function verifyTurnstile(env: Env, token: unknown, ip: string | null) {
  const secret = env.TURNSTILE_SECRET?.trim()
  if (!secret) return // local dev
  if (typeof token !== 'string' || !token) throw new HttpError(403, 'Captcha missing. Reload the page and try again.')
  const form = new FormData()
  form.append('secret', secret)
  form.append('response', token)
  if (ip) form.append('remoteip', ip)
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form })
  const out = (await res.json()) as { success: boolean; 'error-codes'?: string[]; hostname?: string }
  if (!out.success) {
    const codes = out['error-codes'] ?? []
    console.warn('Turnstile rejected', codes, out.hostname)
    if (codes.some((c) => c.includes('secret'))) {
      throw new HttpError(500, 'The server\'s Turnstile secret is wrong or missing (invalid-input-secret).')
    }
    throw new HttpError(403, `Captcha check failed (${codes.join(', ') || 'unknown'}). Reload the page and try again.`)
  }
}

/** Increments today's counters for each key and throws if any is over the limit. */
async function rateLimit(env: Env, keys: string[], limit: number) {
  const day = new Date().toISOString().slice(0, 10)
  const results = await env.DB.batch(
    keys.map((k) =>
      env.DB.prepare(
        `INSERT INTO rate_limits (key, day, count) VALUES (?1, ?2, 1)
         ON CONFLICT (key, day) DO UPDATE SET count = count + 1
         RETURNING count`,
      ).bind(k, day),
    ),
  )
  if (results.some((r) => ((r.results?.[0] as { count: number } | undefined)?.count ?? 0) > limit)) {
    throw new HttpError(429, `Daily upload limit reached (${limit} per day). Try again tomorrow.`)
  }
}

// ---------- handlers ----------

interface MoveRow {
  id: string
  name: string
  slug: string
  aliases: string
  category: string | null
  description: string | null
  credited_to: string | null
  status: string
  merged_into: string | null
}

function moveOut(m: MoveRow & { recording_count?: number }) {
  return {
    id: m.id,
    name: m.name,
    slug: m.slug,
    aliases: JSON.parse(m.aliases || '[]') as string[],
    category: m.category,
    description: m.description,
    creditedTo: m.credited_to,
    status: m.status,
    recordingCount: m.recording_count ?? 0,
  }
}

async function listMoves(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT m.*, COUNT(r.id) AS recording_count
     FROM moves m
     LEFT JOIN recordings r ON r.move_id = m.id AND r.status != 'rejected'
     WHERE m.status IN ('approved', 'proposed')
     GROUP BY m.id
     ORDER BY recording_count DESC, m.name`,
  ).all<MoveRow & { recording_count: number }>()
  return json({ moves: results.map(moveOut) }, 200, { 'Cache-Control': 'public, max-age=30' })
}

interface RecordingRow {
  id: string
  move_id: string
  device_id: string
  nickname: string | null
  fps: number
  frame_count: number
  duration_ms: number
  handedness: string | null
  camera_view: string | null
  camera: string | null
  device: string | null
  width: number | null
  height: number | null
  quality_score: number
  longest_gap_ms: number | null
  status: string
  created_at: number
}

function recordingOut(r: RecordingRow, deviceId: string | null) {
  return {
    id: r.id,
    moveId: r.move_id,
    nickname: r.nickname,
    fps: r.fps,
    frameCount: r.frame_count,
    durationMs: r.duration_ms,
    handedness: r.handedness,
    cameraView: r.camera_view,
    camera: r.camera,
    device: r.device,
    width: r.width,
    height: r.height,
    qualityScore: r.quality_score,
    longestGapMs: r.longest_gap_ms,
    status: r.status,
    createdAt: r.created_at,
    mine: deviceId !== null && r.device_id === deviceId,
  }
}

async function getMove(env: Env, slug: string, deviceId: string | null) {
  const move = await env.DB.prepare(`SELECT * FROM moves WHERE slug = ?1`).bind(slug).first<MoveRow>()
  if (!move || move.status === 'merged') throw new HttpError(404, 'Move not found')
  const { results } = await env.DB.prepare(
    `SELECT * FROM recordings WHERE move_id = ?1 AND status != 'rejected' ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(move.id)
    .all<RecordingRow>()
  return json({ move: moveOut(move), recordings: results.map((r) => recordingOut(r, deviceId)) })
}

async function getRecordingData(env: Env, id: string) {
  const row = await env.DB.prepare(
    `SELECT d.gz FROM recording_data d JOIN recordings r ON r.id = d.recording_id
     WHERE d.recording_id = ?1 AND r.status != 'rejected'`,
  )
    .bind(id)
    .first<{ gz: ArrayBuffer | number[] }>()
  if (!row) throw new HttpError(404, 'Recording not found')
  const bytes = row.gz instanceof ArrayBuffer ? row.gz : new Uint8Array(row.gz).buffer
  // Served as raw gzip bytes; the app decompresses with DecompressionStream.
  return new Response(bytes, {
    headers: { 'Content-Type': 'application/gzip', 'Cache-Control': 'public, max-age=31536000, immutable' },
  })
}

/** Finds a move by name, slug or alias (following merges), or proposes a new one. */
async function resolveMove(env: Env, rawName: string, deviceId: string): Promise<MoveRow> {
  const name = cleanText(rawName, 60)
  const slug = slugify(name)
  if (!slug) throw new HttpError(400, 'Move name is required')
  let move = await env.DB.prepare(`SELECT * FROM moves WHERE slug = ?1`).bind(slug).first<MoveRow>()
  if (!move) {
    move = await env.DB.prepare(
      `SELECT m.* FROM moves m, json_each(m.aliases) a WHERE lower(a.value) = lower(?1) LIMIT 1`,
    )
      .bind(name)
      .first<MoveRow>()
  }
  for (let i = 0; move?.status === 'merged' && move.merged_into && i < 5; i++) {
    move = await env.DB.prepare(`SELECT * FROM moves WHERE id = ?1`).bind(move.merged_into).first<MoveRow>()
  }
  if (move) return move
  const id = crypto.randomUUID()
  await env.DB.prepare(
    `INSERT INTO moves (id, name, slug, status, created_by, created_at) VALUES (?1, ?2, ?3, 'proposed', ?4, ?5)`,
  )
    .bind(id, name, slug, deviceId, Date.now())
    .run()
  return { id, name, slug, aliases: '[]', category: null, description: null, credited_to: null, status: 'proposed', merged_into: null }
}

interface UploadItem {
  moveName?: string
  meta?: {
    cameraView?: string
    handedness?: string
    camera?: string
    device?: string
    width?: number
    height?: number
  }
  sequence?: WireSequence
}

interface UploadBody extends UploadItem {
  turnstileToken?: string
  deviceId?: string
  nickname?: string
}

interface BatchBody {
  turnstileToken?: string
  deviceId?: string
  nickname?: string
  items?: UploadItem[]
}

const MAX_BATCH = 20

async function readJson<T>(req: Request, maxBytes: number): Promise<T> {
  const length = Number(req.headers.get('Content-Length') ?? 0)
  if (length > maxBytes) throw new HttpError(413, 'Upload is too large')
  const text = await req.text()
  if (text.length > maxBytes) throw new HttpError(413, 'Upload is too large')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

type StoreResult =
  | { id: string; deleteKey: string; status: string; duplicate: false; move: { id: string; name: string; slug: string; status: string } }
  | { id: string; status: string; duplicate: true; move: { id: string; name: string; slug: string; status: string } }

/** Validates and stores one recording. Identical landmark data already in the library is not stored twice. */
async function storeRecording(env: Env, item: UploadItem, deviceId: string, nickname: string, ip: string | null): Promise<StoreResult> {
  const err = validateSequence(item.sequence)
  if (err) throw new HttpError(422, `Recording rejected: ${err}`)
  const seq = item.sequence as WireSequence
  const seqJson = JSON.stringify(seq)
  const contentHash = await sha256Hex(seqJson)

  const existing = await env.DB.prepare(
    `SELECT r.id, r.status, m.id AS move_id, m.name, m.slug, m.status AS move_status
     FROM recordings r JOIN moves m ON m.id = r.move_id WHERE r.content_hash = ?1`,
  )
    .bind(contentHash)
    .first<{ id: string; status: string; move_id: string; name: string; slug: string; move_status: string }>()
  if (existing) {
    return {
      id: existing.id,
      status: existing.status,
      duplicate: true,
      move: { id: existing.move_id, name: existing.name, slug: existing.slug, status: existing.move_status },
    }
  }

  const limit = Number(env.DAILY_UPLOAD_LIMIT) || 40
  await rateLimit(env, [`up:dev:${deviceId}`, ...(ip ? [`up:ip:${await sha256Hex(ip)}`] : [])], limit)

  // Recompute stats server side rather than trusting the client.
  const frames = seq.frames
  const durationMs = frames[frames.length - 1][0] - frames[0][0]
  if (durationMs > MAX_DURATION_MS) throw new HttpError(422, 'Recording too long')
  const stats = recordingStats(seq)
  const meta = cleanMeta(item.meta)

  const move = await resolveMove(env, item.moveName ?? '', deviceId)
  const id = crypto.randomUUID()
  const deleteKey = randomKey()
  const gz = await gzip(seqJson)
  // Low-quality recordings are kept but held back until reviewed.
  const status = stats.status
  const now = Date.now()

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO recordings (id, move_id, device_id, delete_hash, nickname, fps, frame_count, duration_ms,
         handedness, camera_view, camera, device, width, height, quality_score, longest_gap_ms, data_bytes, status, created_at,
         content_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`,
    ).bind(
      id,
      move.id,
      deviceId,
      await sha256Hex(deleteKey),
      nickname || null,
      stats.fps,
      stats.frameCount,
      stats.durationMs,
      meta.handedness,
      meta.cameraView,
      meta.camera,
      meta.device,
      meta.width,
      meta.height,
      stats.quality,
      stats.longestGap,
      gz.byteLength,
      status,
      now,
      contentHash,
    ),
    env.DB.prepare(`INSERT INTO recording_data (recording_id, gz) VALUES (?1, ?2)`).bind(id, gz),
  ])

  return { id, deleteKey, status, duplicate: false, move: { id: move.id, name: move.name, slug: move.slug, status: move.status } }
}

async function uploadRecording(req: Request, env: Env) {
  const body = await readJson<UploadBody>(req, MAX_BODY_BYTES)
  const ip = req.headers.get('CF-Connecting-IP')
  await verifyTurnstile(env, body.turnstileToken, ip)
  if (!isUuid(body.deviceId)) throw new HttpError(400, 'Missing device id')
  const result = await storeRecording(env, body, body.deviceId.toLowerCase(), cleanText(body.nickname, 30), ip)
  return json(result, result.duplicate ? 200 : 201)
}

/** Shares up to 20 recordings behind one captcha check; each item succeeds or fails on its own. */
async function uploadBatch(req: Request, env: Env) {
  const body = await readJson<BatchBody>(req, MAX_BODY_BYTES * MAX_BATCH)
  const ip = req.headers.get('CF-Connecting-IP')
  await verifyTurnstile(env, body.turnstileToken, ip)
  if (!isUuid(body.deviceId)) throw new HttpError(400, 'Missing device id')
  const items = Array.isArray(body.items) ? body.items : []
  if (!items.length) throw new HttpError(400, 'Nothing to upload')
  if (items.length > MAX_BATCH) throw new HttpError(400, `At most ${MAX_BATCH} recordings at a time`)
  const deviceId = body.deviceId.toLowerCase()
  const nickname = cleanText(body.nickname, 30)
  const results = []
  for (const item of items) {
    try {
      results.push({ ok: true, ...(await storeRecording(env, item, deviceId, nickname, ip)) })
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      results.push({ ok: false, error: err.message })
      // Stop once the daily limit is hit; the rest would fail the same way.
      if (err.status === 429) break
    }
  }
  return json({ results })
}

async function deleteRecording(req: Request, env: Env, id: string) {
  const key = req.headers.get('X-Delete-Key')
  if (!key) throw new HttpError(401, 'Delete key required')
  const row = await env.DB.prepare(`SELECT delete_hash FROM recordings WHERE id = ?1`).bind(id).first<{ delete_hash: string }>()
  if (!row) throw new HttpError(404, 'Recording not found')
  if (row.delete_hash !== (await sha256Hex(key))) throw new HttpError(403, 'Wrong delete key')
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM recording_data WHERE recording_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM votes WHERE recording_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM recordings WHERE id = ?1`).bind(id),
  ])
  return json({ deleted: true })
}

// ---------- router ----------

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url)
  const path = url.pathname.replace(/\/+$/, '')
  const deviceHeader = req.headers.get('X-Device-Id')
  const deviceId = isUuid(deviceHeader) ? deviceHeader.toLowerCase() : null
  let m: RegExpMatchArray | null

  if (req.method === 'GET' && path === '/api/health') return json({ ok: true })
  if (req.method === 'GET' && path === '/api/moves') return listMoves(env)
  if (req.method === 'GET' && (m = path.match(/^\/api\/moves\/([a-z0-9-]{1,60})$/))) return getMove(env, m[1], deviceId)
  if (req.method === 'GET' && (m = path.match(/^\/api\/recordings\/([0-9a-f-]{36})\/data$/))) return getRecordingData(env, m[1])
  if (req.method === 'POST' && path === '/api/recordings') return uploadRecording(req, env)
  if (req.method === 'POST' && path === '/api/recordings/batch') return uploadBatch(req, env)
  if (req.method === 'DELETE' && (m = path.match(/^\/api\/recordings\/([0-9a-f-]{36})$/))) return deleteRecording(req, env, m[1])
  throw new HttpError(404, 'Not found')
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env)
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    let res: Response
    try {
      res = await route(req, env)
    } catch (err) {
      if (err instanceof HttpError) res = json({ error: err.message }, err.status)
      else {
        console.error(err)
        res = json({ error: 'Server error' }, 500)
      }
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
    return res
  },
} satisfies ExportedHandler<Env>
