import { MAX_DURATION_MS, validateSequence, type WireSequence } from '../../src/shared/sequence'
import { cleanMeta, cleanText, recordingStats, slugify } from '../../src/shared/recordingStats'

export interface Env {
  DB: D1Database
  ALLOWED_ORIGINS: string
  DAILY_UPLOAD_LIMIT: string
  TURNSTILE_SECRET?: string
  /** Lets the admin page in; set with `wrangler secret put ADMIN_TOKEN`. Admin routes are off while it is unset. */
  ADMIN_TOKEN?: string
}

const MAX_BODY_BYTES = 1_500_000

class HttpError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** How many of their own takes one device may share per move; admins are not capped. */
const TAKES_PER_MOVE = 10

// ---------- helpers ----------

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
  if (!allowed.includes(origin)) return {}
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Delete-Key, X-Device-Id, X-Admin-Token',
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

// ---------- edge cache ----------
// Read-mostly answers are kept in Cloudflare's edge cache, so a crowd of readers
// does not become a crowd of database queries. Keys are made-up URLs nobody can
// request from outside. The cache is per data centre, so after a write other
// places may see the old answer for up to the TTL.

const CACHE_ORIGIN = 'https://cache.cardistry.invalid/'
const edgeCache = () => (globalThis as { caches?: { default?: Cache } }).caches?.default
const cacheKey = (key: string) => new Request(CACHE_ORIGIN + key)

async function cachedJson<T>(key: string, ttlSeconds: number, build: () => Promise<T>): Promise<T> {
  const cache = edgeCache()
  if (cache) {
    const hit = await cache.match(cacheKey(key))
    if (hit) return hit.json() as Promise<T>
  }
  const value = await build()
  if (cache) {
    await cache.put(
      cacheKey(key),
      new Response(JSON.stringify(value), { headers: { 'Cache-Control': `public, max-age=${ttlSeconds}` } }),
    )
  }
  return value
}

async function cachedBytes(key: string, ttlSeconds: number, build: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  const cache = edgeCache()
  if (cache) {
    const hit = await cache.match(cacheKey(key))
    if (hit) return hit.arrayBuffer()
  }
  const bytes = await build()
  if (cache) await cache.put(cacheKey(key), new Response(bytes, { headers: { 'Cache-Control': `public, max-age=${ttlSeconds}` } }))
  return bytes
}

async function forget(...keys: string[]) {
  const cache = edgeCache()
  if (!cache) return
  await Promise.all(keys.map((k) => cache.delete(cacheKey(k))))
}

/** Drops every cached answer that mentions a move (and the data of one take, when given). */
const forgetMove = (slug: string | null | undefined, recordingId?: string) =>
  forget('moves', 'library', ...(slug ? [`move:${slug}`] : []), ...(recordingId ? [`data:${recordingId}`] : []))

