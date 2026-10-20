import type { TrackedHand } from '../tracking/types'
import { CARD_ASPECT, saveDeck, type DeckModel } from './deckModel'
import type { Fan, Packet } from './types'

/** Working resolution (long side). Keeps a frame to a few ms while a packet still spans dozens of pixels. */
export const WORK_W = 256
/** A packet further than this (in deck lengths) from every tracked hand isn't one being handled. */
const MAX_HAND_DIST = 1.0
/** Frames the last tracked hands count for after the hand tracker loses them (a hand under a deck often drops out). */
const HAND_MEMORY = 30
const MAX_PACKETS = 3
/** Frames the deck must be held still in the guide before its size is learned. */
const HOLD_FRAMES = 20
/** Edge score (see score()) a rectangle needs to count as a packet, and to keep being one. */
const DETECT_SCORE = 0.15
const KEEP_SCORE = 0.1
/** Short side over long side: face-on is the card's own proportions, tilted packets look thinner. */
const MIN_RATIO = 0.3
const MAX_RATIO = CARD_ASPECT * 1.15
/**
 * A card tilted towards or away from the camera: its long sides look shorter, so it looks squarer,
 * and its short sides lean (radians off square). Seeds try this lean at this squareness.
 */
const TILT_MAX_RATIO = 1
const MAX_SKEW = 0.6
const TILT_SEED = 0.45
const TILT_RATIO = 0.85
/** Blob area limits relative to the deck's face (fingers hide some; a stack's side, a fan or a finger can join a blob). */
const MIN_AREA = 0.15
const MAX_AREA = 6
/** How much of a blob's fitted rectangle must be blob (a back's white border with a patterned middle is a ring). */
const MIN_FILL = 0.15
/** How far from neutral a bright pixel may be and still count as white: skin, wood and painted walls are tinted more. */
const WHITE_SAT = 0.15
/** A light's tint can be taken off by at most this much per channel; a stronger cast is a coloured object, not the light. */
const MAX_GAIN = 1.3
/** Straight edges: direction bins over 180° and offset bins (px) for finding card sides; a side must be this share of the deck's length. */
const SEG_ANGLES = 36
const SEG_RHO = 3
const SEG_MIN_LEN = 0.35
/**
 * How long an edge has sat in one place: a level that rises by BG_RISE of the way to 1 on each
 * processed frame the edge is there and falls by BG_FALL on each it isn't. Past BG_EDGE it is
 * furniture, not a card: about 20 frames in place, and it stays furniture while a hand or a fan
 * covers it for a few seconds.
 */
