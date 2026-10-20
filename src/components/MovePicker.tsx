import { useEffect, useId, useMemo, useState } from 'react'
import { findExisting, loadMoveCandidates, suggestMoves, type MoveCandidate } from '../recording/moveNames'

interface Props {
  value: string
  onChange: (name: string) => void
  autoFocus?: boolean
}

function countLabel(c: MoveCandidate) {
  const parts = []
  if (c.libraryCount) parts.push(`${c.libraryCount} in library`)
  if (c.mineCount) parts.push(`${c.mineCount} yours`)
  return parts.join(' · ') || (c.inLibrary ? 'in library' : '')
}

/**
 * Move name input with suggestions from the starter list, your recordings
 * and the shared library. Typing a near-duplicate ("sybil cut" when the
 * library has "Sybil") suggests the existing name instead of a new move.
 */
export function MovePicker({ value, onChange, autoFocus }: Props) {
  const [candidates, setCandidates] = useState<MoveCandidate[]>([])
  const [text, setText] = useState(value)
  const [open, setOpen] = useState(false)
  const listId = useId()

  useEffect(() => {
    void loadMoveCandidates().then(setCandidates)
  }, [])

  const suggestions = useMemo(() => suggestMoves(text, candidates), [text, candidates])
  const existing = useMemo(() => findExisting(text, candidates), [text, candidates])
  const trimmed = text.trim()

  const choose = (name: string) => {
    setText(name)
    onChange(name)
    setOpen(false)
  }

  const commitTyped = () => {
    // Snap to the existing spelling when the typed name is the same move.
    if (existing?.exact) choose(existing.match.name)
    else onChange(trimmed)
  }

  return (
    <div className="move-picker">
      <input
        value={text}
        placeholder="Type a move, e.g. Sybil"
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
          onChange('')
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Let a tap on a suggestion land first.
          setTimeout(() => setOpen(false), 150)
          commitTyped()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (existing?.exact) choose(existing.match.name)
            else if (trimmed) choose(trimmed)
          }
        }}
      />
      {open && (suggestions.length > 0 || trimmed) && (
        <ul className="suggestions" id={listId} role="listbox">
          {suggestions.map((c) => (
            <li key={c.name}>
              <button type="button" role="option" aria-selected={c.name === value} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(c.name)}>
                <span>{c.name}</span>
                <span className="muted small">{countLabel(c)}</span>
              </button>
            </li>
          ))}
          {trimmed && !existing?.exact && (
            <li>
              <button type="button" role="option" aria-selected={false} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(trimmed)}>
                <span>
                  Add “{trimmed}” as a new move
                </span>
                {existing && <span className="muted small">or did you mean {existing.match.name}?</span>}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
