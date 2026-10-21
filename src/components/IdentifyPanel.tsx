import { useEffect, useRef, useState } from 'react'
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

interface Answer {
  key: string
  guesses: HandGuess[]
}

/** Calms the live result down: what to say now, changing only when it means something. */
function useCalmAnswer(state: IdentifyState | null) {
  // The last confirmed answer stays on screen (as "Last move") until a new one replaces it.
  const [answer, setAnswer] = useState<Answer | null>(null)
  // A hint while nothing is confirmed, changed only after the same move leads two updates running.
  const [maybe, setMaybe] = useState<string | null>(null)
  const lead = useRef<{ name: string; count: number } | null>(null)

  const last = state?.last
  const lastKey = last ? last.guesses.map((g) => `${g.hand}:${g.moveName}`).join('|') : ''
  useEffect(() => {
    if (last && last.guesses.length) setAnswer((prev) => (prev?.key === lastKey ? prev : { key: lastKey, guesses: last.guesses }))
    // Keyed on the answer itself so a re-sent identical answer changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKey])

  const top = state?.status === 'matching' && !state.showLast ? (state.groups[0]?.scores[0]?.moveName ?? null) : null
  useEffect(() => {
    if (!state || state.status !== 'matching') {
      lead.current = null
      setMaybe(null)
      return
    }
    if (state.showLast || !top) return
    lead.current = lead.current?.name === top ? { name: top, count: lead.current.count + 1 } : { name: top, count: 1 }
    if (lead.current.count >= 2) setMaybe(top)
  }, [state, top])

  return { answer, live: Boolean(state?.showLast), watching: state?.status === 'matching', maybe }
}

const confidence = (g: HandGuess) => `${g.strength >= 0.6 ? 'Sure' : 'Likely'} · ${g.withCards ? 'fingers + cards' : 'fingers'}`

/**
 * The move (or moves) Identify thinks is being done. One move fills the
 * section; a different move in each hand splits it in two, laid out the way
 * the hands appear on screen. The section keeps a fixed size and only
 * changes when the answer does.
 */
export function IdentifyMoves({ state, mirror }: { state: IdentifyState | null; mirror: boolean }) {
  const { answer, live, watching, maybe } = useCalmAnswer(state)
  const screenOrder: HandLabel[] = mirror ? ['Left', 'Both', 'Right'] : ['Right', 'Both', 'Left']
  const guesses = answer ? [...answer.guesses].sort((a, b) => screenOrder.indexOf(a.hand) - screenOrder.indexOf(b.hand)) : []
  const heading = live ? 'Doing now' : watching ? (maybe ? `Watching · might be ${maybe}` : 'Watching…') : answer ? 'Last move' : 'Waiting for a move'

  return (
    <section className={`moves ${live ? 'live' : ''}`} aria-live="polite" aria-label="Identified moves">
      <p className="moves-heading">{heading}</p>
      {guesses.length ? (
        <div key={answer!.key} className={`moves-list ${guesses.length > 1 ? 'split' : ''}`}>
          {guesses.map((g) => (
            <div key={g.hand} className="move-answer">
              <strong>{g.moveName}</strong>
              <span>
                {g.hand === 'Both' ? 'Both hands' : `${g.hand} hand`} · {confidence(g)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="moves-list">
          <div className="move-answer">
            <strong>—</strong>
            <span>No move yet</span>
          </div>
        </div>
      )}
    </section>
  )
}
