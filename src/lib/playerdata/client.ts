// PlayerData stateful wrapper for PLAYHUB
// Manages env vars, service token cache, and per-user token refresh via Supabase

import {
  generateAuthUrl,
  exchangeCode,
  refreshToken as refreshTokenStateless,
  getServiceToken,
  executeQuery,
  type PlayerDataCredentials,
  type PlayerDataToken,
} from '@braintwopoint0/playback-commons/playerdata'
import { createServiceClient } from '@/lib/supabase/server'

// ============================================================================
// Config
// ============================================================================

function getCredentials(): PlayerDataCredentials {
  return {
    clientId: process.env.PLAYERDATA_CLIENT_ID!,
    clientSecret: process.env.PLAYERDATA_CLIENT_SECRET!,
  }
}

function getRedirectUri(): string {
  const base = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3001'
  return `${base}/api/auth/playerdata/callback`
}

// ============================================================================
// Service Token Cache (in-memory, 5-min buffer)
// ============================================================================

let serviceTokenCache: { token: string; expiresAt: number } | null = null
const BUFFER_MS = 5 * 60 * 1000 // 5 minutes

async function getServiceAccessToken(): Promise<string> {
  if (
    serviceTokenCache &&
    Date.now() < serviceTokenCache.expiresAt - BUFFER_MS
  ) {
    return serviceTokenCache.token
  }

  const result = await getServiceToken(getCredentials())
  serviceTokenCache = {
    token: result.accessToken,
    expiresAt: result.expiresAt,
  }
  return result.accessToken
}

// Exported for testing
export function clearServiceTokenCache(): void {
  serviceTokenCache = null
}

// ============================================================================
// Per-User Token Management (Supabase storage)
// ============================================================================

interface StoredConnection {
  id: string
  user_id: string
  access_token: string
  refresh_token: string
  expires_at: string
  is_active: boolean
}

/**
 * Get a valid access token for a user, refreshing if needed.
 * Uses service role client to read/write tokens (bypasses RLS).
 * If refresh fails (single-use token already consumed), marks connection inactive.
 */
async function getUserAccessToken(userId: string): Promise<string> {
  const supabase = createServiceClient() as any

  const { data: conn, error } = await supabase
    .from('playerdata_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('is_active', true)
    .single()

  if (error || !conn) {
    throw new Error('No active PlayerData connection for this user')
  }

  const connection = conn as StoredConnection

  // Check if token is still valid (with 5-min buffer)
  const expiresAt = new Date(connection.expires_at).getTime()
  if (Date.now() < expiresAt - BUFFER_MS) {
    return connection.access_token
  }

  // Token expired — refresh it
  try {
    const newToken = await refreshTokenStateless(
      getCredentials(),
      connection.refresh_token
    )

    // Store BOTH new access_token and new refresh_token atomically
    await supabase
      .from('playerdata_connections')
      .update({
        access_token: newToken.accessToken,
        refresh_token: newToken.refreshToken,
        expires_at: new Date(newToken.expiresAt).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', connection.id)

    return newToken.accessToken
  } catch {
    // Refresh failed — mark connection inactive (user must re-authorize)
    await supabase
      .from('playerdata_connections')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', connection.id)

    throw new Error(
      'PlayerData connection expired. Please reconnect your account.'
    )
  }
}

/**
 * Store tokens after initial OAuth code exchange.
 */
async function storeUserTokens(
  userId: string,
  token: PlayerDataToken
): Promise<void> {
  const supabase = createServiceClient() as any

  await supabase.from('playerdata_connections').upsert(
    {
      user_id: userId,
      access_token: token.accessToken,
      refresh_token: token.refreshToken,
      expires_at: new Date(token.expiresAt).toISOString(),
      is_active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  )
}

/**
 * Check if a user has an active PlayerData connection.
 */
async function getUserConnectionStatus(userId: string): Promise<boolean> {
  const supabase = createServiceClient() as any
  const { data } = await supabase
    .from('playerdata_connections')
    .select('id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .single()

  return !!data
}

/**
 * Disconnect a user's PlayerData account.
 */
async function disconnectUser(userId: string): Promise<void> {
  const supabase = createServiceClient() as any
  await supabase.from('playerdata_connections').delete().eq('user_id', userId)
}

// ============================================================================
// Public API
// ============================================================================

export const playerdata = {
  /** Generate the OAuth URL to redirect the user to */
  getConnectUrl(state?: string): string {
    return generateAuthUrl(getCredentials(), getRedirectUri(), state)
  },

  /** Exchange auth code after OAuth callback */
  async handleCallback(code: string, userId: string): Promise<void> {
    const token = await exchangeCode(getCredentials(), code, getRedirectUri())
    await storeUserTokens(userId, token)
  },

  /** Check if a user has connected their PlayerData account */
  isConnected: getUserConnectionStatus,

  /** Disconnect a user's PlayerData account */
  disconnect: disconnectUser,

  /** Execute a GraphQL query as a specific user */
  async queryAsUser<T = unknown>(
    userId: string,
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const token = await getUserAccessToken(userId)
    return executeQuery<T>(token, query, variables)
  },

  /** Execute a GraphQL query using service-level credentials (org-wide) */
  async queryAsService<T = unknown>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    const token = await getServiceAccessToken()
    return executeQuery<T>(token, query, variables)
  },
}
