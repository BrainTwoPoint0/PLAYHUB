import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  startSceneSpeedTest,
  getSpeedTestById,
  getLatestSpeedTest,
  startTestRecording,
  __testing,
} from '../internal-client'

// A finished speed test taken verbatim from the real api.spiideo.com response.
const FINISHED_TEST = {
  id: '96d39265',
  timeCreated: 1782903031915110,
  state: 'finished',
  connectionQuality: 'good',
  meanUploadSpeed: 20.319092295349435,
  minUploadSpeed: 20.319092295349435,
  maxUploadSpeed: 20.319092295349435,
}
const OLDER_TEST = {
  id: '2b2d3000',
  timeCreated: 1782902826970116, // older
  state: 'finished',
  connectionQuality: 'poor',
  meanUploadSpeed: 5.5,
}

// Fake fetch keyed by URL substring. Each route returns [status, body|null].
// A null body models Spiideo's empty-body mutating responses. Sign-in count
// proves the JWT cache.
function makeFetch(routes: Record<string, [number, unknown]>) {
  const signInCalls = { count: 0 }
  const lastBodies: Record<string, unknown> = {}
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/v1/auth/sign-in')) {
      signInCalls.count++
      return res(200, { jwt: 'ey.fake.jwt' })
    }
    for (const key of Object.keys(routes)) {
      if (u.includes(key)) {
        if (init?.body) lastBodies[key] = JSON.parse(init.body as string)
        return res(routes[key][0], routes[key][1])
      }
    }
    return res(404, {})
  }) as unknown as typeof fetch
  return { fn, signInCalls, lastBodies }
}

// Stub Response exposing BOTH json() and text() — internalRequest reads text()
// first (empty-body safe). A null body → empty string.
function res(status: number, body: unknown): Response {
  const text = body === null ? '' : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text,
  } as unknown as Response
}

beforeEach(() => {
  process.env.SPIIDEO_PLAY_EMAIL = 'admin@example.com'
  process.env.SPIIDEO_PLAY_PASSWORD = 'pw'
  process.env.SPIIDEO_ACCOUNT_ID = 'acc-1'
  __testing.clearJwtCache()
})

describe('getSpeedTestById', () => {
  it('returns the specific test we started (not just the newest)', async () => {
    const { fn } = makeFetch({
      '/v2/scenes/network-tests': [
        200,
        { content: [FINISHED_TEST, OLDER_TEST] },
      ],
    })
    const r = await getSpeedTestById('scene-1', OLDER_TEST.id, fn)
    expect(r).toMatchObject({
      state: 'finished',
      connectionQuality: 'poor',
      meanUploadSpeedMbps: 5.5,
    })
  })

  it('returns null when the id is not in the list yet', async () => {
    const { fn } = makeFetch({
      '/v2/scenes/network-tests': [200, { content: [FINISHED_TEST] }],
    })
    expect(await getSpeedTestById('scene-1', 'nope', fn)).toBeNull()
  })

  it('surfaces a terminal error state', async () => {
    const { fn } = makeFetch({
      '/v2/scenes/network-tests': [
        200,
        { content: [{ id: 'e1', timeCreated: 1, state: 'error' }] },
      ],
    })
    const r = await getSpeedTestById('scene-1', 'e1', fn)
    expect(r?.state).toBe('error')
    expect(r?.meanUploadSpeedMbps).toBeNull()
  })
})

describe('getLatestSpeedTest', () => {
  it('maps the newest test and rounds Mbps to 2dp', async () => {
    const { fn } = makeFetch({
      '/v2/scenes/network-tests': [
        200,
        { content: [OLDER_TEST, FINISHED_TEST] },
      ],
    })
    const r = await getLatestSpeedTest('scene-1', fn)
    expect(r).toMatchObject({
      connectionQuality: 'good',
      meanUploadSpeedMbps: 20.32,
    })
  })

  it('returns null when there are no tests yet', async () => {
    const { fn } = makeFetch({
      '/v2/scenes/network-tests': [200, { content: [] }],
    })
    expect(await getLatestSpeedTest('scene-1', fn)).toBeNull()
  })
})

describe('startSceneSpeedTest', () => {
  it('POSTs {sceneId, accountId} and returns the test id', async () => {
    const { fn, lastBodies } = makeFetch({
      '/v2/scenes/network-tests': [201, { id: 'test-99', state: 'created' }],
    })
    const r = await startSceneSpeedTest('scene-1', fn)
    expect(r.id).toBe('test-99')
    expect(lastBodies['/v2/scenes/network-tests']).toEqual({
      sceneId: 'scene-1',
      accountId: 'acc-1',
    })
  })
})

describe('jwt cache', () => {
  it('signs in once across multiple calls', async () => {
    const { fn, signInCalls } = makeFetch({
      '/v2/scenes/network-tests': [200, { content: [] }],
    })
    await getLatestSpeedTest('scene-1', fn)
    await getLatestSpeedTest('scene-1', fn)
    await startSceneSpeedTest('scene-1', fn)
    expect(signInCalls.count).toBe(1)
  })
})

describe('startTestRecording', () => {
  it('creates a session then starts it, tolerating an empty-body record response', async () => {
    const { fn, lastBodies } = makeFetch({
      '/v2/sessions/': [200, null], // PUT .../record → EMPTY body (must not throw)
      '/v2/sessions': [200, { id: 'sess-1' }], // PUT create
    })
    const r = await startTestRecording('scene-1', 'Football Plus', fn)
    expect(r.gameId).toBe('sess-1') // falls back to session id when body empty
    expect(r.state).toBe('recording')
    const createBody = lastBodies['/v2/sessions'] as Record<string, unknown>
    expect(createBody).toMatchObject({
      sceneId: 'scene-1',
      storageTier: 'normal',
      accountId: 'acc-1',
      liveView: false,
    })
    expect(String(createBody.title)).toContain('[PLAYHUB Test] Football Plus')
    const nowMicros = Date.now() * 1000
    expect(Number(createBody.scheduledStopTime)).toBeGreaterThan(nowMicros)
    expect(Number(createBody.scheduledStopTime)).toBeLessThan(
      nowMicros + 5 * 60 * 1000 * 1000
    )
  })
})
