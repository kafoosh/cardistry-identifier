/**
 * The deck's look, learned once from a calibration frame: which colours
 * (in a coarse hue / saturation / brightness grid) cover the deck. Patterned
 * backs are fine, since every colour of the pattern goes in, white borders
 * and packet edges included. Colours that also show up on the fingers are
 * left out, so skin never counts as card.
 */
export interface DeckModel {
  /** 1 where a colour bin belongs to the deck. */
  bins: Uint8Array
  /** Deck face area in hand sizes squared (hand size = wrist to middle knuckle), to size packets. */
  areaHands: number
  /** The deck's long side as a share of the frame height, at calibration. */
  lengthAtCalibration: number
}

const HUE_BINS = 24
const SAT_BINS = 6
const VAL_BINS = 4
export const BIN_COUNT = HUE_BINS * SAT_BINS * VAL_BINS
/** Below this saturation hue is noise, so greys, whites and blacks are binned by brightness only. */
const GREY_SAT = 0.18

/** Colour bin of an RGB pixel. */
export function colourBin(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const v = max / 255
  const s = max === 0 ? 0 : (max - min) / max
  let h = 0
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min) + 6) % 6
    else if (max === g) h = (b - r) / (max - min) + 2
    else h = (r - g) / (max - min) + 4
    h *= 60
  }
  const hb = s < GREY_SAT ? 0 : Math.min(HUE_BINS - 1, Math.floor(h / (360 / HUE_BINS)))
  const sb = Math.min(SAT_BINS - 1, Math.floor(s * SAT_BINS))
  const vb = Math.min(VAL_BINS - 1, Math.floor(v * VAL_BINS))
  return (hb * SAT_BINS + sb) * VAL_BINS + vb
}

/**
 * Builds the deck's colour set from pixel histograms: bins that hold a fair
 * share of the deck pixels, widened by one step of hue and brightness for
 * lighting changes, minus bins that are common on the skin.
 */
export function buildBins(deck: Float32Array, deckTotal: number, skin: Float32Array, skinTotal: number): Uint8Array {
  const out = new Uint8Array(BIN_COUNT)
  for (let i = 0; i < BIN_COUNT; i++) {
    const share = deck[i] / Math.max(1, deckTotal)
    if (share < 0.015) continue
    out[i] = 1
    const vb = i % VAL_BINS
    const sb = Math.floor(i / VAL_BINS) % SAT_BINS
    const hb = Math.floor(i / (VAL_BINS * SAT_BINS))
    const mark = (h: number, s: number, v: number) => {
      if (s < 0 || s >= SAT_BINS || v < 0 || v >= VAL_BINS) return
      out[(((h + HUE_BINS) % HUE_BINS) * SAT_BINS + s) * VAL_BINS + v] = 1
    }
    if (share >= 0.03) {
      mark(hb, sb, vb - 1)
      mark(hb, sb, vb + 1)
      if (hb !== 0 || sb > 0) {
        mark(hb - 1, sb, vb)
        mark(hb + 1, sb, vb)
      }
    }
  }
  if (skinTotal >= 20) {
    for (let i = 0; i < BIN_COUNT; i++) if (skin[i] / skinTotal >= 0.06) out[i] = 0
  }
  return out
}

const KEY = 'cardistry.deck'

export function saveDeck(m: DeckModel) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ bins: Array.from(m.bins), areaHands: m.areaHands, lengthAtCalibration: m.lengthAtCalibration }),
    )
  } catch {
    // Not kept in private mode.
  }
}

export function loadDeck(): DeckModel | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { bins: number[]; areaHands: number; lengthAtCalibration: number }
    if (!Array.isArray(v.bins) || v.bins.length !== BIN_COUNT) return null
    return { bins: Uint8Array.from(v.bins), areaHands: v.areaHands, lengthAtCalibration: v.lengthAtCalibration }
  } catch {
    return null
  }
}
