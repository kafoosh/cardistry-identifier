import type { TrackedHand } from '../tracking/types'
import { CARD_ASPECT, saveDeck, type DeckModel } from './deckModel'
import type { Packet } from './types'

/** Working resolution (long side). Keeps a frame to a few ms while a packet still spans dozens of pixels. */
const WORK_W = 256
/** A packet further than this (in deck lengths) from every tracked hand isn't one being handled. */
const MAX_HAND_DIST = 1.3
const MAX_PACKETS = 3
/** Frames the deck must be held still in the guide before its size is learned. */
const HOLD_FRAMES = 20
/** Edge score (see score()) a rectangle needs to count as a packet, and to keep being one. */
const DETECT_SCORE = 0.15
const KEEP_SCORE = 0.1
/** Short side over long side: face-on is the card's own proportions, tilted packets look thinner. */
const MIN_RATIO = 0.3
const MAX_RATIO = CARD_ASPECT * 1.15
/** Blob area limits relative to the deck's face (fingers hide some; a stack's side, a fan or a finger can join a blob). */
const MIN_AREA = 0.15
const MAX_AREA = 6
/** How much of a blob's fitted rectangle must be blob (a back's white border with a patterned middle is a ring). */
const MIN_FILL = 0.15

/** Where the deck is held for calibration: a card-shaped box in the middle, in normalised frame coordinates. */
export function calibrationBox(aspect: number) {
  // Landscape, the comfortable way to hold a deck up to a camera; on a tall
  // screen the box shrinks so it still fits across.
  const h = Math.min(0.36, 0.8 * aspect * CARD_ASPECT)
  const w = h / CARD_ASPECT / aspect
  return { x0: 0.5 - w / 2, y0: 0.47 - h / 2, x1: 0.5 + w / 2, y1: 0.47 + h / 2 }
}

export interface CalibrationState {
  phase: 'waiting' | 'holding' | 'done'
  /** 0..1 while holding. */
  progress: number
  hint: string
  hand?: 'Left' | 'Right'
  /** The rectangle being fitted to the deck, normalised like a Packet (no id or hand). */
  found?: Omit<Packet, 'id' | 'hand'>
}

interface HandGeo {
  slot: 0 | 1
  label: 'Left' | 'Right'
  pts: [number, number][]
  size: number
}

/** A rectangle in working-frame pixels; angle is the long side's direction. */
interface Rect {
  cx: number
  cy: number
  angle: number
  length: number
  width: number
}

interface Track extends Rect {
  id: number
  misses: number
}

interface Blob {
  n: number
  sx: number
  sy: number
  sxx: number
  syy: number
  sxy: number
  /** Pixel indices in the region. */
  px: number[]
}

/**
 * Card tracking by shape. Playing cards are white (faces) or white-bordered
 * (backs), so each frame is thresholded for white-ish pixels near the hands;
 * each solid blob with a card's proportions and about the deck's size (which
 * a short calibration measures) is a packet. Its rectangle is then snapped
 * onto the image edges and must sit on them, which rules out hands and
 * shelves that happen to be bright. Each packet is held by the nearest hand.
 * Packets that overlap in view merge into one.
 */
export class CardTracker {
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  private w = 0
  private h = 0
  private gx = new Float32Array(0)
  private gy = new Float32Array(0)
  /** Strong-edge level of the current frame, so scores don't depend on lighting or contrast. */
  private norm = 1
  /** 1 where a pixel is white-ish (bright and unsaturated). */
  private white = new Uint8Array(0)
  private tracks: Track[] = []
  private nextId = 1
  private deck: DeckModel | null = null
  private calibrating = false
  private stable = 0
  private lastFit: Rect | null = null
  /** The hand last seen holding the deck, and for how many frames it has been missing since. */
  private lastHolder: HandGeo | null = null
  private holderMissing = 0
  private searching = 0
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

  /** A deck learned now or in an earlier session. */
  get hasDeck() {
    return this.deck !== null
  }

  get isCalibrating() {
    return this.calibrating
  }

  startCalibration() {
    this.calibrating = true
    this.stable = 0
    this.lastFit = null
    this.lastHolder = null
    this.searching = 0
    this.tracks = []
    this.calibration = { phase: 'waiting', progress: 0, hint: 'Hold your deck sideways in the box, back to the camera' }
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
    const out = this.processPixels(px, hands, this.w, this.h)
    this.ms = performance.now() - t0
    return out
  }