const BG_RISE = 0.04
const BG_FALL = 0.01
const BG_EDGE = 0.5
/** A rectangle whose sides are mostly such old edges is not a new packet. */
const MAX_STALE = 0.4
/** Fans: hinge votes land in cells this wide; edge directions are binned this finely over 180°. */
const FAN_CELL = 4
const FAN_BINS = 12
/** Edge pixels this strong (relative to the frame's strong-edge level) vote; fanned faces are faint. */
const FAN_EDGE = 0.12
/** A hinge needs card edges arriving from at least this many direction bins. */
const FAN_MIN_BINS = 8
/** A fan sweeps at least this angle (radians) and its cards are at least this white. */
const FAN_MIN_SPAN = 1.4
const FAN_MIN_WHITE = 0.35
const FAN_MIN_EDGE = 0.17
/** Mean edge strength along arcs through the cards: many thin cards make fine stripes, a few spread cards don't. */
const FAN_MIN_TEXTURE = 0.25
/** A fan shows after this many consecutive frames, and survives this many missed ones. */
const FAN_CONFIRM = 2
const FAN_MISSES = 3
const MAX_FANS = 2
/** A rectangle mostly over a hand (palm and fingers) is often the hand's own outline: it needs a clearer fit to count. */
const HAND_COVER = 0.5
const HAND_SCORE = 0.25
/** Finger width as a share of hand size (wrist to middle knuckle), for telling what a hand covers. */
const FINGER_R = 0.13
const PALM = [0, 1, 5, 9, 13, 17]
const FINGERS = [
  [0, 1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [0, 17, 18, 19, 20],
]

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

/**
 * A card's outline in working-frame pixels; angle is the long side's direction. A card tilted
 * towards or away from the camera looks slanted, so the short sides may lean by skew radians off
 * square (a parallelogram, which is what a small tilted card looks like).
 */
interface Rect {
  cx: number
  cy: number
  angle: number
  length: number
  width: number
  skew?: number
}

/** What a fitted outline may look like: long side in pixels, short over long side, and lean. */
interface Limits {
  minLen: number
  maxLen: number
  minRatio: number
  maxRatio: number
  maxSkew: number
}

interface Track extends Rect {
  id: number
  misses: number
}

interface Fit {
  rect: Rect
  score: number
}

/** A fan in working-frame pixels: hinge, sector (counter-clockwise from `from` to `to`) and reach. */
interface Sector {
  hx: number
  hy: number
  from: number
  to: number
  radius: number
  /** Mean edge strength across the cards (along arcs inside the sector): a fan of many cards is finely striped. */
  texture: number
}

interface FanTrack extends Sector {
  id: number
  hits: number
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
  /** Made on first use, so the tracker also runs where there is no document (a worker, tests). */
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private w = 0
  private h = 0
  private gx = new Float32Array(0)
  private gy = new Float32Array(0)
  /** Strong-edge level of the current frame, so scores don't depend on lighting or contrast. */
  private norm = 1
  private whiteLevel = 90
  /** Per-channel gains applied before the white test: the deck's learned tint (see DeckModel.tint). */
  private gains: [number, number, number] = [1, 1, 1]
  private lastPx: Uint8ClampedArray | null = null
  /** 1 where a pixel is white-ish (bright and unsaturated). */
  private white = new Uint8Array(0)
  /** How long each pixel has been a strong edge (see BG_RISE). */
  private edgeAge = new Float32Array(0)
  private tracks: Track[] = []
  private fanTracks: FanTrack[] = []
  private fanTick = 0
  private nextId = 1
  /** Fans found in the last processed frame, alongside the packets process() returns. */
  fans: Fan[] = []
  /**
   * Also seed packets from straight edges, for decks whose backs have no
   * white border. Off by default: edges alone also pick up drawers, shelves
   * and the odd hand, which the white-blob path never does.
   */
  borderless = false
  private lastGeo: HandGeo[] = []
  private lastGeoAge = Infinity
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
    if (deck?.tint) this.gains = deck.tint
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

  /** The learned deck, for saving outside the tracker (a worker has no storage). */
  get deckModel() {
    return this.deck
  }

  startCalibration() {
    this.calibrating = true
    this.stable = 0
    this.lastFit = null
    this.lastHolder = null
    this.searching = 0
    this.tracks = []
    // The light may have changed since the last deck was learned.
    this.gains = [1, 1, 1]
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
    if (!this.canvas || !this.ctx) {
      this.canvas = document.createElement('canvas')
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })
      if (!this.ctx) return null
    }
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
      this.fans = []
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
      this.edgeAge = new Float32Array(n)
    }
    const grey = new Float32Array(n)
    for (let i = 0; i < n; i++) grey[i] = px[i * 4] * 0.3 + px[i * 4 + 1] * 0.59 + px[i * 4 + 2] * 0.11
    // "White" is relative to the brightest things in view, so dim rooms work too.
    const bright = new Float32Array(Math.ceil(n / 16))
    for (let i = 0, k = 0; i < n; i += 16) bright[k++] = grey[i]
    bright.sort()
    this.whiteLevel = Math.max(90, bright[Math.floor(bright.length * 0.97)] * 0.72)
    this.lastPx = px
    this.whiteMask()
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
    const strong = this.norm * 0.5
    const age = this.edgeAge
    for (let i = 0; i < n; i++) {
      if (Math.abs(gx[i]) + Math.abs(gy[i]) >= strong) age[i] += (1 - age[i]) * BG_RISE
      else age[i] *= 1 - BG_FALL
    }
  }

  /** Which pixels are white: bright, and neutral once the learned light tint is taken off. */
  private whiteMask() {
    const px = this.lastPx
    if (!px) return
    const n = this.w * this.h
    const [kr, kg, kb] = this.gains
    const whiteLevel = this.whiteLevel
    for (let i = 0; i < n; i++) {
      const r = px[i * 4] * kr
      const g = px[i * 4 + 1] * kg
      const b = px[i * 4 + 2] * kb
      const lo = Math.min(r, g, b)
      const hi = Math.max(r, g, b)
      // Cards are neutral; skin, wood and painted walls carry a tint even when bright.
      this.white[i] = lo > whiteLevel && hi - lo < hi * WHITE_SAT ? 1 : 0
    }
  }

  /**
   * The colour of the light, read off a card's border: the mean of the
   * bright, not-too-tinted pixels just inside the rectangle's edges, as
   * gains that would make it neutral. Null when too few pixels qualify.
   */
  private rimTint(r: Rect): [number, number, number] | null {
    const px = this.lastPx
    if (!px) return null
    const { w, h } = this
    const { ux, uy, vx, vy } = axes(r)
    const inset = Math.max(1.5, Math.min(r.length, r.width) * 0.06)
    let sr = 0
    let sg = 0
    let sb = 0
    let n = 0
    const walk = (ox: number, oy: number, dx: number, dy: number, len: number) => {
      const steps = Math.max(6, Math.round(len / 2))
      for (let k = 0; k < steps; k++) {
        const t = (0.05 + (0.9 * (k + 0.5)) / steps) * len
        const x = Math.round(ox + dx * t)
        const y = Math.round(oy + dy * t)
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const i = (y * w + x) * 4
        const cr = px[i]
        const cg = px[i + 1]
        const cb = px[i + 2]
        const lo = Math.min(cr, cg, cb)
        const hi = Math.max(cr, cg, cb)
        if (lo < this.whiteLevel * 0.7 || hi - lo > hi * 0.35) continue
        sr += cr
        sg += cg
        sb += cb
        n++
      }
    }
    for (const sign of [-1, 1]) {
      walk(
        r.cx + vx * sign * (r.width / 2 - inset) - ux * (r.length / 2),
        r.cy + vy * sign * (r.width / 2 - inset) - uy * (r.length / 2),
        ux,
        uy,
        r.length,
      )
      walk(
        r.cx + ux * sign * (r.length / 2 - inset) - vx * (r.width / 2),
        r.cy + uy * sign * (r.length / 2 - inset) - vy * (r.width / 2),
        vx,
        vy,
        r.width,
      )
    }
    if (n < 12) return null
    const mean = (sr + sg + sb) / (3 * n)
    const gain = (sum: number) => Math.min(MAX_GAIN, Math.max(1 / MAX_GAIN, (mean * n) / Math.max(1, sum)))
    return [gain(sr), gain(sg), gain(sb)]
  }

  /** The share of a rectangle's edge pixels that have been edges for a long time (furniture, shelves, drawers). */
  private staleness(r: Rect): number {
    const { w, h, gx, gy, edgeAge } = this
    const { ux, uy, vx, vy, lx, ly, sx, sy } = axes(r)
    let hits = 0
    let old = 0
    const walk = (ox: number, oy: number, dx: number, dy: number, len: number, nx: number, ny: number) => {
      const steps = Math.max(4, Math.min(16, Math.round(len / 3)))
      for (let k = 0; k < steps; k++) {
        const t = (0.1 + (0.8 * (k + 0.5)) / steps) * len
        let best = 0
        let bestI = -1
        for (let o = -1; o <= 1; o++) {
          const px = Math.round(ox + dx * t + nx * o)
          const py = Math.round(oy + dy * t + ny * o)
          if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue
          const i = py * w + px
          const v = Math.abs(gx[i] * nx + gy[i] * ny)
          if (v > best) {
            best = v
            bestI = i
          }
        }
        if (bestI < 0 || best < this.norm * 0.3) continue
        hits++
        if (edgeAge[bestI] >= BG_EDGE) old++
      }
    }
    for (const sign of [-1, 1]) {
      walk(
        r.cx + vx * sign * (r.width / 2) - ux * (r.length / 2),
        r.cy + vy * sign * (r.width / 2) - uy * (r.length / 2),
        ux,
        uy,
        r.length,
        lx,
        ly,
      )
      walk(
        r.cx + ux * sign * (r.length / 2) - vx * (r.width / 2),
        r.cy + uy * sign * (r.length / 2) - vy * (r.width / 2),
        vx,
        vy,
        r.width,
        sx,
        sy,
      )
    }
    return hits ? old / hits : 0
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
    const { ux, uy, vx, vy } = axes(r)
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
    const { ux, uy, vx, vy, lx, ly, sx, sy } = axes(r)
    const L = r.length * s
    const W = r.width * s
    const out: number[] = []
    // Long sides: run along u, offset ±W/2 along v. Short sides: run along v, offset ±L/2 along u.
    // The normal passed in points inward.
    for (const sign of [-1, 1]) {
      const ox = r.cx + vx * sign * (W / 2) - ux * (L / 2)
      const oy = r.cy + vy * sign * (W / 2) - uy * (L / 2)
      out.push(this.lineEdge(ox, oy, ux, uy, L, -sign * lx, -sign * ly))
    }
    for (const sign of [-1, 1]) {
      const ox = r.cx + ux * sign * (L / 2) - vx * (W / 2)
      const oy = r.cy + uy * sign * (L / 2) - vy * (W / 2)
      out.push(this.lineEdge(ox, oy, vx, vy, W, -sign * sx, -sign * sy))
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
  private refine(start: Rect, limits: Limits) {
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
      // Leaning the short sides (a tilted card) only where tilted outlines are allowed.
      if (limits.maxSkew > 0) tries.push((q, sg) => ({ ...q, skew: (q.skew ?? 0) + sg * step.angle * 2 }))
      for (const make of tries) {
        for (const sg of [-1, 1]) {
          const q = make(r, sg)
          const ratio = q.width / q.length
          if (q.length < limits.minLen || q.length > limits.maxLen) continue
          if (ratio < limits.minRatio || ratio > limits.maxRatio) continue
          if (Math.abs(q.skew ?? 0) > limits.maxSkew) continue
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
  private fitCard(blob: Rect, limits: Limits) {
    const seeds: { r: Rect; s: number }[] = []
    for (let a = 0; a < Math.PI; a += Math.PI / 18) {
      for (const sl of [0.6, 0.8, 1]) {
        const length = Math.min(limits.maxLen, Math.max(limits.minLen, blob.length * sl))
        for (const ratio of [CARD_ASPECT, 0.45]) {
          const r = { cx: blob.cx, cy: blob.cy, angle: a, length, width: length * ratio }
          seeds.push({ r, s: this.score(r) })
        }
        // A card tilted towards the camera: its long sides foreshortened, its short sides leaning.
        for (const skew of limits.maxSkew > 0 ? [-TILT_SEED, TILT_SEED] : []) {
          const r = { cx: blob.cx, cy: blob.cy, angle: a, length, width: length * TILT_RATIO, skew }
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

  /** The best sideways card shape near a point, from a grid of positions, sizes and tilts snapped onto edges. */
  private sweep(
    cx: number,
    cy: number,
    bw: number,
    bh: number,
    limits: Limits,
  ) {
    const seeds: { r: Rect; s: number }[] = []
    for (const ox of [-0.15, 0, 0.15]) {
      for (const oy of [-0.15, 0, 0.15]) {
        for (let a = -0.5; a <= 0.5; a += 0.17) {
          for (const sl of [0.5, 0.65, 0.8]) {
            const length = Math.min(limits.maxLen, Math.max(limits.minLen, bw * sl))
            const r = { cx: cx + ox * bw, cy: cy + oy * bh, angle: a, length, width: length * CARD_ASPECT }
            seeds.push({ r, s: this.score(r) })
          }
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

  /**
   * Card-shaped rectangles seeded from straight edges near the hands, for
   * backs with no white border (which the white mask misses). Edge pixels
   * vote by direction and offset; each clear straight run is tried as a
   * card's long side and as its short side, on either side of the line,
   * and the best fits are refined onto the edges.
   */
  private edgeFits(
    near: HandGeo[],
    expected: number,
    limits: Limits,
  ) {
    if (!near.length) return []
    const { w, h, gx, gy, norm } = this
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const g of near) {
      for (const [x, y] of g.pts) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    }
    const reach = expected * 1.2
    const xa = Math.max(2, Math.floor(x0 - reach))
    const xb = Math.min(w - 2, Math.ceil(x1 + reach))
    const ya = Math.max(2, Math.floor(y0 - reach))
    const yb = Math.min(h - 2, Math.ceil(y1 + reach))
    const diag = Math.ceil(Math.hypot(w, h))
    const nRho = Math.ceil((2 * diag) / SEG_RHO)
    const count = new Uint16Array(SEG_ANGLES * nRho)
    const tMin = new Float32Array(SEG_ANGLES * nRho).fill(Infinity)
    const tMax = new Float32Array(SEG_ANGLES * nRho).fill(-Infinity)
    const thr = norm * 0.5
    for (let y = ya; y < yb; y += 2) {
      for (let x = xa; x < xb; x += 2) {
        const i = y * w + x
        const g = Math.hypot(gx[i], gy[i])
        if (g < thr) continue
        // The normal's direction, folded onto 0..π.
        let a = Math.atan2(gy[i], gx[i])
        if (a < 0) a += Math.PI
        const bin = Math.min(SEG_ANGLES - 1, Math.round((a / Math.PI) * SEG_ANGLES) % SEG_ANGLES)
        const na = (bin / SEG_ANGLES) * Math.PI
        const nx = Math.cos(na)
        const ny = Math.sin(na)
        const rho = x * nx + y * ny
        const rb = Math.round((rho + diag) / SEG_RHO)
        if (rb < 0 || rb >= nRho) continue
        const c = bin * nRho + rb
        count[c]++
        // Position along the line.
        const t = -x * ny + y * nx
        if (t < tMin[c]) tMin[c] = t
        if (t > tMax[c]) tMax[c] = t
      }
    }
    // Clear runs: enough votes, longer than a fraction of the deck, and a local peak.
    const minVotes = (expected * SEG_MIN_LEN) / 2
    const runs: { bin: number; rb: number; n: number }[] = []
    for (let bin = 0; bin < SEG_ANGLES; bin++) {
      for (let rb = 1; rb < nRho - 1; rb++) {
        const c = bin * nRho + rb
        const n = count[c]
        if (n < minVotes || tMax[c] - tMin[c] < expected * SEG_MIN_LEN) continue
        if (n < count[c - 1] || n < count[c + 1]) continue
        const prevBin = ((bin + SEG_ANGLES - 1) % SEG_ANGLES) * nRho + rb
        const nextBin = ((bin + 1) % SEG_ANGLES) * nRho + rb
        if (n < count[prevBin] || n < count[nextBin]) continue
        runs.push({ bin, rb, n })
      }
    }
    runs.sort((p, q) => q.n - p.n)
    const seeds: { r: Rect; s: number }[] = []
    for (const { bin, rb } of runs.slice(0, 10)) {
      const c = bin * nRho + rb
      const na = (bin / SEG_ANGLES) * Math.PI
      const nx = Math.cos(na)
      const ny = Math.sin(na)
      const rho = rb * SEG_RHO - diag
      const tm = (tMin[c] + tMax[c]) / 2
      // Run centre and direction (along the line).
      const mx = nx * rho - ny * tm
      const my = ny * rho + nx * tm
      const along = Math.atan2(nx, -ny)
      const run = tMax[c] - tMin[c]
      for (const side of [-1, 1]) {
        // As a long side.
        for (const length of [run, expected]) {
          const L = Math.min(limits.maxLen, Math.max(limits.minLen, length))
          const W = L * CARD_ASPECT
          const r = { cx: mx + nx * side * (W / 2), cy: my + ny * side * (W / 2), angle: along, length: L, width: W }
          seeds.push({ r, s: this.score(r) })
        }
        // As a short side.
        const W = Math.min(limits.maxLen * CARD_ASPECT, Math.max(limits.minLen * CARD_ASPECT, run))
        const L = W / CARD_ASPECT
        const r = { cx: mx + nx * side * (L / 2), cy: my + ny * side * (L / 2), angle: na, length: L, width: W }
        seeds.push({ r, s: this.score(r) })
      }
    }
    seeds.sort((p, q) => q.s - p.s)
    const out: { rect: Rect; score: number }[] = []
    for (const seed of seeds.slice(0, 6)) {
      if (seed.s < DETECT_SCORE * 0.5) break
      const fit = this.refine(seed.r, limits)
      if (fit.score < DETECT_SCORE) continue
      if (out.some((o) => Math.hypot(o.rect.cx - fit.rect.cx, o.rect.cy - fit.rect.cy) < fit.rect.width * 0.5)) continue
      out.push(fit)
    }
    return out
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
    const limits = { minLen: bw * 0.4, maxLen: bw * 1.2, minRatio: CARD_ASPECT * 0.8, maxRatio: MAX_RATIO, maxSkew: 0 }
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
    // Nothing solid and white to start from (the border is thin and partly
    // under the fingers, or the sofa behind is as pale as the border): sweep
    // card shapes over the middle of the box and snap them onto edges.
    if (!found) {
      let fit = this.sweep(bcx, bcy, bw, bh, limits)
      // A likely card whose border isn't reading as white: under a warm or
      // cool light the border is tinted along with everything else. Learn the
      // tint from the border itself, take it off, and look again.
      if (fit && fit.score < DETECT_SCORE && fit.score >= DETECT_SCORE * 0.4) {
        const tint = this.rimTint(fit.rect)
        if (tint && tint.some((g) => Math.abs(g - 1) > 0.03)) {
          this.gains = tint
          this.whiteMask()
          fit = this.sweep(bcx, bcy, bw, bh, limits)
        }
      }
      if (fit && fit.score >= DETECT_SCORE) {
        bestScore = fit.score
        found = fit.rect
      }
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

    this.deck = {
      length: found.length / h,
      lengthHands: holder ? found.length / holder.size : 0,
      tint: this.gains.some((g) => g !== 1) ? this.gains : undefined,
    }
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

  /**
   * Fans. The long edges of fanned cards all run through the hinge, so each
   * strong edge pixel votes for the cells a card length along its edge line,
   * in both directions, tagged with the edge's direction. A cell that
   * collects votes from many directions is a hinge; rays from it then say
   * which angles have card edges along them (the sector), and the sector has
   * to be mostly white.
   */
  private findFans(near: HandGeo[], expected: number): Sector[] {
    if (!near.length) return []
    const { w, h, gx, gy, norm, white } = this
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const g of near) {
      for (const [x, y] of g.pts) {
        x0 = Math.min(x0, x)
        x1 = Math.max(x1, x)
        y0 = Math.min(y0, y)
        y1 = Math.max(y1, y)
      }
    }
    const reach = expected * 1.3
    const cw = Math.ceil(w / FAN_CELL)
    const ch = Math.ceil(h / FAN_CELL)
    const votes = new Uint16Array(cw * ch * FAN_BINS)
    const thr = norm * FAN_EDGE
    const dMin = expected * 0.3
    const dMax = expected * 1.05
    const ya = Math.max(2, Math.floor(y0 - reach))
    const yb = Math.min(h - 2, Math.ceil(y1 + reach))
    const xa = Math.max(2, Math.floor(x0 - reach))
    const xb = Math.min(w - 2, Math.ceil(x1 + reach))
    for (let y = ya; y < yb; y += 2) {
      for (let x = xa; x < xb; x += 2) {
        const i = y * w + x
        const g = Math.hypot(gx[i], gy[i])
        if (g < thr) continue
        const ex = -gy[i] / g
        const ey = gx[i] / g
        let ang = Math.atan2(ey, ex)
        if (ang < 0) ang += Math.PI
        const bin = Math.min(FAN_BINS - 1, Math.floor((ang / Math.PI) * FAN_BINS))
        for (const s of [1, -1]) {
          for (let d = dMin; d <= dMax; d += 4) {
            const px = x + ex * d * s
            const py = y + ey * d * s
            if (px < 0 || py < 0 || px >= w || py >= h) break
            votes[(((py / FAN_CELL) | 0) * cw + ((px / FAN_CELL) | 0)) * FAN_BINS + bin]++
          }
        }
      }
    }
    const cand: { c: number; bins: number; total: number }[] = []
    for (let c = 0; c < cw * ch; c++) {
      let bins = 0
      let total = 0
      for (let b = 0; b < FAN_BINS; b++) {
        const v = votes[c * FAN_BINS + b]
        total += v
        if (v >= 4) bins++
      }
      if (bins >= FAN_MIN_BINS) cand.push({ c, bins, total })
    }
    cand.sort((a, b) => b.bins - a.bins || b.total - a.total)

    const out: Sector[] = []
    const N = 120
    const prof = new Float32Array(N)
    const wh = new Float32Array(N)
    const sm = new Float32Array(N)
    for (const k of cand.slice(0, 12)) {
      const hx = (k.c % cw) * FAN_CELL + FAN_CELL / 2
      const hy = ((k.c / cw) | 0) * FAN_CELL + FAN_CELL / 2
      if (out.some((f) => Math.hypot(f.hx - hx, f.hy - hy) < expected * 0.5 || inSector(f, hx, hy))) continue
      // Edge energy along each ray from the hinge (edges lying along the ray), and whiteness.
      for (let a = 0; a < N; a++) {
        const th = (a / N) * 2 * Math.PI
        const dx = Math.cos(th)
        const dy = Math.sin(th)
        let sum = 0
        let cnt = 0
        let ws = 0
        for (let d = expected * 0.3; d <= expected * 0.95; d += 3) {
          let best = 0
          for (let o = -1; o <= 1; o++) {
            const px = Math.round(hx + dx * d - dy * o)
            const py = Math.round(hy + dy * d + dx * o)
            if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue
            const i = py * w + px
            const v = Math.abs(gx[i] * -dy + gy[i] * dx) / norm
            if (v > best) best = v
            if (o === 0) ws += white[i]
          }
          sum += Math.min(1, best)
          cnt++
        }
        prof[a] = cnt ? sum / cnt : 0
        wh[a] = cnt ? ws / cnt : 0
      }
      let peak = 0
      for (let a = 0; a < N; a++) {
        sm[a] = (prof[(a + N - 1) % N] + prof[a] + prof[(a + 1) % N]) / 3
        peak = Math.max(peak, sm[a])
      }
      const lvl = Math.max(0.12, peak * 0.45)
      // The longest run of rays with edges along them, allowing short gaps.
      let bestStart = 0
      let bestLen = 0
      for (let st = 0; st < N; st++) {
        if (sm[st] <= lvl || sm[(st + N - 1) % N] > lvl) continue
        let len = 0
        let gap = 0
        while (len < N && (sm[(st + len) % N] > lvl || gap < 3)) {
          gap = sm[(st + len) % N] > lvl ? 0 : gap + 1
          len++
        }
        len -= gap
        if (len > bestLen) {
          bestLen = len
          bestStart = st
        }
      }
      const span = (bestLen / N) * 2 * Math.PI
      if (span < FAN_MIN_SPAN) continue
      let e = 0
      let wsum = 0
      for (let j = 0; j < bestLen; j++) {
        e += sm[(bestStart + j) % N]
        wsum += wh[(bestStart + j) % N]
      }
      if (e / bestLen < FAN_MIN_EDGE || wsum / bestLen < FAN_MIN_WHITE) continue
      const from = (bestStart / N) * 2 * Math.PI
      let tex = 0
      let texN = 0
      for (const rr of [0.5, 0.65, 0.8]) {
        const rad = expected * rr
        for (let th = from; th < from + span; th += 1 / rad) {
          const px = Math.round(hx + Math.cos(th) * rad)
          const py = Math.round(hy + Math.sin(th) * rad)
          if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) continue
          const i = py * w + px
          tex += Math.min(1, Math.abs(gx[i] * -Math.sin(th) + gy[i] * Math.cos(th)) / norm)
          texN++
        }
      }
      const texture = texN ? tex / texN : 0
      // A couple of cards spread apart (a Sybil's packets, say) are packets, not a fan.
      if (texture < FAN_MIN_TEXTURE) continue
      out.push({ hx, hy, from, to: from + span, radius: expected, texture })
      if (out.length >= MAX_FANS) break
    }
    return out
  }

  /** Fans matched frame to frame by hinge, eased, and shown only once they have held for a moment. */
  private trackFans(near: HandGeo[], expected: number): FanTrack[] {
    // Fans open and close slowly next to the frame rate, so looking every other time is plenty (it is the dearest step).
    if (this.fanTick++ % 2 === 1) return this.fanTracks.filter((t) => t.hits >= FAN_CONFIRM)
    const found = this.findFans(near, expected)
    const used = new Set<number>()
    const next: FanTrack[] = []
    for (const f of found) {
      let best: FanTrack | null = null
      let bestD = expected * 0.6
      for (const t of this.fanTracks) {
        if (used.has(t.id)) continue
        const d = Math.hypot(t.hx - f.hx, t.hy - f.hy)
        if (d < bestD) {
          bestD = d
          best = t
        }
      }
      if (best) {
        used.add(best.id)
        next.push({ ...smoothSector(best, f), id: best.id, hits: best.hits + 1, misses: 0 })
      } else next.push({ ...f, id: this.nextId++, hits: 1, misses: 0 })
    }
    for (const t of this.fanTracks) {
      if (!used.has(t.id) && t.misses < FAN_MISSES && t.hits >= FAN_CONFIRM) next.push({ ...t, misses: t.misses + 1 })
    }
    this.fanTracks = next
    return next.filter((t) => t.hits >= FAN_CONFIRM)
  }

  /** Share of a rectangle that lies over a hand: its palm, or within a finger's width of a finger bone. */
  private handCover(r: Rect, hands: HandGeo[]): number {
    if (!hands.length) return 0
    const { ux, uy, vx, vy } = axes(r)
    let n = 0
    let over = 0
    for (let a = -0.4; a < 0.45; a += 0.2) {
      for (let b = -0.4; b < 0.45; b += 0.2) {
        const x = r.cx + ux * r.length * a + vx * r.width * b
        const y = r.cy + uy * r.length * a + vy * r.width * b
        n++
        if (hands.some((g) => overHand(g, x, y))) over++
      }
    }
    return over / n
  }

  private normalised(r: Rect): Omit<Packet, 'id' | 'hand'> {
    const out = { cx: r.cx / this.w, cy: r.cy / this.h, angle: r.angle, length: r.length / this.h, width: r.width / this.h }
    return r.skew ? { ...out, skew: r.skew } : out
  }

  /** Packets: solid card-shaped white blobs of about the deck's size near the hands, sitting on image edges. */
  private detect(geo: HandGeo[]): Packet[] {
    const deck = this.deck
    if (!deck) {
      this.tracks = []
      return []
    }
    const { w, h } = this
    // Hands the tracker just lost still say where the cards are; a shelf across the room never gets close.
    if (geo.length) {
      this.lastGeo = geo
      this.lastGeoAge = 0
    } else this.lastGeoAge++
    const near = geo.length ? geo : this.lastGeoAge <= HAND_MEMORY ? this.lastGeo : []
    const fans = this.trackFans(near, deck.length * h)
    this.fans = fans.map((f) => {
      let hand: 0 | 1 | null = null
      let bestD = Infinity
      for (const g of geo) {
        for (const [x, y] of g.pts) {
          const d = Math.hypot(x - f.hx, y - f.hy)
          if (d < bestD) {
            bestD = d
            hand = g.slot
          }
        }
      }
      return { id: f.id, hx: f.hx / w, hy: f.hy / h, from: f.from, to: f.to, radius: f.radius / h, hand }
    })
    // Expected long side: as calibrated. (Hand size would follow the deck towards and away from the
    // camera, but the tracker's hand sizes swing too much when fingers are hidden.)
    const expected = deck.length * h
    const expectedArea = expected * expected * CARD_ASPECT
    const limits = {
      minLen: expected * 0.5,
      maxLen: expected * 1.6,
      minRatio: MIN_RATIO,
      maxRatio: TILT_MAX_RATIO,
      maxSkew: MAX_SKEW,
    }

    // Blobs anywhere (cropping to a region around the hands would cut a deck in half when the
    // tracker has lost the hand holding it); ones far from every hand are dropped at the end.
    const fits: Fit[] = []
    for (const { rect, fill } of this.blobs(0, 0, w - 1, h - 1)) {
      const area = rect.length * rect.width
      if (area < expectedArea * MIN_AREA || area > expectedArea * MAX_AREA) continue
      if (fill < MIN_FILL) continue
      const fit = this.fitCard(rect, limits)
      if (fit && fit.score >= DETECT_SCORE) fits.push(fit)
    }
    // Backs without a white border don't make a blob; their straight sides still give them away.
    for (const fit of this.borderless ? this.edgeFits(near, expected, limits) : []) {
      // Edges alone also outline drawers and shelves; those have been there all along.
      if (this.staleness(fit.rect) <= MAX_STALE) fits.push(fit)
    }
    // Best first, and one rectangle per packet: two blobs of one packet (a finger across it) or a
    // blob and an edge run often land on the same card.
    const found: Rect[] = []
    for (const fit of fits.sort((a, b) => b.score - a.score)) {
      const r = fit.rect
      // A rectangle inside a fan is the fan's outline, not a packet.
      if (fans.some((f) => inSector(f, r.cx, r.cy))) continue
      // Pale skin reads as white, so a hand can outline itself; a card held over it still fits clearly.
      if (fit.score < HAND_SCORE && this.handCover(r, near) > HAND_COVER) continue
      if (found.some((o) => overlaps(o, r))) continue
      found.push(r)
    }

    // Match to known packets so ids stay put and outlines glide; a packet missing for a frame or two is kept.
    const used = new Set<number>()
    const next: Track[] = []
    for (const f of found.slice(0, MAX_PACKETS)) {
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
      } else if (near.length && this.staleness(f) <= MAX_STALE) {
        // A new packet whose outline has sat in place for seconds is part of the room (a book, a frame).
        next.push({ ...f, id: this.nextId++, misses: 0 })
      }
      // With no hand seen for a while, only packets already being followed carry on; nothing new
      // starts, so a shelf can't become a packet.
    }
    for (const t of this.tracks) {
      if (used.has(t.id) || t.misses >= 2) continue
      // Still on its edges? Then it's just not a clean blob this frame (a finger across it, say).
      const sc = this.score(t)
      if (sc < KEEP_SCORE || (sc < HAND_SCORE && this.handCover(t, near) > HAND_COVER)) continue
      if (next.some((o) => overlaps(o, t))) continue
      next.push({ ...t, misses: t.misses + 1 })
    }
    this.tracks = next

    const out: Packet[] = []
    for (const t of this.tracks) {
      let hand: 0 | 1 | null = null
      let bestD = Infinity
      for (const g of near) {
        for (const [x, y] of g.pts) {
          const d = Math.hypot(x - t.cx, y - t.cy)
          if (d < bestD) {
            bestD = d
            hand = geo.length ? g.slot : null
          }
        }
      }
      // A card shape away from every hand isn't a packet being handled (a picture frame, a sheet of
      // paper). With no hand seen for a while, the packet is kept but belongs to no hand.
      if (near.length && bestD > expected * MAX_HAND_DIST) continue
      out.push({ id: t.id, ...this.normalised(t), hand })
    }
    return out
  }
}

/**
 * A rectangle's directions: u along its length and v along its width (leaning by the skew), and
 * the normals of its long sides (l, at right angles to u) and short sides (s, at right angles to v),
 * each pointing the way u or v points.
 */
function axes(r: Rect) {
  const ux = Math.cos(r.angle)
  const uy = Math.sin(r.angle)
  const k = r.skew ?? 0
  const vx = -Math.sin(r.angle + k)
  const vy = Math.cos(r.angle + k)
  return { ux, uy, vx, vy, lx: -uy, ly: ux, sx: vy, sy: -vx }
}

function mean(v: number[]) {
  return v.reduce((s, x) => s + x, 0) / v.length
}

/** Whether two rectangles are one packet: either's centre lies well inside the other. */
function overlaps(a: Rect, b: Rect) {
  const inside = (p: Rect, q: Rect) => {
    const dx = q.cx - p.cx
    const dy = q.cy - p.cy
    const u = dx * Math.cos(p.angle) + dy * Math.sin(p.angle)
    const v = -dx * Math.sin(p.angle) + dy * Math.cos(p.angle)
    return Math.abs(u) < p.length * 0.3 && Math.abs(v) < p.width * 0.3
  }
  return inside(a, b) || inside(b, a)
}

/** Whether a point is over a hand: inside the palm, or within a finger's width of a finger bone. */
function overHand(g: HandGeo, x: number, y: number) {
  const p = g.pts
  let inPalm = false
  for (let i = 0, j = PALM.length - 1; i < PALM.length; j = i++) {
    const [xi, yi] = p[PALM[i]]
    const [xj, yj] = p[PALM[j]]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inPalm = !inPalm
  }
  if (inPalm) return true
  const rad = g.size * FINGER_R
  for (const f of FINGERS) {
    for (let k = 0; k + 1 < f.length; k++) {
      const [ax, ay] = p[f[k]]
      const [bx, by] = p[f[k + 1]]
      const dx = bx - ax
      const dy = by - ay
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)))
      if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < rad) return true
    }
  }
  return false
}

/** Whether a point lies in the fan's sector (a little beyond its reach counts too). */
function inSector(f: Sector, x: number, y: number) {
  if (Math.hypot(x - f.hx, y - f.hy) > f.radius * 1.1) return false
  const a = Math.atan2(y - f.hy, x - f.hx)
  const rel = (((a - f.from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return rel <= f.to - f.from
}

/** Eases a fan towards its new fit: the hinge glides, and the sector is eased by its middle and width. */
function smoothSector(prev: Sector, next: Sector): Sector {
  const k = 0.6
  const mid = (s: Sector) => (s.from + s.to) / 2
  let dm = mid(next) - mid(prev)
  dm = Math.atan2(Math.sin(dm), Math.cos(dm))
  const m = mid(prev) + dm * k
  const span = (prev.to - prev.from) * (1 - k) + (next.to - next.from) * k
  return {
    hx: prev.hx + (next.hx - prev.hx) * k,
    hy: prev.hy + (next.hy - prev.hy) * k,
    from: m - span / 2,
    to: m + span / 2,
    radius: prev.radius + (next.radius - prev.radius) * k,
    texture: prev.texture + (next.texture - prev.texture) * k,
  }
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
    skew: (prev.skew ?? 0) + ((next.skew ?? 0) - (prev.skew ?? 0)) * k,
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
