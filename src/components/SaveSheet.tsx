import { useEffect, useMemo, useState } from 'react'
import { detectActiveHands, keepHands } from '../recording/activeHands'
import { longestGapMs, qualityScore, type Capture } from '../recording/recorder'
import { SLOT_COLOURS } from '../tracking/draw'
import type { Frame } from '../tracking/types'
import { STARTER_MOVES, type CameraView, type DominantHand } from '../recording/types'
import { ReplayCanvas } from './ReplayCanvas'

export interface SaveDetails {
  moveName: string
  cameraView: CameraView
  dominantHand: DominantHand
  keepVideo: boolean
  /** Frames with idle hands removed. */
  frames: Frame[]
}

interface Props {
  capture: Capture
  width: number
  height: number
  mirror: boolean
  knownMoves: string[]
  /** `again` starts the next take straight away. */
  onSave: (details: SaveDetails, again: boolean) => void
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
  const activity = useMemo(() => detectActiveHands(capture.frames), [capture.frames])
  const [kept, setKept] = useState(() => new Set(activity.filter((h) => h.active).map((h) => h.slot)))
  const frames = useMemo(() => keepHands(capture.frames, kept), [capture.frames, kept])

  const videoUrl = useMemo(() => (capture.video ? URL.createObjectURL(capture.video) : null), [capture.video])
  useEffect(() => () => void (videoUrl && URL.revokeObjectURL(videoUrl)), [videoUrl])

  const moveName = (choice === OTHER ? custom : choice).trim()
  const tooShort = capture.frames.length < 10
  const quality = useMemo(() => qualityScore(frames), [frames])
  const gap = useMemo(() => longestGapMs(frames), [frames])

  const toggleHand = (slot: 0 | 1) =>
    setKept((prev) => {
      const next = new Set(prev)
      if (next.has(slot)) next.delete(slot)
      else next.add(slot)
      return next
    })

  const save = (again: boolean) => {
    if (!moveName || !kept.size) return
    const prefsOut = { moveName, cameraView, dominantHand, keepVideo }
    savePrefs(prefsOut)
    onSave({ ...prefsOut, frames }, again)
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-label="Save recording">
        <h2>Save this recording</h2>
        <ReplayCanvas frames={frames} width={width} height={height} mirror={mirror} videoUrl={videoUrl} />
        <p className="small muted">
          {(capture.durationMs / 1000).toFixed(1)}s · {frames.length} frames
          {' · '}hands tracked {(quality * 100).toFixed(0)}%
          {gap > 0 ? ` · longest drop ${(gap / 1000).toFixed(2)}s` : ' · no drops'}
          {capture.video ? ' · video clip captured' : ''}
        </p>
        {tooShort && <p className="hint">This recording is very short. Try again and hold the move for longer.</p>}

        {activity.some((h) => h.presence > 0) && (
          <div className="field">
            <span>Hands in this move (idle hands are left out)</span>
            <div className="hand-chips">
              {activity
                .filter((h) => h.presence > 0)
                .map((h) => (
                  <button
                    key={h.slot}
                    className={`hand-chip ${kept.has(h.slot) ? 'selected' : ''}`}
                    onClick={() => toggleHand(h.slot)}
                    aria-pressed={kept.has(h.slot)}
                  >
                    <span className="dot" style={{ background: SLOT_COLOURS[h.slot] }} />
                    {h.handedness ?? `Hand ${h.slot ? 'B' : 'A'}`} hand
                    <span className="muted small">{kept.has(h.slot) ? (h.active ? 'moving' : 'kept') : 'idle, left out'}</span>
                  </button>
                ))}
            </div>
          </div>
        )}

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

        <div className="sheet-actions">
          <button onClick={onDiscard}>Discard</button>
          <button onClick={() => save(false)} disabled={!moveName || tooShort || !kept.size}>
            Save
          </button>
          <button className="primary" onClick={() => save(true)} disabled={!moveName || tooShort || !kept.size}>
            Save &amp; record another
          </button>
        </div>
      </div>
    </div>
  )
}
