import { useEffect, useRef, type RefObject } from 'react'
import type { MotionWatcher } from '../recognition/motionWatcher'

/** Bar width at which the strip is full, as a multiple of the motion-on level. */
const FULL = 2.5

/**
 * The finger-motion meter along the bottom of the camera. It updates its own
 * bar a few times a second straight from the watcher, so moving your hands
 * doesn't re-render the whole camera screen.
 */
export function MotionStrip({ watcherRef }: { watcherRef: RefObject<MotionWatcher | null> }) {
  const stripRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    let width = ''
    let active = false
    const id = setInterval(() => {
      const m = watcherRef.current?.latest
      const strip = stripRef.current
      const bar = barRef.current
      if (!m || !strip || !bar) return
      const w = `${Math.min(100, (m.energy / (m.on * FULL)) * 100).toFixed(0)}%`
      if (w !== width) bar.style.width = width = w
      if (m.active !== active) strip.classList.toggle('active', (active = m.active))
    }, 150)
    return () => clearInterval(id)
  }, [watcherRef])

  return (
    <div ref={stripRef} className="motion-strip" title="Finger motion">
      <span ref={barRef} style={{ width: '0%' }} />
      <i style={{ left: `${100 / FULL}%` }} />
    </div>
  )
}
