import type { MoveScore } from './recognizer'

/** Strength below this is a weak fit that isn't worth announcing. Each move's strength scale puts its acceptance limit here. */
export const MIN_STRENGTH = 0.3
/** The best move must beat the runner-up by this much strength, or the window is ambiguous and nothing is announced. */
export const MIN_MARGIN = 0.12

/** A clear winner: strong enough, and well ahead of the next move. */
export function clearWinner(scores: MoveScore[]): MoveScore | undefined {
  const [top, next] = scores
  if (!top || top.strength < MIN_STRENGTH) return undefined
  if (next && top.strength - next.strength < MIN_MARGIN) return undefined
  return top
}

/**
 * The answer: a two-hand move when it fits about as well as the best
 * one-hand move (it explains both hands at once), otherwise the clear
 * one-hand move in each hand. Empty when nothing is clear: "not sure"
 * rather than a guess.
 */
export function chooseAnswer<S>(
  both: MoveScore[],
  singles: { slot: S; scores: MoveScore[] }[],
): { both: MoveScore } | { singles: { slot: S; top: MoveScore }[] } {
  const two = clearWinner(both)
  const ones = singles
    .map((s) => ({ slot: s.slot, top: clearWinner(s.scores) }))
    .filter((s): s is { slot: S; top: MoveScore } => s.top !== undefined)
  const bestSingle = Math.max(0, ...ones.map((s) => s.top.strength))
  if (two && two.strength >= bestSingle * 0.9) return { both: two }
  return { singles: ones }
}
