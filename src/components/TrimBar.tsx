interface Props {
  durationMs: number
  value: { startMs: number; endMs: number }
  /** `moved` says which handle changed, so the replay can show that frame. */
  onChange: (value: { startMs: number; endMs: number }, moved: 'start' | 'end') => void
}

/** Shortest clip the handles allow. */
const MIN_GAP_MS = 300

/** Two handles over the take's timeline that set where the saved clip starts and ends. */
export function TrimBar({ durationMs, value, onChange }: Props) {
  const max = Math.max(durationMs, 1)
  const pct = (ms: number) => `${(ms / max) * 100}%`
  return (
    <div className="trim">
      <div className="trim-head small">
        <span>Trim</span>
        <span className="muted tabular">
          {(value.startMs / 1000).toFixed(1)}s to {(value.endMs / 1000).toFixed(1)}s
        </span>
        {(value.startMs > 0 || value.endMs < durationMs) && (
          <button className="link" onClick={() => onChange({ startMs: 0, endMs: durationMs }, 'start')}>
            Keep all
          </button>
        )}
      </div>
      <div className="trim-track">
        <div className="trim-kept" style={{ left: pct(value.startMs), width: pct(value.endMs - value.startMs) }} />
        <input
          type="range"
          min={0}
          max={max}
          step={10}
          value={value.startMs}
          onChange={(e) => onChange({ ...value, startMs: Math.min(Number(e.target.value), value.endMs - MIN_GAP_MS) }, 'start')}
          aria-label="Clip start"
        />
        <input
          type="range"
          min={0}
          max={max}
          step={10}
          value={value.endMs}
          onChange={(e) => onChange({ ...value, endMs: Math.max(Number(e.target.value), value.startMs + MIN_GAP_MS) }, 'end')}
          aria-label="Clip end"
        />
      </div>
    </div>
  )
}