async function slugOfRecording(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare(`SELECT m.slug FROM recordings r JOIN moves m ON m.id = r.move_id WHERE r.id = ?1`)
    .bind(id)
    .first<{ slug: string }>()
  return row?.slug ?? null
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

async function movesWithCounts(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT m.*, COUNT(r.id) AS recording_count
     FROM moves m
     LEFT JOIN recordings r ON r.move_id = m.id AND r.status != 'rejected'
     WHERE m.status IN ('approved', 'proposed')
     GROUP BY m.id
     ORDER BY recording_count DESC, m.name`,
  ).all<MoveRow & { recording_count: number }>()
  return results
}

async function listMoves(env: Env) {
  const moves = await cachedJson('moves', 30, async () => (await movesWithCounts(env)).map(moveOut))
  return json({ moves }, 200, { 'Cache-Control': 'public, max-age=30' })
}

/**
 * Everything Identify needs in one request: the moves and every take that may
 * be matched against (approved ones, plus this device's own pending ones).
 */
async function getLibrary(env: Env, deviceId: string | null) {
  const lib = await cachedJson('library', 60, async () => {
    const moves = (await movesWithCounts(env)).filter((m) => m.recording_count > 0)
    const { results } = await env.DB.prepare(
      `SELECT r.* FROM recordings r JOIN moves m ON m.id = r.move_id
       WHERE r.status != 'rejected' AND m.status IN ('approved', 'proposed')
       ORDER BY r.created_at DESC LIMIT 2000`,
    ).all<RecordingRow>()
    return { moves, recordings: results }
  })
  const names = new Map(lib.moves.map((m) => [m.id, m.name]))
  return json(
    {
      moves: lib.moves.map(moveOut),
      recordings: lib.recordings
        .filter((r) => names.has(r.move_id) && (r.status === 'approved' || r.device_id === deviceId))
        .map((r) => ({ ...recordingOut(r, deviceId), moveName: names.get(r.move_id) })),
    },
    200,
    { 'Cache-Control': 'private, max-age=30' },
  )
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
  const found = await cachedJson<{ move: MoveRow; recordings: RecordingRow[] } | null>(`move:${slug}`, 60, async () => {
    const move = await env.DB.prepare(`SELECT * FROM moves WHERE slug = ?1`).bind(slug).first<MoveRow>()
    if (!move || move.status === 'merged') return null
    const { results } = await env.DB.prepare(
      `SELECT * FROM recordings WHERE move_id = ?1 AND status != 'rejected' ORDER BY created_at DESC LIMIT 200`,
    )
      .bind(move.id)
      .all<RecordingRow>()
    return { move, recordings: results }
  })
  if (!found) throw new HttpError(404, 'Move not found')
  return json(
    { move: moveOut(found.move), recordings: found.recordings.map((r) => recordingOut(r, deviceId)) },
    200,
    { 'Cache-Control': 'private, max-age=30' },
  )
}

async function getRecordingData(env: Env, id: string) {
  // A take's data never changes, so a day in the edge cache is safe; deleting or
  // rejecting a take drops it from the cache at once.
  const bytes = await cachedBytes(`data:${id}`, 86_400, async () => {
    const row = await env.DB.prepare(
      `SELECT d.gz FROM recording_data d JOIN recordings r ON r.id = d.recording_id
       WHERE d.recording_id = ?1 AND r.status != 'rejected'`,
    )
      .bind(id)
      .first<{ gz: ArrayBuffer | number[] }>()
    if (!row) throw new HttpError(404, 'Recording not found')
    return row.gz instanceof ArrayBuffer ? row.gz : new Uint8Array(row.gz).buffer
  })
  // Served as raw gzip bytes; the app decompresses with DecompressionStream.
  return new Response(bytes, {
    headers: { 'Content-Type': 'application/gzip', 'Cache-Control': 'public, max-age=31536000, immutable' },
  })
}

// ---------- matching model ----------

/** D1 keeps a row under 2 MB. */
const MAX_MODEL_BYTES = 1_900_000

async function getModelVersion(env: Env) {
  const row = await env.DB.prepare(`SELECT version FROM models WHERE id = 'current'`).first<{ version: string }>()
  return json({ version: row?.version ?? null }, 200, { 'Cache-Control': 'no-store' })
}

async function getModel(req: Request, env: Env) {
  const row = await env.DB.prepare(`SELECT version, gz FROM models WHERE id = 'current'`).first<{
    version: string
    gz: ArrayBuffer | number[]
  }>()
  if (!row) throw new HttpError(404, 'No model yet')
  const etag = `"${row.version}"`
  // A changed library gets a new model within minutes; revalidating each time costs a 304 when it hasn't.
  const headers = { ETag: etag, 'Cache-Control': 'no-cache' }
  if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers })
  const bytes = row.gz instanceof ArrayBuffer ? row.gz : new Uint8Array(row.gz).buffer
  // Raw gzip bytes, like take data; the app decompresses with DecompressionStream.
  return new Response(bytes, { headers: { ...headers, 'Content-Type': 'application/gzip' } })
}

async function putModel(req: Request, env: Env) {
  const version = req.headers.get('X-Model-Version') ?? ''
  if (!/^[0-9a-f]{8,64}$/.test(version)) throw new HttpError(400, 'Missing model version')
  const gz = await req.arrayBuffer()
  if (!gz.byteLength || gz.byteLength > MAX_MODEL_BYTES) throw new HttpError(413, 'Model too large')
  await env.DB.prepare(
    `INSERT INTO models (id, version, gz, created_at) VALUES ('current', ?1, ?2, ?3)
     ON CONFLICT (id) DO UPDATE SET version = excluded.version, gz = excluded.gz, created_at = excluded.created_at`,
  )
    .bind(version, gz, Date.now())
    .run()
  return json({ ok: true, version, bytes: gz.byteLength })
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
  if (move?.status === 'rejected') throw new HttpError(400, `"${move.name}" was turned down as a move name. Pick one of the listed moves.`)
  if (move) return move
  if ((await getSetting(env, 'accept_proposed_moves', '1')) !== '1')
    throw new HttpError(400, 'New move names are not being accepted right now. Pick one of the listed moves.')
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
async function storeRecording(
  env: Env,
  item: UploadItem,
  deviceId: string,
  nickname: string,
  ip: string | null,
  admin: boolean,
): Promise<StoreResult> {
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
  if (!admin) {
    const own = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM recordings WHERE device_id = ?1 AND move_id = ?2 AND status != 'rejected'`,
    )
      .bind(deviceId, move.id)
      .first<{ n: number }>()
    if ((own?.n ?? 0) >= TAKES_PER_MOVE)
      throw new HttpError(
        409,
        `You have already shared ${TAKES_PER_MOVE} takes of ${move.name}. Delete one of yours to share another.`,
        'move_cap',
      )
  }
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
  await forgetMove(move.slug)

  return { id, deleteKey, status, duplicate: false, move: { id: move.id, name: move.name, slug: move.slug, status: move.status } }
}

