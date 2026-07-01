// TikTok OAuth + token lifecycle for PLAYHUB
// Mirrors the PlayerData wrapper (src/lib/playerdata/client.ts): per-user tokens
// are stored and refreshed via the Supabase service-role client, never touched by
// the browser. TikTok rotates the refresh token on every refresh, so we persist
// BOTH the new access and refresh tokens atomically and mark the connection
// inactive when a refresh fails (single-use discipline identical to PlayerData).
//
// Endpoints + field names verified against:
//   https://developers.tiktok.com/doc/login-kit-web
//   https://developers.tiktok.com/doc/oauth-user-access-token-management

import { createServiceClient } from '@/lib/supabase/server'
import { TikTokAuthError, TikTokRefreshError } from './errors'

// ============================================================================
// Config
// ============================================================================

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/'
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/'

// The five scopes this app requests. Every scope here must be demonstrated in the
// TikTok app-review demo video or the submission is delayed.
export const TIKTOK_SCOPES = [
  'user.info.basic',
  'user.info.profile',
  'user.info.stats',
  'video.list',
  'video.upload',
] as const

const BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

function getClientKey(): string {
  const key = process.env.TIKTOK_CLIENT_KEY
  if (!key) throw new Error('TIKTOK_CLIENT_KEY is not configured')
  return key
}

function getClientSecret(): string {
  const secret = process.env.TIKTOK_CLIENT_SECRET
  if (!secret) throw new Error('TIKTOK_CLIENT_SECRET is not configured')
  return secret
}

/**
 * The OAuth redirect URI. Must match a URI registered in the TikTok developer
 * portal AND be identical in the authorize request and the token exchange.
 * `TIKTOK_REDIRECT_URI` lets local dev point at an ngrok tunnel (TikTok rejects
 * localhost for web); otherwise we derive it from the app URL.
 */
function getRedirectUri(): string {
  if (process.env.TIKTOK_REDIRECT_URI) return process.env.TIKTOK_REDIRECT_URI
  const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
  return `${base}/api/auth/tiktok/callback`
}

// ============================================================================
// Token types
// ============================================================================

/** Raw JSON returned by the TikTok token endpoint (top-level fields). */
interface TikTokTokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  refresh_expires_in?: number
  open_id?: string
  scope?: string
  token_type?: string
  error?: string
  error_description?: string
  log_id?: string
}

/** Normalised token with absolute expiry timestamps (ms since epoch). */
export interface TikTokToken {
  accessToken: string
  refreshToken: string
  openId: string
  scope: string
  expiresAt: number
  refreshExpiresAt: number
}

function normaliseToken(raw: TikTokTokenResponse): TikTokToken {
  if (raw.error || !raw.access_token || !raw.refresh_token || !raw.open_id) {
    throw new Error(
      `TikTok token error: ${raw.error ?? 'missing_fields'}${
        raw.error_description ? ` — ${raw.error_description}` : ''
      }`
    )
  }
  const now = Date.now()
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    openId: raw.open_id,
    scope: raw.scope ?? '',
    // expires_in / refresh_expires_in are seconds; fall back to TikTok defaults
    // (24h access, 365d refresh) if the field is ever absent.
    expiresAt: now + (raw.expires_in ?? 86400) * 1000,
    refreshExpiresAt: now + (raw.refresh_expires_in ?? 31536000) * 1000,
  }
}

// ============================================================================
// Token endpoint calls (form-urlencoded, per TikTok docs)
// ============================================================================

/** Low-level token call: returns the parsed body + HTTP status; throws only on a
 *  network/transport failure. Callers interpret `error`/status per grant type. */
async function requestToken(
  params: Record<string, string>
): Promise<{ raw: TikTokTokenResponse; httpStatus: number }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // TikTok requires this to avoid the response being cached.
      'Cache-Control': 'no-cache',
    },
    body: new URLSearchParams(params).toString(),
  })
  const raw = (await res.json()) as TikTokTokenResponse
  return { raw, httpStatus: res.status }
}

