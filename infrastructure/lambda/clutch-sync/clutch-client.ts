// Minimal Clutch API client for the sync Lambda.
// Lambdas are self-contained by repo convention (no imports from src/).
// Auth: account login → 24h Bearer token, no refresh endpoint.

import type { ClutchVideoStatus } from './state-machine'

const CLUTCH_API_BASE = 'https://api.clutchapp.io/v1'
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000

const CLUTCH_EMAIL = process.env.CLUTCH_EMAIL!
const CLUTCH_PASSWORD = process.env.CLUTCH_PASSWORD!

let tokenCache: { token: string; expiresAt: number } | null = null

async function login(): Promise<string> {
  const response = await fetch(`${CLUTCH_API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: CLUTCH_EMAIL, password: CLUTCH_PASSWORD }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Clutch login failed: ${response.status} - ${text.slice(0, 200)}`
    )
  }

  const body = (await response.json()) as { data: { token: string } }
  tokenCache = { token: body.data.token, expiresAt: Date.now() + TOKEN_TTL_MS }
  return tokenCache.token
}

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token
  }
  return login()
}

// Retries exactly once on 401 after a forced re-login.
async function clutchFetch(path: string): Promise<Response> {
  const doFetch = async (token: string) =>
    fetch(`${CLUTCH_API_BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    })

  let response = await doFetch(await getToken())
  if (response.status === 401) {
    tokenCache = null
    response = await doFetch(await login())
  }
  return response
}

// IDs are interpolated into URL paths — validate format defensively.
function safePathId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid Clutch resource id: ${id.slice(0, 50)}`)
  }
  return encodeURIComponent(id)
}

export async function getVideoStatus(
  videoId: string
): Promise<ClutchVideoStatus> {
  const response = await clutchFetch(`/video/${safePathId(videoId)}/status`)
  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Clutch video status failed: ${response.status} - ${text.slice(0, 200)}`
    )
  }
  const body = (await response.json()) as {
    data: { status: ClutchVideoStatus }
  }
  return body.data.status
}

/**
 * Signed output URLs (valid 12h — fetch fresh every run, never persist).
 * Returns null while Clutch still responds 202 (processing).
 */
export async function getVideoResults(
  videoId: string
): Promise<Record<string, string> | null> {
  const response = await clutchFetch(`/video/${safePathId(videoId)}/results`)
  if (response.status === 202) return null
  if (!response.ok) {
    const text = await response.text()
    throw new Error(
      `Clutch video results failed: ${response.status} - ${text.slice(0, 200)}`
    )
  }
  const body = (await response.json()) as {
    data: { outputs: Array<{ key: string; url: string }> }
  }
  const results: Record<string, string> = {}
  for (const output of body.data.outputs || []) {
    results[output.key] = output.url
  }
  return results
}
