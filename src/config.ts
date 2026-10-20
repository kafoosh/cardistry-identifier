/** Base URL of the shared library API (Cloudflare Worker). Empty until it's deployed. */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '')
/** Cloudflare Turnstile site key. Empty in local dev, where the API skips the check. */
export const TURNSTILE_SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY ?? ''

export const sharingEnabled = () => API_BASE !== ''
