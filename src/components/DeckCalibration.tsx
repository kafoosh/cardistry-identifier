import { useEffect, useRef, useState } from 'react'
import { calibrationBox, type CalibrationState } from '../cards/cardTracker'
import type { CardTracking } from '../cards/cardTracking'

interface Props {
  tracker: CardTracking
  /** Whether a deck from an earlier session can be reused. */
  hasSavedDeck: boolean
  onDone: () => void
  onUseSaved: () => void
  onSkip: () => void
  /** Whether the preview is mirrored, so the fitted outline lines up with it. */
  mirror: boolean
}

/**
 * "Show me your deck": a card-shaped guide over the camera. Holding the deck
 * in it, back to the camera, for a moment teaches the tracker the deck's
 * colours and size; then a confirmation, and recording can start.
 */
export function DeckCalibration({ tracker, hasSavedDeck, onDone, onUseSaved, onSkip, mirror }: Props) {
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
      if (c.found) {
        // The rectangle fitted to the deck, mirrored like the preview.
        const f = c.found
        const fx = (mirror ? 1 - f.cx : f.cx) * w
        const ang = mirror ? Math.PI - f.angle : f.angle
        ctx.save()
        ctx.translate(fx, f.cy * h)
        ctx.rotate(ang)
        ctx.strokeStyle = done ? '#4ade80' : '#2dd4bf'
        ctx.lineWidth = 2 * unit
        ctx.strokeRect((-f.length * h) / 2, (-f.width * h) / 2, f.length * h, f.width * h)
        ctx.restore()
      }
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
  }, [tracker, mirror])

  // Close by itself shortly after a clean lock.
  useEffect(() => {
    if (cal.phase !== 'done') return
    const id = setTimeout(onDone, 1400)
    return () => clearTimeout(id)
  }, [cal.phase, onDone])

  return (
    <div className="deck-cal">
      <canvas ref={canvasRef} />
      <div className="deck-cal-text">
        {cal.phase === 'done' ? (
          <>
            <strong>✓ Deck locked{cal.hand ? ` in your ${cal.hand.toLowerCase()} hand` : ''}</strong>
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
