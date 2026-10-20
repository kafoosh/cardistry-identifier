import { fetchMoves } from '../api/client'
import { sharingEnabled } from '../config'
import { listRecordings } from '../storage/db'
import { STARTER_MOVES } from './types'

export interface MoveCandidate {
  name: string
  aliases: string[]
  /** Recordings of it in the shared library. */
  libraryCount: number
  /** Recordings of it on this device. */
  mineCount: number
  inLibrary: boolean
}

/** Lowercase letters and digits only, so "Sybil Cut", "sybil-cut" and "sybilcut" compare equal. */
export const normaliseName = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '')

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length]
}

/** Words that people add or drop when naming the same move. */
const FILLER = /(cut|cuts|spin|spins|flourish)$/

/** How close a typed name is to a candidate: lower is better, Infinity means unrelated. */
function score(query: string, c: MoveCandidate): number {
  const q = normaliseName(query)
  if (!q) return 1000 - c.libraryCount - c.mineCount // empty: list popular first
  let best = Infinity
  for (const n of [c.name, ...c.aliases].map(normaliseName)) {
    if (n === q) return 0
    if (n.replace(FILLER, '') === q.replace(FILLER, '')) best = Math.min(best, 1)
    if (n.startsWith(q)) best = Math.min(best, 2)
    else if (n.includes(q)) best = Math.min(best, 3)
    const d = levenshtein(q, n)
    if (d <= Math.max(1, Math.floor(n.length / 5))) best = Math.min(best, 3 + d)
  }
  return best
}

/** Best matches for what's typed, most relevant (then most recorded) first. */
export function suggestMoves(query: string, candidates: MoveCandidate[], limit = 6): MoveCandidate[] {
  return candidates
    .map((c) => ({ c, s: score(query, c) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s || b.c.libraryCount + b.c.mineCount - (a.c.libraryCount + a.c.mineCount) || a.c.name.localeCompare(b.c.name))
    .slice(0, limit)
    .map((x) => x.c)
}

/** An existing move the typed name probably means (same name ignoring case/spacing, or a near-typo). */
export function findExisting(name: string, candidates: MoveCandidate[]): { match: MoveCandidate; exact: boolean } | null {
  const q = normaliseName(name)
  if (!q) return null
  for (const c of candidates) {
    if ([c.name, ...c.aliases].some((n) => normaliseName(n) === q)) return { match: c, exact: true }
  }
  const [top] = suggestMoves(name, candidates, 1)
  return top && score(name, top) <= 4 ? { match: top, exact: false } : null
}

let libraryCache: Promise<MoveCandidate[]> | null = null

/** Move names from the starter list, this device's recordings and the shared library, merged by name. */
export async function loadMoveCandidates(): Promise<MoveCandidate[]> {
  const byKey = new Map<string, MoveCandidate>()
  const add = (name: string, patch: Partial<MoveCandidate>) => {
    const key = normaliseName(name)
    const prev = byKey.get(key) ?? { name, aliases: [], libraryCount: 0, mineCount: 0, inLibrary: false }
    byKey.set(key, { ...prev, ...patch, aliases: [...new Set([...prev.aliases, ...(patch.aliases ?? [])])] })
  }
  for (const name of STARTER_MOVES) add(name, {})

  if (sharingEnabled()) {
    libraryCache ??= fetchMoves()
      .then((moves) =>
        moves.map((m) => ({ name: m.name, aliases: m.aliases, libraryCount: m.recordingCount, mineCount: 0, inLibrary: true })),
      )
      .catch(() => {
        libraryCache = null
        return []
      })
    for (const m of await libraryCache) add(m.name, { name: m.name, aliases: m.aliases, libraryCount: m.libraryCount, inLibrary: true })
  }

  const mine = new Map<string, number>()
  for (const r of await listRecordings().catch(() => [])) mine.set(r.moveName, (mine.get(r.moveName) ?? 0) + 1)
  for (const [name, count] of mine) {
    const key = normaliseName(name)
    add(byKey.get(key)?.name ?? name, { mineCount: (byKey.get(key)?.mineCount ?? 0) + count })
  }
  return [...byKey.values()]
}

/** Forget the cached library list (after sharing adds new moves). */
export function invalidateMoveCandidates() {
  libraryCache = null
}
