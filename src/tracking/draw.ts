import { HAND_CONNECTIONS } from './handTracker'
import type { Fan, Packet } from '../cards/types'
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

/** Card packets as rotated boxes in the colour of the hand holding them (white when loose). */
export function drawCards(ctx: CanvasRenderingContext2D, packets: Packet[]) {
  const { width: w, height: h } = ctx.canvas
  const unit = Math.max(w, h) / 640
  for (const p of packets) {
    const cx = p.cx * w
    const cy = p.cy * h
    const hl = (p.length * h) / 2
    const hw = (p.width * h) / 2
    const c = Math.cos(p.angle)
    const s = Math.sin(p.angle)
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(Math.atan2(s, c))
    ctx.strokeStyle = p.hand === null ? '#ffffff' : SLOT_COLOURS[p.hand]
    ctx.lineWidth = 2 * unit
    ctx.setLineDash([6 * unit, 4 * unit])
    ctx.strokeRect(-hl, -hw, hl * 2, hw * 2)
    ctx.restore()
  }
}

/** Fans as a sector from the hinge: two rays and the arc the cards sweep. */
export function drawFans(ctx: CanvasRenderingContext2D, fans: Fan[]) {
  const { width: w, height: h } = ctx.canvas
  const unit = Math.max(w, h) / 640
  for (const f of fans) {
    const hx = f.hx * w
    const hy = f.hy * h
    const r = f.radius * h
    ctx.save()
    ctx.strokeStyle = f.hand === null ? '#ffffff' : SLOT_COLOURS[f.hand]
    ctx.lineWidth = 2 * unit
    ctx.setLineDash([6 * unit, 4 * unit])
    ctx.beginPath()
    ctx.moveTo(hx + Math.cos(f.from) * r, hy + Math.sin(f.from) * r)
    ctx.lineTo(hx, hy)
    ctx.lineTo(hx + Math.cos(f.to) * r, hy + Math.sin(f.to) * r)
    ctx.arc(hx, hy, r, f.to, f.from, true)
    ctx.stroke()
    ctx.restore()
  }
}
