// Spiideo internal-API helpers for the snapshot Lambda: spin up a short live
// session on a scene's camera, wait for the tentative HLS playlist, and tear it
// down. Copy-adapted (like the other Spiideo Lambdas) — see
// docs/decisions/2026-07-01-spiideo-scene-health.md.

const BASE = 'https://api.spiideo.com'

// Keep the live session alive comfortably longer than the whole capture
// (poll ~60s + ffmpeg 30s + slack). Must dominate poll_max + ffmpeg_timeout so
// the stream can't self-stop mid-grab. Explicit deleteGame tears it down early
// on success, so a long TTL costs nothing.
const SESSION_TTL_MS = 150_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/v1/auth/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, rolesToAssume: ['ROLE_USER'] }),
  })
  if (!res.ok) throw new Error(`sign-in HTTP ${res.status}`)
  const body = (await res.json().catch(() => ({}))) as { jwt?: string }
  if (!body.jwt) throw new Error('sign-in missing jwt')
  return body.jwt
}

// Empty-body-safe request (Spiideo's mutating endpoints return empty bodies).
async function req<T>(
  jwt: string,
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.method || 'GET',
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok)
    throw new Error(`${opts.method || 'GET'} ${path} → HTTP ${res.status}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

// Create a live-view session and kick the tentative (live-preview) stream.
export async function startLiveSession(
  jwt: string,
  accountId: string,
  sceneId: string,
  sceneName: string
): Promise<string> {
  const stopTimeMicros = (Date.now() + SESSION_TTL_MS) * 1000
  const session = await req<{ id: string }>(jwt, '/v2/sessions', {
    method: 'PUT',
    body: {
      title: `[PLAYHUB Snapshot] ${sceneName} | ${new Date().toISOString()}`,
      sceneId,
      storageTier: 'normal',
      scheduledStopTime: stopTimeMicros,
      accountId,
      liveView: true,
    },
  })
  const gameId = session.id
  await req(jwt, `/v2/sessions/${gameId}/record`, { method: 'PUT' })
  await req(jwt, `/v2/games/${gameId}`, {
    method: 'PATCH',
    body: {
      action: 'updateGame',
      performTentativeStreams: { action: 'replace', value: 'requested' },
    },
  })
  return gameId
}

// Poll until the aggregated (VirtualPanorama) stream's HLS playlist is servable,
// then return a ready-to-fetch playlist URL (auth as query param, as the UI does).
export async function waitForPlaylist(
  jwt: string,
  accountId: string,
  gameId: string,
  {
    tries = 20,
    intervalMs = 3000,
  }: { tries?: number; intervalMs?: number } = {}
): Promise<string | null> {
  for (let i = 0; i < tries; i++) {
    await sleep(intervalMs)
    let content: Array<{ id: string; type?: string }> = []
    try {
      const st = await req<{ content: Array<{ id: string; type?: string }> }>(
        jwt,
        `/v1/streams?gameId=${gameId}&type=aggregated&type=intermediate&type=tag`
      )
      content = st?.content ?? []
    } catch {
      continue
    }
    const agg = content.find((s) => s.type === 'aggregated')
    if (!agg) continue
    const playlist = `${BASE}/v2/streams/${agg.id}/playlist?accountId=${encodeURIComponent(
      accountId
    )}&authorization=bearer+${jwt}`
    const head = await fetch(playlist, {
      method: 'HEAD',
      redirect: 'manual',
    }).catch(() => null)
    if (head && head.status >= 200 && head.status < 400) return playlist
  }
  return null
}

// Best-effort teardown. A still-recording game rejects DELETE (400); if so the
// session self-stops at its scheduledStopTime.
export async function deleteGame(jwt: string, gameId: string): Promise<void> {
  try {
    await fetch(`${BASE}/v2/games/${gameId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${jwt}` },
    })
  } catch {
    /* ignore */
  }
}
