import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runPoll, configFromEnv, type PollConfig } from '../index'

// Minimal Response-like stub — signIn/authedGet only touch .status/.ok/.json().
function jsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const SCENES_OK = {
  content: [
    {
      id: 'scene-online',
      name: 'Online Scene',
      status: {
        online: true,
        sceneAlertState: 'none',
        cameraCount: 1,
        onlineCameras: 1,
        outtages: 3,
      },
    },
    {
      id: 'scene-offline',
      name: 'Offline Scene',
      status: {
        online: false,
        sceneAlertState: 'attention',
        cameraCount: 2,
        onlineCameras: 0,
        outtages: 0,
      },
    },
  ],
}

// Build a fake fetch keyed by URL substring. Each entry is [status, body].
function fakeFetch(routes: Record<string, [number, unknown]>): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url)
    for (const key of Object.keys(routes)) {
      if (u.includes(key)) return jsonResponse(routes[key][0], routes[key][1])
    }
    return jsonResponse(404, {})
  }) as unknown as typeof fetch
}

const CONFIG: PollConfig = {
  email: 'e@x.com',
  password: 'secret',
  accountId: 'acc-1',
  dryRun: false,
}

const HAPPY_ROUTES: Record<string, [number, unknown]> = {
  '/v1/auth/sign-in': [200, { jwt: 'ey.jwt' }],
  '/v2/scenes': [200, SCENES_OK],
  '/v2/scene-status/overview': [
    200,
    { numberInMaintenance: 1, numberInAttention: 2 },
  ],
}

describe('runPoll — branch behaviour', () => {
  it('happy path: reachable, upserts rows, no alert', async () => {
    const writeRows = vi.fn(async () => {})
    const sendAlert = vi.fn(async () => {})
    const res = await runPoll({
      config: CONFIG,
      fetchImpl: fakeFetch(HAPPY_ROUTES),
      writeRows,
      sendAlert,
    })
    expect(res.statusCode).toBe(200)
    expect(res.metrics).toMatchObject({
      apiReachable: 1,
      contractErrors: 0,
      scenesUpserted: 2,
      scenesOnline: 1,
      scenesOffline: 1,
    })
    expect(writeRows).toHaveBeenCalledOnce()
    expect(writeRows.mock.calls[0][0]).toHaveLength(2)
    expect(sendAlert).not.toHaveBeenCalled()
  })

  it('still writes health when the best-effort overview endpoint fails', async () => {
    const writeRows = vi.fn(async () => {})
    const res = await runPoll({
      config: CONFIG,
      fetchImpl: fakeFetch({
        ...HAPPY_ROUTES,
        '/v2/scene-status/overview': [500, {}], // overview drift/outage
      }),
      writeRows,
      sendAlert: vi.fn(async () => {}),
    })
    expect(res.metrics.apiReachable).toBe(1)
    expect(writeRows).toHaveBeenCalledOnce()
  })

  it('contract drift: ContractErrors=1, no write, API-drift alert, throws', async () => {
    const writeRows = vi.fn(async () => {})
    const sendAlert = vi.fn(async () => {})
    const driftScenes = {
      content: [{ id: 'x', name: 'X', status: { foo: 1 } }],
    }
    await expect(
      runPoll({
        config: CONFIG,
        fetchImpl: fakeFetch({
          ...HAPPY_ROUTES,
          '/v2/scenes': [200, driftScenes],
        }),
        writeRows,
        sendAlert,
      })
    ).rejects.toThrow(/contract failed/)
    expect(writeRows).not.toHaveBeenCalled()
    expect(sendAlert).toHaveBeenCalledOnce()
    expect(sendAlert.mock.calls[0][0]).toMatch(/internal API may have changed/)
  })

  it('network failure: ApiReachable=0, ContractErrors=0, API alert, throws', async () => {
    const sendAlert = vi.fn(async () => {})
    await expect(
      runPoll({
        config: CONFIG,
        fetchImpl: fakeFetch({ ...HAPPY_ROUTES, '/v2/scenes': [500, {}] }),
        writeRows: vi.fn(async () => {}),
        sendAlert,
      })
    ).rejects.toThrow(/HTTP 500/)
    expect(sendAlert.mock.calls[0][0]).toMatch(/internal API may have changed/)
  })

  it('DB failure: API was fine, alert points at the database, throws', async () => {
    const sendAlert = vi.fn(async () => {})
    const writeRows = vi.fn(async () => {
      throw new Error('DB: upsert failed: connection reset')
    })
    await expect(
      runPoll({
        config: CONFIG,
        fetchImpl: fakeFetch(HAPPY_ROUTES),
        writeRows,
        sendAlert,
      })
    ).rejects.toThrow(/upsert failed/)
    expect(sendAlert.mock.calls[0][0]).toMatch(/database write/)
  })
})

describe('configFromEnv', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.SPIIDEO_PLAY_EMAIL
    delete process.env.SPIIDEO_PLAY_PASSWORD
    delete process.env.SPIIDEO_ACCOUNT_ID
    delete process.env.DRY_RUN
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  it('throws a CONFIG-tagged error listing every missing var', () => {
    expect(() => configFromEnv()).toThrow(
      /CONFIG:.*SPIIDEO_PLAY_EMAIL.*SPIIDEO_PLAY_PASSWORD.*SPIIDEO_ACCOUNT_ID/
    )
  })

  it('routes a missing-config run to the configuration alert', async () => {
    const sendAlert = vi.fn(async () => {})
    await expect(runPoll({ sendAlert })).rejects.toThrow(/CONFIG:/)
    expect(sendAlert.mock.calls[0][0]).toMatch(/configuration/)
  })

  it('reads config and dryRun from env when present', () => {
    process.env.SPIIDEO_PLAY_EMAIL = 'e@x.com'
    process.env.SPIIDEO_PLAY_PASSWORD = 'pw'
    process.env.SPIIDEO_ACCOUNT_ID = 'acc-9'
    process.env.DRY_RUN = '1'
    expect(configFromEnv()).toEqual({
      email: 'e@x.com',
      password: 'pw',
      accountId: 'acc-9',
      dryRun: true,
    })
  })
})
