import { useCallback, useEffect, useRef, useState } from 'react'
import { describeCameraError, hasMultipleCameras, openCamera, stopStream } from './tracking/camera'
import { SLOT_COLOURS } from './tracking/draw'
import { loadHandTracker, type LoadedTracker } from './tracking/handTracker'
import type { TrackingStats } from './tracking/stats'
import { TrackingLoop } from './tracking/trackingLoop'
import type { CameraFacing, Handedness } from './tracking/types'

type Phase = 'idle' | 'loading' | 'live' | 'error'

const EMPTY_STATS: TrackingStats = {
  fps: 0,
  inferenceMs: 0,
  presence: [0, 0],
  confidence: [0, 0],
  dropouts: [0, 0],
}

let trackerPromise: Promise<LoadedTracker> | null = null
function getTracker() {
  trackerPromise ??= loadHandTracker().catch((err) => {
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

  const live = phase === 'live'
  const lowFps = live && stats.fps > 0 && stats.fps < 20
  const losingHands = live && stats.fps > 0 && Math.max(stats.presence[0], stats.presence[1]) < 0.6

  return (
    <div className="app">
      <header className="topbar">
        <h1>Cardistry Identifier</h1>
        {live && (
          <div className="badges">
            <span className={`badge ${lowFps ? 'warn' : ''}`}>{stats.fps.toFixed(0)} fps</span>
            <span className="badge">{stats.inferenceMs.toFixed(0)} ms</span>
            <span className="badge">{delegate}</span>
          </div>
        )}
      </header>

      <main className="stage-wrap">
        <div className={`stage ${live ? 'is-live' : ''}`}>
          <video
            ref={videoRef}
            className={mirror ? 'mirror' : ''}
            playsInline
            muted
            autoPlay
          />
          <canvas ref={canvasRef} className={mirror ? 'mirror' : ''} />
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

      {live && (
        <section className="panel">
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
    </div>
  )
}
