import type { HandLabel, IdentifyState } from '../recognition/identifier'

interface Props {
  state: IdentifyState | null
  templateCount: number
  moveCount: number
  sharedCount: number
  sharedError: boolean
  sensitivity: number
  onSensitivity: (v: number) => void
  onRecord: () => void
}

/** Live guesses: the latest confident match, plus the current top 3 with match strength. */
export function IdentifyPanel({ state, templateCount, moveCount, sharedCount, sharedError, sensitivity, onSensitivity, onRecord }: Props) {
  if (!state) return <p className="muted small">Loading recordings from this device and the library…</p>
  if (state.status === 'no-templates') {
    return (
      <div className="identify">
        <p className="hint">
          Nothing to compare against yet.{' '}
          {sharedError
            ? "The shared library couldn't be reached, and there are no takes saved on this device."
            : 'Record and save a few moves first (about five takes each), then come back here.'}
        </p>
        <button className="primary" onClick={onRecord}>
          Record moves
        </button>
      </div>
    )
  }
  const recent = state.showLast ? state.last : null
  const handName = (h: HandLabel) => (h === 'Both' ? 'both hands' : `${h.toLowerCase()} hand`)
  return (
    <div className="identify">
      <div className="guess" aria-live="polite">
        {recent ? (
          recent.guesses.length === 1 ? (
            <>
              <span className="muted small">That looked like</span>
              <strong>{recent.guesses[0].moveName}</strong>
              <span className="muted small">{handName(recent.guesses[0].hand)}</span>
            </>
          ) : (
            <div className="guess-hands">
              {recent.guesses.map((g) => (
                <div key={g.hand}>
                  <span className="muted small">{g.hand} hand</span>
                  <strong>{g.moveName}</strong>
                </div>
              ))}
            </div>
          )
        ) : (
          <span className="muted">{state.status === 'still' ? 'Waiting for a move…' : 'Watching…'}</span>
        )}
      </div>
      {state.groups.map((g) => (
        <div key={g.hand} className="score-group">
          {state.groups.length > 1 && <span className="muted small">{g.hand === 'Both' ? 'Both hands' : `${g.hand} hand`}</span>}
          <ol className="scores">
            {g.scores.map((s) => (
              <li key={s.moveName}>
                <span className="score-name">{s.moveName}</span>
                <span className="bar">
                  <span style={{ width: `${Math.round(s.strength * 100)}%` }} />
                </span>
                <span className="muted small tabular">{s.distance.toFixed(2)}</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
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
        {sharedCount ? ` (${sharedCount} from the shared library)` : ''}
        {sharedError ? " (the shared library couldn't be reached, so only this device's takes)" : ''}
        {state.matchMs ? ` · ${state.matchMs.toFixed(0)} ms per check` : ''}. Raise sensitivity if moves are missed,
        lower it if wrong moves pop up. The number is the match distance (lower is closer).
      </p>
    </div>
  )
}
