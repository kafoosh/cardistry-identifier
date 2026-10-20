import { HAND_CONNECTIONS } from '../tracking/handTracker'
import type { TrackedHand } from '../tracking/types'
import type { Packet } from './types'

/** Working resolution (long side). Cards are big relative to this, and it keeps a frame to a few ms. */
const WORK_W = 192
/** Colour difference (sum of |ΔR|+|ΔG|+|ΔB|) that counts as "not the background". */
const FOREGROUND_DIFF = 48
/** How far (in hand sizes) around the hands to look for cards. */
const ROI_MARGIN = 1.2
/** Pixels this close to a finger or palm bone (in hand sizes) are hand, not card. */
const BONE_RADIUS = 0.14
/** Packet area limits, in hand sizes squared (hand size = wrist to middle knuckle). */
const MIN_AREA = 0.12
const MAX_AREA = 8
const MAX_PACKETS = 4

interface HandGeo {
  slot: 0 | 1
  pts: [number, number][]
  size: number
}

/**
 * Classical, no-training card tracking, run on a small copy of each frame:
 * learn the background wherever the hands aren't, learn skin colour from the
 * pixels under the hand landmarks, and in the region around the hands call
 * anything that is neither background, skin nor finger a card. Each blob of
 * card pixels becomes a packet: centre, long-axis angle and size from its
 * image moments, held by the nearest hand. Works for patterned backs, since
 * it never needs the deck's colour. Packets touching each other merge; the
 * hand that holds them and their size still tell the matcher a lot.
 */
export class CardTracker {
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!
  private w = 0
  private h = 0
  private bg: Float32Array | null = null
  private known: Uint8Array | null = null
  private skin = { cb: 0, cr: 0, vcb: 120, vcr: 120, ready: false }
  private tracks: Packet[] = []
  private nextId = 1
  /** Last processing time, ms. */
  ms = 0

  reset() {
    this.bg = null
    this.known = null
    this.tracks = []
    this.skin.ready = false
  }

