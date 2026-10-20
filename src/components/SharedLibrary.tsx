import { useEffect, useState } from 'react'
import {
  deleteSharedRecording,
  fetchMove,
  fetchMoves,
  fetchRecordingFrames,
  hasDeleteKey,
  type SharedMove,
  type SharedRecording,
} from '../api/client'
import { sharingEnabled } from '../config'
import type { Frame } from '../tracking/types'
import { ReplayCanvas } from './ReplayCanvas'

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

function RecordingItem({ rec, onDeleted }: { rec: SharedRecording; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [frames, setFrames] = useState<Frame[] | null>(null)
  const [error, setError] = useState('')
  const canDelete = rec.mine && hasDeleteKey(rec.id)

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && !frames) {
      fetchRecordingFrames(rec.id)
        .then(setFrames)
        .catch((err: Error) => setError(err.message))
    }
  }

  const remove = async () => {
    if (!confirm('Delete your recording from the shared library?')) return
    try {
      await deleteSharedRecording(rec.id)
      onDeleted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <li className={open ? 'is-open' : ''}>
      <button className="rec-row" onClick={toggle}>
        <span>{rec.nickname || 'Anonymous'}</span>
        <span className="muted small tabular">
          {fmtDate(rec.createdAt)} · {(rec.durationMs / 1000).toFixed(1)}s{rec.cameraView ? ` · ${rec.cameraView}` : ''}
          {rec.device ? ` · ${rec.device}` : ''}
        </span>
        {rec.mine && <span className="pill accent">yours</span>}
        {rec.status === 'pending' && <span className="pill">in review</span>}
        <span className={`quality ${rec.qualityScore < 0.6 ? 'low' : ''}`}>{(rec.qualityScore * 100).toFixed(0)}%</span>
      </button>
      {open && (
        <div className="rec-detail">
          {error && <p className="error small">{error}</p>}
          {frames ? (
            <ReplayCanvas
              frames={frames}
              width={rec.width ?? 640}
              height={rec.height ?? 480}
              mirror={rec.camera === 'user'}
            />
          ) : (
            !error && <p className="muted small">Loading…</p>
          )}
          {canDelete && (
            <div className="controls">
              <button className="danger" onClick={remove}>
                Delete from library
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  )
}

/** Browse everyone's shared recordings by move and replay them. */
export function SharedLibrary() {
  const [moves, setMoves] = useState<SharedMove[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ move: SharedMove; recordings: SharedRecording[] } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!sharingEnabled()) return
    fetchMoves()
      .then(setMoves)
      .catch((err: Error) => setError(err.message))
  }, [])

  const loadMove = (slug: string) => {
    setError('')
    fetchMove(slug)
      .then(setDetail)
      .catch((err: Error) => setError(err.message))
  }

  const select = (slug: string | null) => {
    setSelected(slug)
    setDetail(null)
    if (slug) loadMove(slug)
  }

  if (!sharingEnabled()) {
    return (
      <div className="empty">
        <p>The shared library isn't connected yet.</p>
        <p className="muted small">Once it is, you'll be able to share recordings and replay everyone else's here.</p>
      </div>
    )
  }
  if (error && !moves) return <p className="error">{error}</p>
  if (!moves) return <p className="muted">Loading…</p>

  if (selected) {
    return (
      <div className="library">
        <button onClick={() => select(null)}>← All moves</button>
        {error && <p className="error">{error}</p>}
        {!detail ? (
          <p className="muted">Loading…</p>
        ) : (
          <section className="move-group">
            <h3>
              {detail.move.name}
              {detail.move.status === 'proposed' && <span className="pill"> proposed</span>}
            </h3>
            {detail.move.description && <p className="small muted">{detail.move.description}</p>}
            {detail.recordings.length === 0 ? (
              <p className="muted small">No recordings yet. Record one under Camera, then share it from My moves.</p>
            ) : (
              <ul>
                {detail.recordings.map((r) => (
                  <RecordingItem key={r.id} rec={r} onDeleted={() => loadMove(detail.move.slug)} />
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    )
  }

  return (
    <div className="library">
      <p className="muted small">Everyone's shared recordings. Tap a move to replay them.</p>
      <ul className="move-list">
        {moves.map((m) => (
          <li key={m.id}>
            <button className="rec-row" onClick={() => select(m.slug)}>
              <span>{m.name}</span>
              <span className="muted small">{m.category ?? ''}</span>
              {m.status === 'proposed' && <span className="pill">proposed</span>}
              <span className="quality">{m.recordingCount}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
