import { useCallback, useEffect, useRef, useState } from 'react'
import { Library } from './components/Library'
import { SaveSheet, type SaveDetails } from './components/SaveSheet'
import { SharedLibrary } from './components/SharedLibrary'
import { canRecordVideo, describeDevice, longestGapMs, MAX_RECORDING_MS, qualityScore, Recorder, type Capture } from './recording/recorder'
import { listRecordings, requestPersistentStorage, saveRecording } from './storage/db'
import { describeCameraError, hasMultipleCameras, openCamera, stopStream } from './tracking/camera'
import { SLOT_COLOURS } from './tracking/draw'
import { loadHandTracker, type LoadedTracker } from './tracking/handTracker'
import type { TrackingStats } from './tracking/stats'
import { TrackingLoop } from './tracking/trackingLoop'
import type { CameraFacing, Handedness } from './tracking/types'

type Phase = 'idle' | 'loading' | 'live' | 'error'
type Tab = 'live' | 'library' | 'shared'
type RecState = 'ready' | 'countdown' | 'recording' | 'review'

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

  const [tab, setTab] = useState<Tab>('live')
  const [recState, setRecState] = useState<RecState>('ready')
  const [countdown, setCountdown] = useState(COUNTDOWN_S)
  const [elapsed, setElapsed] = useState(0)
  const [capture, setCapture] = useState<Capture | null>(null)
  const [knownMoves, setKnownMoves] = useState<string[]>([])
  const [savedNote, setSavedNote] = useState('')
  const [recordVideo, setRecordVideo] = useState(() => {
    try {
      return localStorage.getItem('cardistry.recordVideo') === '1'
    } catch {
      return false
    }
  })
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

  const finishRecording = useCallback(async () => {
    const rec = recorderRef.current
    if (!rec) return
    recorderRef.current = null
    const cap = await rec.stop()
    const v = videoRef.current
    if (v?.videoWidth) setVideoSize({ width: v.videoWidth, height: v.videoHeight })
    setCapture(cap)
    setRecState('review')
    listRecordings()
      .then((all) => setKnownMoves([...new Set(all.map((r) => r.moveName))]))
      .catch(() => {})
  }, [])

  const startRecording = useCallback(() => {
    setSavedNote('')
    setRecState('countdown')
    setCountdown(COUNTDOWN_S)
  }, [])

  // Countdown, then start capturing.
  useEffect(() => {
    if (recState !== 'countdown') return
    if (countdown === 0) {
      const loop = loopRef.current
      const stream = streamRef.current
      if (!loop || !stream) return setRecState('ready')
      const rec = new Recorder(loop, stream, () => void finishRecording())
      rec.start(recordVideo && canRecordVideo())
      recorderRef.current = rec
      setElapsed(0)
      setRecState('recording')
      return
    }
    const id = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(id)
  }, [recState, countdown, finishRecording, recordVideo])

  useEffect(() => {
    if (recState !== 'recording') return
    const id = setInterval(() => setElapsed(recorderRef.current?.elapsedMs ?? 0), 100)
    return () => clearInterval(id)
  }, [recState])

  const save = (d: SaveDetails, again: boolean) => {
    if (!capture) return
    const frames = d.frames
    const id = crypto.randomUUID()
    // Close the sheet straight away and write in the background.
    setCapture(null)
    if (again) startRecording()
    else setRecState('ready')
    setSavedNote(`Saving ${d.moveName}…`)
    saveRecording(
      {
        id,
        moveName: d.moveName,
        createdAt: Date.now(),
        frames,
        fps: capture.durationMs > 0 ? ((frames.length - 1) * 1000) / capture.durationMs : 0,
        frameCount: frames.length,
        durationMs: capture.durationMs,
        camera: facing,
        cameraView: d.cameraView,
        dominantHand: d.dominantHand,
        device: describeDevice(),
        videoWidth: videoSize.width,
        videoHeight: videoSize.height,
        qualityScore: qualityScore(frames),
        longestGapMs: longestGapMs(frames),
        hasVideo: Boolean(d.keepVideo && capture.video),
        videoMimeType: capture.video?.type,
      },
      d.keepVideo ? capture.video : null,
    )
      .then(() => {
        setSavedNote(`Saved ${d.moveName}.`)
        void requestPersistentStorage()
      })
      .catch((err) => setSavedNote(`Couldn't save: ${err instanceof Error ? err.message : err}`))
  }

  const switchTab = (next: Tab) => {
    if (next === tab) return
    if (next !== 'live') {
      stop()
      setPhase('idle')
    }
    setTab(next)
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
          <Library onRecordMore={() => switchTab('live')} />
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
          <div className="record-row">
            {recState === 'recording' ? (
              <button className="record is-recording" onClick={() => void finishRecording()}>
                Stop recording
              </button>
            ) : recState === 'countdown' ? (
              <button className="record" onClick={() => setRecState('ready')}>
                Cancel
              </button>
            ) : (
              <button className="record" onClick={startRecording} disabled={recState === 'review'}>
                <span className="rec-dot" /> Record a move
              </button>
            )}
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
          knownMoves={knownMoves}
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
