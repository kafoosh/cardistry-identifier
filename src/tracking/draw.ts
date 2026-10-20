import { HAND_CONNECTIONS } from './handTracker'
import type { TrackedHand } from './types'

export const SLOT_COLOURS = ['#2dd4bf', '#fbbf24'] as const

const FINGERTIPS = new Set([4, 8, 12, 16, 20])

/**
 * Draws the hand wireframes in raw (unmirrored) image space. When the
 * preview is mirrored for a front camera, the canvas is flipped with CSS
 * together with the video, so stored landmarks are never mirrored.
 */
export function drawHands(ctx: CanvasRenderingContext2D, hands: TrackedHand[]) {
  const { width: w, height: h } = ctx.canvas
  ctx.clearRect(0, 0, w, h)
  const unit = Math.max(w, h) / 640

  for (const hand of hands) {
    const colour = SLOT_COLOURS[hand.slot]
    const pts = hand.landmarks

    ctx.strokeStyle = colour
    ctx.lineWidth = 3 * unit
    ctx.lineCap = 'round'
    ctx.globalAlpha = 0.9
    ctx.beginPath()
    for (const { start, end } of HAND_CONNECTIONS) {
      ctx.moveTo(pts[start][0] * w, pts[start][1] * h)
      ctx.lineTo(pts[end][0] * w, pts[end][1] * h)
    }
    ctx.stroke()

    ctx.globalAlpha = 1
    for (let i = 0; i < pts.length; i++) {
      const r = (FINGERTIPS.has(i) ? 5 : 3.5) * unit
      ctx.beginPath()
      ctx.arc(pts[i][0] * w, pts[i][1] * h, r, 0, Math.PI * 2)
      ctx.fillStyle = FINGERTIPS.has(i) ? '#ffffff' : colour
      ctx.fill()
    }
  }
}
