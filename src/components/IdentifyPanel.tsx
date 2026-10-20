import type { HandGuess, HandLabel, IdentifyState } from '../recognition/identifier'

interface StatusProps {
  state: IdentifyState | null
  sharedError: boolean
  onRecord: () => void
}

/** One line above the camera: what Identify is doing. */
export function IdentifyStatus({ state, sharedError, onRecord }: StatusProps) {
  if (!state) return <p className="identify-status muted small">Loading takes from this device and the library…</p>
  if (state.status === 'no-templates') {
    return (
      <div className="identify-status">
        <span className="small">
          {sharedError
            ? "Nothing to compare against: the library couldn't be reached and there are no takes on this device."
            : 'Nothing to compare against yet. Record a few takes first.'}
        </span>
        <button className="link" onClick={onRecord}>
          Record
        </button>
      </div>
    )
  }
  return (
    <p className="identify-status small muted">
      <span className={`live-dot ${state.status === 'matching' ? 'on' : ''}`} />
      <span className="identify-status-text">
        {state.status === 'still' ? 'Waiting for a move' : 'Watching'}
        {sharedError ? ' · library unreachable' : ''}
      </span>
    </p>
  )
}

interface BoxContent {
  moveName: string | null
  strength: number
  withCards: boolean
  /** Holding the latest confident answer. */
  confident: boolean
  runnerUp: string | null
}

function contentFor(state: IdentifyState | null, hand: HandLabel): BoxContent {
  const guess: HandGuess | undefined = state?.showLast ? state.last?.guesses.find((g) => g.hand === hand) : undefined
  const scores = state?.groups.find((g) => g.hand === hand)?.scores ?? []
  if (guess) {
    return {
      moveName: guess.moveName,
      strength: guess.strength,
      withCards: guess.withCards,
      confident: true,
      runnerUp: scores.find((s) => s.moveName !== guess.moveName && s.strength > 0)?.moveName ?? null,
    }
  }
  const top = scores[0]
  return {
    moveName: top && top.strength > 0 ? top.moveName : null,
    strength: top ? top.strength : 0,
    withCards: Boolean(top?.withCards),
    confident: false,
    runnerUp: top && scores[1] && scores[1].strength > 0 ? scores[1].moveName : null,
  }
}

/**
 * Left hand, both hands, right hand: one box each, laid out the way the
 * hands appear on screen (swapped when the preview isn't mirrored).
 */
export function IdentifyBoxes({ state, mirror }: { state: IdentifyState | null; mirror: boolean }) {
  const order: HandLabel[] = mirror ? ['Left', 'Both', 'Right'] : ['Right', 'Both', 'Left']
  return (
    <div className="hand-boxes">
      {order.map((hand) => {
        const c = contentFor(state, hand)
        return (
          <div key={hand} className={`hand-box ${hand === 'Both' ? 'both' : ''} ${c.confident ? 'confident' : ''}`}>
            <span className="hand-box-label">{hand === 'Both' ? 'Both hands' : `${hand} hand`}</span>
            <strong className="hand-box-move">{c.moveName ?? '—'}</strong>
            <span className="hand-box-bar">
              <span style={{ width: `${Math.round(c.strength * 100)}%` }} />
            </span>
            <span className="hand-box-meta">
              {c.moveName ? `${Math.round(c.strength * 100)}%` : ' '}
              {c.moveName && c.withCards ? ' · fingers + cards' : c.moveName ? ' · fingers' : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}
