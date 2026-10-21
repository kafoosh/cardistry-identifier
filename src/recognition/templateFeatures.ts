import { detectActiveHands, keepHands } from '../recording/activeHands'
import type { Frame } from '../tracking/types'
import { extractFeatures } from './features'
import type { Template } from './recognizer'

/**
 * Features for a take, and whether it is a one-hand or two-hand move. A
 * one-hand take is encoded from its moving hand alone; matching tries the
 * mirror image too, so it can match that move done in either hand. The take
 * is also encoded the way Identify's other kind of matching would see it
 * (see Template.alt).
 */
export function templateFeatures(frames: Frame[], aspect: number): Pick<Template, 'features' | 'hands' | 'alt'> | null {
  const activity = detectActiveHands(frames)
  const active = activity.filter((h) => h.active && h.presence >= 0.3)
  const hands = active.length >= 2 ? 2 : 1
  const alone = (slot: 0 | 1) => extractFeatures(keepHands(frames, new Set([slot])), aspect, slot)
  const features = hands === 2 || !active.length ? extractFeatures(frames, aspect) : alone(active[0].slot)
  if (!features || features.frames < 4) return null
  const alt =
    hands === 2
      ? active.map((h) => alone(h.slot))
      : activity.filter((h) => h.presence >= 0.3).length === 2
        ? [extractFeatures(frames, aspect)]
        : []
  return { features, hands, alt: alt.filter((f): f is NonNullable<typeof f> => f !== null && f.frames >= 4) }
}
