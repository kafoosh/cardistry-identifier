import type { IdentifyState } from '../recognition/identifier'

interface Props {
  state: IdentifyState | null
  templateCount: number
  moveCount: number
  sensitivity: number
  onSensitivity: (v: number) => void
}

/** Live guesses: the latest confident match, plus the current top 3 with match strength. */
export function IdentifyPanel({ state, templateCount, moveCount, sensitivity, onSensitivity }: Props) {
  if (!state) return <p className="muted small">Loading your recordings…</p>
  if (state.status === 'no-templates') {
    return (
      <p className="hint">
        Nothing to compare against yet. Record and save a few moves first (about five takes each), then come back here.
      </p>
    )
  }
  const recent = state.showLast ? state.last : null
  return (
    <div className="identify">
      <div className="guess" aria-live="polite">
        {recent ? (
          <>
            <span className="muted small">That looked like</span>
            <strong>{recent.moveName}</strong>
          </>
        ) : (
          <span className="muted">{state.status === 'still' ? 'Waiting for a move…' : 'Watching…'}</span>
        )}
      </div>
      {state.scores.length > 0 && (
        <ol className="scores">
          {state.scores.map((s) => (
            <li key={s.moveName}>
              <span className="score-name">{s.moveName}</span>
              <span className="bar">
                <span style={{ width: `${Math.round(s.strength * 100)}%` }} />
              </span>
              <span className="muted small tabular">{s.distance.toFixed(2)}</span>
            </li>
          ))}
        </ol>
      )}
      <label className="field slider">
        <span>
          Sensitivity <span className="tabular">{sensitivity.toFixed(1)}×</span>
        </span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={sensitivity}
          onChange={(e) => onSensitivity(Number(e.target.value))}
        />
      </label>
      <p className="muted small">
        Comparing against {templateCount} recording{templateCount === 1 ? '' : 's'} of {moveCount} move
        {moveCount === 1 ? '' : 's'}
        {state.matchMs ? ` · ${state.matchMs.toFixed(0)} ms per check` : ''}. Raise sensitivity if moves are missed,
        lower it if wrong moves pop up. The number is the match distance (lower is closer).
      </p>
    </div>
  )
}
