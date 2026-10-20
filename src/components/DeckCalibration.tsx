import { useEffect, useRef, useState } from 'react'
import { calibrationBox, type CalibrationState, type CardTracker } from '../cards/cardTracker'

interface Props {
  tracker: CardTracker
  /** Whether a deck from an earlier session can be reused. */
  hasSavedDeck: boolean
  onDone: () => void
  onUseSaved: () => void
  onSkip: () => void
}

/**
 * "Show me your deck": a card-shaped guide over the camera. Holding the deck
 * in it, back to the camera, for a moment teaches the tracker the deck's
 * colours and size; then a confirmation, and recording can start.
 */
export function DeckCalibration({ tracker, hasSavedDeck, onDone, onUseSaved, onSkip }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [cal, setCal] = useState<CalibrationState>(tracker.calibration)

  useEffect(() => {
    let raf = 0
    let last = ''
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const c = tracker.calibration
      const key = `${c.phase}:${c.progress.toFixed(2)}:${c.hint}:${c.hand}`
      if (key !== last) {
        last = key
        setCal({ ...c })
      }
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      const video = canvas?.closest('.stage')?.querySelector('video')
      if (!canvas || !ctx || !video?.videoWidth) return
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
      }
      const { width: w, height: h } = canvas
      const box = calibrationBox(w / h)
      const x = box.x0 * w
      const y = box.y0 * h
      const bw = (box.x1 - box.x0) * w
      const bh = (box.y1 - box.y0) * h
      const unit = Math.max(w / (canvas.clientWidth || w), h / (canvas.clientHeight || h))
      ctx.clearRect(0, 0, w, h)
      // Dim everything but the box.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
      ctx.fillRect(0, 0, w, h)
      ctx.clearRect(x, y, bw, bh)
      const done = c.phase === 'done'
      ctx.lineWidth = 3 * unit
      ctx.strokeStyle = done ? '#4ade80' : 'rgba(255, 255, 255, 0.85)'
      ctx.setLineDash(done ? [] : [10 * unit, 8 * unit])
      ctx.strokeRect(x, y, bw, bh)
      ctx.setLineDash([])
      if (c.phase === 'holding' && c.progress > 0) {
        // Progress runs around the box outline.
        const per = 2 * (bw + bh)
        let left = per * c.progress
        ctx.strokeStyle = '#2dd4bf'
        ctx.lineWidth = 6 * unit
        ctx.beginPath()
        let px = x
        let py = y
        ctx.moveTo(px, py)
        for (const [dx, dy, len] of [
          [1, 0, bw],
          [0, 1, bh],
          [-1, 0, bw],
          [0, -1, bh],
        ] as const) {
          const seg = Math.min(len, left)
          left -= seg
          px += dx * seg
          py += dy * seg
          ctx.lineTo(px, py)
          if (left <= 0) break
        }
        ctx.stroke()
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [tracker])

  // Close by itself shortly after a clean lock.
  useEffect(() => {
    if (cal.phase !== 'done' || cal.warning) return
    const id = setTimeout(onDone, 1400)
    return () => clearTimeout(id)
  }, [cal.phase, cal.warning, onDone])

  return (
    <div className="deck-cal">
      <canvas ref={canvasRef} />
      <div className="deck-cal-text">
        {cal.phase === 'done' ? (
          <>
            <strong>✓ Deck locked{cal.hand ? ` in your ${cal.hand.toLowerCase()} hand` : ''}</strong>
            {cal.warning && <span className="small">{cal.warning}</span>}
            <button className="primary" onClick={onDone}>
              Start
            </button>
          </>
        ) : (
          <>
            <strong>Show me your deck</strong>
            <span className="small">{cal.hint}</span>
            <div className="deck-cal-actions">
              {hasSavedDeck && (
                <button className="link" onClick={onUseSaved}>
                  Use my last deck
                </button>
              )}
              <button className="link" onClick={onSkip}>
                Skip cards
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
