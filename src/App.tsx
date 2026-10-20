import { useCallback, useEffect, useRef, useState } from 'react'
import { Library } from './components/Library'
import { RecordSetup } from './components/RecordSetup'
import { loadRecordSetup, saveRecordSetup, type RecordSetupValue } from './recording/recordSetup'
import { SaveSheet, type SaveDetails } from './components/SaveSheet'
import { IdentifyPanel } from './components/IdentifyPanel'
import { SharedLibrary } from './components/SharedLibrary'
import { Identifier, type IdentifyState } from './recognition/identifier'
import { activeSpan, MOTION_ON } from './recognition/motion'
import { MotionWatcher } from './recognition/motionWatcher'
import { getMatcher } from './recognition/shared'
import { loadTemplates } from './recognition/templates'
import { canRecordVideo, describeDevice, longestGapMs, MAX_RECORDING_MS, qualityScore, Recorder, type Capture } from './recording/recorder'
import { requestPersistentStorage, saveRecording } from './storage/db'
import { describeCameraError, hasMultipleCameras, openCamera, stopStream } from './tracking/camera'
import { SLOT_COLOURS } from './tracking/draw'
import { loadHandTracker, type LoadedTracker } from './tracking/handTracker'
import type { TrackingStats } from './tracking/stats'
import { TrackingLoop } from './tracking/trackingLoop'
import type { CameraFacing, Handedness } from './tracking/types'

type Phase = 'idle' | 'loading' | 'live' | 'error'
type Tab = 'live' | 'library' | 'shared'
/** Stillness that ends an automatic take, and the shortest take auto-stop allows. */
const AUTO_STOP_STILL_MS = 1200
const AUTO_STOP_MIN_MS = 1000

type RecState = 'ready' | 'countdown' | 'armed' | 'recording' | 'review'
type Mode = 'record' | 'identify'

const COUNTDOWN_S = 3

const EMPTY_STATS: TrackingStats = {
  fps: 0,
  inferenceMs: 0,
  presence: [0, 0],
  confidence: [0, 0],
  dropouts: [0, 0],
}

