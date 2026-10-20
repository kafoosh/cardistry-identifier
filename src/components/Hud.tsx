import { useEffect, useRef, type RefObject } from 'react'
import type { HandLabel, IdentifyState } from '../recognition/identifier'
import type { TrackingLoop } from '../tracking/trackingLoop'
import type { Frame } from '../tracking/types'

interface Props {
  loopRef: RefObject<TrackingLoop | null>
  state: IdentifyState | null
  mirror: boolean
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

const CYAN = '#5ef2ff'
const MAGENTA = '#ff5ef2'

/**
 * Futuristic targeting overlay for Identify: brackets, a scan line and a
 * spinning reticle around the hand (or both hands) doing the move, with a
 * leader line to a label. Drawn on its own unmirrored canvas, so the text
 * reads correctly; positions are mirrored by hand to line up with the preview.
 */
export function Hud({ loopRef, state, mirror }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<Frame | null>(null)
  const stateRef = useRef(state)
  const boxes = useRef(new Map<HandLabel, Box>())

  useEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    return loopRef.current?.onFrame((f) => {
      frameRef.current = f
    })
  }, [loopRef])

  useEffect(() => {
    let raf = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const canvas = canvasRef.current
      const frame = frameRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      const video = canvas.parentElement?.querySelector('video')
      if (video?.videoWidth && (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight)) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
      }
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      const s = stateRef.current
      if (!frame || !s) return
      const guesses = s.showLast && s.last ? s.last.guesses : []
      // Canvas pixels per screen pixel (the canvas is scaled to fit), so lines and text keep a readable size.
      const unit = Math.max(w / (canvas.clientWidth || w), h / (canvas.clientHeight || h))
      const seen = new Set<HandLabel>()
      const labels: Box[] = []
      for (const g of guesses) {
        const target = regionFor(frame, g.hand, g.slot)
        if (!target) continue
        seen.add(g.hand)
        const px: Box = {
          x0: (mirror ? 1 - target.x1 : target.x0) * w,
          x1: (mirror ? 1 - target.x0 : target.x1) * w,
          y0: target.y0 * h,
          y1: target.y1 * h,
        }
        // Ease towards the target so the frame glides instead of jittering.
        const prev = boxes.current.get(g.hand)
        const b = prev
          ? {
              x0: prev.x0 + (px.x0 - prev.x0) * 0.3,
              x1: prev.x1 + (px.x1 - prev.x1) * 0.3,
              y0: prev.y0 + (px.y0 - prev.y0) * 0.3,
              y1: prev.y1 + (px.y1 - prev.y1) * 0.3,
            }
          : px
        boxes.current.set(g.hand, b)
        drawTarget(ctx, b, g.moveName, g.strength, g.withCards, g.hand === 'Both' ? MAGENTA : CYAN, unit, now, w, h, labels)
      }
      for (const k of [...boxes.current.keys()]) if (!seen.has(k)) boxes.current.delete(k)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [mirror])

  return <canvas ref={canvasRef} className="hud" aria-hidden="true" />
}

