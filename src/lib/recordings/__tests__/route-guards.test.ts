import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../access-control', () => ({ checkRecordingAccess: vi.fn() }))

import {
  hasRecordingAccess,
  timingSafeStrEqual,
  RECORDING_UUID_RE,
} from '../route-guards'
import { checkRecordingAccess } from '../access-control'

const mockAccess = checkRecordingAccess as unknown as ReturnType<typeof vi.fn>
const ID = '11111111-1111-4111-8111-111111111111'
const rec = (over: Record<string, unknown> = {}) => ({
  status: 'published',
  share_token: 'sekret',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockAccess.mockResolvedValue({ hasAccess: false })
})

describe('hasRecordingAccess — the shared access invariant', () => {
  it('false for missing or unpublished rows (no existence oracle)', async () => {
    expect(await hasRecordingAccess(null, ID, 'sekret', null)).toBe(false)
    expect(
      await hasRecordingAccess(rec({ status: 'draft' }), ID, 'sekret', null)
    ).toBe(false)
    expect(mockAccess).not.toHaveBeenCalled()
  })

  it('true on a matching share token WITHOUT calling checkRecordingAccess', async () => {
    expect(await hasRecordingAccess(rec(), ID, 'sekret', null)).toBe(true)
    expect(mockAccess).not.toHaveBeenCalled()
  })

  it('false on a wrong token and no user', async () => {
    expect(await hasRecordingAccess(rec(), ID, 'wrong', null)).toBe(false)
  })

  it('falls back to checkRecordingAccess for an authenticated user', async () => {
    mockAccess.mockResolvedValue({ hasAccess: true })
    expect(await hasRecordingAccess(rec(), ID, null, { id: 'u1' })).toBe(true)
    expect(mockAccess).toHaveBeenCalledWith(ID, 'u1')
    mockAccess.mockResolvedValue({ hasAccess: false })
    expect(await hasRecordingAccess(rec(), ID, null, { id: 'u2' })).toBe(false)
  })
})

describe('timingSafeStrEqual', () => {
  it('true on equal strings, false on unequal / unequal length', () => {
    expect(timingSafeStrEqual('abc', 'abc')).toBe(true)
    expect(timingSafeStrEqual('abc', 'abd')).toBe(false)
    expect(timingSafeStrEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeStrEqual('', '')).toBe(true)
  })
})

describe('RECORDING_UUID_RE', () => {
  it('matches a v4 UUID, rejects junk', () => {
    expect(RECORDING_UUID_RE.test(ID)).toBe(true)
    expect(RECORDING_UUID_RE.test('nope')).toBe(false)
    expect(RECORDING_UUID_RE.test(`${ID} OR 1=1`)).toBe(false)
  })
})
