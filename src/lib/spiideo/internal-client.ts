// Spiideo INTERNAL API client for PLAYHUB (server-side only).
//
// This is the API behind the CloudControl web UI (api.spiideo.com) — distinct
// from the public OAuth API in client.ts (api-public.spiideo.com), which has no
// device health or device-command endpoints. Auth here is a plain email/
// password sign-in that returns a JWT — pure fetch, no browser, so it runs fine
// on Netlify functions.
//
// Used by the admin scene-health API route to read status and issue the
// CloudControl device commands (speed test, test recording). Credentials come
// from SPIIDEO_PLAY_EMAIL / SPIIDEO_PLAY_PASSWORD / SPIIDEO_ACCOUNT_ID.
// Endpoints reverse-engineered 2026-07-01 — see
// docs/decisions/2026-07-01-spiideo-scene-health.md.

const SPIIDEO_INTERNAL_API_BASE = 'https://api.spiideo.com'

// Distinct error type so callers classify "we're misconfigured" (503) vs
// "Spiideo rejected the call" (502) without brittle string matching.
export class SpiideoNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpiideoNotConfiguredError'
  }
}

// ============================================================================
// Types
// ============================================================================

export interface SpeedTestResult {
  state: 'created' | 'running' | 'finished' | 'error' | string
  connectionQuality: string | null // e.g. 'good'
  meanUploadSpeedMbps: number | null
  minUploadSpeedMbps: number | null
  maxUploadSpeedMbps: number | null
  timeCreated: number | null
}

export interface TestRecordingResult {
  gameId: string
  state: string // 'recording' on success
  stopTimeMicros: number
}

interface SceneNetworkTest {
  id: string
  timeCreated?: number
  state?: string
  connectionQuality?: string
  meanUploadSpeed?: number
  minUploadSpeed?: number
  maxUploadSpeed?: number
}

// ============================================================================
// Config + auth (JWT cache with in-flight dedup, mirroring the public client)
// ============================================================================

interface InternalConfig {
  email: string
  password: string
  accountId: string
}

function getConfig(): InternalConfig {
  const email = process.env.SPIIDEO_PLAY_EMAIL
  const password = process.env.SPIIDEO_PLAY_PASSWORD
  const accountId = process.env.SPIIDEO_ACCOUNT_ID
  if (!email || !password || !accountId) {
    throw new SpiideoNotConfiguredError(
      'Spiideo internal API not configured (SPIIDEO_PLAY_EMAIL / SPIIDEO_PLAY_PASSWORD / SPIIDEO_ACCOUNT_ID)'
    )
  }
  return { email, password, accountId }
}

let jwtCache: { jwt: string; expiresAt: number } | null = null
let jwtInFlight: Promise<string> | null = null

// The sign-in JWT lasts ~30 days; cache it for 24h with a wide margin so a
// long-lived server process re-signs-in occasionally rather than every call.
const JWT_TTL_MS = 24 * 60 * 60 * 1000

async function signIn(fetchImpl: typeof fetch): Promise<string> {
  const { email, password } = getConfig()
  const res = await fetchImpl(`${SPIIDEO_INTERNAL_API_BASE}/v1/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, rolesToAssume: ['ROLE_USER'] }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Spiideo sign-in failed: HTTP ${res.status}`)
  const body = (await res.json().catch(() => ({}))) as { jwt?: string }
  if (!body.jwt) throw new Error('Spiideo sign-in response missing jwt')
  jwtCache = { jwt: body.jwt, expiresAt: Date.now() + JWT_TTL_MS }
  return body.jwt
}

async function getJwt(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (jwtCache && Date.now() < jwtCache.expiresAt) return jwtCache.jwt
  // Dedup concurrent cold-cache sign-ins into one request.
  if (!jwtInFlight) {
    jwtInFlight = signIn(fetchImpl).finally(() => {
      jwtInFlight = null
    })
  }
  return jwtInFlight
}

function clearJwtCache(): void {
  jwtCache = null
}

async function internalRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  const doFetch = async (jwt: string) =>
    fetchImpl(`${SPIIDEO_INTERNAL_API_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        authorization: `Bearer ${jwt}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
    })

  let res = await doFetch(await getJwt(fetchImpl))
  if (res.status === 401) {
    // Stale/expired jwt — re-sign-in once and retry.
    clearJwtCache()
    res = await doFetch(await getJwt(fetchImpl))
  }
  if (!res.ok) {
    throw new Error(
      `Spiideo internal API ${options.method || 'GET'} ${path} → HTTP ${res.status}`
    )
  }
  // Spiideo's mutating endpoints (PUT/POST) return EMPTY bodies with a 200/204 —
  // res.json() throws "Unexpected end of JSON input" on them. Read text first.
  // (Same invariant as sync-recordings; docs/decisions/2026-06-04-...)
  if (res.status === 204) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

