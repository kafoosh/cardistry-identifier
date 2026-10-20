import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { Library } from './components/Library'
import { CardTracker } from './cards/cardTracker'
import { loadDeck } from './cards/deckModel'
import { DeckCalibration } from './components/DeckCalibration'
import { CameraSettings } from './components/CameraSettings'
import { MovePicker } from './components/MovePicker'
import { loadRecordSetup, saveRecordSetup, type RecordSetupValue } from './recording/recordSetup'
import { SaveSheet, type SaveDetails } from './components/SaveSheet'
import { Hud } from './components/Hud'
import { IdentifyBoxes, IdentifyStatus } from './components/IdentifyPanel'
import { SharedLibrary } from './components/SharedLibrary'
import { Identifier, type IdentifyState } from './recognition/identifier'
import { activeSpan, MOTION_ON } from './recognition/motion'
import { MotionWatcher } from './recognition/motionWatcher'
import { getMatcher } from './recognition/shared'
import { loadTemplates } from './recognition/templates'
import {
  canRecordVideo,
  describeDevice,
  longestGapMs,
  MAX_RECORDING_MS,
  qualityScore,
  Recorder,
  type Capture,
} from './recording/recorder'
import { requestPersistentStorage, saveRecording } from './storage/db'
import { describeCameraError, openCamera, stopStream } from './tracking/camera'
import { SLOT_COLOURS } from './tracking/draw'
import { loadHandTracker, type LoadedTracker } from './tracking/handTracker'
import type { TrackingStats } from './tracking/stats'
import { TrackingLoop } from './tracking/trackingLoop'
import type { CameraFacing, Handedness } from './tracking/types'
import type { CameraView, DominantHand } from './recording/types'

type Phase = 'idle' | 'loading' | 'live' | 'error'
type Tab = 'live' | 'library' | 'shared'
/** Reads an on/off preference saved with remember(). */
function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

/** Saves an on/off preference; ignored in private mode. */
function remember(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // Not persisted in private mode.
  }
}

