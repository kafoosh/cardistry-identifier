import { useEffect, useMemo, useState } from 'react'
import { longestGapMs, qualityScore, type Capture } from '../recording/recorder'
import { STARTER_MOVES, type CameraView, type DominantHand } from '../recording/types'
import { ReplayCanvas } from './ReplayCanvas'

export interface SaveDetails {
  moveName: string
  cameraView: CameraView
  dominantHand: DominantHand
  keepVideo: boolean
}

interface Props {
  capture: Capture
  width: number
  height: number
  mirror: boolean
  knownMoves: string[]
  onSave: (details: SaveDetails) => Promise<void>
  onDiscard: () => void
}

const PREFS_KEY = 'cardistry.savePrefs'
const OTHER = '__other__'

function loadPrefs(): Partial<SaveDetails> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}')
  } catch {
    return {}
  }
}

function savePrefs(p: Partial<SaveDetails>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    // Private mode; preferences just won't be remembered.
  }
}

/** Shown after a recording: replay it, name the move and save or discard. */
export function SaveSheet({ capture, width, height, mirror, knownMoves, onSave, onDiscard }: Props) {
  const [prefs] = useState(loadPrefs)
  const options = useMemo(
    () => [...new Set([...STARTER_MOVES, ...knownMoves])].sort((a, b) => a.localeCompare(b)),
    [knownMoves],
  )
  const [choice, setChoice] = useState(prefs.moveName && options.includes(prefs.moveName) ? prefs.moveName : options[0])
  const [custom, setCustom] = useState('')
  const [cameraView, setCameraView] = useState<CameraView>(prefs.cameraView ?? 'front')
  const [dominantHand, setDominantHand] = useState<DominantHand>(prefs.dominantHand ?? 'right')
  const [keepVideo, setKeepVideo] = useState(prefs.keepVideo ?? true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const videoUrl = useMemo(() => (capture.video ? URL.createObjectURL(capture.video) : null), [capture.video])
  useEffect(() => () => void (videoUrl && URL.revokeObjectURL(videoUrl)), [videoUrl])

  const moveName = (choice === OTHER ? custom : choice).trim()
  const tooShort = capture.frames.length < 10
  const quality = useMemo(() => qualityScore(capture.frames), [capture.frames])
  const gap = useMemo(() => longestGapMs(capture.frames), [capture.frames])

  const save = async () => {
    if (!moveName) return
    setSaving(true)
    setError('')
    try {
      const details = { moveName, cameraView, dominantHand, keepVideo }
      savePrefs(details)
      await onSave(details)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-label="Save recording">
        <h2>Save this recording</h2>
        <ReplayCanvas frames={capture.frames} width={width} height={height} mirror={mirror} videoUrl={videoUrl} />
        <p className="small muted">
          {(capture.durationMs / 1000).toFixed(1)}s · {capture.frames.length} frames
          {' · '}hands tracked {(quality * 100).toFixed(0)}%
          {gap > 0 ? ` · longest drop ${(gap / 1000).toFixed(2)}s` : ' · no drops'}
          {capture.video ? ' · video clip captured' : ''}
        </p>
        {tooShort && <p className="hint">This recording is very short. Try again and hold the move for longer.</p>}

        <label className="field">
          <span>Move</span>
          <select value={choice} onChange={(e) => setChoice(e.target.value)}>
            {options.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={OTHER}>Another move…</option>
          </select>
        </label>
        {choice === OTHER && (
          <label className="field">
            <span>Move name</span>
            <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. Sybil cut" autoFocus />
          </label>
        )}

        <div className="field-row">
          <label className="field">
            <span>Camera angle</span>
            <select value={cameraView} onChange={(e) => setCameraView(e.target.value as CameraView)}>
              <option value="front">Front</option>
              <option value="top-down">Top-down</option>
              <option value="side">Side</option>
            </select>
          </label>
          <label className="field">
            <span>Dominant hand</span>
            <select value={dominantHand} onChange={(e) => setDominantHand(e.target.value as DominantHand)}>
              <option value="right">Right</option>
              <option value="left">Left</option>
            </select>
          </label>
        </div>

        {capture.video && (
          <label className="check">
            <input type="checkbox" checked={keepVideo} onChange={(e) => setKeepVideo(e.target.checked)} />
            Keep the video clip on this device
          </label>
        )}

        {error && <p className="error">{error}</p>}
        <div className="sheet-actions">
          <button onClick={onDiscard} disabled={saving}>
            Discard
          </button>
          <button className="primary" onClick={save} disabled={saving || !moveName || tooShort}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
