import { type Ref, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { drawHands } from '../tracking/draw'
import type { Frame } from '../tracking/types'

interface Props {
  frames: Frame[]
  width: number
  height: number
  mirror: boolean
  /** Optional clip recorded alongside; the wireframe is drawn over it in sync. */
  videoUrl?: string | null
  /** Frame time (ms) at which the video's time 0 falls. */
  videoStartMs?: number
  /** Loop only this part (ms on the frame clock); the rest stays scrubbable. */
  range?: { startMs: number; endMs: number }
  /** Lets the parent pause and jump to a time (used while dragging trim handles). */
  handle?: Ref<ReplayHandle>
  /** Hand slots that were tracked but are left out of the take: drawn faded. */
  faded?: Set<number>
}

export interface ReplayHandle {
  seek: (ms: number) => void
}

const SPEEDS = [0.25, 0.5, 1] as const

/** Index of the last frame with t <= time (frames are sorted by t). */
function frameAt(frames: Frame[], time: number): number {
  let lo = 0
  let hi = frames.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (frames[mid].t <= time) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Replays a recording's wireframe, looping, with play/pause, scrubbing and slow motion. */
export function ReplayCanvas({ frames, width, height, mirror, videoUrl, videoStartMs = 0, range, handle, faded }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  const [time, setTime] = useState(0)
  const timeRef = useRef(0)
  const duration = frames.length ? frames[frames.length - 1].t : 0
  const loopStart = range ? Math.max(0, range.startMs) : 0
  const loopEnd = range ? Math.min(duration, range.endMs) : duration

  // Draw whenever the time changes.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx || !frames.length) return
    const hands = frames[frameAt(frames, time)].hands
    if (!faded?.size) drawHands(ctx, hands)
    else {
      drawHands(ctx, hands.filter((h) => faded.has(h.slot)), { alpha: 0.3 })
      drawHands(ctx, hands.filter((h) => !faded.has(h.slot)), { clear: false })
    }
  }, [frames, time, faded])

  // Advance time: follow the video when there is one, otherwise a clock.
  useEffect(() => {
    const video = videoRef.current
    if (video) {
      video.playbackRate = speed
      if (playing) void video.play().catch(() => setPlaying(false))
      else video.pause()
    }
    if (!playing) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      if (video && videoUrl) {
        timeRef.current = video.currentTime * 1000 + videoStartMs
        if (timeRef.current > loopEnd || timeRef.current < loopStart - 100) {
          timeRef.current = loopStart
          video.currentTime = Math.max(0, (loopStart - videoStartMs) / 1000)
        }
      } else {
        timeRef.current += (now - last) * speed
        if (timeRef.current > loopEnd || timeRef.current < loopStart) timeRef.current = loopStart
      }
      last = now
      setTime(timeRef.current)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, loopStart, loopEnd, videoUrl, videoStartMs])

  const seek = useCallback(
    (ms: number) => {
      timeRef.current = ms
      setTime(ms)
      if (videoRef.current) videoRef.current.currentTime = Math.max(0, (ms - videoStartMs) / 1000)
    },
    [videoStartMs],
  )

  useImperativeHandle(handle, () => ({
    seek: (ms: number) => {
      setPlaying(false)
      seek(ms)
    },
  }), [seek])

  return (
    <div className="replay">
      <div className="replay-stage" style={{ aspectRatio: `${width} / ${height}` }}>
        {videoUrl && (
          <video ref={videoRef} src={videoUrl} className={mirror ? 'mirror' : ''} playsInline muted loop />
        )}
        <canvas ref={canvasRef} width={width} height={height} className={mirror ? 'mirror' : ''} />
      </div>
      <div className="replay-controls">
        <button onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(duration, 1)}
          step={1}
          value={Math.min(time, duration)}
          onChange={(e) => {
            setPlaying(false)
            seek(Number(e.target.value))
          }}
          aria-label="Scrub"
        />
        <span className="small muted tabular">
          {(Math.min(time, duration) / 1000).toFixed(1)}s / {(duration / 1000).toFixed(1)}s
        </span>
        <div className="speed">
          {SPEEDS.map((s) => (
            <button key={s} className={s === speed ? 'selected' : ''} onClick={() => setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
