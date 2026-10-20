import { useEffect, useState } from 'react'
import {
  adminToken,
  deleteRecording,
  fetchOverview,
  resolveReport,
  saveSettings,
  setAdminToken,
  updateMove,
  updateRecording,
  type AdminMove,
  type AdminOverview,
  type AdminRecording,
} from '../api/admin'

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

function TokenForm({ error, onSubmit }: { error: string; onSubmit: (token: string) => void }) {
  const [token, setToken] = useState('')
  return (
    <form
      className="library admin-login"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(token.trim())
      }}
    >
      <h3>Admin</h3>
      <p className="muted small">
        Enter the admin token (the ADMIN_TOKEN secret from the repository settings). It is kept in this browser only.
      </p>
      <label className="field">
        <span>Admin token</span>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
      </label>
      {error && <p className="error small">{error}</p>}
      <div className="controls">
        <button className="primary" type="submit" disabled={!token.trim()}>
          Open admin
        </button>
      </div>
    </form>
  )
}

function MoveRow({
  move,
  moves,
  onChange,
}: {
  move: AdminMove
  moves: AdminMove[]
  onChange: (change: { status?: AdminMove['status']; name?: string; mergeInto?: string }) => void
}) {
  const [merging, setMerging] = useState(false)
  const [target, setTarget] = useState('')
  const rename = () => {
    const name = prompt('New name for this move', move.name)?.trim()
    if (name && name !== move.name) onChange({ name })
  }
  const targets = moves.filter((m) => m.id !== move.id && (m.status === 'approved' || m.status === 'proposed'))
  return (
    <li className="admin-row">
      <div className="admin-row-main">
        <strong>{move.name}</strong>
        {move.status !== 'approved' && (
          <span className={`pill ${move.status === 'rejected' ? 'warn' : ''}`}>{move.status}</span>
        )}
        <span className="muted small">
          {move.recordingCount} {move.recordingCount === 1 ? 'take' : 'takes'}
          {move.aliases.length ? ` · also ${move.aliases.join(', ')}` : ''}
          {move.status === 'merged' && move.mergedInto
            ? ` · merged into ${moves.find((m) => m.id === move.mergedInto)?.name ?? '?'}`
            : ''}
          {' · '}
          {fmtDate(move.createdAt)}
        </span>
      </div>
      {move.status !== 'merged' && (
        <div className="controls admin-actions">
          {move.status !== 'approved' && (
            <button className="link" onClick={() => onChange({ status: 'approved' })}>
              Approve
            </button>
          )}
          {move.status !== 'rejected' && (
            <button className="link" onClick={() => onChange({ status: 'rejected' })}>
              Turn down
            </button>
          )}
          {move.status === 'rejected' && (
            <button className="link" onClick={() => onChange({ status: 'proposed' })}>
              Back to proposed
            </button>
          )}
          <button className="link" onClick={rename}>
            Rename
          </button>
          {!merging ? (
            <button className="link" onClick={() => setMerging(true)}>
              Merge into…
            </button>
          ) : (
            <span className="admin-merge">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Pick a move</option>
                {targets.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              <button
                className="link"
                disabled={!target}
                onClick={() => {
                  if (
                    confirm(`Move every take of "${move.name}" into "${targets.find((m) => m.id === target)?.name}"?`)
                  ) {
                    onChange({ mergeInto: target })
                    setMerging(false)
                  }
                }}
              >
                Merge
              </button>
              <button className="link" onClick={() => setMerging(false)}>
                Cancel
              </button>
            </span>
          )}
        </div>
      )}
    </li>
  )
}

function TakeRow({
  rec,
  onStatus,
  onDelete,
}: {
  rec: AdminRecording
  onStatus: (status: AdminRecording['status']) => void
  onDelete: () => void
}) {
  return (
    <li className="admin-row">
      <div className="admin-row-main">
        <strong>{rec.moveName}</strong>
        {rec.status !== 'approved' && (
          <span className={`pill ${rec.status === 'rejected' ? 'warn' : ''}`}>{rec.status}</span>
        )}
        <span className="muted small tabular">
          {rec.nickname || 'Anonymous'} · {fmtDate(rec.createdAt)} · {(rec.durationMs / 1000).toFixed(1)}s ·{' '}
          {(rec.qualityScore * 100).toFixed(0)}%{rec.cameraView ? ` · ${rec.cameraView}` : ''}
          {rec.device ? ` · ${rec.device}` : ''} · device {rec.deviceId.slice(0, 8)}
        </span>
      </div>
      <div className="controls admin-actions">
        {rec.status !== 'approved' && (
          <button className="link" onClick={() => onStatus('approved')}>
            Approve
          </button>
        )}
        {rec.status !== 'pending' && (
          <button className="link" onClick={() => onStatus('pending')}>
            Hold
          </button>
        )}
        {rec.status !== 'rejected' && (
          <button className="link" onClick={() => onStatus('rejected')}>
            Reject
          </button>
        )}
        <button className="link danger-link" onClick={() => confirm('Delete this take for good?') && onDelete()}>
          Delete
        </button>
      </div>
    </li>
  )
}

type TakeFilter = 'pending' | 'all' | 'rejected'

/** The owner's control room: the proposed-moves switch, every move, recent takes and open reports. */
export function Admin() {
  const [hasToken, setHasToken] = useState(() => !!adminToken())
  const [data, setData] = useState<AdminOverview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [takeFilter, setTakeFilter] = useState<TakeFilter>('pending')

  const load = () =>
    fetchOverview()
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((err: Error) => {
        setError(err.message)
        if (/token/i.test(err.message)) {
          setData(null)
          setHasToken(false)
        }
      })

  useEffect(() => {
    if (hasToken) void load()
  }, [hasToken])

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await action()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!hasToken) {
    return (
      <TokenForm
        error={error}
        onSubmit={(token) => {
          setAdminToken(token)
          setError('')
          setHasToken(true)
        }}
      />
    )
  }
  if (!data) return <p className="muted">{error || 'Loading…'}</p>

  const takes = data.recordings.filter((r) =>
    takeFilter === 'all'
      ? r.status !== 'rejected'
      : takeFilter === 'pending'
        ? r.status === 'pending'
        : r.status === 'rejected',
  )
  const visibleMoves = data.moves.filter((m) => m.status !== 'merged')

  return (
    <div className={`library admin ${busy ? 'is-busy' : ''}`}>
      <div className="admin-head">
        <h3>Admin</h3>
        <button
          className="link"
          onClick={() => {
            setAdminToken('')
            setData(null)
            setHasToken(false)
          }}
        >
          Forget token
        </button>
      </div>
      {error && <p className="error small">{error}</p>}

      <section className="move-group">
        <label className="check">
          <input
            type="checkbox"
            checked={data.settings.acceptProposedMoves}
            disabled={busy}
            onChange={(e) => run(() => saveSettings({ acceptProposedMoves: e.target.checked }))}
          />
          Accept new move names from uploads
        </label>
        <p className="muted small">
          When off, uploads must use a move already in the list; new names are turned away with a message. Each device
          can share 10 takes per move; uploads from this browser are not capped while the token is set.
        </p>
      </section>

      <section className="move-group">
        <h3>Moves</h3>
        {!visibleMoves.length && <p className="muted small">No moves yet.</p>}
        <ul className="admin-list">
          {visibleMoves.map((m) => (
            <MoveRow
              key={m.id}
              move={m}
              moves={data.moves}
              onChange={(change) => run(() => updateMove(m.id, change))}
            />
          ))}
        </ul>
      </section>

      <section className="move-group">
        <h3>Takes</h3>
        <div className="controls">
          {(['pending', 'all', 'rejected'] as TakeFilter[]).map((f) => (
            <button key={f} className={takeFilter === f ? 'selected' : ''} onClick={() => setTakeFilter(f)}>
              {f === 'pending' ? 'In review' : f === 'all' ? 'All' : 'Rejected'}
            </button>
          ))}
        </div>
        {!takes.length && <p className="muted small">Nothing here.</p>}
        <ul className="admin-list">
          {takes.map((r) => (
            <TakeRow
              key={r.id}
              rec={r}
              onStatus={(status) => run(() => updateRecording(r.id, status))}
              onDelete={() => run(() => deleteRecording(r.id))}
            />
          ))}
        </ul>
        {data.recordings.length >= 200 && <p className="muted small">Showing the latest 200 takes.</p>}
      </section>

      <section className="move-group">
        <h3>Reports</h3>
        {!data.reports.length && <p className="muted small">No open reports.</p>}
        <ul className="admin-list">
          {data.reports.map((rep) => (
            <li key={rep.id} className="admin-row">
              <div className="admin-row-main">
                <strong>{rep.targetType}</strong>
                <span className="muted small">
                  {rep.reason || 'No reason given'} · {rep.targetId.slice(0, 8)} · {fmtDate(rep.createdAt)}
                </span>
              </div>
              <div className="controls admin-actions">
                <button className="link" onClick={() => run(() => resolveReport(rep.id))}>
                  Resolve
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