/** Bounding box (normalised, unmirrored) of a hand and the packets it holds, or of everything for both hands. */
function regionFor(frame: Frame, hand: HandLabel, slot?: 0 | 1): Box | null {
  const hands =
    hand === 'Both'
      ? frame.hands
      : frame.hands.filter((h) => (slot !== undefined ? h.slot === slot : h.handedness === hand))
  if (!hands.length) return null
  const slots = new Set(hands.map((h) => h.slot))
  let x0 = 1
  let y0 = 1
  let x1 = 0
  let y1 = 0
  for (const hd of hands) {
    for (const [x, y] of hd.landmarks) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  for (const p of frame.cards ?? []) {
    if (p.hand === null || !slots.has(p.hand)) continue
    x0 = Math.min(x0, p.cx - p.length / 2)
    x1 = Math.max(x1, p.cx + p.length / 2)
    y0 = Math.min(y0, p.cy - p.length / 2)
    y1 = Math.max(y1, p.cy + p.length / 2)
  }
  const padX = (x1 - x0) * 0.12
  const padY = (y1 - y0) * 0.12
  return {
    x0: Math.max(0, x0 - padX),
    y0: Math.max(0, y0 - padY),
    x1: Math.min(1, x1 + padX),
    y1: Math.min(1, y1 + padY),
  }
}

function drawTarget(
  ctx: CanvasRenderingContext2D,
  b: Box,
  name: string,
  strength: number,
  withCards: boolean,
  colour: string,
  unit: number,
  now: number,
  canvasW: number,
  canvasH: number,
  /** Labels already placed this frame; this one moves to avoid them. */
  placed: Box[],
) {
  const bw = b.x1 - b.x0
  const bh = b.y1 - b.y0
  const cx = (b.x0 + b.x1) / 2
  const cy = (b.y0 + b.y1) / 2
  const corner = Math.min(bw, bh) * 0.22
  ctx.save()
  ctx.strokeStyle = colour
  ctx.fillStyle = colour
  ctx.shadowColor = colour
  ctx.shadowBlur = 12 * unit
  ctx.lineWidth = 2.5 * unit

  // Corner brackets.
  ctx.beginPath()
  for (const [x, y, dx, dy] of [
    [b.x0, b.y0, 1, 1],
    [b.x1, b.y0, -1, 1],
    [b.x0, b.y1, 1, -1],
    [b.x1, b.y1, -1, -1],
  ]) {
    ctx.moveTo(x, y + dy * corner)
    ctx.lineTo(x, y)
    ctx.lineTo(x + dx * corner, y)
  }
  ctx.stroke()

  // Faint frame and a scan line sweeping down.
  ctx.globalAlpha = 0.18
  ctx.lineWidth = 1 * unit
  ctx.strokeRect(b.x0, b.y0, bw, bh)
  const scan = b.y0 + ((now / 1400) % 1) * bh
  const grad = ctx.createLinearGradient(0, scan - 24 * unit, 0, scan)
  grad.addColorStop(0, 'transparent')
  grad.addColorStop(1, colour)
  ctx.globalAlpha = 0.35
  ctx.fillStyle = grad
  ctx.fillRect(b.x0, scan - 24 * unit, bw, 24 * unit)
  ctx.fillStyle = colour

  // Spinning reticle at the centre.
  ctx.globalAlpha = 0.85
  ctx.lineWidth = 2 * unit
  const r = Math.min(bw, bh) * 0.16
  ctx.setLineDash([8 * unit, 6 * unit])
  ctx.lineDashOffset = -now / 20
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.beginPath()
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    ctx.moveTo(cx + dx * r * 0.5, cy + dy * r * 0.5)
    ctx.lineTo(cx + dx * r * 1.35, cy + dy * r * 1.35)
  }
  ctx.stroke()

  // Leader line to a label above the box, kept on screen.
  const fontPx = Math.round(13 * unit)
  ctx.font = `600 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`
  const title = name.toUpperCase()
  const sub = `${Math.round(strength * 100)}% · ${withCards ? 'FINGERS+CARDS' : 'FINGERS'}`
  const tw = Math.max(ctx.measureText(title).width, ctx.measureText(sub).width * 0.8) + 16 * unit
  const th = fontPx * 2.4
  const goRight = cx < canvasW / 2
  const lx = goRight ? Math.min(canvasW - tw - 4 * unit, b.x1 + 8 * unit) : Math.max(4 * unit, b.x0 - tw - 8 * unit)
  // Above the box if there's room, else below; step away from labels already drawn.
  let labelY = Math.max(th + 4 * unit, b.y0 - 18 * unit)
  const hits = (y: number) => placed.some((p) => lx < p.x1 && lx + tw > p.x0 && y - th < p.y1 && y > p.y0)
  for (let k = 0; k < 6 && hits(labelY); k++) labelY = Math.min(canvasH - 4 * unit, labelY + th + 6 * unit)
  placed.push({ x0: lx, y0: labelY - th, x1: lx + tw, y1: labelY })
  ctx.globalAlpha = 0.9
  ctx.lineWidth = 1.5 * unit
  ctx.beginPath()
  ctx.moveTo(goRight ? b.x1 : b.x0, b.y0)
  ctx.lineTo(goRight ? lx : lx + tw, labelY)
  ctx.stroke()
  ctx.shadowBlur = 0
  ctx.globalAlpha = 0.65
  ctx.fillStyle = '#04121a'
  ctx.fillRect(lx, labelY - th, tw, th)
  ctx.globalAlpha = 1
  ctx.strokeRect(lx, labelY - th, tw, th)
  ctx.fillStyle = colour
  ctx.fillText(title, lx + 8 * unit, labelY - th + fontPx * 1.1)
  ctx.font = `500 ${Math.round(fontPx * 0.75)}px ui-monospace, SFMono-Regular, Menlo, monospace`
  ctx.fillText(sub, lx + 8 * unit, labelY - th + fontPx * 2.05)
  ctx.restore()
}
