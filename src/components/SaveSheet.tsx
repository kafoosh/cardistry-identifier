import { useEffect, useMemo, useRef, useState } from 'react'
import { detectActiveHands, keepHands } from '../recording/activeHands'
import { longestGapMs, qualityScore, type Capture } from '../recording/recorder'
import { sliceFrames } from '../recognition/motion'
import { SLOT_COLOURS } from '../tracking/draw'
import type { Frame } from '../tracking/types'
import { MovePicker } from './MovePicker'
import { ReplayCanvas, type ReplayHandle } from './ReplayCanvas'
import { TrimBar } from './TrimBar'

export interface SaveDetails {
  moveName: string
  keepVideo: boolean
  /** Frames inside the trim, with idle hands removed; times start at 0. */
  frames: Frame[]
  durationMs: number
  /** Frame time at which the kept video's time 0 falls, after trimming. */
  videoStartMs: number
}


interface Props {
  capture: Capture
  moveName: string
  width: number
  height: number
  mirror: boolean
  /** `again` starts the next take straight away. */
  onSave: (details: SaveDetails, again: boolean) => void
  onDiscard: () => void
}

/** Shown after a take: replay it, check which hands count, and save or discard. */
export function SaveSheet({ capture, moveName: declared, width, height, mirror, onSave, onDiscard }: Props) {
  const [moveName, setMoveName] = useState(declared)
  const [editingName, setEditingName] = useState(!declared)
  const [keepVideo, setKeepVideo] = useState(true)
  const fullMs = capture.frames.length ? capture.frames[capture.frames.length - 1].t : 0
  const [trim, setTrim] = useState(() => capture.suggestedTrim ?? { startMs: 0, endMs: fullMs })
  const replay = useRef<ReplayHandle>(null)
  const trimmed = useMemo(() => sliceFrames(capture.frames, trim.startMs, trim.endMs), [capture.frames, trim])
  const activity = useMemo(() => detectActiveHands(capture.frames), [capture.frames])
  const [kept, setKept] = useState(() => new Set(activity.filter((h) => h.active).map((h) => h.slot)))
  // Replay shows the whole take (so the cut can be widened again); saving keeps only the trimmed part.
  const replayFrames = useMemo(() => keepHands(capture.frames, kept), [capture.frames, kept])
  const frames = useMemo(() => keepHands(trimmed, kept), [trimmed, kept])
  const trimBase = capture.frames.find((f) => f.t >= trim.startMs)?.t ?? 0
  const durationMs = frames.length ? frames[frames.length - 1].t : 0

  const videoUrl = useMemo(() => (capture.video ? URL.createObjectURL(capture.video) : null), [capture.video])
  useEffect(() => () => void (videoUrl && URL.revokeObjectURL(videoUrl)), [videoUrl])

  const tooShort = frames.length < 10
  const quality = useMemo(() => qualityScore(frames), [frames])
  const gap = useMemo(() => longestGapMs(frames), [frames])
  const canSave = Boolean(moveName.trim()) && !tooShort && kept.size > 0

  const toggleHand = (slot: 0 | 1) =>
    setKept((prev) => {
      const next = new Set(prev)
      if (next.has(slot)) next.delete(slot)
      else next.add(slot)
      return next
    })

  const save = (again: boolean) => {
    if (canSave) onSave({ moveName: moveName.trim(), keepVideo, frames, durationMs, videoStartMs: capture.videoStartMs - trimBase }, again)
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-label="Save recording">
        <div className="sheet-title">
          {editingName ? (
            <label className="field">
              <span>Move</span>
              <MovePicker value={moveName} onChange={setMoveName} autoFocus />
            </label>
          ) : (
            <>
              <h2>{moveName}</h2>
              <button className="link" onClick={() => setEditingName(true)}>
                Change move
              </button>
            </>
          )}
        </div>
        <ReplayCanvas
          frames={replayFrames}
          range={trim}
          handle={replay}
          width={width}
          height={height}
          mirror={mirror}
          videoUrl={videoUrl}
          videoStartMs={capture.videoStartMs}
        />
        <TrimBar
          durationMs={fullMs}
          value={trim}
          onChange={(next, moved) => {
            setTrim(next)
            replay.current?.seek(moved === 'start' ? next.startMs : next.endMs)
          }}
        />
        <p className="small muted">
          {(durationMs / 1000).toFixed(1)}s kept of {(fullMs / 1000).toFixed(1)}s · {frames.length} frames
          {' · '}hands tracked {(quality * 100).toFixed(0)}%
          {gap > 0 ? ` · longest drop ${(gap / 1000).toFixed(2)}s` : ' · no drops'}
          {capture.video ? ' · video clip captured' : ''}
        </p>
        {tooShort && <p className="hint">This take is very short. Widen the trim, or try again and hold the move for longer.</p>}

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

        {capture.video && (
          <label className="check">
            <input type="checkbox" checked={keepVideo} onChange={(e) => setKeepVideo(e.target.checked)} />
            Keep the video clip on this device
          </label>
        )}

        <div className="sheet-actions">
          <button onClick={onDiscard}>Discard</button>
          <button onClick={() => save(false)} disabled={!canSave}>
            Save
          </button>
          <button className="primary" onClick={() => save(true)} disabled={!canSave}>
            Save &amp; record another
          </button>
        </div>
      </div>
    </div>
  )
}