let trackerPromise: Promise<LoadedTracker> | null = null
function getTracker() {
  // `?cpu` in the URL forces the CPU delegate, for devices with a broken GPU path.
  trackerPromise ??= loadHandTracker(!new URLSearchParams(location.search).has('cpu')).catch((err) => {
    trackerPromise = null
    throw err
  })
  return trackerPromise
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const loopRef = useRef<TrackingLoop | null>(null)
  const recorderRef = useRef<Recorder | null>(null)
  const watcherRef = useRef<MotionWatcher | null>(null)

  const [tab, setTab] = useState<Tab>('live')
  const [recState, setRecState] = useState<RecState>('ready')
  const [countdown, setCountdown] = useState(COUNTDOWN_S)
  const [elapsed, setElapsed] = useState(0)
  const [capture, setCapture] = useState<Capture | null>(null)
  const [setup, setSetupState] = useState<RecordSetupValue>(loadRecordSetup)
  const setSetup = (v: RecordSetupValue) => {
    setSetupState(v)
    saveRecordSetup(v)
  }
  const [savedNote, setSavedNote] = useState('')
  const [recordVideo, setRecordVideo] = useState(() => {
    try {
      return localStorage.getItem('cardistry.recordVideo') === '1'
    } catch {
      return false
    }
  })
  const [autoStart, setAutoStart] = useState(() => {
    try {
      return localStorage.getItem('cardistry.autoStart') !== '0'
    } catch {
      return true
    }
  })
  const [motion, setMotion] = useState({ energy: 0, active: false })
  const [mode, setMode] = useState<Mode>('record')
  const [identify, setIdentify] = useState<IdentifyState | null>(null)
  const [templateInfo, setTemplateInfo] = useState({ templates: 0, moves: 0, shared: 0, sharedError: false })
  const [sensitivity, setSensitivity] = useState(1)
  const thresholdRef = useRef({ base: 1, sensitivity: 1 })
  useEffect(() => {
    thresholdRef.current.sensitivity = sensitivity
  }, [sensitivity])
  const [videoSize, setVideoSize] = useState({ width: 640, height: 480 })

  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [facing, setFacing] = useState<CameraFacing>('user')
  const [mirror, setMirror] = useState(true)
  const [showGuide, setShowGuide] = useState(true)
  const [canSwitch, setCanSwitch] = useState(false)
  const [delegate, setDelegate] = useState('')
  const [stats, setStats] = useState<TrackingStats>(EMPTY_STATS)
  const [labels, setLabels] = useState<[Handedness | null, Handedness | null]>([null, null])

  const stop = useCallback(() => {
    recorderRef.current?.cancel()
    recorderRef.current = null
    setRecState('ready')
    setCapture(null)
    watcherRef.current?.stop()
    watcherRef.current = null
    loopRef.current?.stop()
    loopRef.current = null
    stopStream(streamRef.current)
    streamRef.current = null
  }, [])

  const start = useCallback(
    async (nextFacing: CameraFacing) => {
      stop()
      setPhase('loading')
      setError('')
      try {
        const [tracker, stream] = await Promise.all([getTracker(), openCamera(nextFacing)])
        streamRef.current = stream
        const video = videoRef.current!
        video.srcObject = stream
        await video.play()
        setDelegate(tracker.delegate)
        setFacing(nextFacing)
        setMirror(nextFacing === 'user')
        const loop = new TrackingLoop(video, canvasRef.current!, tracker.landmarker)
        loop.onFrame((f) => {
          setLabels((prev) => {
            const next: [Handedness | null, Handedness | null] = [null, null]
            for (const h of f.hands) next[h.slot] = h.handedness
            return prev[0] === next[0] && prev[1] === next[1] ? prev : next
          })
        })
        loop.start()
        loopRef.current = loop
        watcherRef.current = new MotionWatcher(loop)
        setPhase('live')
        setCanSwitch(await hasMultipleCameras())
      } catch (err) {
        stop()
        setError(describeCameraError(err))
        setPhase('error')
      }
    },
    [stop],
  )

  useEffect(() => {
    if (phase !== 'live') return
    const id = setInterval(() => {
      if (loopRef.current) setStats(loopRef.current.stats.read())
    }, 500)
    return () => clearInterval(id)
  }, [phase])

  useEffect(() => stop, [stop])

  useEffect(() => {
    if (phase !== 'live') return
    const id = setInterval(() => {
      const m = watcherRef.current?.latest
      if (m) setMotion({ energy: m.energy, active: m.active })
    }, 150)
    return () => clearInterval(id)
  }, [phase])

  const finishRecording = useCallback(async () => {
    const rec = recorderRef.current
    if (!rec) return
    recorderRef.current = null
    const raw = await rec.stop()
    // Suggest cutting the idle time before and after the move; the review sheet lets the user adjust it.
    const span = activeSpan(raw.frames)
    const cap: Capture = { ...raw, suggestedTrim: span && span.endMs - span.startMs >= 300 ? span : undefined }
    const v = videoRef.current
    if (v?.videoWidth) setVideoSize({ width: v.videoWidth, height: v.videoHeight })
    setCapture(cap)
    setRecState('review')
  }, [])

  const beginCapture = useCallback(
    (preroll: Parameters<Recorder['start']>[1]) => {
      const loop = loopRef.current
      const stream = streamRef.current
      if (!loop || !stream || recorderRef.current) return
      const rec = new Recorder(loop, stream, () => void finishRecording())
      rec.start(recordVideo && canRecordVideo(), preroll)
      recorderRef.current = rec
      setElapsed(0)
      setRecState('recording')
    },
    [finishRecording, recordVideo],
  )

  const startRecording = useCallback(() => {
    setSavedNote('')
    setRecState('countdown')
    setCountdown(COUNTDOWN_S)
  }, [])

  // Countdown, then either wait for motion (auto) or start capturing.
  useEffect(() => {
    if (recState !== 'countdown') return
    const id = setTimeout(() => {
      if (countdown > 1) setCountdown((c) => c - 1)
      else if (autoStart) setRecState('armed')
      else beginCapture([])
    }, 1000)
    return () => clearTimeout(id)
  }, [recState, countdown, autoStart, beginCapture])

  // Auto-start: wait for fresh finger motion, then record from just before it.
  // Motion already under way when arming (fidgeting during the countdown)
  // has to settle first, so a take never starts half-way through something.
  useEffect(() => {
    const watcher = watcherRef.current
    if (recState !== 'armed' || !watcher) return
    let settled = !watcher.latest.active
    return watcher.onSample((s) => {
      if (!s.active) settled = true
      else if (settled) beginCapture(watcher.recent(700))
    })
  }, [recState, beginCapture])

  // Auto-stop: once the fingers have been still for a while. Short holds
  // inside a move don't end the take, and the first second is never cut off.
  useEffect(() => {
    const watcher = watcherRef.current
    if (recState !== 'recording' || !autoStart || !watcher) return
    let stillSince: number | null = null
    return watcher.onSample((s) => {
      if (s.moving) stillSince = null
      else stillSince ??= s.t
      const elapsed = recorderRef.current?.elapsedMs ?? 0
      if (stillSince !== null && s.t - stillSince >= AUTO_STOP_STILL_MS && elapsed >= AUTO_STOP_MIN_MS) void finishRecording()
    })
  }, [recState, autoStart, finishRecording])

  useEffect(() => {
    if (recState !== 'recording') return
    const id = setInterval(() => setElapsed(recorderRef.current?.elapsedMs ?? 0), 100)
    return () => clearInterval(id)
  }, [recState])

  const save = (d: SaveDetails, again: boolean) => {
    if (!capture) return
    if (d.moveName !== setup.moveName) setSetup({ ...setup, moveName: d.moveName })
    // Close the sheet straight away and write in the background.
    setCapture(null)
    if (again) startRecording()
    else setRecState('ready')
    const takes = d.repeats ?? [{ frames: d.frames, durationMs: d.durationMs, videoStartMs: d.videoStartMs }]
    const label = takes.length > 1 ? `${takes.length} takes of ${d.moveName}` : d.moveName
    setSavedNote(`Saving ${label}…`)
    const createdAt = Date.now()
    void (async () => {
      try {
        for (const [i, take] of takes.entries()) {
          const { frames } = take
          // One copy of the clip is enough; repeats from the same take share it.
          const video = d.keepVideo && i === 0 ? capture.video : null
          await saveRecording(
            {
              id: crypto.randomUUID(),
              moveName: d.moveName,
              createdAt: createdAt + i,
              frames,
              fps: take.durationMs > 0 ? ((frames.length - 1) * 1000) / take.durationMs : 0,
              frameCount: frames.length,
              durationMs: take.durationMs,
              camera: facing,
              cameraView: setup.cameraView,
              dominantHand: setup.dominantHand,
              device: describeDevice(),
              videoWidth: videoSize.width,
              videoHeight: videoSize.height,
              qualityScore: qualityScore(frames),
              longestGapMs: longestGapMs(frames),
              hasVideo: Boolean(video),
              videoStartMs: take.videoStartMs,
              videoMimeType: video?.type,
            },
            video,
          )
        }
        setSavedNote(`Saved ${label}.`)
        void requestPersistentStorage()
      } catch (err) {
        setSavedNote(`Couldn't save: ${err instanceof Error ? err.message : err}`)
      }
    })()
  }


  // Identify mode: load templates, estimate a threshold, then match live.
  useEffect(() => {
    if (phase !== 'live' || mode !== 'identify' || !loopRef.current) return
    let identifier: Identifier | null = null
    let cancelled = false
    setIdentify(null)
    void (async () => {
      const { templates, sharedError } = await loadTemplates()
      if (cancelled || !loopRef.current) return
      const matcher = getMatcher()
      const outliers = new Set(await matcher.setTemplates(templates))
      const used = templates.filter((t) => !outliers.has(t.id))
      setTemplateInfo({
        templates: used.length,
        moves: new Set(used.map((t) => t.moveName)).size,
        shared: used.filter((t) => t.source === 'shared').length,
        sharedError,
      })
      thresholdRef.current.base = (await matcher.selfTest()).threshold
      if (cancelled || !loopRef.current) return
      if (!watcherRef.current) return
      identifier = new Identifier(
        loopRef.current,
        watcherRef.current,
        matcher,
        templates,
        () => {
          const v = videoRef.current
          return v?.videoWidth ? v.videoWidth / v.videoHeight : 4 / 3
        },
        () => thresholdRef.current.base * thresholdRef.current.sensitivity,
        setIdentify,
      )
    })()
    return () => {
      cancelled = true
      identifier?.stop()
    }
  }, [phase, mode])

  // Remember whether the camera was running when leaving the Camera tab, so
  // coming back restarts it instead of showing the start screen again.
  const resumeCameraRef = useRef(false)

  const switchTab = (next: Tab) => {
    if (next === tab) return
    if (next !== 'live') {
      resumeCameraRef.current = phase === 'live'
      stop()
      setPhase('idle')
    } else if (resumeCameraRef.current) {
      void start(facing)
    }
    setTab(next)
  }

  const goRecord = () => {
    setMode('record')
    setTab('live')
    if (phase !== 'live') void start(facing)
  }

  const live = phase === 'live'
  const lowFps = live && stats.fps > 0 && stats.fps < 20
  const losingHands = live && stats.fps > 0 && Math.max(stats.presence[0], stats.presence[1]) < 0.6

  return (
    <div className="app">
      <header className="topbar">
        <h1>Cardistry Identifier</h1>
        <nav className="tabs">
          <button className={tab === 'live' ? 'selected' : ''} onClick={() => switchTab('live')}>
            Camera
          </button>
          <button className={tab === 'library' ? 'selected' : ''} onClick={() => switchTab('library')}>
            My moves
          </button>
          <button className={tab === 'shared' ? 'selected' : ''} onClick={() => switchTab('shared')}>
            Library
          </button>
        </nav>
        {live && tab === 'live' && (
          <div className="badges">
            <span className={`badge ${lowFps ? 'warn' : ''}`}>{stats.fps.toFixed(0)} fps</span>
            <span className="badge">{stats.inferenceMs.toFixed(0)} ms</span>
            <span className="badge">{delegate}</span>
          </div>
        )}
      </header>

      {tab === 'library' && (
        <main className="library-wrap">
          <Library onRecordMore={goRecord} />
        </main>
      )}

      {tab === 'shared' && (
        <main className="library-wrap">
          <SharedLibrary />
        </main>
      )}

      <main className="stage-wrap" hidden={tab !== 'live'}>
        <div className={`stage ${live ? 'is-live' : ''}`}>
          <video
            ref={videoRef}
            className={mirror ? 'mirror' : ''}
            playsInline
            muted
            autoPlay
          />
          <canvas ref={canvasRef} className={mirror ? 'mirror' : ''} />
          {live && recState === 'countdown' && <div className="countdown">{countdown}</div>}
          {live && recState === 'armed' && (
            <div className="rec-indicator">Ready. Start the move whenever you like…</div>
          )}
          {live && recState === 'recording' && (
            <div className="rec-indicator">
              <span className="rec-dot" /> REC {(elapsed / 1000).toFixed(1)}s / {MAX_RECORDING_MS / 1000}s
            </div>
          )}
          {live && showGuide && (
            <div className="guide" aria-hidden="true">
              <span>Keep both hands and the deck inside the frame</span>
            </div>
          )}

          {phase !== 'live' && (
            <div className="intro">
              {phase === 'loading' ? (
                <p className="muted">Starting camera and loading the hand tracker…</p>
              ) : (
                <>
                  <p>
                    Track your hands live while you do cardistry. Prop your phone or laptop up so both hands are free and
                    in view, with good light.
                  </p>
                  {phase === 'error' && <p className="error">{error}</p>}
                  <div className="intro-actions">
                    <button className="primary" onClick={() => start('user')}>
                      Start camera
                    </button>
                    <button onClick={() => start('environment')}>Use rear camera</button>
                  </div>
                  <p className="muted small">Everything runs on your device. Nothing is uploaded.</p>
                </>
              )}
            </div>
          )}
        </div>
      </main>

      {live && tab === 'live' && (
        <section className="panel">
          <div className="mode-switch" role="tablist">
            <button
              className={mode === 'record' ? 'selected' : ''}
              onClick={() => setMode('record')}
              disabled={recState !== 'ready'}
            >
              Record
            </button>
            <button
              className={mode === 'identify' ? 'selected' : ''}
              onClick={() => setMode('identify')}
              disabled={recState !== 'ready'}
            >
              Identify
            </button>
          </div>
          {mode === 'identify' && (
            <IdentifyPanel
              state={identify}
              templateCount={templateInfo.templates}
              moveCount={templateInfo.moves}
              sharedCount={templateInfo.shared}
              sharedError={templateInfo.sharedError}
              sensitivity={sensitivity}
              onSensitivity={setSensitivity}
              onRecord={() => setMode('record')}
            />
          )}
          {mode === 'record' && <RecordSetup value={setup} onChange={setSetup} disabled={recState !== 'ready'} />}
          <div className="record-row" hidden={mode !== 'record'}>
            {recState === 'recording' ? (
              <button className="record is-recording" onClick={() => void finishRecording()}>
                Stop recording
              </button>
            ) : recState === 'countdown' || recState === 'armed' ? (
              <button className="record" onClick={() => setRecState('ready')}>
                Cancel
              </button>
            ) : (
              <button
                className="record"
                onClick={startRecording}
                disabled={recState === 'review' || !setup.moveName}
                title={setup.moveName ? undefined : 'Choose the move first'}
              >
                <span className="rec-dot" /> {setup.moveName ? `Record ${setup.moveName}` : 'Choose a move to record'}
              </button>
            )}
            <label className="check small">
              <input
                type="checkbox"
                checked={autoStart}
                disabled={recState !== 'ready'}
                onChange={(e) => {
                  setAutoStart(e.target.checked)
                  try {
                    localStorage.setItem('cardistry.autoStart', e.target.checked ? '1' : '0')
                  } catch {
                    // Not persisted in private mode.
                  }
                }}
              />
              Start and stop automatically when I move
            </label>
            {canRecordVideo() && (
              <label className="check small">
                <input
                  type="checkbox"
                  checked={recordVideo}
                  disabled={recState !== 'ready'}
                  onChange={(e) => {
                    setRecordVideo(e.target.checked)
                    try {
                      localStorage.setItem('cardistry.recordVideo', e.target.checked ? '1' : '0')
                    } catch {
                      // Not persisted in private mode.
                    }
                  }}
                />
                Also record video
              </label>
            )}
            {savedNote && <span className="saved-note">{savedNote}</span>}
          </div>
          <div className="motion-meter" title="Finger motion. Recording and Identify start when it passes the mark.">
            <span className="small muted">Finger motion</span>
            <span className={`bar ${motion.active ? 'active' : ''}`}>
              <span style={{ width: `${Math.min(100, (motion.energy / (MOTION_ON * 2.5)) * 100)}%` }} />
              <i style={{ left: `${100 / 2.5}%` }} />
            </span>
            <span className="small muted">{motion.active ? 'moving' : 'idle'}</span>
          </div>
          <div className="hands">
            {[0, 1].map((slot) => (
              <div className="hand" key={slot}>
                <span className="dot" style={{ background: SLOT_COLOURS[slot] }} />
                <div>
                  <strong>
                    Hand {slot === 0 ? 'A' : 'B'}
                    {labels[slot] ? ` · ${labels[slot]}` : ''}
                  </strong>
                  <div className="muted small">
                    seen {(stats.presence[slot] * 100).toFixed(0)}% · conf {(stats.confidence[slot] * 100).toFixed(0)}% ·{' '}
                    {stats.dropouts[slot]} drop{stats.dropouts[slot] === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="muted small">Last 5 seconds. Drops count how often a hand was lost and found again.</p>
          {(lowFps || losingHands) && (
            <p className="hint">
              {lowFps
                ? 'Tracking is running slowly. Close other tabs or apps, or try the other camera.'
                : 'The tracker keeps losing your hands. Try more light, a plainer background, or a different angle.'}
            </p>
          )}
          <div className="controls">
            {canSwitch && (
              <button onClick={() => start(facing === 'user' ? 'environment' : 'user')}>Switch camera</button>
            )}
            <button onClick={() => setMirror((m) => !m)}>{mirror ? 'Unmirror' : 'Mirror'}</button>
            <button onClick={() => setShowGuide((g) => !g)}>{showGuide ? 'Hide guide' : 'Show guide'}</button>
            <button
              onClick={() => {
                stop()
                setPhase('idle')
              }}
            >
              Stop
            </button>
          </div>
        </section>
      )}

      {capture && recState === 'review' && (
        <SaveSheet
          capture={capture}
          width={videoSize.width}
          height={videoSize.height}
          mirror={mirror}
          moveName={setup.moveName}
          onSave={save}
          onDiscard={() => {
            setCapture(null)
            setRecState('ready')
          }}
        />
      )}
    </div>
  )
}
