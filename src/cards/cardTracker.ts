import type { TrackedHand } from '../tracking/types'
import { BIN_COUNT, buildBins, colourBin, saveDeck, type DeckModel } from './deckModel'
import type { Packet } from './types'

/** Working resolution (long side). Cards are big relative to this, and it keeps a frame to a few ms. */
const WORK_W = 192
/** How far (in hand sizes) around the hands to look for packets. */
const ROI_MARGIN = 1.0
/** A packet further than this (in hand sizes) from both hands isn't one being handled. */
const MAX_HAND_DIST = 1.6
/** Packet area limits as a share of the whole deck's face. */
const MIN_DECK_SHARE = 0.06
const MAX_DECK_SHARE = 1.8
const MAX_PACKETS = 4
/** Frames the deck must be held still in the guide before it's learned. */
const HOLD_FRAMES = 24

/** Where the deck is held for calibration: a card-shaped box in the middle, in normalised frame coordinates. */
export function calibrationBox(aspect: number) {
  // Landscape, the comfortable way to hold a deck up to a camera; on a tall
  // screen the box shrinks so it still fits across.
  const h = Math.min(0.36, (0.8 * aspect * 63) / 88)
  const w = (h * 88) / 63 / aspect
  return { x0: 0.5 - w / 2, y0: 0.47 - h / 2, x1: 0.5 + w / 2, y1: 0.47 + h / 2 }
}

export interface CalibrationState {
  phase: 'waiting' | 'holding' | 'done'
  /** 0..1 while holding. */
  progress: number
  hint: string
  /** Which hand held the deck, by MediaPipe's label. */
  hand?: 'Left' | 'Right'
  /** Set when the background has a lot of the deck's colours. */
  warning?: string
}

interface HandGeo {
  slot: 0 | 1
  label: 'Left' | 'Right'
  pts: [number, number][]
  size: number
}

/**
 * Card tracking that starts from the deck. A short calibration learns the
 * deck's colours (and size relative to the hand) while it is held in a
 * guide box; after that, each frame looks only near the hands for pixels
 * with the deck's colours. Each blob is a packet: centre, long-axis angle
 * and size from its image moments, held by the nearest hand. Every packet
 * comes from that deck, so blobs much smaller or bigger than it, or far
 * from both hands, are ignored. Touching packets merge into one blob.
 */
export class CardTracker {
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  private w = 0
  private h = 0
  private tracks: Packet[] = []
  private nextId = 1
  private deck: DeckModel | null = null
  private calibrating = false
  private prevBox: Uint8ClampedArray | null = null
  private stable = 0
  /** The hand last seen holding the deck, and for how many frames it has been missing since. */
  private lastHolder: HandGeo | null = null
  private holderMissing = 0
  /** Why the last lock attempt was refused, shown for a while after. */
  private notice = ''
  private noticeFrames = 0
  calibration: CalibrationState = { phase: 'waiting', progress: 0, hint: '' }
  /** Last processing time, ms. */
  ms = 0

  constructor(deck: DeckModel | null = null) {
    this.deck = deck
  }

  /** Whether a deck has been learned, so packets can be tracked. */
  get ready() {
    return this.deck !== null && !this.calibrating
  }

  startCalibration() {
    this.calibrating = true
    this.stable = 0
    this.prevBox = null
    this.lastHolder = null
    this.noticeFrames = 0
    this.tracks = []
    this.calibration = { phase: 'waiting', progress: 0, hint: 'Hold your deck in the box, back to the camera' }
  }

  /** A deck learned now or in an earlier session. */
  get hasDeck() {
    return this.deck !== null
  }

  get isCalibrating() {
    return this.calibrating
  }

  stopCalibration() {
    this.calibrating = false
  }

  private grab(video: HTMLVideoElement): Uint8ClampedArray | null {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return null
    const w = WORK_W
    const h = Math.max(1, Math.round((WORK_W * vh) / vw))
    if (w !== this.w || h !== this.h) {
      this.w = this.canvas.width = w
      this.h = this.canvas.height = h
    }
    this.ctx.drawImage(video, 0, 0, w, h)
    return this.ctx.getImageData(0, 0, w, h).data
  }

  private geometry(hands: TrackedHand[]): HandGeo[] {
    return hands.map((hd) => {
      const pts = hd.landmarks.map((p) => [p[0] * this.w, p[1] * this.h] as [number, number])
      return {
        slot: hd.slot,
        label: hd.handedness,
        pts,
        size: Math.max(4, Math.hypot(pts[9][0] - pts[0][0], pts[9][1] - pts[0][1])),
      }
    })
  }

