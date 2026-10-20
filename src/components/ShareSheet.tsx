import { useState } from 'react'
import { uploadRecording, type UploadResult } from '../api/client'
import type { LocalRecording } from '../recording/types'
import { Turnstile } from './Turnstile'

const NICK_KEY = 'cardistry.nickname'

function readNick() {
  try {
    return localStorage.getItem(NICK_KEY) ?? ''
  } catch {
    return ''
  }
}

interface Props {
  recording: LocalRecording
  onDone: (result: UploadResult) => void
  onClose: () => void
}

/** Confirms and uploads one local recording's landmarks to the shared library. */
export function ShareSheet({ recording, onDone, onClose }: Props) {
  const [nickname, setNickname] = useState(readNick)
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const share = async () => {
    if (token === null) return
    setBusy(true)
    setError('')
    try {
      try {
        localStorage.setItem(NICK_KEY, nickname.trim())
      } catch {
        // Not remembered in private mode.
      }
      onDone(await uploadRecording(recording, nickname.trim(), token))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-label="Share recording">
        <h2>Share this {recording.moveName} to the library</h2>
        <p className="small">
          Only the hand landmarks are shared (the wireframe points), never video. They are public, anyone can replay them,
          and they are used to train the shared move recogniser. You can delete it later from this browser.
        </p>
        <label className="field">
          <span>Nickname (optional, shown on the recording)</span>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={30} placeholder="Anonymous" />
        </label>
        <Turnstile onToken={setToken} onError={setError} />
        {error && <p className="error">{error}</p>}
        <div className="sheet-actions">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={share} disabled={busy || token === null}>
            {busy ? 'Sharing…' : token === null ? 'Checking…' : 'Share'}
          </button>
        </div>
      </div>
    </div>
  )
}