async function exchangeCode(code: string): Promise<TikTokToken> {
  const { raw, httpStatus } = await requestToken({
    client_key: getClientKey(),
    client_secret: getClientSecret(),
    code,
    grant_type: 'authorization_code',
    redirect_uri: getRedirectUri(),
  })
  if (httpStatus < 200 || httpStatus >= 300 || raw.error) {
    throw new Error(
      `TikTok token exchange failed: ${raw.error ?? httpStatus}${
        raw.error_description ? ` — ${raw.error_description}` : ''
      }`
    )
  }
  return normaliseToken(raw)
}

/**
 * Refresh the access token. Classifies failures so the caller can decide whether
 * to deactivate the connection: a definitively dead refresh token
 * (invalid_grant/invalid_request) sets TikTokRefreshError.invalid=true; a 5xx,
 * unexpected status, or network error is transient (invalid=false → retry later).
 */
async function refreshAccessToken(refreshToken: string): Promise<TikTokToken> {
  let raw: TikTokTokenResponse
  let httpStatus: number
  try {
    ;({ raw, httpStatus } = await requestToken({
      client_key: getClientKey(),
      client_secret: getClientSecret(),
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }))
  } catch (e) {
    // Network/transport failure — transient, do not deactivate.
    throw new TikTokRefreshError(
      false,
      `TikTok refresh network error: ${e instanceof Error ? e.message : e}`
    )
  }
  if (raw.error) {
    const invalid =
      raw.error === 'invalid_grant' || raw.error === 'invalid_request'
    throw new TikTokRefreshError(invalid, `TikTok refresh error: ${raw.error}`)
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    // 5xx or unexpected status with no error envelope — treat as transient.
    throw new TikTokRefreshError(false, `TikTok refresh HTTP ${httpStatus}`)
  }
  try {
    return normaliseToken(raw)
  } catch (e) {
    // A malformed 2xx body (missing token fields, no error envelope) is more
    // likely a transient upstream glitch than a dead token — don't deactivate.
    throw new TikTokRefreshError(
      false,
      `TikTok refresh malformed response: ${e instanceof Error ? e.message : e}`
    )
  }
}

// ============================================================================
// Per-user token storage (Supabase, service role — bypasses RLS)
// ============================================================================

interface StoredConnection {
  id: string
  user_id: string
  open_id: string
  access_token: string
  refresh_token: string
  expires_at: string
  is_active: boolean
}

