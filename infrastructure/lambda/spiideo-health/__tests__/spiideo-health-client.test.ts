import { describe, it, expect } from 'vitest'
import {
  validateContract,
  mapSceneToRow,
  microsToIso,
  type SpiideoSceneWithStatus,
} from '../spiideo-health-client'

// Fixtures taken verbatim from real api.spiideo.com responses (2026-07-01).
const DEAD_PORTABLE: SpiideoSceneWithStatus = {
  id: 'bd0a47fa-49df-4721-9fc6-0492052a3275',
  name: 'Dead Portable Smartcam',
  availableForRecording: true,
  status: {
    sceneAlertState: 'attention',
    online: false,
    lastOnlineChange: 1761851222962677,
    outtages: 0,
    cameraCount: 1,
    onlineCameras: 0,
  },
}
const FOOTBALL_PLUS: SpiideoSceneWithStatus = {
  id: 'b3595080-25db-4d2f-a1ab-ccfb9eabda4f',
  name: 'Football Plus',
  availableForRecording: true,
  status: {
    sceneAlertState: 'none',
    online: true,
    lastOnlineChange: 1782908415357148,
    outtages: 19,
    cameraCount: 1,
    onlineCameras: 1,
  },
}
const GOOD_SCENES = { content: [DEAD_PORTABLE, FOOTBALL_PLUS] }

describe('validateContract', () => {
  it('passes on the real payload shape', () => {
    const r = validateContract({
      signInStatus: 200,
      jwt: 'ey.jwt.token',
      scenes: GOOD_SCENES,
    })
    expect(r.ok).toBe(true)
    expect(r.failures).toEqual([])
  })

  it('fails when sign-in is not 200', () => {
    const r = validateContract({
      signInStatus: 403,
      jwt: 'ey.jwt',
      scenes: GOOD_SCENES,
    })
    expect(r.ok).toBe(false)
    expect(r.failures.join()).toMatch(/HTTP 403/)
  })

  it('fails when jwt is missing (auth shape changed)', () => {
    const r = validateContract({
      signInStatus: 200,
      jwt: null,
      scenes: GOOD_SCENES,
    })
    expect(r.ok).toBe(false)
    expect(r.failures.join()).toMatch(/jwt/)
  })

  it('does NOT couple overview shape to the contract (overview is best-effort)', () => {
    // Overview is intentionally not part of the contract — it is not persisted,
    // so its shape must never block writing scene health.
    const r = validateContract({
      signInStatus: 200,
      jwt: 'ey.jwt',
      scenes: GOOD_SCENES,
    })
    expect(r.ok).toBe(true)
  })

  it('fails when scenes.content is not an array', () => {
    const r = validateContract({
      signInStatus: 200,
      jwt: 'ey.jwt',
      scenes: {} as never,
    })
    expect(r.ok).toBe(false)
    expect(r.failures.join()).toMatch(/content/)
  })

  it('fails when a scene is missing its id (upsert conflict target)', () => {
    const r = validateContract({
      signInStatus: 200,
      jwt: 'ey.jwt',
      scenes: {
        content: [
          DEAD_PORTABLE,
          { name: 'no id', status: DEAD_PORTABLE.status },
        ] as never,
      },
    })
    expect(r.ok).toBe(false)
    expect(r.failures.join()).toMatch(/id/)
  })

  it('fails when scene.status drops online/sceneAlertState', () => {
    const r = validateContract({
      signInStatus: 200,
      jwt: 'ey.jwt',
      scenes: {
        content: [{ id: 'x', name: 'X', status: { foo: 1 } }] as never,
      },
    })
    expect(r.ok).toBe(false)
    expect(r.failures.join()).toMatch(/scene.status shape/)
  })

  it('does NOT fail on a legitimately empty scene list', () => {
    const r = validateContract({
      signInStatus: 200,
      jwt: 'ey.jwt',
      scenes: { content: [] },
    })
    expect(r.ok).toBe(true)
  })
})

describe('mapSceneToRow', () => {
  const CHECKED = '2026-07-01T12:00:00.000Z'

  it('maps an offline scene correctly', () => {
    const row = mapSceneToRow(DEAD_PORTABLE, 'acc-1', CHECKED)
    expect(row).toMatchObject({
      scene_id: 'bd0a47fa-49df-4721-9fc6-0492052a3275',
      scene_name: 'Dead Portable Smartcam',
      account_id: 'acc-1',
      organization_id: null,
      online: false,
      alert_state: 'attention',
      available_for_recording: true,
      camera_count: 1,
      online_cameras: 0,
      outages: 0,
      last_checked_at: CHECKED,
    })
    // microseconds → ISO (rounded to nearest ms)
    expect(row.last_online_change).toBe(
      new Date(Math.round(1761851222962677 / 1000)).toISOString()
    )
    // raw status preserved for future fields
    expect(row.status_raw).toEqual(DEAD_PORTABLE.status)
  })

  it('maps an online scene with outages', () => {
    const row = mapSceneToRow(FOOTBALL_PLUS, 'acc-1', CHECKED)
    expect(row.online).toBe(true)
    expect(row.alert_state).toBe('none')
    expect(row.online_cameras).toBe(1)
    expect(row.outages).toBe(19)
  })

  it('never throws on a scene missing its status object', () => {
    const row = mapSceneToRow({ id: 'z', name: 'Z' }, 'acc-1', CHECKED)
    expect(row.online).toBeNull()
    expect(row.alert_state).toBeNull()
    expect(row.camera_count).toBeNull()
    expect(row.last_online_change).toBeNull()
    expect(row.status_raw).toBeNull()
  })
})

describe('microsToIso', () => {
  it('converts microseconds since epoch to ISO', () => {
    expect(microsToIso(1761851222962677)).toBe(
      new Date(Math.round(1761851222962677 / 1000)).toISOString()
    )
  })
  it('returns null for non-finite / non-number input', () => {
    expect(microsToIso(undefined)).toBeNull()
    expect(microsToIso(null)).toBeNull()
    expect(microsToIso(NaN)).toBeNull()
    expect(microsToIso('nope')).toBeNull()
  })
})