  process(video: HTMLVideoElement, hands: TrackedHand[]): Packet[] {
    const t0 = performance.now()
    const px = this.grab(video)
    if (!px) return []
    const geo = this.geometry(hands)
    const out = this.calibrating ? (this.calibrateStep(px, geo), []) : this.detect(px, geo)
    this.ms = performance.now() - t0
    return out
  }

  private refuse(why: string, holder: HandGeo) {
    this.stable = 0
    this.notice = why
    this.noticeFrames = 45
    this.calibration = { phase: 'holding', progress: 0, hint: why, hand: holder.label }
  }

  /** One calibration frame: wait for a hand holding something still in the box, then learn its colours. */
  private calibrateStep(px: Uint8ClampedArray, geo: HandGeo[]) {
    const { w, h } = this
    const box = calibrationBox(w / h)
    const bx0 = Math.round(box.x0 * w)
    const by0 = Math.round(box.y0 * h)
    const bx1 = Math.round(box.x1 * w)
    const by1 = Math.round(box.y1 * h)
    const bw = bx1 - bx0
    const bh = by1 - by0
    // The middle of the box: deck, not the hand around its edges.
    const ix0 = bx0 + Math.round(bw * 0.2)
    const iy0 = by0 + Math.round(bh * 0.2)
    const ix1 = bx1 - Math.round(bw * 0.2)
    const iy1 = by1 - Math.round(bh * 0.2)

    // The holding hand: the one nearest the box, with some of it in or around the box.
    const near = geo.filter((g) =>
      g.pts.some(([x, y]) => x > bx0 - bw * 0.3 && x < bx1 + bw * 0.3 && y > by0 - bh * 0.3 && y < by1 + bh * 0.3),
    )
    const bcx = (bx0 + bx1) / 2
    const bcy = (by0 + by1) / 2
    const gap = (g: HandGeo) => Math.min(...g.pts.map(([x, y]) => Math.hypot(x - bcx, y - bcy)))
    const seen = near.sort((a, b) => gap(a) - gap(b))[0]
    // A deck covering the fingers makes the hand tracker drop the hand now and then; ride over short gaps.
    if (seen) {
      this.lastHolder = seen
      this.holderMissing = 0
    } else this.holderMissing++
    const holder = seen ?? (this.holderMissing <= 10 ? this.lastHolder : null)
    if (!holder) {
      this.lastHolder = null
      this.stable = 0
      this.prevBox = null
      this.calibration = { phase: 'waiting', progress: 0, hint: 'Hold your deck in the box, back to the camera' }
      return
    }

    // Held still? Compare the middle of the box with the last frame.
    const inner: number[] = []
    for (let y = iy0; y < iy1; y++)
      for (let x = ix0; x < ix1; x++) inner.push(px[(y * w + x) * 4], px[(y * w + x) * 4 + 1], px[(y * w + x) * 4 + 2])
    const cur = Uint8ClampedArray.from(inner)
    let diff = 0
    if (this.prevBox && this.prevBox.length === cur.length) {
      for (let i = 0; i < cur.length; i++) diff += Math.abs(cur[i] - this.prevBox[i])
      diff /= cur.length
    } else diff = Infinity
    this.prevBox = cur
    this.stable = diff < 10 ? this.stable + 1 : diff === Infinity ? 0 : Math.max(0, this.stable - 6)
    this.calibration = {
      phase: 'holding',
      progress: Math.min(1, this.stable / HOLD_FRAMES),
      hint: this.noticeFrames-- > 0 ? this.notice : this.stable ? 'Hold still…' : 'Hold the deck steady in the box',
      hand: holder.label,
    }
    if (this.stable < HOLD_FRAMES) return

    // Learn: deck colours from the middle of the box, skin from fingertips and knuckles outside it.
    const deckHist = new Float32Array(BIN_COUNT)
    let deckTotal = 0
    for (let i = 0; i < cur.length; i += 3) {
      deckHist[colourBin(cur[i], cur[i + 1], cur[i + 2])]++
      deckTotal++
    }
    const skinHist = new Float32Array(BIN_COUNT)
    let skinTotal = 0
    for (const g of geo) {
      for (const [x, y] of g.pts) {
        if (x > bx0 && x < bx1 && y > by0 && y < by1) continue
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.round(x) + dx
            const yy = Math.round(y) + dy
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
            const i = (yy * w + xx) * 4
            skinHist[colourBin(px[i], px[i + 1], px[i + 2])]++
            skinTotal++
          }
        }
      }
    }
    // A face or a bare hand in the box is not a deck.
    let skinLike = 0
    if (skinTotal) {
      for (let b = 0; b < BIN_COUNT; b++) if (skinHist[b] / skinTotal >= 0.06) skinLike += deckHist[b]
    }
    if (skinLike / deckTotal > 0.35) {
      return this.refuse('I see skin in the box. Cover it with the back of your deck', holder)
    }
    const bins = buildBins(deckHist, deckTotal, skinHist, skinTotal)

    // How big is the deck? The deck-coloured blob around the box.
    const ex0 = Math.max(0, bx0 - Math.round(bw * 0.3))
    const ey0 = Math.max(0, by0 - Math.round(bh * 0.3))
    const ex1 = Math.min(w - 1, bx1 + Math.round(bw * 0.3))
    const ey1 = Math.min(h - 1, by1 + Math.round(bh * 0.3))
    const rw = ex1 - ex0 + 1
    const rh = ey1 - ey0 + 1
    const mask = new Uint8Array(rw * rh)
    for (let y = ey0; y <= ey1; y++) {
      for (let x = ex0; x <= ex1; x++) {
        const i = (y * w + x) * 4
        if (bins[colourBin(px[i], px[i + 1], px[i + 2])]) mask[(y - ey0) * rw + (x - ex0)] = 1
      }
    }
    const blobs = components(majority(mask, rw, rh), rw, rh).sort((a, b) => b.n - a.n)
    const blob = blobs[0]
    const area = blob ? blob.n : bw * bh
    const length = blob ? Math.sqrt(12 * eigen(blob).l1) : bh

    // Warn if the background shares the deck's colours: sample away from the box and hands.
    let bgHits = 0
    let bgTotal = 0
    for (let y = 2; y < h; y += 6) {
      for (let x = 2; x < w; x += 6) {
        if (x > ex0 && x < ex1 && y > ey0 && y < ey1) continue
        if (geo.some((g) => g.pts.some(([lx, ly]) => Math.hypot(lx - x, ly - y) < g.size))) continue
        const i = (y * w + x) * 4
        bgTotal++
        if (bins[colourBin(px[i], px[i + 1], px[i + 2])]) bgHits++
      }
    }
    const bgShare = bgTotal ? bgHits / bgTotal : 0
    if (bgShare > 0.4) {
      // The box probably holds background, not a deck.
      return this.refuse("I can't tell the deck from the background. Hold it closer so it fills the box", holder)
    }

    this.deck = { bins, areaHands: area / (holder.size * holder.size), lengthAtCalibration: length / h }
    saveDeck(this.deck)
    this.calibrating = false
    this.calibration = {
      phase: 'done',
      progress: 1,
      hint: 'Deck locked',
      hand: holder.label,
      warning:
        bgShare > 0.15
          ? 'Some of the background is the same colour as your deck, so it may be mistaken for cards. A plainer background helps.'
          : undefined,
    }
  }

  /** Packets: deck-coloured blobs near the hands. */
  private detect(px: Uint8ClampedArray, geo: HandGeo[]): Packet[] {
    const deck = this.deck
    if (!deck || !geo.length) {
      this.tracks = []
      return []
    }
    const { w, h } = this
    let x0 = w
    let y0 = h
    let x1 = 0
    let y1 = 0
    for (const g of geo) {
      const m = g.size * ROI_MARGIN
      for (const [x, y] of g.pts) {
        x0 = Math.min(x0, x - m)
        y0 = Math.min(y0, y - m)
        x1 = Math.max(x1, x + m)
        y1 = Math.max(y1, y + m)
      }
    }
    x0 = Math.max(0, Math.floor(x0))
    y0 = Math.max(0, Math.floor(y0))
    x1 = Math.min(w - 1, Math.ceil(x1))
    y1 = Math.min(h - 1, Math.ceil(y1))
    if (x1 <= x0 || y1 <= y0) return []
    const rw = x1 - x0 + 1
    const rh = y1 - y0 + 1
    const mask = new Uint8Array(rw * rh)
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = (y * w + x) * 4
        if (deck.bins[colourBin(px[i], px[i + 1], px[i + 2])]) mask[(y - y0) * rw + (x - x0)] = 1
      }
    }
    const blobs = components(majority(mask, rw, rh), rw, rh)
    const meanSize = geo.reduce((s, g) => s + g.size, 0) / geo.length
    const deckArea = deck.areaHands * meanSize * meanSize
    const found: Omit<Packet, 'id'>[] = []
    for (const b of blobs) {
      if (b.n < deckArea * MIN_DECK_SHARE || b.n > deckArea * MAX_DECK_SHARE) continue
      const { mx, my, angle, l1, l2 } = eigen(b)
      const cx = mx + x0
      const cy = my + y0
      let hand: 0 | 1 | null = null
      let bestD = Infinity
      for (const g of geo) {
        for (const [x, y] of g.pts) {
          const d = Math.hypot(x - cx, y - cy) / g.size
          if (d < bestD) {
            bestD = d
            hand = g.slot
          }
        }
      }
      if (bestD > MAX_HAND_DIST || hand === null) continue
      found.push({
        cx: cx / w,
        cy: cy / h,
        angle,
        // A uniform rectangle's variance along a side is side²/12.
        length: Math.sqrt(12 * l1) / h,
        width: Math.sqrt(12 * l2) / h,
        hand,
      })
    }
    found.sort((a, b) => b.length * b.width - a.length * a.width)
    return this.track(found.slice(0, MAX_PACKETS), meanSize / h)
  }

  /** Keeps packet ids stable frame to frame and smooths their shape. */
  private track(found: Omit<Packet, 'id'>[], handSize: number): Packet[] {
    const used = new Set<number>()
    const out: Packet[] = []
    for (const f of found) {
      let best: Packet | null = null
      let bestD = handSize * 1.2
      for (const t of this.tracks) {
        if (used.has(t.id)) continue
        const d = Math.hypot(t.cx - f.cx, t.cy - f.cy)
        if (d < bestD) {
          bestD = d
          best = t
        }
      }
      if (!best) {
        out.push({ ...f, id: this.nextId++ })
        continue
      }
      used.add(best.id)
      const k = 0.6
      // Average angles on the doubled circle: a packet turned 180° is the same packet.
      const a2 = Math.atan2(
        Math.sin(2 * best.angle) * (1 - k) + Math.sin(2 * f.angle) * k,
        Math.cos(2 * best.angle) * (1 - k) + Math.cos(2 * f.angle) * k,
      )
      out.push({
        id: best.id,
        cx: best.cx + (f.cx - best.cx) * k,
        cy: best.cy + (f.cy - best.cy) * k,
        angle: a2 / 2,
        length: best.length + (f.length - best.length) * k,
        width: best.width + (f.width - best.width) * k,
        hand: f.hand,
      })
    }
    this.tracks = out
    return out
  }
}

