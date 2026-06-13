// Clutch API Client for PLAYHUB
// Clutch Cams are padel cameras controlled via a public REST API.
// Auth is the Clutch account login (email/password) — the token lasts 24h
// and there is no refresh endpoint, so we re-login on expiry/401.
// Documentation: https://clutchapp.notion.site/Clutch-Public-API-Documentation-325f733f6e698072be25c5d4e4602b11

const CLUTCH_API_BASE = 'https://api.clutchapp.io/v1'

// Token is valid 24h; refresh after 23h to keep a safety margin.
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000

// ============================================================================
// Types
// ============================================================================

export interface ClutchConfig {
  email: string
  password: string
}

export type ClutchVideoStatus =
  | 'SCHEDULED'
  | 'QUEUED'
  | 'RECORDING'
  | 'PROCESSING'
  | 'DELAYED_PROCESSING'
  | 'COMPLETED'
  | 'COMPLETED_EMPTY_COURT'
  | 'OK'
  | 'OK_EMPTY_COURT'
  | 'FAILED'
  | 'FAILED_DEVICE_OCCUPIED'
  | 'FAILED_DEVICE_OFFLINE'

export type ClutchDeviceState = 'available' | 'unavailable' | 'recording'

export interface ClutchDeviceStatus {
  id: string
  name: string
  status: ClutchDeviceState
  videoId: string | null
}

export interface ClutchScheduleResult {
  videoId: string
  deviceId: string
  status: string
  recordingStartsAt: string | null
}

/** Output key → signed URL (valid 12 hours — never persist these). */
export type ClutchResults = Record<string, string>

export class ClutchConflictError extends Error {
  conflictingIds: string[]

  constructor(message: string, conflictingIds: string[]) {
    super(message)
    this.name = 'ClutchConflictError'
    this.conflictingIds = conflictingIds
  }
}

// ============================================================================
// Configuration & auth
// ============================================================================

let tokenCache: { token: string; expiresAt: number } | null = null

/** Test helper — resets the module-level token cache. */
export function clearTokenCache(): void {
  tokenCache = null
}

export function getClutchConfig(): ClutchConfig {
  const email = process.env.CLUTCH_EMAIL
  const password = process.env.CLUTCH_PASSWORD

  if (!email || !password) {
    throw new Error(
      'Clutch credentials not configured (CLUTCH_EMAIL / CLUTCH_PASSWORD)'
    )
  }

  return { email, password }
}

export function isClutchConfigured(): boolean {
  return Boolean(process.env.CLUTCH_EMAIL && process.env.CLUTCH_PASSWORD)
}

async function login(): Promise<string> {
  const { email, password } = getClutchConfig()

  const response = await fetch(`${CLUTCH_API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Clutch login failed: ${response.status} - ${errorText.slice(0, 200)}`
    )
  }

  const body = (await response.json()) as { data: { token: string } }
  tokenCache = {
    token: body.data.token,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  }
  return tokenCache.token
}

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token
  }
  return login()
}

/**
 * Authenticated fetch against the Clutch API. Retries exactly once on 401
 * after a forced re-login (token may have been minted just under 24h ago).
 */
async function clutchFetch(
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const doFetch = async (token: string) =>
    fetch(`${CLUTCH_API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
        Authorization: `Bearer ${token}`,
      },
      cache: 'no-store',
    })

  let response = await doFetch(await getToken())

  if (response.status === 401) {
    tokenCache = null
    response = await doFetch(await login())
  }

  return response
}

// Device/video IDs are interpolated into URL paths. They come from trusted
// sources (admin-managed mappings, Clutch responses), but validate the format
// anyway so a bad value can never become a path traversal.
function safePathId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid Clutch resource id: ${id.slice(0, 50)}`)
  }
  return encodeURIComponent(id)
}

async function expectOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Clutch ${context} failed: ${response.status} - ${errorText.slice(0, 300)}`
    )
  }
}

// ============================================================================
// Device endpoints
// ============================================================================

export async function getDeviceStatus(
  deviceId: string
): Promise<ClutchDeviceStatus> {
  const response = await clutchFetch(
    `/clutchcam/device/${safePathId(deviceId)}/status`
  )
  await expectOk(response, 'device status')

  const body = (await response.json()) as {
    data: {
      id: string
      name: string
      status: ClutchDeviceState
      video_id: string | null
    }
  }
  return {
    id: body.data.id,
    name: body.data.name,
    status: body.data.status,
    videoId: body.data.video_id ?? null,
  }
}

export async function scheduleDeviceRecording(
  deviceId: string,
  startTimeIso: string,
  maxDurationMin: number
): Promise<ClutchScheduleResult> {
  const response = await clutchFetch(
    `/clutchcam/device/${safePathId(deviceId)}/schedule`,
    {
      method: 'POST',
      body: JSON.stringify({
        start_time: startTimeIso,
        max_recording_duration_min: maxDurationMin,
      }),
    }
  )

  if (response.status === 400) {
    const body = (await response.json().catch(() => null)) as {
      error?: string
      data?: { conflicting_ids?: string[] }
    } | null
    if (body?.data?.conflicting_ids?.length) {
      throw new ClutchConflictError(
        body.error || 'Schedule conflict',
        body.data.conflicting_ids
      )
    }
    throw new Error(
      `Clutch schedule failed: 400 - ${body?.error || 'bad request'}`
    )
  }
  await expectOk(response, 'schedule')

  const body = (await response.json()) as {
    data: {
      id: string
      status: string
      video_id: string
      recording_starts_at?: string
    }
  }
  return {
    videoId: body.data.video_id,
    deviceId,
    status: body.data.status,
    recordingStartsAt: body.data.recording_starts_at ?? null,
  }
}

// ============================================================================
// Video endpoints
// ============================================================================

export async function getVideoStatus(
  videoId: string
): Promise<ClutchVideoStatus> {
  const response = await clutchFetch(`/video/${safePathId(videoId)}/status`)
  await expectOk(response, 'video status')

  const body = (await response.json()) as {
    data: { status: ClutchVideoStatus }
  }
  return body.data.status
}

/**
 * Returns the signed output URLs for a processed video, or null while the
 * video is still processing (Clutch responds 202). URLs expire after 12h —
 * always fetch fresh, never persist.
 */
export async function getVideoResults(
  videoId: string
): Promise<ClutchResults | null> {
  const response = await clutchFetch(`/video/${safePathId(videoId)}/results`)

  if (response.status === 202) {
    return null
  }
  await expectOk(response, 'video results')

  const body = (await response.json()) as {
    data: { outputs: Array<{ key: string; url: string }> }
  }
  const results: ClutchResults = {}
  for (const output of body.data.outputs || []) {
    results[output.key] = output.url
  }
  return results
}

/** Cancels a scheduled recording. */
export async function cancelVideo(videoId: string): Promise<void> {
  const response = await clutchFetch(`/video/${safePathId(videoId)}/cancel`, {
    method: 'DELETE',
  })
  await expectOk(response, 'cancel')
}
