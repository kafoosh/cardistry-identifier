/**
 * What calibration learns about the deck: how big it is. Cards are found by
 * shape (a rectangle with a poker card's proportions), so the size is what
 * tells a packet apart from other rectangles in view, like a phone or a
 * picture frame.
 */
export interface DeckModel {
  /** The deck's long side as a share of the frame height, at calibration. */
  length: number
  /** The long side in hand sizes (wrist to middle knuckle) at calibration, or 0 when no hand was tracked. */
  lengthHands: number
}

/** A standard poker card is 63 × 88 mm: short side over long side. */
export const CARD_ASPECT = 63 / 88

const KEY = 'cardistry.deck.v2'

export function saveDeck(m: DeckModel) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    // Not kept in private mode.
  }
}

export function loadDeck(): DeckModel | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<DeckModel>
    if (!(typeof v.length === 'number' && v.length > 0 && typeof v.lengthHands === 'number' && v.lengthHands >= 0))
      return null
    return { length: v.length, lengthHands: v.lengthHands }
  } catch {
    return null
  }
}