  process(video: HTMLVideoElement, hands: TrackedHand[]): Packet[] {
    const t0 = performance.now()
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (!vw || !vh) return []
    const w = WORK_W
    const h = Math.max(1, Math.round((WORK_W * vh) / vw))
    if (w !== this.w || h !== this.h) {
      this.w = this.canvas.width = w
      this.h = this.canvas.height = h
      this.bg = new Float32Array(w * h * 3)
      this.known = new Uint8Array(w * h)
    }
    this.ctx.drawImage(video, 0, 0, w, h)
    const px = this.ctx.getImageData(0, 0, w, h).data
    const bg = this.bg!
    const known = this.known!

    const geo: HandGeo[] = hands.map((hd) => {
      const pts = hd.landmarks.map((p) => [p[0] * w, p[1] * h] as [number, number])
      return { slot: hd.slot, pts, size: Math.max(4, Math.hypot(pts[9][0] - pts[0][0], pts[9][1] - pts[0][1])) }
    })

    // Region around the hands (where cards can be), in work pixels.
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
    const hasRoi = geo.length > 0 && x1 > x0 && y1 > y0

    // Background: learn everywhere outside the region (fast at first, then slowly).
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (hasRoi && x >= x0 && x <= x1 && y >= y0 && y <= y1) continue
        const i = y * w + x
        const k = i * 3
        const rate = known[i] ? 0.05 : 1
        bg[k] += (px[i * 4] - bg[k]) * rate
        bg[k + 1] += (px[i * 4 + 1] - bg[k + 1]) * rate
        bg[k + 2] += (px[i * 4 + 2] - bg[k + 2]) * rate
        known[i] = 1
      }
    }
    if (!hasRoi) {
      this.tracks = []
      this.ms = performance.now() - t0
      return []
    }

    this.learnSkin(px, geo)

    // Hand pixels: thick lines along every bone.
    const rw = x1 - x0 + 1
    const rh = y1 - y0 + 1
    const handMask = new Uint8Array(rw * rh)
    for (const g of geo) {
      const r = g.size * BONE_RADIUS
      for (const { start, end } of HAND_CONNECTIONS) paintSegment(handMask, rw, rh, x0, y0, g.pts[start], g.pts[end], r)
      // Palm: fill between the knuckles and the wrist.
      paintSegment(handMask, rw, rh, x0, y0, g.pts[0], g.pts[9], g.size * 0.45)
    }

    // Where the background behind the hands hasn't been seen yet (hands in
    // view from the start), compare with the colours just around the region.
    const palette = this.ringPalette(px, x0, y0, x1, y1)

    // Card pixels: not background, not skin, not hand.
    const mask = new Uint8Array(rw * rh)
    const { cb: mcb, cr: mcr, vcb, vcr } = this.skin
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const j = (y - y0) * rw + (x - x0)
        if (handMask[j]) continue
        const i = y * w + x
        const r = px[i * 4]
        const gg = px[i * 4 + 1]
        const b = px[i * 4 + 2]
        if (known[i]) {
          const k = i * 3
          if (Math.abs(r - bg[k]) + Math.abs(gg - bg[k + 1]) + Math.abs(b - bg[k + 2]) < FOREGROUND_DIFF) continue
        } else {
          let near = false
          for (let p = 0; p < palette.length && !near; p += 3) {
            near = Math.abs(r - palette[p]) + Math.abs(gg - palette[p + 1]) + Math.abs(b - palette[p + 2]) < FOREGROUND_DIFF
          }
          if (near) continue
        }
        if (this.skin.ready) {
          const cb = 128 - 0.1687 * r - 0.3313 * gg + 0.5 * b
          const cr = 128 + 0.5 * r - 0.4187 * gg - 0.0813 * b
          const d = ((cb - mcb) * (cb - mcb)) / vcb + ((cr - mcr) * (cr - mcr)) / vcr
          if (d < 6) continue
        }
        mask[j] = 1
      }
    }
    const clean = majority(mask, rw, rh)
    const blobs = components(clean, rw, rh)

    const meanSize = geo.reduce((s, g) => s + g.size, 0) / geo.length
    const found: Omit<Packet, 'id'>[] = []
    for (const b of blobs) {
      const area = b.n / (meanSize * meanSize)
      if (area < MIN_AREA || area > MAX_AREA) continue
      const mx = b.sx / b.n
      const my = b.sy / b.n
      const cxx = b.sxx / b.n - mx * mx
      const cyy = b.syy / b.n - my * my
      const cxy = b.sxy / b.n - mx * my
      const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
      const tr = cxx + cyy
      const det = Math.sqrt(Math.max(0, ((cxx - cyy) / 2) ** 2 + cxy * cxy))
      const l1 = tr / 2 + det
      const l2 = Math.max(0, tr / 2 - det)
      const cx = mx + x0
      const cy = my + y0
      // Nearest hand owns it.
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
      if (bestD > 2) hand = null
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
    const packets = this.track(found.slice(0, MAX_PACKETS), meanSize / h)
    this.ms = performance.now() - t0
    return packets
  }

  /** Background colours sampled on a ring just outside the hand region. */
  private ringPalette(px: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number): number[] {
    const out: number[] = []
    const add = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
      const i = (y * this.w + x) * 4
      out.push(px[i], px[i + 1], px[i + 2])
    }
    const m = 3
    for (let x = x0 - m; x <= x1 + m; x += 4) {
      add(x, y0 - m)
      add(x, y1 + m)
    }
    for (let y = y0 - m; y <= y1 + m; y += 4) {
      add(x0 - m, y)
      add(x1 + m, y)
    }
    return out
  }

  /** Skin colour (Cb/Cr mean and spread) from small patches under the palm and finger bases. */
  private learnSkin(px: Uint8ClampedArray, geo: HandGeo[]) {
    const samples: [number, number][] = []
    for (const g of geo) {
      for (const [a, b] of [
        [0, 9],
        [5, 9],
        [9, 13],
        [13, 17],
        [0, 5],
        [0, 17],
        [5, 6],
        [9, 10],
        [13, 14],
      ]) {
        const x = Math.round((g.pts[a][0] + g.pts[b][0]) / 2)
        const y = Math.round((g.pts[a][1] + g.pts[b][1]) / 2)
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue
        const i = (y * this.w + x) * 4
        const r = px[i]
        const gg = px[i + 1]
        const bl = px[i + 2]
        samples.push([128 - 0.1687 * r - 0.3313 * gg + 0.5 * bl, 128 + 0.5 * r - 0.4187 * gg - 0.0813 * bl])
      }
    }
    if (samples.length < 4) return
    // Median is robust to a sample that landed on a card.
    const med = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]
    const cb = med(samples.map((s) => s[0]))
    const cr = med(samples.map((s) => s[1]))
    const vcb = Math.max(36, med(samples.map((s) => (s[0] - cb) ** 2)) * 2.5)
    const vcr = Math.max(36, med(samples.map((s) => (s[1] - cr) ** 2)) * 2.5)
    const k = this.skin.ready ? 0.1 : 1
    this.skin.cb += (cb - this.skin.cb) * k
    this.skin.cr += (cr - this.skin.cr) * k
    this.skin.vcb += (vcb - this.skin.vcb) * k
    this.skin.vcr += (vcr - this.skin.vcr) * k
    this.skin.ready = true
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

function paintSegment(
  mask: Uint8Array,
  rw: number,
  rh: number,
  x0: number,
  y0: number,
  a: [number, number],
  b: [number, number],
  r: number,
) {
  const ax = a[0] - x0
  const ay = a[1] - y0
  const bx = b[0] - x0
  const by = b[1] - y0
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - r))
  const maxX = Math.min(rw - 1, Math.ceil(Math.max(ax, bx) + r))
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - r))
  const maxY = Math.min(rh - 1, Math.ceil(Math.max(ay, by) + r))
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  const r2 = r * r
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const u = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
      const ex = ax + u * dx - x
      const ey = ay + u * dy - y
      if (ex * ex + ey * ey <= r2) mask[y * rw + x] = 1
    }
  }
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