async function uploadRecording(req: Request, env: Env) {
  const body = await readJson<UploadBody>(req, MAX_BODY_BYTES)
  const ip = req.headers.get('CF-Connecting-IP')
  await verifyTurnstile(env, body.turnstileToken, ip)
  if (!isUuid(body.deviceId)) throw new HttpError(400, 'Missing device id')
  const admin = await isAdmin(req, env)
  const result = await storeRecording(env, body, body.deviceId.toLowerCase(), cleanText(body.nickname, 30), ip, admin)
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
  const admin = await isAdmin(req, env)
  const results = []
  for (const item of items) {
    try {
      results.push({ ok: true, ...(await storeRecording(env, item, deviceId, nickname, ip, admin)) })
    } catch (err) {
      if (!(err instanceof HttpError)) throw err
      results.push({ ok: false, error: err.message, code: err.code })
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
  const slug = await slugOfRecording(env, id)
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM recording_data WHERE recording_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM votes WHERE recording_id = ?1`).bind(id),
    env.DB.prepare(`DELETE FROM recordings WHERE id = ?1`).bind(id),
  ])
  await forgetMove(slug, id)
  return json({ deleted: true })
}

// ---------- settings ----------

async function getSetting(env: Env, key: string, fallback: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = ?1`).bind(key).first<{ value: string }>()
  return row?.value ?? fallback
}

// ---------- admin ----------

const MOVE_STATUSES = new Set(['approved', 'proposed', 'rejected'])
const RECORDING_STATUSES = new Set(['approved', 'pending', 'rejected'])

/** True when the request carries the admin token. Without a token configured nobody is admin. */
async function isAdmin(req: Request, env: Env): Promise<boolean> {
  const expected = env.ADMIN_TOKEN?.trim()
  const given = req.headers.get('X-Admin-Token') ?? ''
  if (!expected || !given) return false
  // Compare hashes, so the comparison takes the same time whatever was sent.
  return (await sha256Hex(given)) === (await sha256Hex(expected))
}

/** Admin routes need the admin token; without one configured they are off altogether. */
async function requireAdmin(req: Request, env: Env) {
  if (!env.ADMIN_TOKEN?.trim()) throw new HttpError(503, 'The admin token is not set up yet')
  if (!(await isAdmin(req, env))) throw new HttpError(401, 'Wrong admin token')
}

interface ReportRow {
  id: string
  target_type: string
  target_id: string
  reason: string | null
  device_id: string | null
  resolved: number
  created_at: number
}

async function adminOverview(env: Env) {
  const [moves, recordings, reports, accept] = await Promise.all([
    env.DB.prepare(
      `SELECT m.*, COUNT(r.id) AS recording_count, m.created_by AS created_by, m.created_at AS created_at
       FROM moves m LEFT JOIN recordings r ON r.move_id = m.id AND r.status != 'rejected'
       GROUP BY m.id ORDER BY m.status = 'proposed' DESC, recording_count DESC, m.name`,
    ).all<MoveRow & { recording_count: number; created_by: string | null; created_at: number }>(),
    env.DB.prepare(
      `SELECT r.*, m.name AS move_name FROM recordings r JOIN moves m ON m.id = r.move_id
       ORDER BY r.status = 'pending' DESC, r.created_at DESC LIMIT 200`,
    ).all<RecordingRow & { move_name: string }>(),
    env.DB.prepare(`SELECT * FROM reports WHERE resolved = 0 ORDER BY created_at DESC LIMIT 100`).all<ReportRow>(),
    getSetting(env, 'accept_proposed_moves', '1'),
  ])
  return json({
    settings: { acceptProposedMoves: accept === '1' },
    moves: moves.results.map((m) => ({
      ...moveOut(m),
      mergedInto: m.merged_into,
      createdBy: m.created_by,
      createdAt: m.created_at,
    })),
    recordings: recordings.results.map((r) => ({ ...recordingOut(r, null), moveName: r.move_name, deviceId: r.device_id })),
    reports: reports.results.map((r) => ({
      id: r.id,
      targetType: r.target_type,
      targetId: r.target_id,
      reason: r.reason,
      createdAt: r.created_at,
    })),
  })
}

async function adminSettings(req: Request, env: Env) {
  const body = await readJson<{ acceptProposedMoves?: unknown }>(req, 10_000)
  if (typeof body.acceptProposedMoves === 'boolean') {
    await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('accept_proposed_moves', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1`)
      .bind(body.acceptProposedMoves ? '1' : '0')
      .run()
  }
  return json({ settings: { acceptProposedMoves: (await getSetting(env, 'accept_proposed_moves', '1')) === '1' } })
}

/** Approve, turn down, rename or merge a move. Merging moves its takes to the target and hides the name. */
async function adminMove(req: Request, env: Env, id: string) {
  const body = await readJson<{ status?: unknown; name?: unknown; mergeInto?: unknown }>(req, 10_000)
  const move = await env.DB.prepare(`SELECT * FROM moves WHERE id = ?1`).bind(id).first<MoveRow>()
  if (!move) throw new HttpError(404, 'Move not found')
  if (typeof body.mergeInto === 'string') {
    const target = await env.DB.prepare(`SELECT * FROM moves WHERE id = ?1`).bind(body.mergeInto).first<MoveRow>()
    if (!target || target.id === move.id || target.status === 'merged') throw new HttpError(400, 'Pick another move to merge into')
    const aliases = JSON.parse(target.aliases || '[]') as string[]
    if (!aliases.some((a) => a.toLowerCase() === move.name.toLowerCase())) aliases.push(move.name)
    await env.DB.batch([
      env.DB.prepare(`UPDATE recordings SET move_id = ?1 WHERE move_id = ?2`).bind(target.id, move.id),
      env.DB.prepare(`UPDATE moves SET status = 'merged', merged_into = ?1 WHERE id = ?2`).bind(target.id, move.id),
      env.DB.prepare(`UPDATE moves SET aliases = ?1 WHERE id = ?2`).bind(JSON.stringify(aliases), target.id),
    ])
  } else {
    const sets: string[] = []
    const binds: unknown[] = []
    if (typeof body.status === 'string') {
      if (!MOVE_STATUSES.has(body.status)) throw new HttpError(400, 'Bad status')
      sets.push(`status = ?${binds.length + 1}`)
      binds.push(body.status)
    }
    if (typeof body.name === 'string') {
      const name = cleanText(body.name, 60)
      const slug = slugify(name)
      if (!slug) throw new HttpError(400, 'Name is required')
      const clash = await env.DB.prepare(`SELECT id FROM moves WHERE slug = ?1 AND id != ?2`).bind(slug, id).first()
      if (clash) throw new HttpError(400, 'Another move already has that name')
      sets.push(`name = ?${binds.length + 1}`, `slug = ?${binds.length + 2}`)
      binds.push(name, slug)
    }
    if (sets.length) {
      binds.push(id)
      await env.DB.prepare(`UPDATE moves SET ${sets.join(', ')} WHERE id = ?${binds.length}`).bind(...binds).run()
    }
  }
  const updated = await env.DB.prepare(`SELECT * FROM moves WHERE id = ?1`).bind(id).first<MoveRow>()
  await forgetMove(move.slug)
  if (updated && updated.slug !== move.slug) await forgetMove(updated.slug)
  if (updated?.merged_into) {
    const target = await env.DB.prepare(`SELECT slug FROM moves WHERE id = ?1`).bind(updated.merged_into).first<{ slug: string }>()
    await forgetMove(target?.slug)
  }
  return json({ move: updated ? moveOut(updated) : null })
}

async function adminRecording(req: Request, env: Env, id: string) {
  const slug = await slugOfRecording(env, id)
  if (req.method === 'DELETE') {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM recording_data WHERE recording_id = ?1`).bind(id),
      env.DB.prepare(`DELETE FROM votes WHERE recording_id = ?1`).bind(id),
      env.DB.prepare(`DELETE FROM recordings WHERE id = ?1`).bind(id),
    ])
    await forgetMove(slug, id)
    return json({ deleted: true })
  }
  const body = await readJson<{ status?: unknown }>(req, 10_000)
  if (typeof body.status !== 'string' || !RECORDING_STATUSES.has(body.status)) throw new HttpError(400, 'Bad status')
  const r = await env.DB.prepare(`UPDATE recordings SET status = ?1 WHERE id = ?2 RETURNING *`).bind(body.status, id).first<RecordingRow>()
  if (!r) throw new HttpError(404, 'Recording not found')
  await forgetMove(slug, id)
  return json({ recording: recordingOut(r, null) })
}