  /** The work of process() on an RGBA frame of the given size (also used by tests). */
  processPixels(px: Uint8ClampedArray, hands: TrackedHand[], w: number, h: number): Packet[] {
    this.w = w
    this.h = h
    this.maps(px)
    const geo = this.geometry(hands)
    if (this.calibrating) {
      this.calibrateStep(geo)
      return []
    }
    return this.detect(geo)
  }

  /** Sobel gradients of the grey image, the frame's strong-edge level, and the white mask. */
  private maps(px: Uint8ClampedArray) {
    const { w, h } = this
    const n = w * h
    if (this.gx.length !== n) {
      this.gx = new Float32Array(n)
      this.gy = new Float32Array(n)
      this.white = new Uint8Array(n)
    }
    const grey = new Float32Array(n)
    for (let i = 0; i < n; i++) grey[i] = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11
    // "White" is relative to the brightest things in view, so dim rooms work too.
    const bright = new Float32Array(Math.ceil(n / 16))
    for (let i = 0, k = 0; i < n; i += 16) bright[k++] = grey[i]
    bright.sort()
    const whiteLevel = Math.max(90, bright[Math.floor(bright.length * 0.97)] * 0.72)
    for (let i = 0; i < n; i++) {
      const r = px[i * 4]
      const g = px[i * 4 + 1]
      const b = px[i * 4 + 2]
      const lo = Math.min(r, g, b)
      const hi = Math.max(r, g, b)
      // Cards are neutral; skin, wood and painted walls carry a tint even when bright.
      this.white[i] = lo > whiteLevel && hi - lo < hi * 0.15 ? 1 : 0
    }
    const { gx, gy } = this
    const mags: number[] = []
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        const a = grey[i - w - 1]
        const b = grey[i - w]
        const c = grey[i - w + 1]
        const d = grey[i - 1]
        const f = grey[i + 1]
        const g = grey[i + w - 1]
        const k = grey[i + w]
        const l = grey[i + w + 1]
        gx[i] = c + 2 * f + l - a - 2 * d - g
        gy[i] = g + 2 * k + l - a - 2 * b - c
        if ((x & 3) === 0 && (y & 3) === 0) mags.push(Math.abs(gx[i]) + Math.abs(gy[i]))
      }
    }
    mags.sort((p, q) => p - q)
    // The 95th percentile: a clear edge, but not the single hardest one in view.
    this.norm = Math.max(40, mags[Math.floor(mags.length * 0.95)] ?? 40)
  }

  /** Edge evidence (0..1) for the line from (x, y) along (dx, dy) for len pixels, with the edge brightening along (nx, ny). */
  private lineEdge(x: number, y: number, dx: number, dy: number, len: number, nx: number, ny: number) {
    const { w, h, gx, gy } = this
    const steps = Math.max(4, Math.min(16, Math.round(len / 3)))
    let sum = 0
    let hit = 0
    for (let k = 0; k < steps; k++) {
      // Skip the ends: corners are often under fingers or rounded.
      const t = (0.1 + (0.8 * (k + 0.5)) / steps) * len
      let best = 0
      // Allow the edge to sit a pixel either side of the line.
      for (let o = -1; o <= 1; o++) {
        const px = Math.round(x + dx * t + nx * o)
        const py = Math.round(y + dy * t + ny * o)
        if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue
        const i = py * w + px
        // Signed: a card is brighter than the hand or clothing around it, so the edge brightens inward.
        const v = gx[i] * nx + gy[i] * ny
        if (v > best) best = v
      }
      const v = best / this.norm
      sum += Math.min(1, v)
      if (v > 0.3) hit++
    }
    // Strength times coverage: a card's side is an edge along its whole length,
    // while a curve (a face, a shoulder) only touches the line in places.
    return (sum / steps) * (hit / steps)
  }

  /** Share of white pixels along a line (same walk as lineEdge). */
  private lineWhite(x: number, y: number, dx: number, dy: number, len: number) {
    const { w, h, white } = this
    const steps = Math.max(4, Math.min(16, Math.round(len / 3)))
    let hit = 0
    for (let k = 0; k < steps; k++) {
      const t = (0.1 + (0.8 * (k + 0.5)) / steps) * len
      const px = Math.round(x + dx * t)
      const py = Math.round(y + dy * t)
      if (px < 0 || py < 0 || px >= w || py >= h) continue
      hit += white[py * w + px]
    }
    return hit / steps
  }

  /** Whiteness just inside (or, with outside, just beyond) each of the four sides. */
  private rim(r: Rect, outside = false): number[] {
    const ux = Math.cos(r.angle)
    const uy = Math.sin(r.angle)
    const vx = -uy
    const vy = ux
    const inset = Math.max(1.5, Math.min(r.length, r.width) * 0.06) * (outside ? -1.5 : 1)
    const L = r.length
    const W = r.width
    const out: number[] = []
    for (const sign of [-1, 1]) {
      const ox = r.cx + vx * sign * (W / 2 - inset) - ux * (L / 2)
      const oy = r.cy + vy * sign * (W / 2 - inset) - uy * (L / 2)
      out.push(this.lineWhite(ox, oy, ux, uy, L))
    }
    for (const sign of [-1, 1]) {
      const ox = r.cx + ux * sign * (L / 2 - inset) - vx * (W / 2)
      const oy = r.cy + uy * sign * (L / 2 - inset) - vy * (W / 2)
      out.push(this.lineWhite(ox, oy, vx, vy, W))
    }
    return out
  }

  /** The four sides' edge strengths for a rectangle scaled by s about its centre. */
  private sides(r: Rect, s: number): number[] {
    const ux = Math.cos(r.angle)
    const uy = Math.sin(r.angle)
    const vx = -uy
    const vy = ux
    const L = r.length * s
    const W = r.width * s
    const out: number[] = []
    // Long sides: run along u, offset ±W/2 along v. Short sides: run along v, offset ±L/2 along u.
    // The normal passed in points inward.
    for (const sign of [-1, 1]) {
      const ox = r.cx + vx * sign * (W / 2) - ux * (L / 2)
      const oy = r.cy + vy * sign * (W / 2) - uy * (L / 2)
      out.push(this.lineEdge(ox, oy, ux, uy, L, -sign * vx, -sign * vy))
    }
    for (const sign of [-1, 1]) {
      const ox = r.cx + ux * sign * (L / 2) - vx * (W / 2)
      const oy = r.cy + uy * sign * (L / 2) - vy * (W / 2)
      out.push(this.lineEdge(ox, oy, vx, vy, W, -sign * ux, -sign * uy))
    }
    return out
  }

  /**
   * How well a rectangle looks like a card's outline, roughly 0..1: the
   * edge strength of its three best sides (one may be hidden under
   * fingers), less the edges just outside it (a busy texture, where any
   * rectangle finds edges, scores low), scaled by white-inside contrast.
   */
  private score(r: Rect): number {
    if (r.length < 6 || r.width < 2) return 0
    const at = this.sides(r, 1).sort((a, b) => b - a)
    const boundary = (at[0] + at[1] + at[2]) / 3
    const outer = mean(this.sides(r, 1.3))
    // A card's edge has its white face or border just inside and something else just outside.
    // The pattern on a back has edges too, but white on the outside of them.
    const inside = this.rim(r)
    const beyond = this.rim(r, true)
    const rim = inside.map((v, i) => v * (1 - beyond[i])).sort((a, b) => b - a)
    const contrast = (rim[0] + rim[1] + rim[2]) / 3
    return Math.max(0, boundary - 0.4 * outer) * (0.25 + 0.75 * contrast)
  }

  /** Nudges a rectangle onto the edges by coordinate ascent, within the given limits. */
  private refine(start: Rect, limits: { minLen: number; maxLen: number; minRatio: number; maxRatio: number }) {
    let r = { ...start }
    let best = this.score(r)
    let step = { pos: Math.max(1, r.length * 0.05), angle: 0.06, size: 0.05 }
    for (let pass = 0; pass < 4; pass++) {
      const tries: ((q: Rect, sign: number) => Rect)[] = [
        (q, sg) => ({ ...q, cx: q.cx + sg * step.pos }),
        (q, sg) => ({ ...q, cy: q.cy + sg * step.pos }),
        (q, sg) => ({ ...q, angle: q.angle + sg * step.angle }),
        (q, sg) => ({ ...q, length: q.length * (1 + sg * step.size), width: q.width * (1 + sg * step.size) }),
        (q, sg) => ({ ...q, width: q.width * (1 + sg * step.size) }),
      ]
      for (const make of tries) {
        for (const sg of [-1, 1]) {
          const q = make(r, sg)
          const ratio = q.width / q.length
          if (q.length < limits.minLen || q.length > limits.maxLen) continue
          if (ratio < limits.minRatio || ratio > limits.maxRatio) continue
          const sc = this.score(q)
          if (sc > best) {
            best = sc
            r = q
          }
        }
      }
      step = { pos: Math.max(0.5, step.pos * 0.5), angle: step.angle * 0.5, size: step.size * 0.5 }
    }
    return { rect: r, score: best }
  }

  /**
   * Solid white blobs in a region, as rectangles from their image moments,
   * with each one's fill (blob area over rectangle area).
   */
  private blobs(x0: number, y0: number, x1: number, y1: number): { rect: Rect; fill: number }[] {
    const { w, h, white } = this
    x0 = Math.max(0, Math.floor(x0))
    y0 = Math.max(0, Math.floor(y0))
    x1 = Math.min(w - 1, Math.ceil(x1))
    y1 = Math.min(h - 1, Math.ceil(y1))
    if (x1 - x0 < 4 || y1 - y0 < 4) return []
    const rw = x1 - x0 + 1
    const rh = y1 - y0 + 1
    const mask = new Uint8Array(rw * rh)
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[(y - y0) * rw + (x - x0)] = white[y * w + x]
    const out: { rect: Rect; fill: number }[] = []
    for (const b of components(majority(mask, rw, rh), rw, rh)) {
      if (b.n < 30) continue
      // Orientation from the moments; extent along each axis from the pixels themselves (trimmed a little),
      // so a card back, which is a white ring round a patterned middle, still measures as its outline.
      const { angle } = eigen(b)
      const ux = Math.cos(angle)
      const uy = Math.sin(angle)
      const us = new Float32Array(b.n)
      const vs = new Float32Array(b.n)
      for (let k = 0; k < b.n; k++) {
        const i = b.px[k]
        const x = i % rw
        const y = (i - x) / rw
        us[k] = x * ux + y * uy
        vs[k] = -x * uy + y * ux
      }
      us.sort()
      vs.sort()
      const lo = Math.floor(b.n * 0.02)
      const hi = Math.ceil(b.n * 0.98) - 1
      const length = us[hi] - us[lo] + 1
      const width = vs[hi] - vs[lo] + 1
      const cu = (us[hi] + us[lo]) / 2
      const cv = (vs[hi] + vs[lo]) / 2
      const cx = cu * ux - cv * uy + x0
      const cy = cu * uy + cv * ux + y0
      out.push({ rect: { cx, cy, angle, length, width }, fill: b.n / Math.max(1, length * width) })
    }
    return out
  }

  /**
   * The best card rectangle on a blob. The blob's outline only roughly says
   * where the card is (a stack's bright side or a finger joins it, and a
   * back is a ring), so try every orientation and a few sizes about its
   * centre, then snap the best few onto the edges.
   */
  private fitCard(blob: Rect, limits: { minLen: number; maxLen: number; minRatio: number; maxRatio: number }) {
    const seeds: { r: Rect; s: number }[] = []
    for (let a = 0; a < Math.PI; a += Math.PI / 18) {
      for (const sl of [0.6, 0.8, 1]) {
        const length = Math.min(limits.maxLen, Math.max(limits.minLen, blob.length * sl))
        for (const ratio of [CARD_ASPECT, 0.45]) {
          const r = { cx: blob.cx, cy: blob.cy, angle: a, length, width: length * ratio }
          seeds.push({ r, s: this.score(r) })
        }
      }
    }
    seeds.sort((p, q) => q.s - p.s)
    let best: { rect: Rect; score: number } | null = null
    for (const seed of seeds.slice(0, 4)) {
      const fit = this.refine(seed.r, limits)
      if (!best || fit.score > best.score) best = fit
    }
    return best
  }

  /** One calibration frame: find a card-shaped white blob in the box, and learn its size once it holds steady. */
  private calibrateStep(geo: HandGeo[]) {
    const { w, h } = this
    const box = calibrationBox(w / h)
    const bx0 = box.x0 * w
    const by0 = box.y0 * h
    const bx1 = box.x1 * w
    const by1 = box.y1 * h
    const bw = bx1 - bx0
    const bh = by1 - by0

    // The holding hand, when the tracker has it: the deck often hides enough of the hand to lose it,
    // so the lock doesn't wait for one.
    const bcx = (bx0 + bx1) / 2
    const bcy = (by0 + by1) / 2
    const gap = (g: HandGeo) => Math.min(...g.pts.map(([x, y]) => Math.hypot(x - bcx, y - bcy)))
    const seen = geo.filter((g) => gap(g) < bw * 0.6).sort((a, b) => gap(a) - gap(b))[0]
    if (seen) {
      this.lastHolder = seen
      this.holderMissing = 0
    } else this.holderMissing++
    const holder = seen ?? (this.holderMissing <= 30 ? this.lastHolder : null)

    // The deck: a card-proportioned white blob centred in the box, snapped onto its edges.
    const limits = { minLen: bw * 0.4, maxLen: bw * 1.2, minRatio: CARD_ASPECT * 0.8, maxRatio: MAX_RATIO }
    let found: Rect | null = null
    let bestScore = 0
    // Last frame's fit first: the deck is being held still, so it's usually right where it was.
    if (this.lastFit) {
      const fit = this.refine(this.lastFit, limits)
      if (fit.score >= DETECT_SCORE) {
        bestScore = fit.score
        found = fit.rect
      }
    }
    for (const { rect, fill } of this.blobs(bx0 - bw * 0.2, by0 - bh * 0.3, bx1 + bw * 0.2, by1 + bh * 0.3)) {
      if (fill < MIN_FILL) continue
      if (Math.abs(rect.cx - bcx) > bw * 0.3 || Math.abs(rect.cy - bcy) > bh * 0.4) continue
      if (rect.length < limits.minLen * 0.8 || rect.length > limits.maxLen * 1.3) continue
      const fit = this.fitCard(rect, limits)
      if (!fit || fit.score < DETECT_SCORE || fit.score <= bestScore) continue
      // Sideways, as the guide shows.
      if (Math.abs(Math.sin(fit.rect.angle)) > 0.5) continue
      bestScore = fit.score
      found = fit.rect
    }
    const prev = this.lastFit
    const steady =
      found &&
      prev &&
      Math.hypot(found.cx - prev.cx, found.cy - prev.cy) < found.length * 0.08 &&
      Math.abs(found.length / prev.length - 1) < 0.1
    // A frame where the deck isn't picked out (a finger moved, the light flickered) doesn't start over.
    if (found) this.lastFit = found
    else if (this.searching > 8) this.lastFit = null
    this.stable = steady ? this.stable + 1 : found ? Math.max(0, this.stable - 4) : Math.max(0, this.stable - 1)
    this.searching = found ? 0 : this.searching + 1
    this.calibration = {
      phase: found ? 'holding' : 'waiting',
      progress: Math.min(1, this.stable / HOLD_FRAMES),
      hint: found
        ? 'Hold still…'
        : this.searching > 30
          ? "I can't make out the deck yet. Hold it flat, filling the box, with the back to the camera"
          : 'Hold your deck sideways in the box, back to the camera',
      hand: holder?.label,
      found: found ? this.normalised(found) : undefined,
    }
    if (!found || this.stable < HOLD_FRAMES) return

    this.deck = { length: found.length / h, lengthHands: holder ? found.length / holder.size : 0 }
    saveDeck(this.deck)
    this.calibrating = false
    this.calibration = {
      phase: 'done',
      progress: 1,
      hint: 'Deck locked',
      hand: holder?.label,
      found: this.normalised(found),
    }
  }

  private normalised(r: Rect): Omit<Packet, 'id' | 'hand'> {
    return { cx: r.cx / this.w, cy: r.cy / this.h, angle: r.angle, length: r.length / this.h, width: r.width / this.h }
  }

  /** Packets: solid card-shaped white blobs of about the deck's size near the hands, sitting on image edges. */
  private detect(geo: HandGeo[]): Packet[] {
    const deck = this.deck
    if (!deck) {
      this.tracks = []
      return []
    }
    const { w, h } = this
    // Expected long side: as calibrated. (Hand size would follow the deck towards and away from the
    // camera, but the tracker's hand sizes swing too much when fingers are hidden.)
    const expected = deck.length * h
    const expectedArea = expected * expected * CARD_ASPECT
    const limits = { minLen: expected * 0.5, maxLen: expected * 1.6, minRatio: MIN_RATIO, maxRatio: MAX_RATIO }

    // Blobs anywhere (cropping to a region around the hands would cut a deck in half when the
    // tracker has lost the hand holding it); ones far from every hand are dropped at the end.
    const found: Rect[] = []
    for (const { rect, fill } of this.blobs(0, 0, w - 1, h - 1)) {
      const area = rect.length * rect.width
      if (area < expectedArea * MIN_AREA || area > expectedArea * MAX_AREA) continue
      if (fill < MIN_FILL) continue
      const fit = this.fitCard(rect, limits)
      if (fit && fit.score >= DETECT_SCORE) found.push(fit.rect)
    }

    // Match to known packets so ids stay put and outlines glide; a packet missing for a frame or two is kept.
    const used = new Set<number>()
    const next: Track[] = []
    for (const f of found.sort((a, b) => b.length * b.width - a.length * a.width).slice(0, MAX_PACKETS)) {
      let best: Track | null = null
      let bestD = Math.min(f.length, expected) * 0.6
      for (const t of this.tracks) {
        if (used.has(t.id)) continue
        const d = Math.hypot(t.cx - f.cx, t.cy - f.cy)
        if (d < bestD) {
          bestD = d
          best = t
        }
      }
      if (best) {
        used.add(best.id)
        next.push({ ...smooth(best, f), id: best.id, misses: 0 })
      } else if (geo.length) next.push({ ...f, id: this.nextId++, misses: 0 })
      // With no hand in view, only packets already being followed carry on (the hand tracker drops the
      // hand under a deck for a few frames); nothing new starts, so a shelf can't become a packet.
    }
    for (const t of this.tracks) {
      if (used.has(t.id) || t.misses >= 2) continue
      // Still on its edges? Then it's just not a clean blob this frame (a finger across it, say).
      if (this.score(t) >= KEEP_SCORE) next.push({ ...t, misses: t.misses + 1 })
    }
    this.tracks = next

    const out: Packet[] = []
    for (const t of this.tracks) {
      let hand: 0 | 1 | null = null
      let bestD = Infinity
      for (const g of geo) {
        for (const [x, y] of g.pts) {
          const d = Math.hypot(x - t.cx, y - t.cy)
          if (d < bestD) {
            bestD = d
            hand = g.slot
          }
        }
      }
      // A card shape away from every tracked hand isn't a packet being handled (a picture frame, a sheet
      // of paper). With no hand tracked at all, the packet is kept but belongs to no hand.
      if (geo.length && bestD > expected * MAX_HAND_DIST) continue
      out.push({ id: t.id, ...this.normalised(t), hand })
    }
    return out
  }
}

