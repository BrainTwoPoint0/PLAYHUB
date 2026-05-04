// CSRF defence-in-depth shared across all state-mutating API routes.
// Supabase cookies default to SameSite=Lax which already blocks cross-site
// POSTs from a different origin; this is the backstop in case anything
// ever loosens that default.
//
// Production: requires NEXT_PUBLIC_APP_URL to be set. Missing env var
// fails CLOSED rather than silently disabling the check (deploy
// misconfiguration shouldn't open a CSRF vector).
//
// Development: missing env var fails OPEN to keep curl / scripts ergonomic.

import type { NextRequest } from 'next/server'

export function passesCsrfCheck(request: NextRequest): boolean {
  const origin = request.headers.get('origin')
  const allowed = process.env.NEXT_PUBLIC_APP_URL
  // Sec-Fetch-Site is the most reliable signal in modern browsers.
  // 'same-origin' = same scheme+host+port; 'none' = direct address-bar
  // navigation (no document context). Both are safe.
  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite === 'same-origin' || fetchSite === 'none') return true

  // Older browsers / native clients / curl omit Origin entirely. Allow
  // those through — server-side auth is still enforced at every route.
  if (!origin) return true

  if (!allowed) {
    // Prod misconfiguration → fail closed. Dev → fail open for ergonomics.
    return process.env.NODE_ENV !== 'production'
  }

  try {
    return new URL(origin).origin === new URL(allowed).origin
  } catch {
    return false
  }
}
