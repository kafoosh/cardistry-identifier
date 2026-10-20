import type { HandLabel, IdentifyState } from '../recognition/identifier'

const handName = (h: HandLabel) => (h === 'Both' ? 'both hands' : `${h.toLowerCase()} hand`)

interface GuessProps {
  state: IdentifyState | null
  templateCount: number
  moveCount: number
  sharedCount: number
  sharedError: boolean
  onRecord: () => void
}

/** The current answer, shown above the camera: one move, or one per hand. */
export function IdentifyGuess({ state, templateCount, moveCount, sharedCount, sharedError, onRecord }: GuessProps) {
  if (!state) return <p className="muted small">Loading takes from this device and the library…</p>
  if (state.status === 'no-templates') {
    return (
      <div className="guess-empty">
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
  const recent = state.showLast ? state.last : null
  if (!recent) {
    return (
      <div className="guess">
        <span className="muted">{state.status === 'still' ? 'Waiting for a move…' : 'Watching…'}</span>
        <span className="muted small">
          {templateCount} take{templateCount === 1 ? '' : 's'} of {moveCount} move{moveCount === 1 ? '' : 's'}
          {sharedCount ? `, ${sharedCount} from the library` : ''}
          {sharedError ? ", library unreachable" : ''}
        </span>
      </div>
    )
  }
  if (recent.guesses.length === 1) {
    const g = recent.guesses[0]
    return (
      <div className="guess" aria-live="polite">
        <strong>{g.moveName}</strong>
        <span className="muted small">{handName(g.hand)}</span>
      </div>
    )
  }
  return (
    <div className="guess guess-hands" aria-live="polite">
      {recent.guesses.map((g) => (
        <div key={g.hand}>
          <span className="muted small">{g.hand} hand</span>
          <strong>{g.moveName}</strong>
        </div>
      ))}
    </div>
  )
}

/** Top candidates per hand, drawn over the bottom of the camera view. */
export function IdentifyScores({ state }: { state: IdentifyState | null }) {
  if (!state?.groups.length) return null
  return (
    <div className="scores-overlay">
      {state.groups.map((g) => (
        <div key={g.hand} className="score-group">
          {state.groups.length > 1 && <span className="small">{g.hand === 'Both' ? 'Both hands' : `${g.hand} hand`}</span>}
          <ol className="scores">
            {g.scores.map((s) => (
              <li key={s.moveName}>
                <span className="score-name">{s.moveName}</span>
                <span className="bar">
                  <span style={{ width: `${Math.round(s.strength * 100)}%` }} />
                </span>
                <span className="small tabular">{s.distance.toFixed(2)}</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  )
}
