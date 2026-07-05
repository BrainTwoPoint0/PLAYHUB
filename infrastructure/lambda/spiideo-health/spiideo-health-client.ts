// Spiideo INTERNAL API client (api.spiideo.com) — scene/camera health.
//
// This is NOT the public api-public.spiideo.com used by src/lib/spiideo/client.ts
// (OAuth client-credentials, no health data). This is the API behind the
// CloudControl web UI. Auth is a plain email/password sign-in that returns a
// JWT — no browser, no OAuth app. Copy-adapted into the Lambda (like
// veo-sync/veo-scraper.ts) rather than imported, to keep the bundle standalone.

const SPIIDEO_INTERNAL_API_BASE = 'https://api.spiideo.com'

// ── types ───────────────────────────────────────────────────────────

export interface SpiideoSceneStatus {
  online?: boolean
  sceneAlertState?: 'none' | 'attention' | 'maintenance' | string
  availableForRecording?: boolean
  cameraCount?: number
  onlineCameras?: number
  outtages?: number // Spiideo's spelling; normalised to `outages` in the row
  lastOnlineChange?: number // microseconds since epoch
  [key: string]: unknown
}

export interface SpiideoSceneWithStatus {
  id: string
  name?: string
  title?: string
  availableForRecording?: boolean
  status?: SpiideoSceneStatus
  [key: string]: unknown
}

export interface SpiideoOverview {
  numberInMaintenance?: number
  numberInAttention?: number
}

export interface SceneHealthRow {
  scene_id: string
  scene_name: string | null
  account_id: string
  organization_id: string | null
  online: boolean | null
  alert_state: string | null
  available_for_recording: boolean | null
  camera_count: number | null
  online_cameras: number | null
  outages: number | null
  last_online_change: string | null
  status_raw: SpiideoSceneStatus | null
  last_checked_at: string
}

export interface SignInResult {
  status: number
  jwt: string | null
}

export interface ContractResult {
  ok: boolean
  failures: string[]
}

// ── auth + fetch ────────────────────────────────────────────────────

export async function signIn(
  email: string,
  password: string,
  fetchImpl: typeof fetch = fetch
): Promise<SignInResult> {
  const res = await fetchImpl(`${SPIIDEO_INTERNAL_API_BASE}/v1/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, rolesToAssume: ['ROLE_USER'] }),
  })
  let body: { jwt?: string } = {}
  try {
    body = (await res.json()) as { jwt?: string }
  } catch {
    // non-JSON body (e.g. an HTML error page) → jwt stays null, caught by contract
  }
  return { status: res.status, jwt: body?.jwt ?? null }
}

async function authedGet<T>(
  jwt: string,
  path: string,
  fetchImpl: typeof fetch = fetch
): Promise<T> {
  const res = await fetchImpl(`${SPIIDEO_INTERNAL_API_BASE}${path}`, {
    headers: { authorization: `Bearer ${jwt}` },
  })
  if (!res.ok) {
    // Non-2xx here means the API is unreachable/changed — surfaced as an
    // ApiReachable=0 canary failure by the handler, not swallowed.
    throw new Error(`GET ${path} → HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

export function getOverview(
  jwt: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch
): Promise<SpiideoOverview> {
  return authedGet<SpiideoOverview>(
    jwt,
    `/v2/scene-status/overview?accountId=${encodeURIComponent(accountId)}`,
    fetchImpl
  )
}

export function getScenesWithStatus(
  jwt: string,
  accountId: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ content: SpiideoSceneWithStatus[] }> {
  return authedGet<{ content: SpiideoSceneWithStatus[] }>(
    jwt,
    `/v2/scenes?accountId=${encodeURIComponent(accountId)}&status=true&pageSize=200`,
    fetchImpl
  )
}

// ── contract validation (the canary) ────────────────────────────────

// Verifies the reverse-engineered API still returns what we DEPEND ON (auth +
// the scene fields we persist). Any failure means Spiideo changed the private
// API — the handler alerts and re-throws so ContractErrors + Lambda Errors fire.
//
// Deliberately does NOT validate /scene-status/overview: we don't persist it,
// so an unrelated change to that summary endpoint must not block writing scene
// health. Overview is fetched best-effort by the handler.
export function validateContract(input: {
  signInStatus: number
  jwt: string | null
  scenes: { content: SpiideoSceneWithStatus[] } | undefined
}): ContractResult {
  const failures: string[] = []

  if (input.signInStatus !== 200) {
    failures.push(`sign-in returned HTTP ${input.signInStatus} (expected 200)`)
  }
  if (!input.jwt) {
    failures.push('sign-in response missing `jwt`')
  }

  const s = input.scenes
  if (!s || !Array.isArray(s.content)) {
    failures.push('scenes response missing `content` array')
  } else if (s.content.length > 0) {
    // Every scene must have a usable primary key — scene_id is the upsert
    // conflict target, so a missing id would corrupt the write.
    if (
      !s.content.every((sc) => typeof sc.id === 'string' && sc.id.length > 0)
    ) {
      failures.push('scene missing string `id`')
    }
    // At least one scene must carry the status fields we persist. `.some()` is
    // intentional (lenient): a mixed payload where a few scenes lack status is
    // tolerated — those rows map to null — but a total loss of the status shape
    // trips the canary. Empty content is NOT failed (an account can legitimately
    // have zero scenes).
    const hasStatusShape = s.content.some(
      (sc) =>
        sc.status != null &&
        typeof sc.status.online === 'boolean' &&
        'sceneAlertState' in sc.status
    )
    if (!hasStatusShape) {
      failures.push(
        'scene.status shape changed (no online:boolean / sceneAlertState)'
      )
    }
  }

  return { ok: failures.length === 0, failures }
}

// ── mapping ─────────────────────────────────────────────────────────

// Spiideo timestamps are MICROSECONDS since epoch. Guard against missing /
// non-finite values so a partial payload never throws mid-map.
export function microsToIso(micros: unknown): string | null {
  if (typeof micros !== 'number' || !Number.isFinite(micros)) return null
  const ms = Math.round(micros / 1000)
  const d = new Date(ms)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function mapSceneToRow(
  scene: SpiideoSceneWithStatus,
  accountId: string,
  checkedAtIso: string
): SceneHealthRow {
  const st = scene.status ?? {}
  const numOrNull = (v: unknown) => (typeof v === 'number' ? v : null)
  const boolOrNull = (v: unknown) => (typeof v === 'boolean' ? v : null)
  return {
    scene_id: scene.id,
    scene_name: scene.name ?? scene.title ?? null,
    account_id: accountId,
    organization_id: null, // backfilled from playhub_scene_venue_mapping in the handler
    online: boolOrNull(st.online),
    alert_state:
      typeof st.sceneAlertState === 'string' ? st.sceneAlertState : null,
    available_for_recording: boolOrNull(
      scene.availableForRecording ?? st.availableForRecording
    ),
    camera_count: numOrNull(st.cameraCount),
    online_cameras: numOrNull(st.onlineCameras),
    // Spiideo's field is misspelled `outtages`; also read `outages` so a future
    // spelling fix doesn't silently null the column.
    outages: numOrNull(st.outtages ?? (st as { outages?: unknown }).outages),
    last_online_change: microsToIso(st.lastOnlineChange),
    status_raw: scene.status ?? null,
    last_checked_at: checkedAtIso,
  }
}