/** Stillness that ends an automatic take, and the shortest take auto-stop allows. */
const AUTO_STOP_STILL_MS = 1200
const AUTO_STOP_MIN_MS = 1000
/** While armed and waiting, restart the background recording this long before it would hit the limit. */
const ARMED_RESTART_MARGIN_MS = 3000

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
  const [trackCards, setTrackCards] = useState(() => readPref('cardistry.trackCards', true))
  const [showCards, setShowCards] = useState(() => readPref('cardistry.showCards', true))
  const [hud, setHud] = useState(() => readPref('cardistry.hud', true))
  const [wireframe, setWireframe] = useState(() => readPref('cardistry.wireframe', true))
  // One tracker for the app's life; it keeps the learned deck between camera sessions.
  const [cardTracker] = useState(() => new CardTracker(loadDeck()))
  const trackCardsRef = useRef(trackCards)
  useEffect(() => {
    trackCardsRef.current = trackCards
  }, [trackCards])
  /** Deck calibration for this camera session. */
  const [deckStep, setDeckStep] = useState<'idle' | 'calibrating' | 'done'>('idle')
  /** Cards skipped for this camera session. */
  const [cardsSkipped, setCardsSkipped] = useState(false)
  const [autoStart, setAutoStart] = useState(() => {
    try {
      return localStorage.getItem('cardistry.autoStart') !== '0'
    } catch {
      return true
    }
  })
  const [motion, setMotion] = useState({ energy: 0, active: false, on: MOTION_ON })
  const [mode, setMode] = useState<Mode>('record')
  const [identify, setIdentify] = useState<IdentifyState | null>(null)
  const [templateInfo, setTemplateInfo] = useState({
    templates: 0,
    moves: 0,
    shared: 0,
    sharedError: false,
  })
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
        // ?debug exposes the latest frame for automated tests.
        if (new URLSearchParams(location.search).has('debug')) {
          const w = window as unknown as { __frame: unknown; __setIdentify: unknown; __cards: unknown }
          loop.onFrame((f) => (w.__frame = f))
          w.__setIdentify = setIdentify
          w.__cards = cardTracker
        }
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
        // Card tracking starts by learning the deck: show the calibration overlay.
        if (trackCardsRef.current) {
          const cards = cardTracker
          loop.cards = cards
          cards.startCalibration()
          setCardsSkipped(false)
          setDeckStep('calibrating')
        }
        setPhase('live')
      } catch (err) {
        stop()
        setError(describeCameraError(err))
        setPhase('error')
      }
    },
    [stop, cardTracker],
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
      if (m) setMotion({ energy: m.energy, active: m.active, on: m.on })
    }, 150)
    return () => clearInterval(id)
  }, [phase])

  const finishRecording = useCallback(async () => {
    const rec = recorderRef.current
    if (!rec) return
    recorderRef.current = null
    // Respond to the tap straight away; the clip can take a moment to finalise.
    setRecState('review')
    try {
      const raw = await rec.stop()
      if (raw.frames.length < 2) {
        setSavedNote('Nothing was recorded. Check your hands are in view and try again.')
        setRecState('ready')
        return
      }
      // Suggest cutting the idle time before and after the move; the review sheet lets the user adjust it.
      const span = activeSpan(raw.frames)
      const cap: Capture = {
        ...raw,
        suggestedTrim: span && span.endMs - span.startMs >= 300 ? span : undefined,
      }
      const v = videoRef.current
      if (v?.videoWidth) setVideoSize({ width: v.videoWidth, height: v.videoHeight })
      setCapture(cap)
    } catch (err) {
      setSavedNote(`Couldn't finish the take: ${err instanceof Error ? err.message : err}`)
      setRecState('ready')
    }
  }, [])

  /** Starts capturing. In auto mode it starts 'armed': already recording, so a move that never trips the motion detector isn't lost. */
  const beginCapture = useCallback(
    (preroll: Parameters<Recorder['start']>[1], state: 'recording' | 'armed' = 'recording') => {
      const loop = loopRef.current
      const stream = streamRef.current
      if (!loop || !stream || recorderRef.current) return
      const rec = new Recorder(loop, stream, () => void finishRecording())
      rec.start(recordVideo && canRecordVideo(), preroll)
      recorderRef.current = rec
      setElapsed(0)
      setRecState(state)
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
      else beginCapture([], autoStart ? 'armed' : 'recording')
    }, 1000)
    return () => clearTimeout(id)
  }, [recState, countdown, autoStart, beginCapture])

  // Auto-start: the take is already recording while armed; fresh finger
  // motion marks the start (the review trims the wait). Motion already under
  // way when arming has to settle first. If nothing happens for a long time,
  // the recording restarts quietly so the take never fills with waiting.
  useEffect(() => {
    const watcher = watcherRef.current
    if (recState !== 'armed' || !watcher) return
    let settled = !watcher.latest.active
    return watcher.onSample((s) => {
      if (!s.active) settled = true
      else if (settled) {
        setElapsed(0)
        setRecState('recording')
        return
      }
      const rec = recorderRef.current
      if (rec && rec.elapsedMs > MAX_RECORDING_MS - ARMED_RESTART_MARGIN_MS) {
        rec.cancel()
        recorderRef.current = null
        beginCapture(watcher.recent(1500), 'armed')
      }
    })
  }, [recState, beginCapture])

  // Auto-stop: once the fingers have been still for a while. Short holds
  // inside a move don't end the take, and the first second is never cut off.
  useEffect(() => {
    const watcher = watcherRef.current
    if (recState !== 'recording' || !autoStart || !watcher) return
    let stillSince: number | null = null
    let startedAt: number | null = null
    return watcher.onSample((s) => {
      startedAt ??= s.t
      if (s.moving) stillSince = null
      else stillSince ??= s.t
      if (stillSince !== null && s.t - stillSince >= AUTO_STOP_STILL_MS && s.t - startedAt >= AUTO_STOP_MIN_MS)
        void finishRecording()
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
    setSavedNote(`Saving ${d.moveName}…`)
    const { frames } = d
    const video = d.keepVideo ? capture.video : null
    void (async () => {
      try {
        await saveRecording(
          {
            id: crypto.randomUUID(),
            moveName: d.moveName,
            createdAt: Date.now(),
            frames,
            fps: d.durationMs > 0 ? ((frames.length - 1) * 1000) / d.durationMs : 0,
            frameCount: frames.length,
            durationMs: d.durationMs,
            camera: facing,
            cameraView: setup.cameraView,
            dominantHand: setup.dominantHand,
            device: describeDevice(),
            videoWidth: videoSize.width,
            videoHeight: videoSize.height,
            qualityScore: qualityScore(frames),
            longestGapMs: longestGapMs(frames),
            hasVideo: Boolean(video),
            videoStartMs: d.videoStartMs,
            videoMimeType: video?.type,
          },
          video,
        )
        setSavedNote(`Saved ${d.moveName}.`)
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

  const [showSettings, setShowSettings] = useState(false)

  // Apply the card toggles to the running loop.
  useEffect(() => {
    const loop = loopRef.current
    if (!loop) return
    loop.cards = trackCards && !cardsSkipped ? cardTracker : null
    loop.showCards = showCards
    loop.showWireframe = wireframe
  }, [trackCards, showCards, wireframe, cardsSkipped, phase, cardTracker])

  const finishDeck = useCallback(() => setDeckStep('done'), [])
  const recalibrateDeck = () => {
    const cards = cardTracker
    cards.startCalibration()
    setCardsSkipped(false)
    setDeckStep('calibrating')
    setShowSettings(false)
  }

  const changeMode = (m: Mode) => {
    if (recState === 'ready') setMode(m)
  }

  // Swipe across the camera view to switch between Record and Identify.
  const swipeStart = useRef<{ x: number; y: number } | null>(null)
  const swipeHandlers = {
    onPointerDown: (e: PointerEvent) => {
      swipeStart.current = { x: e.clientX, y: e.clientY }
    },
    onPointerUp: (e: PointerEvent) => {
      const s0 = swipeStart.current
      swipeStart.current = null
      if (!s0) return
      const dx = e.clientX - s0.x
      const dy = e.clientY - s0.y
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return
      changeMode(dx < 0 ? 'identify' : 'record')
    },
    onPointerCancel: () => {
      swipeStart.current = null
    },
  }

  const live = phase === 'live'
  const calibrating = live && trackCards && deckStep === 'calibrating'
  const hasSavedDeck = calibrating && cardTracker.hasDeck
  const lowFps = live && stats.fps > 0 && stats.fps < 20
  const losingHands = live && stats.fps > 0 && Math.max(stats.presence[0], stats.presence[1]) < 0.6

  return (
    <div className={`app ${tab === 'live' ? 'app-camera' : ''}`}>
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

      <main className="camera" hidden={tab !== 'live'}>
        <div className="camera-top">
          {live && mode === 'record' && (
            <fieldset className="what" disabled={recState !== 'ready'}>
              <label className="field">
                <span>What are you recording?</span>
                <MovePicker value={setup.moveName} onChange={(moveName) => setSetup({ ...setup, moveName })} />
              </label>
            </fieldset>
          )}
          {live && mode === 'identify' && (
            <IdentifyStatus
              state={identify}
              templateCount={templateInfo.templates}
              moveCount={templateInfo.moves}
              sharedCount={templateInfo.shared}
              sharedError={templateInfo.sharedError}
              onRecord={() => setMode('record')}
            />
          )}
        </div>

        <div className={`stage ${live ? 'is-live' : ''}`} {...swipeHandlers}>
          <video ref={videoRef} className={mirror ? 'mirror' : ''} playsInline muted autoPlay />
          <canvas ref={canvasRef} className={mirror ? 'mirror' : ''} />
          {live && recState === 'countdown' && <div className="countdown">{countdown}</div>}
          {live && recState === 'armed' && (
            <div className="rec-indicator">
              <span className="rec-dot" /> Recording. Start the move whenever you like…
            </div>
          )}
          {live && recState === 'review' && !capture && <div className="rec-indicator">Finishing the take…</div>}
          {live && recState === 'recording' && (
            <div className="rec-indicator">
              <span className="rec-dot" /> REC {(elapsed / 1000).toFixed(1)}s / {MAX_RECORDING_MS / 1000}s
            </div>
          )}
          {live && showGuide && recState === 'ready' && !calibrating && mode === 'record' && (
            <div className="guide" aria-hidden="true">
              <span>Keep both hands and the deck inside the frame</span>
            </div>
          )}
          {live && mode === 'identify' && hud && <Hud loopRef={loopRef} state={identify} mirror={mirror} />}
          {live && !calibrating && (
            <div className="layer-toggles">
              <button
                className={wireframe ? 'on' : ''}
                onClick={() => {
                  setWireframe(!wireframe)
                  remember('cardistry.wireframe', !wireframe)
                }}
                aria-pressed={wireframe}
              >
                Wireframe
              </button>
              {mode === 'identify' && (
                <button
                  className={hud ? 'on' : ''}
                  onClick={() => {
                    setHud(!hud)
                    remember('cardistry.hud', !hud)
                  }}
                  aria-pressed={hud}
                >
                  HUD
                </button>
              )}
            </div>
          )}
          {live && mode === 'record' && trackCards && !calibrating && recState === 'ready' && (
            <button className="deck-chip" onClick={recalibrateDeck}>
              {cardsSkipped ? 'Track my deck' : 'Recalibrate deck'}
            </button>
          )}
          {live && savedNote && recState !== 'recording' && <div className="toast">{savedNote}</div>}
          {live && (lowFps || losingHands) && (
            <div className="toast warn">
              {lowFps
                ? 'Tracking is slow. Close other tabs or apps, or try the other camera.'
                : 'Losing your hands. Try more light or a plainer background.'}
            </div>
          )}
          {live && (
            <div className={`motion-strip ${motion.active ? 'active' : ''}`} title="Finger motion">
              <span
                style={{
                  width: `${Math.min(100, (motion.energy / (motion.on * 2.5)) * 100)}%`,
                }}
              />
              <i style={{ left: `${100 / 2.5}%` }} />
            </div>
          )}

          {calibrating && (
            <DeckCalibration
              tracker={cardTracker}
              mirror={mirror}
              hasSavedDeck={hasSavedDeck}
              onDone={finishDeck}
              onUseSaved={() => {
                cardTracker.stopCalibration()
                setDeckStep('done')
              }}
              onSkip={() => {
                cardTracker.stopCalibration()
                setCardsSkipped(true)
                setDeckStep('done')
              }}
            />
          )}
          {phase !== 'live' && (
            <div className="intro">
              {phase === 'loading' ? (
                <p className="muted">Starting camera and loading the hand tracker…</p>
              ) : (
                <>
                  <p>
                    Track your hands live while you do cardistry. Prop your phone or laptop up so both hands are free
                    and in view, with good light.
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

        {live && (
          <div className="camera-bottom">
            <div className="mode-carousel" role="tablist" aria-label="Mode">
              {(['record', 'identify'] as const).map((m) => (
                <button
                  key={m}
                  role="tab"
                  aria-selected={mode === m}
                  className={mode === m ? 'selected' : ''}
                  onClick={() => changeMode(m)}
                  disabled={recState !== 'ready'}
                >
                  {m === 'record' ? 'Record' : 'Identify'}
                </button>
              ))}
            </div>
            {mode === 'identify' && <IdentifyBoxes state={identify} mirror={mirror} />}
            <div className={`shutter-row ${mode === 'identify' ? 'slim' : ''}`}>
              <button
                className="round"
                onClick={() => start(facing === 'user' ? 'environment' : 'user')}
                disabled={recState !== 'ready'}
                aria-label={facing === 'user' ? 'Flip to the back camera' : 'Flip to the front camera'}
                title={facing === 'user' ? 'Flip to the back camera' : 'Flip to the front camera'}
              >
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 8h3l2-2h6l2 2h3v10H4z" />
                  <path d="M9.5 13a2.5 2.5 0 0 0 4.3 1.7" />
                  <path d="M14.5 13a2.5 2.5 0 0 0-4.3-1.7" />
                  <path d="M14 15.5v-1.8h-1.8" />
                  <path d="M10 10.5v1.8h1.8" />
                </svg>
              </button>
              {mode === 'record' ? (
                <button
                  className={`shutter ${recState === 'recording' || recState === 'armed' ? 'is-recording' : ''} ${recState === 'countdown' ? 'is-waiting' : ''}`}
                  onClick={() => {
                    // Armed is already recording, so a tap there stops and keeps the take too.
                    if (recState === 'recording' || recState === 'armed') void finishRecording()
                    else if (recState === 'countdown') setRecState('ready')
                    else startRecording()
                  }}
                  disabled={calibrating || recState === 'review' || (recState === 'ready' && !setup.moveName)}
                  aria-label={
                    recState === 'recording' || recState === 'armed'
                      ? 'Stop recording'
                      : recState === 'ready'
                        ? 'Record'
                        : 'Cancel'
                  }
                >
                  <span />
                </button>
              ) : (
                <p className="shutter-hint small muted">Do a move. Swipe right to record</p>
              )}
              <button className="round" onClick={() => setShowSettings(true)} aria-label="Settings" title="Settings">
                ⚙
              </button>
            </div>
            <p className="shutter-hint small muted" hidden={mode === 'identify'}>
              {recState === 'recording'
                ? autoStart
                  ? 'Stops when your fingers settle, or tap to stop'
                  : 'Tap to stop'
                : recState === 'countdown'
                  ? 'Get ready… tap to cancel'
                  : recState === 'armed'
                    ? 'Do the move. It stops when your fingers settle, or tap to stop'
                    : !setup.moveName
                      ? 'Name the move above first'
                      : autoStart
                        ? `Tap, then start ${setup.moveName} when ready. Swipe left to identify`
                        : `Tap to record ${setup.moveName}. Swipe left to identify`}
            </p>
          </div>
        )}
      </main>

      {showSettings && (
        <CameraSettings onClose={() => setShowSettings(false)}>
          <div className="field-row">
            <label className="field">
              <span>Camera angle</span>
              <select
                value={setup.cameraView}
                onChange={(e) =>
                  setSetup({
                    ...setup,
                    cameraView: e.target.value as CameraView,
                  })
                }
              >
                <option value="front">Front</option>
                <option value="top-down">Top-down</option>
                <option value="side">Side</option>
              </select>
            </label>
            <label className="field">
              <span>Dominant hand</span>
              <select
                value={setup.dominantHand}
                onChange={(e) =>
                  setSetup({
                    ...setup,
                    dominantHand: e.target.value as DominantHand,
                  })
                }
              >
                <option value="right">Right</option>
                <option value="left">Left</option>
              </select>
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => {
                setAutoStart(e.target.checked)
                remember('cardistry.autoStart', e.target.checked)
              }}
            />
            Start and stop recording automatically when I move
          </label>
          {canRecordVideo() && (
            <label className="check">
              <input
                type="checkbox"
                checked={recordVideo}
                onChange={(e) => {
                  setRecordVideo(e.target.checked)
                  remember('cardistry.recordVideo', e.target.checked)
                }}
              />
              Also record video
            </label>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={trackCards}
              onChange={(e) => {
                setTrackCards(e.target.checked)
                remember('cardistry.trackCards', e.target.checked)
              }}
            />
            Track cards too (experimental). Moves are matched on fingers and cards together
          </label>
          {trackCards && (
            <label className="check">
              <input
                type="checkbox"
                checked={showCards}
                onChange={(e) => {
                  setShowCards(e.target.checked)
                  remember('cardistry.showCards', e.target.checked)
                }}
              />
              Show card boxes on the camera
            </label>
          )}
          {trackCards && <button onClick={recalibrateDeck}>Learn my deck again</button>}
          <label className="check">
            <input
              type="checkbox"
              checked={hud}
              onChange={(e) => {
                setHud(e.target.checked)
                remember('cardistry.hud', e.target.checked)
              }}
            />
            Futuristic overlay in Identify
          </label>
          <label className="field slider">
            <span>
              Identify sensitivity <span className="tabular">{sensitivity.toFixed(1)}×</span>
            </span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.1}
              value={sensitivity}
              onChange={(e) => setSensitivity(Number(e.target.value))}
            />
          </label>
          <p className="muted small">Raise it if moves are missed, lower it if wrong moves pop up.</p>
          <div className="controls">
            <button onClick={() => setMirror((m) => !m)}>{mirror ? 'Unmirror' : 'Mirror'}</button>
            <button onClick={() => setShowGuide((g) => !g)}>{showGuide ? 'Hide guide' : 'Show guide'}</button>
            <button
              onClick={() => {
                setShowSettings(false)
                stop()
                setPhase('idle')
              }}
            >
              Stop camera
            </button>
          </div>
          <h3 className="small">Tracking</h3>
          <div className="badges">
            <span className={`badge ${lowFps ? 'warn' : ''}`}>{stats.fps.toFixed(0)} fps</span>
            <span className="badge">{stats.inferenceMs.toFixed(0)} ms</span>
            <span className="badge">{delegate}</span>
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
                    seen {(stats.presence[slot] * 100).toFixed(0)}% · conf {(stats.confidence[slot] * 100).toFixed(0)}%
                    · {stats.dropouts[slot]} drop
                    {stats.dropouts[slot] === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="muted small">Last 5 seconds. Drops count how often a hand was lost and found again.</p>
        </CameraSettings>
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