// ============================================================================
// Speed test — POST to start, GET the list, match the test we started by id
// ============================================================================

const roundMbps = (v: number | undefined): number | null =>
  typeof v === 'number' ? Math.round(v * 100) / 100 : null

function mapSpeedTest(t: SceneNetworkTest): SpeedTestResult {
  return {
    state: t.state ?? 'unknown',
    connectionQuality: t.connectionQuality ?? null,
    meanUploadSpeedMbps: roundMbps(t.meanUploadSpeed),
    minUploadSpeedMbps: roundMbps(t.minUploadSpeed),
    maxUploadSpeedMbps: roundMbps(t.maxUploadSpeed),
    timeCreated: t.timeCreated ?? null,
  }
}

// Kicks off a scene network (upload speed) test. Returns the test id to poll.
export async function startSceneSpeedTest(
  sceneId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ id: string }> {
  const { accountId } = getConfig()
  const res = await internalRequest<{ id: string }>(
    '/v2/scenes/network-tests',
    { method: 'POST', body: { sceneId, accountId } },
    fetchImpl
  )
  return { id: res.id }
}

async function listSpeedTests(
  sceneId: string,
  fetchImpl: typeof fetch = fetch
): Promise<SceneNetworkTest[]> {
  const res = await internalRequest<{ content: SceneNetworkTest[] }>(
    `/v2/scenes/network-tests?sceneId=${encodeURIComponent(sceneId)}&sortProperty=timeCreated`,
    {},
    fetchImpl
  )
  return Array.isArray(res.content) ? res.content : []
}

// Returns a SPECIFIC test by id (the one we started) so polling can't latch
// onto a stale prior result, and can see a terminal 'error' state.
export async function getSpeedTestById(
  sceneId: string,
  testId: string,
  fetchImpl: typeof fetch = fetch
): Promise<SpeedTestResult | null> {
  const list = await listSpeedTests(sceneId, fetchImpl)
  const match = list.find((t) => t.id === testId)
  return match ? mapSpeedTest(match) : null
}

// Newest test for a scene (used to show last-known result on load).
export async function getLatestSpeedTest(
  sceneId: string,
  fetchImpl: typeof fetch = fetch
): Promise<SpeedTestResult | null> {
  const list = await listSpeedTests(sceneId, fetchImpl)
  if (list.length === 0) return null
  const newest = list.reduce((a, b) =>
    (b.timeCreated ?? 0) > (a.timeCreated ?? 0) ? b : a
  )
  return mapSpeedTest(newest)
}

// ============================================================================
// Test recording — create a session, then start it. We set a SHORT stop time
// so it self-terminates (CloudControl's own default is ~10 min).
// ============================================================================

const TEST_RECORDING_SECONDS = 60

export async function startTestRecording(
  sceneId: string,
  sceneName: string,
  fetchImpl: typeof fetch = fetch
): Promise<TestRecordingResult> {
  const { accountId } = getConfig()
  // Spiideo timestamps are MICROSECONDS since epoch.
  const stopTimeMicros = (Date.now() + TEST_RECORDING_SECONDS * 1000) * 1000
  const title = `[PLAYHUB Test] ${sceneName} | ${new Date().toISOString()}`

  const session = await internalRequest<{ id: string }>(
    '/v2/sessions',
    {
      method: 'PUT',
      body: {
        title,
        sceneId,
        storageTier: 'normal',
        scheduledStopTime: stopTimeMicros,
        accountId,
        liveView: false,
      },
    },
    fetchImpl
  )

  const recording = await internalRequest<{
    id?: string
    state?: string
    gameId?: string
  }>(
    `/v2/sessions/${encodeURIComponent(session.id)}/record`,
    { method: 'PUT' },
    fetchImpl
  )

  return {
    gameId: recording?.gameId ?? recording?.id ?? session.id,
    state: recording?.state ?? 'recording',
    stopTimeMicros,
  }
}

// Exposed for tests to reset the module-level jwt cache between cases.
export const __testing = { clearJwtCache }
