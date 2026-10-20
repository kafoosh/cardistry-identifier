import { useRef, useState } from 'react'
import { MAX_BATCH, readNick, rememberNick, uploadBatch, type BatchItemResult } from '../api/client'
import { invalidateMoveCandidates } from '../recording/moveNames'
import type { LocalRecording } from '../recording/types'
import { Turnstile } from './Turnstile'

export interface ShareOutcome {
  recording: LocalRecording
  result: BatchItemResult
}

interface Props {
  recordings: LocalRecording[]
  onDone: (outcomes: ShareOutcome[]) => void
  onClose: () => void
}

/**
 * Confirms and uploads local recordings' landmarks to the shared library,
 * in batches of up to 20, each behind a fresh Turnstile check.
 */
export function ShareSheet({ recordings, onDone, onClose }: Props) {
  const [nickname, setNickname] = useState(readNick)
  const [token, setToken] = useState<string | null>(null)
  const [widgetKey, setWidgetKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  const waiter = useRef<((t: string) => void) | null>(null)

  const onToken = (t: string | null) => {
    setToken(t)
    if (t !== null && waiter.current) {
      waiter.current(t)
      waiter.current = null
    }
  }

  const nextToken = () =>
    new Promise<string>((resolve) => {
      waiter.current = resolve
      setToken(null)
      setWidgetKey((k) => k + 1)
    })

  const share = async () => {
    if (token === null) return
    setBusy(true)
    setError('')
    rememberNick(nickname)
    const outcomes: ShareOutcome[] = []
    try {
      let current: string = token
      for (let i = 0; i < recordings.length; i += MAX_BATCH) {
        if (i > 0) current = await nextToken()
        const chunk = recordings.slice(i, i + MAX_BATCH)
        const results = await uploadBatch(chunk, nickname.trim(), current)
        chunk.forEach((recording, k) => outcomes.push({ recording, result: results[k] }))
        setProgress(outcomes.length)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
      if (!outcomes.length) return
    }
    invalidateMoveCandidates()
    onDone(outcomes)
  }

  const many = recordings.length > 1
  const moves = [...new Set(recordings.map((r) => r.moveName))]

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-label="Share to library">
        <h2>
          {many ? `Share ${recordings.length} recordings to the library` : `Share this ${recordings[0].moveName} to the library`}
        </h2>
        {many && (
          <p className="small muted">
            {moves.slice(0, 6).join(', ')}
            {moves.length > 6 ? ` and ${moves.length - 6} more` : ''}. Anything already in the library is skipped.
          </p>
        )}
        <p className="small">
          Only the hand landmarks are shared (the wireframe points), never video. They are public, anyone can replay them,
          and they are used to train the shared move recogniser. You can delete your recordings later from this browser.
        </p>
        <label className="field">
          <span>Nickname (optional, shown on the recordings)</span>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={30} placeholder="Anonymous" />
        </label>
        <Turnstile key={widgetKey} onToken={onToken} onError={setError} />
        {busy && many && (
          <p className="small muted tabular">
            Shared {progress} of {recordings.length}…
          </p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="sheet-actions">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={share} disabled={busy || token === null}>
            {busy ? 'Sharing…' : token === null ? 'Checking…' : many ? `Share ${recordings.length}` : 'Share'}
          </button>
        </div>
      </div>
    </div>
  )
}