async function storeUserTokens(
  userId: string,
  token: TikTokToken
): Promise<void> {
  const supabase = createServiceClient() as any
  const { error } = await supabase.from('tiktok_connections').upsert(
    {
      user_id: userId,
      open_id: token.openId,
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_at: new Date(token.expiresAt).toISOString(),
      refresh_expires_at: new Date(token.refreshExpiresAt).toISOString(),
      scope: token.scope,
      is_active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )
  if (error) throw new Error(`Failed to store TikTok tokens: ${error.message}`)
}

/**
 * Return a valid access token for a user, refreshing if within the expiry buffer.
 * On refresh failure the connection is marked inactive so the UI can prompt a
 * reconnect. Reads/writes go through the service-role client (tokens are secrets).
 */
async function getUserAccessToken(userId: string): Promise<string> {
  const supabase = createServiceClient() as any

  const { data: conn, error } = await supabase
    .from('tiktok_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .single()

  if (error || !conn) {
    throw new TikTokAuthError(
      'not_connected',
      'No active TikTok connection for this user'
    )
  }

  const connection = conn as StoredConnection
  const expiresAt = new Date(connection.expires_at).getTime()
  if (Date.now() < expiresAt - BUFFER_MS) {
    return connection.access_token
  }

  let fresh
  try {
    fresh = await refreshAccessToken(connection.refresh_token)
  } catch (e) {
    // Rotation race: TikTok refresh tokens are single-use, so a concurrent
    // request (e.g. the dashboard's parallel profile+videos calls) may have
    // already refreshed this row. Re-read before assuming the token is dead.
    const { data: latest } = await supabase
      .from('tiktok_connections')
      .select('access_token, is_active')
      .eq('id', connection.id)
      .single()
    if (
      latest?.is_active &&
      latest.access_token &&
      latest.access_token !== connection.access_token
    ) {
      return latest.access_token as string
    }
    // Transient upstream/network failure — keep the connection active and let
    // the next request retry rather than forcing a needless reconnect.
    if (e instanceof TikTokRefreshError && !e.invalid) {
      throw new Error('TikTok is temporarily unavailable. Please try again.')
    }
    // Refresh token is definitively dead — deactivate and require reconnect.
    // Guard on the refresh_token we read: if a concurrent winner has since
    // rotated it (pre-persist race), this becomes a no-op so we don't kill a
    // connection that was successfully refreshed a moment ago.
    const { error: deErr } = await supabase
      .from('tiktok_connections')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', connection.id)
      .eq('refresh_token', connection.refresh_token)
    if (deErr) console.error('[tiktok] deactivate failed:', deErr.message)
    throw new TikTokAuthError(
      'needs_reconnect',
      'TikTok connection expired. Please reconnect your account.'
    )
  }

  // Persist BOTH rotated tokens atomically — the old refresh token is now dead.
  // is_active:true re-activates the row in case a concurrent loser deactivated it
  // in the pre-persist window (see the guarded deactivate above); all orderings
  // then converge to {is_active:true, latest tokens}.
  const { error: updErr } = await supabase
    .from('tiktok_connections')
    .update({
      access_token: fresh.accessToken,
      refresh_token: fresh.refreshToken,
      expires_at: new Date(fresh.expiresAt).toISOString(),
      refresh_expires_at: new Date(fresh.refreshExpiresAt).toISOString(),
      scope: fresh.scope,
      is_active: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connection.id)
  if (updErr) {
    // TikTok rotated the refresh token but we failed to store it — the stored
    // one is now dead. Surface loudly; the next call will require a reconnect.
    console.error('[tiktok] failed to persist refreshed tokens:', updErr.message)
    throw new Error('Could not save refreshed TikTok credentials. Please try again.')
  }
  return fresh.accessToken
}

/** Connection summary for status/UI (no tokens). Null when not connected. */
async function getConnection(
  userId: string
): Promise<{ openId: string; scope: string; isActive: boolean } | null> {
  const supabase = createServiceClient() as any
  const { data } = await supabase
    .from('tiktok_connections')
    .select('open_id, scope, is_active')
    .eq('user_id', userId)
    .single()
  if (!data) return null
  return {
    openId: data.open_id,
    scope: data.scope ?? '',
    isActive: !!data.is_active,
  }
}

async function getUserConnectionStatus(userId: string): Promise<boolean> {
  const supabase = createServiceClient() as any
  const { data } = await supabase
    .from('tiktok_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .single()
  return !!data
}

async function disconnectUser(userId: string): Promise<void> {
  const supabase = createServiceClient() as any
  await supabase.from('tiktok_connections').delete().eq('user_id', userId)
}

// ============================================================================
// Public API
// ============================================================================

export const tiktok = {
  /** Build the authorize URL to redirect the user to (state = CSRF token). */
  getConnectUrl(state: string): string {
    const params = new URLSearchParams({
      client_key: getClientKey(),
      scope: TIKTOK_SCOPES.join(','),
      response_type: 'code',
      redirect_uri: getRedirectUri(),
      state,
    })
    return `${AUTHORIZE_URL}?${params.toString()}`
  },

  /** Exchange the auth code after callback and persist the tokens. */
  async handleCallback(code: string, userId: string): Promise<void> {
    const token = await exchangeCode(code)
    await storeUserTokens(userId, token)
  },

  /** Valid access token for a user, refreshing + rotating as needed. */
  getAccessToken: getUserAccessToken,

  /** Connection summary (open_id/scope/active) or null. */
  getConnection,

  /** Whether the user has an active TikTok connection. */
  isConnected: getUserConnectionStatus,

  /** Remove the user's TikTok connection. */
  disconnect: disconnectUser,
}
