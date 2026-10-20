import { useEffect, useMemo, useState } from 'react'
import { sharingEnabled } from '../config'
import type { SelfTestResult } from '../recognition/calibration'
import { getMatcher } from '../recognition/shared'
import { loadLocalTemplates, loadTemplates } from '../recognition/templates'
import type { LocalRecording, RecordingSummary } from '../recording/types'
import { deleteRecording, listRecordings, loadRecording, loadVideo, markShared, renameRecording } from '../storage/db'
import { ReplayCanvas } from './ReplayCanvas'
import { MovePicker } from './MovePicker'
import { ShareSheet, type ShareOutcome } from './ShareSheet'

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function SelfTestReport({ result }: { result: SelfTestResult }) {
  if (!result.total) {
    return (
      <div className="self-test small">
        Record at least two takes of a move to test recognition. Each take is checked against all the others.
      </div>
    )
  }
  const mistakes = Object.entries(result.confusion).flatMap(([truth, guesses]) =>
    Object.entries(guesses)
      .filter(([g]) => g !== truth)
      .map(([g, n]) => ({ truth, guess: g, n })),
  )
  const pct = (n: number) => Math.round((n / result.total) * 100)
  return (
    <div className="self-test small">
      <strong>
        {result.correct} of {result.total} takes recognised ({pct(result.correct)}%), {result.wrong} wrong (
        {pct(result.wrong)}%), {result.unsure} not sure
      </strong>{' '}
      across {result.testedMoves} move{result.testedMoves === 1 ? '' : 's'}. Each take is held out and run through
      Identify against all the other takes, yours and the library's.
      {mistakes.length > 0 && (
        <ul>
          {mistakes.map((m) =>
            m.guess === '(not sure)' ? (
              <li key={`${m.truth}-${m.guess}`}>
                {m.truth}: not sure ×{m.n}
              </li>
            ) : (
              <li key={`${m.truth}-${m.guess}`}>
                {m.truth} mistaken for {m.guess} ×{m.n}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}

/** Recordings saved on this device, grouped by move, with replay, rename, delete and export. */
export function Library({ onRecordMore }: { onRecordMore: () => void }) {
  const [items, setItems] = useState<RecordingSummary[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [open, setOpen] = useState<LocalRecording | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [sharing, setSharing] = useState<LocalRecording[] | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const [note, setNote] = useState('')
  const [test, setTest] = useState<SelfTestResult | 'running' | null>(null)
  const [outliers, setOutliers] = useState<Set<string>>(new Set())
  const [hideShared, setHideShared] = useState(() => {
    try {
      return localStorage.getItem('cardistry.hideShared') !== '0'
    } catch {
      return true
    }
  })
  const toggleHideShared = () => {
    setHideShared(!hideShared)
    try {
      localStorage.setItem('cardistry.hideShared', hideShared ? '0' : '1')
    } catch {
      // Not remembered in private mode.
    }
  }

  // Flag takes that don't look like the rest of their move (they're left out of matching).
  useEffect(() => {
    if (!items?.length) return
    let cancelled = false
    void loadLocalTemplates()
      .then(({ templates }) => getMatcher().setTemplates(templates))
      .then((ids) => !cancelled && setOutliers(new Set(ids)))
    return () => {
      cancelled = true
    }
  }, [items])

  const runSelfTest = async () => {
    setTest('running')
    // The same takes Identify matches against: this device's and the library's.
    const { templates } = await loadTemplates()
    const matcher = getMatcher()
    setOutliers(new Set(await matcher.setTemplates(templates)))
    setTest(await matcher.selfTest())
  }

  const refresh = () =>
    listRecordings()
      .then(setItems)
      .catch((err) => setError(String(err)))

  useEffect(() => {
    void refresh()
  }, [])

  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    if (!openId) return
    void (async () => {
      const rec = await loadRecording(openId)
      const video = rec?.hasVideo ? await loadVideo(openId) : null
      if (cancelled) return
      if (video) {
        url = URL.createObjectURL(video)
        setVideoUrl(url)
      }
      setOpen(rec)
    })()
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [openId])

  const toggle = (id: string) => {
    setOpen(null)
    setVideoUrl(null)
    setOpenId(openId === id ? null : id)
  }

  const sharedHidden = hideShared ? (items ?? []).filter((r) => r.sharedId).length : 0
  const groups = useMemo(() => {
    const map = new Map<string, RecordingSummary[]>()
    for (const r of (items ?? []).filter((r) => !(hideShared && r.sharedId)))
      map.set(r.moveName, [...(map.get(r.moveName) ?? []), r])
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [items, hideShared])

  const exportAll = async () => {
    const all = await Promise.all((items ?? []).map((r) => loadRecording(r.id)))
    const payload = {
      format: 'cardistry-identifier/recordings',
      version: 1,
      exportedAt: Date.now(),
      recordings: all.filter(Boolean),
    }
    download(
      new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      `cardistry-recordings-${Date.now()}.json`,
    )
  }

  const remove = async (r: RecordingSummary) => {
    if (!confirm(`Delete this ${r.moveName} recording? This can't be undone.`)) return
    await deleteRecording(r.id)
    if (openId === r.id) toggle(r.id)
    await refresh()
  }

  const saveRename = async () => {
    if (!renaming) return
    const name = renaming.name.trim()
    setRenaming(null)
    if (!name) return
    await renameRecording(renaming.id, name)
    await refresh()
  }

  const shareAll = async () => {
    const unshared = (items ?? []).filter((r) => !r.sharedId)
    const recs = await Promise.all(unshared.map((r) => loadRecording(r.id)))
    setSharing(recs.filter((r): r is LocalRecording => r !== null))
  }

  const finishSharing = async (outcomes: ShareOutcome[]) => {
    let added = 0
    let already = 0
    let held = 0
    const failures: string[] = []
    for (const { recording, result } of outcomes) {
      if (!result.ok) {
        failures.push(result.error)
        continue
      }
      await markShared(recording.id, result.id)
      if (result.duplicate) already++
      else {
        added++
        if (result.status === 'pending') held++
      }
    }
    setSharing(null)
    const parts = []
    if (added) parts.push(`Shared ${added} recording${added === 1 ? '' : 's'}. Thanks!`)
    if (already) parts.push(`${already} ${already === 1 ? 'was' : 'were'} already in the library.`)
    if (held) parts.push(`${held} had patchy tracking and ${held === 1 ? 'is' : 'are'} held for review.`)
    if (failures.length) parts.push(`${failures.length} failed: ${[...new Set(failures)].join('; ')}`)
    setNote(parts.join(' '))
    await refresh()
  }

  if (error) return <p className="error">{error}</p>
  const shareable = sharingEnabled()
  const unsharedCount = (items ?? []).filter((r) => !r.sharedId).length
  const moveCount = new Set((items ?? []).map((r) => r.moveName)).size
  if (!items) return <p className="muted">Loading…</p>

  if (!items.length) {
    return (
      <div className="empty">
        <p>No recordings yet.</p>
        <p className="muted small">
          Record each starter move about five times, from your phone and your laptop. Recordings stay on this device.
        </p>
        <button className="primary" onClick={onRecordMore}>
          Record a move
        </button>
      </div>
    )
  }

  return (
    <div className="library">
      <div className="library-head">
        <p className="muted small">
          {items.length} recording{items.length === 1 ? '' : 's'} of {moveCount} move{moveCount === 1 ? '' : 's'}, saved
          on this device only.
        </p>
        <div className="controls">
          <button onClick={runSelfTest} disabled={test === 'running'}>
            {test === 'running' ? 'Testing…' : 'Test recognition'}
          </button>
          {shareable && unsharedCount > 0 && (
            <button className="primary" onClick={shareAll}>
              Share all to library ({unsharedCount})
            </button>
          )}
          <button onClick={exportAll}>Export all (JSON)</button>
        </div>
      </div>
      {test && test !== 'running' && <SelfTestReport result={test} />}
      {note && <p className="saved-note">{note}</p>}
      {(sharedHidden > 0 || (!hideShared && items.some((r) => r.sharedId))) && (
        <label className="check small">
          <input type="checkbox" checked={hideShared} onChange={toggleHideShared} />
          Hide takes already shared to the library{sharedHidden ? ` (${sharedHidden} hidden)` : ''}
        </label>
      )}
      {groups.length === 0 && sharedHidden > 0 && (
        <p className="muted small">Everything here is shared. Untick the box above to see those takes.</p>
      )}

      {groups.map(([move, recs]) => (
        <section key={move} className="move-group">
          <h3>
            {move} <span className="muted small">× {recs.length}</span>
          </h3>
          <ul>
            {recs.map((r) => (
              <li key={r.id} className={openId === r.id ? 'is-open' : ''}>
                <button className="rec-row" onClick={() => toggle(r.id)}>
                  <span>{fmtDate(r.createdAt)}</span>
                  <span className="muted small tabular">
                    {(r.durationMs / 1000).toFixed(1)}s · {r.cameraView} ·{' '}
                    {r.camera === 'user' ? 'front cam' : 'rear cam'} · {r.device}
                    {r.longestGapMs ? ` · longest drop ${(r.longestGapMs / 1000).toFixed(2)}s` : ''}
                  </span>
                  {r.sharedId && <span className="pill">shared</span>}
                  {outliers.has(r.id) && (
                    <span
                      className="pill warn"
                      title="This take looks different from your other takes of this move, so it isn't used for recognition."
                    >
                      unusual
                    </span>
                  )}
                  <span className={`quality ${r.qualityScore < 0.6 ? 'low' : ''}`}>
                    {(r.qualityScore * 100).toFixed(0)}%
                  </span>
                </button>
                {openId === r.id && (
                  <div className="rec-detail">
                    {open ? (
                      <ReplayCanvas
                        frames={open.frames}
                        width={open.videoWidth}
                        height={open.videoHeight}
                        mirror={open.camera === 'user'}
                        videoUrl={videoUrl}
                        videoStartMs={open.videoStartMs}
                      />
                    ) : (
                      <p className="muted small">Loading…</p>
                    )}
                    {renaming?.id === r.id && (
                      <div className="rename">
                        <MovePicker
                          value={renaming.name}
                          onChange={(name) => setRenaming({ id: r.id, name })}
                          autoFocus
                        />
                        <button className="primary" onClick={saveRename} disabled={!renaming.name.trim()}>
                          Save
                        </button>
                        <button onClick={() => setRenaming(null)}>Cancel</button>
                      </div>
                    )}
                    <div className="controls">
                      {shareable && open && !r.sharedId && (
                        <button className="primary" onClick={() => setSharing([open])}>
                          Share to library
                        </button>
                      )}
                      <button onClick={() => setRenaming({ id: r.id, name: r.moveName })}>Change move</button>
                      {open && (
                        <button
                          onClick={() =>
                            download(
                              new Blob([JSON.stringify(open)], { type: 'application/json' }),
                              `${slug(r.moveName)}-${r.id.slice(0, 8)}.json`,
                            )
                          }
                        >
                          Download landmarks
                        </button>
                      )}
                      {videoUrl && (
                        <button
                          onClick={async () => {
                            const v = await loadVideo(r.id)
                            if (v)
                              download(
                                v,
                                `${slug(r.moveName)}-${r.id.slice(0, 8)}.${v.type.includes('mp4') ? 'mp4' : 'webm'}`,
                              )
                          }}
                        >
                          Download video
                        </button>
                      )}
                      <button className="danger" onClick={() => remove(r)}>
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {sharing && sharing.length > 0 && (
        <ShareSheet recordings={sharing} onClose={() => setSharing(null)} onDone={finishSharing} />
      )}
    </div>
  )
}