function mean(v: number[]) {
  return v.reduce((s, x) => s + x, 0) / v.length
}

/** Eases a track towards its new fit, so the outline glides instead of jittering. */
function smooth(prev: Rect, next: Rect): Rect {
  const k = 0.7
  // Average angles on the doubled circle: a packet turned 180° is the same packet.
  const a2 = Math.atan2(
    Math.sin(2 * prev.angle) * (1 - k) + Math.sin(2 * next.angle) * k,
    Math.cos(2 * prev.angle) * (1 - k) + Math.cos(2 * next.angle) * k,
  )
  return {
    cx: prev.cx + (next.cx - prev.cx) * k,
    cy: prev.cy + (next.cy - prev.cy) * k,
    angle: a2 / 2,
    length: prev.length + (next.length - prev.length) * k,
    width: prev.width + (next.width - prev.width) * k,
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

/** 4-connected components with their first and second moments. */
function components(mask: Uint8Array, w: number, h: number): Blob[] {
  const seen = new Uint8Array(mask.length)
  const stack: number[] = []
  const out: Blob[] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const b: Blob = { n: 0, sx: 0, sy: 0, sxx: 0, syy: 0, sxy: 0, px: [] }
    seen[start] = 1
    stack.push(start)
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i - x) / w
      b.n++
      b.px.push(i)
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
