import { useEffect, useMemo, useRef, useState } from 'react'
import { readNick, rememberNick } from '../api/client'
import { detectActiveHands, keepHands } from '../recording/activeHands'
import type { Capture } from '../recording/recorder'
import { sliceFrames } from '../recognition/motion'
import { SLOT_COLOURS } from '../tracking/draw'
import type { Frame } from '../tracking/types'
import { MovePicker } from './MovePicker'
import { ReplayCanvas, type ReplayHandle } from './ReplayCanvas'
import { TrimBar } from './TrimBar'
import { Turnstile } from './Turnstile'

const SHARE_KEY = 'cardistry.shareOnSave'

function readShare() {
  try {
    return localStorage.getItem(SHARE_KEY) !== '0'
  } catch {
    return true
  }
}

export interface SaveDetails {
  moveName: string
  keepVideo: boolean
  /** Frames inside the trim, with idle hands removed; times start at 0. */
  frames: Frame[]
  durationMs: number
  /** Frame time at which the kept video's time 0 falls, after trimming. */
  videoStartMs: number
  /** Also upload the take to the shared library, with this spam-check token and nickname. */
  share: { token: string; nickname: string } | null
}

interface Props {
  capture: Capture
  moveName: string
  width: number
  height: number
  mirror: boolean
  /** The shared library is set up, so Save can upload too. */
  shareable: boolean
  /** `again` starts the next take straight away. */
  onSave: (details: SaveDetails, again: boolean) => void
  onDiscard: () => void
}

/** Shown after a take: replay it, check which hands count, and save or discard. */
export function SaveSheet({ capture, moveName: declared, width, height, mirror, shareable, onSave, onDiscard }: Props) {
  const [moveName, setMoveName] = useState(declared)
  const [editingName, setEditingName] = useState(!declared)
  const [keepVideo, setKeepVideo] = useState(true)
  const fullMs = capture.frames.length ? capture.frames[capture.frames.length - 1].t : 0
  const [trim, setTrim] = useState(() => capture.suggestedTrim ?? { startMs: 0, endMs: fullMs })
  const replay = useRef<ReplayHandle>(null)
  const trimmed = useMemo(() => sliceFrames(capture.frames, trim.startMs, trim.endMs), [capture.frames, trim])
  const activity = useMemo(() => detectActiveHands(capture.frames), [capture.frames])
  const [kept, setKept] = useState(() => new Set(activity.filter((h) => h.active).map((h) => h.slot)))
  // Replay shows the whole take (so the cut can be widened again) and every tracked hand, with
  // left-out hands faded; saving keeps only the trimmed part and the kept hands.
  const leftOut = useMemo(() => new Set(([0, 1] as const).filter((slot) => !kept.has(slot))), [kept])
  const frames = useMemo(() => keepHands(trimmed, kept), [trimmed, kept])
  const trimBase = capture.frames.find((f) => f.t >= trim.startMs)?.t ?? 0
  const durationMs = frames.length ? frames[frames.length - 1].t : 0

  const videoUrl = useMemo(() => (capture.video ? URL.createObjectURL(capture.video) : null), [capture.video])
  useEffect(() => () => void (videoUrl && URL.revokeObjectURL(videoUrl)), [videoUrl])

  const tooShort = frames.length < 10
  const canSave = Boolean(moveName.trim()) && !tooShort && kept.size > 0

  const toggleHand = (slot: 0 | 1) =>
    setKept((prev) => {
      const next = new Set(prev)
      if (next.has(slot)) next.delete(slot)
      else next.add(slot)
      return next
    })

  // Saving shares to the library too, unless switched off; the spam check runs
  // quietly while the take is reviewed, so Save rarely has to wait for it. It
  // starts a moment after the sheet opens (or on Save) so it doesn't hold up
  // the start of the replay.
  const [share, setShare] = useState(readShare)
  const sharing = shareable && share
  const [nickname, setNickname] = useState(readNick)
  const [editingNick, setEditingNick] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [shareError, setShareError] = useState('')
  /** A Save tapped before the spam check finished: whether it was "record another". */
  const [waiting, setWaiting] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setChecking(true), 2000)
    return () => clearTimeout(id)
  }, [])

  const toggleShare = (on: boolean) => {
    setShare(on)
    try {
      localStorage.setItem(SHARE_KEY, on ? '1' : '0')
    } catch {
      // Not remembered in private mode.
    }
  }

  const send = (again: boolean, shareToken: string | null) => {
    if (sharing) rememberNick(nickname)
    const share = sharing && shareToken !== null ? { token: shareToken, nickname: nickname.trim() } : null
    onSave({ moveName: moveName.trim(), keepVideo, frames, durationMs, videoStartMs: capture.videoStartMs - trimBase, share }, again)
  }

  const save = (again: boolean) => {
    if (!canSave) return
    setChecking(true)
    if (sharing && token === null && !shareError) setWaiting(again)
    else send(again, token)
  }

  useEffect(() => {
    if (waiting === null) return
    if (!sharing) send(waiting, null)
    else if (token !== null) send(waiting, token)
    // The check failed: save on this device rather than lose the take.
    else if (shareError) send(waiting, null)
    // Fires once the token (or an error) arrives for a waiting Save, or sharing is switched off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, token, shareError, sharing])

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
          frames={capture.frames}
          faded={leftOut}
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
        {tooShort && <p className="hint">Too short to save. Widen the trim.</p>}

        {activity.some((h) => h.presence > 0) && (
          <div className="hand-chips" aria-label="Hands in this take">
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
                    {!kept.has(h.slot) && <span className="muted small">left out</span>}
                  </button>
                ))}
          </div>
        )}

        {capture.video && (
          <label className="check">
            <input type="checkbox" checked={keepVideo} onChange={(e) => setKeepVideo(e.target.checked)} />
            Keep the video on this phone
          </label>
        )}

        {shareable && (
          <div className="share-on-save">
            <label className="check">
              <input type="checkbox" checked={share} onChange={(e) => toggleShare(e.target.checked)} />
              Share to the library
            </label>
            {share && (
              <span className="small muted">
                as{' '}
                {editingNick ? (
                  <input
                    className="nick"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    maxLength={30}
                    placeholder="Anonymous"
                    aria-label="Nickname"
                    autoFocus
                  />
                ) : (
                  <button className="link" onClick={() => setEditingNick(true)}>
                    {nickname.trim() || 'Anonymous'}
                  </button>
                )}
              </span>
            )}
          </div>
        )}
        {sharing && checking && <Turnstile onToken={setToken} onError={setShareError} quiet />}
        {sharing && shareError && <p className="small error">{shareError} Saving keeps it on this phone.</p>}

        <div className="sheet-actions">
          <button onClick={onDiscard} disabled={waiting !== null}>
            Discard
          </button>
          <button onClick={() => save(false)} disabled={!canSave || waiting !== null}>
            {waiting === false ? 'Checking…' : 'Save'}
          </button>
          <button className="primary" onClick={() => save(true)} disabled={!canSave || waiting !== null}>
            {waiting === true ? 'Checking…' : <>Save &amp; record another</>}
          </button>
        </div>
      </div>
    </div>
  )
}
