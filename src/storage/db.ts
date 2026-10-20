import type { LocalRecording, RecordingSummary } from '../recording/types'

const DB_NAME = 'cardistry-identifier'
const DB_VERSION = 1

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // Summaries are listed often; frames are only loaded for replay.
      const summaries = db.createObjectStore('summaries', { keyPath: 'id' })
      summaries.createIndex('createdAt', 'createdAt')
      db.createObjectStore('frames')
      db.createObjectStore('videos')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveRecording(rec: LocalRecording, video: Blob | null) {
  const db = await open()
  const tx = db.transaction(['summaries', 'frames', 'videos'], 'readwrite')
  const { frames, ...summary } = rec
  tx.objectStore('summaries').put(summary)
  tx.objectStore('frames').put(frames, rec.id)
  if (video) tx.objectStore('videos').put(video, rec.id)
  await done(tx)
}

export async function listRecordings(): Promise<RecordingSummary[]> {
  const db = await open()
  const all = await request(db.transaction('summaries').objectStore('summaries').getAll() as IDBRequest<RecordingSummary[]>)
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function loadRecording(id: string): Promise<LocalRecording | null> {
  const db = await open()
  const tx = db.transaction(['summaries', 'frames'])
  const [summary, frames] = await Promise.all([
    request(tx.objectStore('summaries').get(id) as IDBRequest<RecordingSummary | undefined>),
    request(tx.objectStore('frames').get(id) as IDBRequest<LocalRecording['frames'] | undefined>),
  ])
  return summary && frames ? { ...summary, frames } : null
}

export async function loadVideo(id: string): Promise<Blob | null> {
  const db = await open()
  return (await request(db.transaction('videos').objectStore('videos').get(id) as IDBRequest<Blob | undefined>)) ?? null
}

export async function deleteRecording(id: string) {
  const db = await open()
  const tx = db.transaction(['summaries', 'frames', 'videos'], 'readwrite')
  for (const store of ['summaries', 'frames', 'videos']) tx.objectStore(store).delete(id)
  await done(tx)
}

async function updateSummary(id: string, patch: Partial<RecordingSummary>) {
  const db = await open()
  const tx = db.transaction('summaries', 'readwrite')
  const store = tx.objectStore('summaries')
  const summary = await request(store.get(id) as IDBRequest<RecordingSummary | undefined>)
  if (summary) store.put({ ...summary, ...patch })
  await done(tx)
}

export const renameRecording = (id: string, moveName: string) => updateSummary(id, { moveName })

export const markShared = (id: string, sharedId: string | undefined) => updateSummary(id, { sharedId })

/** Asks the browser not to evict our data under storage pressure (best effort). */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {
    // Not supported; data still saves, it just may be evicted.
  }
}