async function adminReport(env: Env, id: string) {
  await env.DB.prepare(`UPDATE reports SET resolved = 1 WHERE id = ?1`).bind(id).run()
  return json({ resolved: true })
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
  if (req.method === 'GET' && path === '/api/library') return getLibrary(env, deviceId)
  if (req.method === 'GET' && (m = path.match(/^\/api\/moves\/([a-z0-9-]{1,60})$/))) return getMove(env, m[1], deviceId)
  if (req.method === 'GET' && (m = path.match(/^\/api\/recordings\/([0-9a-f-]{36})\/data$/))) return getRecordingData(env, m[1])
  if (req.method === 'GET' && path === '/api/model') return getModel(req, env)
  if (req.method === 'GET' && path === '/api/model/version') return getModelVersion(env)
  if (req.method === 'POST' && path === '/api/recordings') return uploadRecording(req, env)
  if (req.method === 'POST' && path === '/api/recordings/batch') return uploadBatch(req, env)
  if (req.method === 'DELETE' && (m = path.match(/^\/api\/recordings\/([0-9a-f-]{36})$/))) return deleteRecording(req, env, m[1])
  if (path.startsWith('/api/admin/')) {
    await requireAdmin(req, env)
    if (req.method === 'GET' && path === '/api/admin/overview') return adminOverview(env)
    if (req.method === 'PATCH' && path === '/api/admin/settings') return adminSettings(req, env)
    if (req.method === 'PUT' && path === '/api/admin/model') return putModel(req, env)
    if (req.method === 'PATCH' && (m = path.match(/^\/api\/admin\/moves\/([0-9a-z-]{1,60})$/))) return adminMove(req, env, m[1])
    if ((req.method === 'PATCH' || req.method === 'DELETE') && (m = path.match(/^\/api\/admin\/recordings\/([0-9a-f-]{36})$/)))
      return adminRecording(req, env, m[1])
    if (req.method === 'PATCH' && (m = path.match(/^\/api\/admin\/reports\/([0-9a-z-]{1,60})$/))) return adminReport(env, m[1])
  }
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
      if (err instanceof HttpError) res = json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status)
      else {
        console.error(err)
        res = json({ error: 'Server error' }, 500)
      }
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
    return res
  },
} satisfies ExportedHandler<Env>
