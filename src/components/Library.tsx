import { useEffect, useMemo, useState } from 'react'
import type { LocalRecording, RecordingSummary } from '../recording/types'
import { deleteRecording, listRecordings, loadRecording, loadVideo, renameRecording } from '../storage/db'
import { ReplayCanvas } from './ReplayCanvas'

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

/** Recordings saved on this device, grouped by move, with replay, rename, delete and export. */
export function Library({ onRecordMore }: { onRecordMore: () => void }) {
  const [items, setItems] = useState<RecordingSummary[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [open, setOpen] = useState<LocalRecording | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refresh = () =>
    listRecordings()
      .then(setItems)
      .catch((err) => setError(String(err)))

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    if (!openId) return
    void (async () => {
      const rec = await loadRecording(openId)
      const video = rec?.hasVideo ? await loadVideo(openId) : null
      if (cancelled) return
      if (video) {
        url = URL.createObjectURL(video)
        setVideoUrl(url)
      }
      setOpen(rec)
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [openId])

  const toggle = (id: string) => {
    setOpen(null)
    setVideoUrl(null)
    setOpenId(openId === id ? null : id)
  }

  const groups = useMemo(() => {
    const map = new Map<string, RecordingSummary[]>()
    for (const r of items ?? []) map.set(r.moveName, [...(map.get(r.moveName) ?? []), r])
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [items])

  const exportAll = async () => {
    const all = await Promise.all((items ?? []).map((r) => loadRecording(r.id)))
    const payload = { format: 'cardistry-identifier/recordings', version: 1, exportedAt: Date.now(), recordings: all.filter(Boolean) }
    download(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `cardistry-recordings-${Date.now()}.json`)
  }

  const remove = async (r: RecordingSummary) => {
    if (!confirm(`Delete this ${r.moveName} recording? This can't be undone.`)) return
    await deleteRecording(r.id)
    if (openId === r.id) toggle(r.id)
    await refresh()
  }

  const rename = async (r: RecordingSummary) => {
    const name = prompt('Move name', r.moveName)?.trim()
    if (!name || name === r.moveName) return
    await renameRecording(r.id, name)
    await refresh()
  }

  if (error) return <p className="error">{error}</p>
  if (!items) return <p className="muted">Loading…</p>

  if (!items.length) {
    return (
      <div className="empty">
        <p>No recordings yet.</p>
        <p className="muted small">
          Record each starter move about five times, from your phone and your laptop. Recordings stay on this device.
        </p>
        <button className="primary" onClick={onRecordMore}>
          Record a move
        </button>
      </div>
    )
  }

  return (
    <div className="library">
      <div className="library-head">
        <p className="muted small">
          {items.length} recording{items.length === 1 ? '' : 's'} of {groups.length} move{groups.length === 1 ? '' : 's'}
          , saved on this device only.
        </p>
        <button onClick={exportAll}>Export all (JSON)</button>
      </div>

      {groups.map(([move, recs]) => (
        <section key={move} className="move-group">
          <h3>
            {move} <span className="muted small">× {recs.length}</span>
          </h3>
          <ul>
            {recs.map((r) => (
              <li key={r.id} className={openId === r.id ? 'is-open' : ''}>
                <button className="rec-row" onClick={() => toggle(r.id)}>
                  <span>{fmtDate(r.createdAt)}</span>
                  <span className="muted small tabular">
                    {(r.durationMs / 1000).toFixed(1)}s · {r.cameraView} · {r.camera === 'user' ? 'front cam' : 'rear cam'}{' '}
                    · {r.device}
                    {r.longestGapMs ? ` · longest drop ${(r.longestGapMs / 1000).toFixed(2)}s` : ''}
                  </span>
                  <span className={`quality ${r.qualityScore < 0.6 ? 'low' : ''}`}>
                    {(r.qualityScore * 100).toFixed(0)}%
                  </span>
                </button>
                {openId === r.id && (
                  <div className="rec-detail">
                    {open ? (
                      <ReplayCanvas
                        frames={open.frames}
                        width={open.videoWidth}
                        height={open.videoHeight}
                        mirror={open.camera === 'user'}
                        videoUrl={videoUrl}
                      />
                    ) : (
                      <p className="muted small">Loading…</p>
                    )}
                    <div className="controls">
                      <button onClick={() => rename(r)}>Rename</button>
                      {open && (
                        <button
                          onClick={() =>
                            download(
                              new Blob([JSON.stringify(open)], { type: 'application/json' }),
                              `${slug(r.moveName)}-${r.id.slice(0, 8)}.json`,
                            )
                          }
                        >
                          Download landmarks
                        </button>
                      )}
                      {videoUrl && (
                        <button
                          onClick={async () => {
                            const v = await loadVideo(r.id)
                            if (v) download(v, `${slug(r.moveName)}-${r.id.slice(0, 8)}.${v.type.includes('mp4') ? 'mp4' : 'webm'}`)
                          }}
                        >
                          Download video
                        </button>
                      )}
                      <button className="danger" onClick={() => remove(r)}>
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
