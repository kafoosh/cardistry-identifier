// Turns a folder of seed takes into SQL for the shared library. Each file is
// the body of a single POST /api/recordings without turnstileToken:
// { moveName, deviceId, nickname, meta?, sequence }. The same stats, status
// rule, content hash and gzip as the live upload path apply; a take whose
// landmark data is already in the library is skipped, and a move name not in
// the library is added as 'proposed', as an upload would.
//
//   node seed.mjs --dir ../seed/<batch> --out seed.sql [--dry-run]
//
// The SQL is meant for `wrangler d1 execute DB --remote --file seed.sql`.
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { cleanMeta, cleanText, recordingStats, slugify } from '../../src/shared/recordingStats'
import { MAX_DURATION_MS, validateSequence, type WireSequence } from '../../src/shared/sequence'

interface SeedTake {
  moveName?: string
  deviceId?: string
  nickname?: string
  meta?: Record<string, unknown>
  sequence?: WireSequence
}

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const dir = opt('--dir')
const out = opt('--out') ?? 'seed.sql'
const dryRun = args.includes('--dry-run')
if (!dir) {
  console.error('usage: seed --dir <folder> [--out seed.sql] [--dry-run]')
  process.exit(2)
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`
const v = (x: string | number | null) => (x === null ? 'NULL' : typeof x === 'number' ? String(x) : q(x))
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const isUuid = (s: unknown): s is string =>
  typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
const now = Date.now()
const sql: string[] = []
const moves = new Map<string, string>()
const problems: string[] = []
let takes = 0
let pending = 0

for (const file of files) {
  let take: SeedTake
  try {
    take = JSON.parse(readFileSync(join(dir, file), 'utf8')) as SeedTake
  } catch {
    problems.push(`${file}: not valid JSON`)
    continue
  }
  const err = validateSequence(take.sequence)
  if (err) {
    problems.push(`${file}: ${err}`)
    continue
  }
  if (!isUuid(take.deviceId)) {
    problems.push(`${file}: deviceId must be a UUID`)
    continue
  }
  const name = cleanText(take.moveName, 60)
  const slug = slugify(name)
  if (!slug) {
    problems.push(`${file}: moveName missing`)
    continue
  }
  const seq = take.sequence as WireSequence
  const seqJson = JSON.stringify(seq)
  if (seq.frames[seq.frames.length - 1][0] - seq.frames[0][0] > MAX_DURATION_MS) {
    problems.push(`${file}: recording too long`)
    continue
  }
  const stats = recordingStats(seq)
  const meta = cleanMeta(take.meta)
  const deviceId = take.deviceId.toLowerCase()
  const nickname = cleanText(take.nickname, 30) || null
  const contentHash = sha256(seqJson)
  const gz = gzipSync(seqJson)
  const id = randomUUID()
  const deleteHash = sha256(randomUUID())

  if (!moves.has(slug)) {
    moves.set(slug, name)
    sql.push(
      `INSERT INTO moves (id, name, slug, status, created_by, created_at) SELECT ${q(randomUUID())}, ${q(name)}, ${q(slug)}, 'proposed', ${q(deviceId)}, ${now} WHERE NOT EXISTS (SELECT 1 FROM moves WHERE slug = ${q(slug)});`,
    )
  }
  const cols =
    'id, move_id, device_id, delete_hash, nickname, fps, frame_count, duration_ms, handedness, camera_view, camera, device, width, height, quality_score, longest_gap_ms, data_bytes, status, created_at, content_hash'
  const vals = [
    q(id),
    `(SELECT id FROM moves WHERE slug = ${q(slug)})`,
    q(deviceId),
    q(deleteHash),
    v(nickname),
    v(stats.fps),
    v(stats.frameCount),
    v(stats.durationMs),
    v(meta.handedness),
    v(meta.cameraView),
    v(meta.camera),
    v(meta.device),
    v(meta.width),
    v(meta.height),
    v(stats.quality),
    v(stats.longestGap),
    v(gz.byteLength),
    q(stats.status),
    String(now),
    q(contentHash),
  ].join(', ')
  sql.push(
    `INSERT INTO recordings (${cols}) SELECT ${vals} WHERE NOT EXISTS (SELECT 1 FROM recordings WHERE content_hash = ${q(contentHash)});`,
  )
  sql.push(
    `INSERT INTO recording_data (recording_id, gz) SELECT ${q(id)}, X'${gz.toString('hex')}' WHERE EXISTS (SELECT 1 FROM recordings WHERE id = ${q(id)}) AND NOT EXISTS (SELECT 1 FROM recording_data WHERE recording_id = ${q(id)});`,
  )
  takes++
  if (stats.status === 'pending') pending++
  console.log(
    `${file}: ${name} · ${stats.frameCount} frames · ${(stats.durationMs / 1000).toFixed(1)} s · quality ${stats.quality} · ${stats.status}`,
  )
}

console.log(`\n${takes} takes of ${moves.size} moves (${pending} pending review), ${problems.length} skipped`)
for (const p of problems) console.log(`  skipped ${p}`)
if (!takes) process.exit(1)
if (!dryRun) {
  writeFileSync(out, sql.join('\n') + '\n')
  console.log(`wrote ${out}`)
}
