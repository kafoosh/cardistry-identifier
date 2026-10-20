// Production defaults; both values are public. Local dev leaves them empty
// unless VITE_API_BASE / VITE_TURNSTILE_SITEKEY are set, so it never hits the
// live API by accident (and the Turnstile widget only allows kafoosh.github.io).
const PROD_API_BASE = 'https://cardistry-api.kennethaidanfoo.workers.dev'
const PROD_TURNSTILE_SITEKEY = '0x4AAAAAAFdRpxQ8IkkBexua'

/** Base URL of the shared library API (Cloudflare Worker). */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? (import.meta.env.PROD ? PROD_API_BASE : '')).replace(/\/+$/, '')
/** Cloudflare Turnstile site key. Empty in local dev, where the API skips the check. */
export const TURNSTILE_SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY ?? (import.meta.env.PROD ? PROD_TURNSTILE_SITEKEY : '')

export const sharingEnabled = () => API_BASE !== ''
