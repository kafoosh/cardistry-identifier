import { useEffect, useRef } from 'react'
import { TURNSTILE_SITEKEY } from '../config'

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  remove: (id: string) => void
}

declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null

function loadScript(): Promise<TurnstileApi> {
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    s.async = true
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile failed to load')))
    s.onerror = () => {
      scriptPromise = null
      reject(new Error("Couldn't load the spam check. Check your connection and try again."))
    }
    document.head.appendChild(s)
  })
  return scriptPromise
}

/**
 * Cloudflare Turnstile (free, usually invisible) spam check. Calls onToken
 * with a fresh token, or with '' straight away when no site key is set
 * (local dev, where the API skips the check).
 */
export function Turnstile({
  onToken,
  onError,
  quiet = false,
}: {
  onToken: (token: string | null) => void
  onError: (msg: string) => void
  /** Take no room unless the check needs the person to tap it. */
  quiet?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!TURNSTILE_SITEKEY) {
      onToken('')
      return
    }
    let widgetId: string | null = null
    let cancelled = false
    loadScript()
      .then((api) => {
        if (cancelled || !ref.current) return
        widgetId = api.render(ref.current, {
          sitekey: TURNSTILE_SITEKEY,
          theme: 'dark',
          size: 'flexible',
          ...(quiet ? { appearance: 'interaction-only' } : {}),
          callback: onToken,
          'expired-callback': () => onToken(null),
          'error-callback': () => onError('The spam check failed. Reload the page and try again.'),
        })
      })
      .catch((err: Error) => onError(err.message))
    return () => {
      cancelled = true
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId)
    }
    // Render once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <div ref={ref} className="turnstile" />
}
