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

const ONE = '#e6fbff'
const BOTH = '#ffd9f6'

/**
 * Light targeting overlay for Identify: small corner marks around the hand
 * (or both hands) doing the move, with the move's name beside them. Drawn on its own unmirrored canvas, so the text
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
    const draw = () => {
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
        drawTarget(ctx, b, g.moveName, g.strength, g.hand === 'Both' ? BOTH : ONE, unit, w, h, labels)
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
  colour: string,
  unit: number,
  canvasW: number,
  canvasH: number,
  /** Labels already placed this frame; this one moves to avoid them. */
  placed: Box[],
) {
  const bw = b.x1 - b.x0
  const bh = b.y1 - b.y0
  const corner = Math.min(bw, bh) * 0.12
  ctx.save()
  ctx.strokeStyle = colour
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 1.5 * unit

  // Small corner marks only, so the hands stay clear.
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

  // A quiet label just above the box (below it if there is no room).
  const fontPx = Math.round(12 * unit)
  ctx.font = `500 ${fontPx}px system-ui, sans-serif`
  const text = `${name} · ${Math.round(strength * 100)}%`
  const tw = ctx.measureText(text).width + 12 * unit
  const th = fontPx * 1.7
  const lx = Math.min(canvasW - tw - 4 * unit, Math.max(4 * unit, b.x0))
  let ly = b.y0 - th - 4 * unit
  if (ly < 4 * unit) ly = Math.min(canvasH - th - 4 * unit, b.y1 + 4 * unit)
  const hits = (y: number) => placed.some((p) => lx < p.x1 && lx + tw > p.x0 && y < p.y1 && y + th > p.y0)
  for (let k = 0; k < 6 && hits(ly); k++) ly = Math.min(canvasH - th - 4 * unit, ly + th + 4 * unit)
  placed.push({ x0: lx, y0: ly, x1: lx + tw, y1: ly + th })
  ctx.globalAlpha = 0.6
  ctx.fillStyle = '#000'
  ctx.beginPath()
  ctx.roundRect(lx, ly, tw, th, th / 2)
  ctx.fill()
  ctx.globalAlpha = 0.95
  ctx.fillStyle = colour
  ctx.textBaseline = 'middle'
  ctx.fillText(text, lx + 6 * unit, ly + th / 2)
  ctx.restore()
}