/** Centre, long-axis angle and the two variances of a blob. */
function eigen(b: Blob) {
  const mx = b.sx / b.n
  const my = b.sy / b.n
  const cxx = b.sxx / b.n - mx * mx
  const cyy = b.syy / b.n - my * my
  const cxy = b.sxy / b.n - mx * my
  const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
  const tr = cxx + cyy
  const det = Math.sqrt(Math.max(0, ((cxx - cyy) / 2) ** 2 + cxy * cxy))
  return { mx, my, angle, l1: tr / 2 + det, l2: Math.max(0, tr / 2 - det) }
}

/** 3×3 majority filter: removes speckle and fills pinholes. */
function majority(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += mask[(y + dy) * w + x + dx]
      out[y * w + x] = s >= 5 ? 1 : 0
    }
  }
  return out
}

interface Blob {
  n: number
  sx: number
  sy: number
  sxx: number
  syy: number
  sxy: number
}

/** 4-connected components with their first and second moments. */
function components(mask: Uint8Array, w: number, h: number): Blob[] {
  const seen = new Uint8Array(mask.length)
  const stack: number[] = []
  const out: Blob[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const b: Blob = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0 }
    seen[start] = 1
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i - x) / w
      b.n++
      b.sx += x
      b.sy += y
      b.sxx += x * x
      b.syy += y * y
      b.sxy += x * y
      const visit = (j: number) => {
        if (mask[j] && !seen[j]) {
          seen[j] = 1
          stack.push(j)
        }
      }
      if (x > 0) visit(i - 1)
      if (x < w - 1) visit(i + 1)
      if (y > 0) visit(i - w)
      if (y < h - 1) visit(i + w)
    }
    out.push(b)
  }
  return out
}
