import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the auth module before importing client
vi.mock('../auth', () => {
  const mockApi = vi.fn()
  const mockClose = vi.fn()
  return {
    getVeoSession: vi.fn(async () => ({
      api: mockApi,
      close: mockClose,
    })),
    invalidateTokenCache: vi.fn(),
    // Expose mock for tests to configure
    __mockApi: mockApi,
    __mockClose: mockClose,
  }
})

import { invitePlayer, removeMember, setMatchPrivacy } from '../client'
import { getVeoSession } from '../auth'

// Get the mock api function
function getMockApi() {
  return (getVeoSession as any).__mockApi || vi.fn()
}

// Helper to get the mock from the module
async function getApiMock() {
  const session = await getVeoSession()
  return session.api as ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ============================================================================
// invitePlayer
// ============================================================================

describe('invitePlayer', () => {
  it('should return success when invitation is created (201)', async () => {
    const api = await getApiMock()
    api.mockResolvedValueOnce({
      status: 201,
      body: JSON.stringify({
        invitations: [{ email: 'test@example.com', permission_role: 'viewer' }],
        existing_invitations: [],
      }),
    })

    const result = await invitePlayer('club-slug', 'team-slug', 'test@example.com')

    expect(result.success).toBe(true)
    expect(result.message).toContain('Invitation sent')
    expect(api).toHaveBeenCalledWith(
      'POST',
      '/api/app/clubs/club-slug/teams/team-slug/addressed-invitations/',
      { invitations: [{ email: 'test@example.com', permission_role: 'viewer' }] }
    )
  })

  it('should return success when email already has pending invitation (200)', async () => {
    const api = await getApiMock()
    api.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({
        invitations: [],
        existing_invitations: [{ email: 'test@example.com' }],
      }),
    })

    const result = await invitePlayer('club-slug', 'team-slug', 'test@example.com')

    expect(result.success).toBe(true)
    expect(result.message).toContain('already has a pending invitation')
  })

  it('should return failure on 403', async () => {
    const api = await getApiMock()
    api.mockResolvedValueOnce({
      status: 403,
      body: JSON.stringify({ detail: 'Permission denied' }),
    })

    const result = await invitePlayer('club-slug', 'team-slug', 'test@example.com')

    expect(result.success).toBe(false)
    expect(result.message).toContain('Failed to invite')
  })
})

// ============================================================================
// removeMember
// ============================================================================

describe('removeMember', () => {
  it('should remove an active member found by email', async () => {
    const api = await getApiMock()

    // GET active members - returns member
    api.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify([
        { id: 'member-123', email: 'player@example.com', name: 'Player', status: 'active', permission_role: 'viewer' },
      ]),
    })

    // DELETE member - success
    api.mockResolvedValueOnce({ status: 204, body: '' })

    const result = await removeMember('club-slug', 'team-slug', 'player@example.com')

    expect(result.success).toBe(true)
    expect(result.message).toContain('Removed')
    expect(result.data).toEqual({ memberId: 'member-123' })
  })

  it('should revoke invitation if member not found in active list', async () => {
    const api = await getApiMock()

    // GET active members - empty
    api.mockResolvedValueOnce({ status: 200, body: JSON.stringify([]) })

    // GET all members - empty
    api.mockResolvedValueOnce({ status: 200, body: JSON.stringify([]) })

    // GET invitations - found
    api.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify([
        { id: 'inv-456', public_identifier: 'inv-456', email: 'player@example.com' },
      ]),
    })

    // DELETE invitation - success
    api.mockResolvedValueOnce({ status: 204, body: '' })

    const result = await removeMember('club-slug', 'team-slug', 'player@example.com')

    expect(result.success).toBe(true)
    expect(result.message).toContain('Revoked invitation')
  })

  it('should return failure when member not found anywhere', async () => {
    const api = await getApiMock()

    // GET active members - empty
    api.mockResolvedValueOnce({ status: 200, body: JSON.stringify([]) })
    // GET all members - empty
    api.mockResolvedValueOnce({ status: 200, body: JSON.stringify([]) })
    // GET invitations - empty
    api.mockResolvedValueOnce({ status: 200, body: JSON.stringify([]) })
    // GET addressed-invitations - empty
    api.mockResolvedValueOnce({ status: 200, body: JSON.stringify([]) })

    const result = await removeMember('club-slug', 'team-slug', 'unknown@example.com')

    expect(result.success).toBe(false)
    expect(result.message).toContain('not found')
  })

  it('should handle case-insensitive email matching', async () => {
    const api = await getApiMock()

    api.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify([
        { id: 'member-789', email: 'Player@Example.COM', name: 'Player', status: 'active', permission_role: 'viewer' },
      ]),
    })
    api.mockResolvedValueOnce({ status: 204, body: '' })

    const result = await removeMember('club-slug', 'team-slug', 'player@example.com')

    expect(result.success).toBe(true)
  })
})

// ============================================================================
// setMatchPrivacy
// ============================================================================

describe('setMatchPrivacy', () => {
  it('should set privacy to private successfully', async () => {
    const api = await getApiMock()
    api.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ privacy: 'private', title: 'Test Match' }),
    })

    const result = await setMatchPrivacy('match-slug-123', 'private')

    expect(result.success).toBe(true)
    expect(result.message).toContain('private')
    expect(api).toHaveBeenCalledWith(
      'PATCH',
      '/api/app/matches/match-slug-123/',
      { privacy: 'private' }
    )
  })

  it('should set privacy to public successfully', async () => {
    const api = await getApiMock()
    api.mockResolvedValueOnce({
      status: 200,
      body: JSON.stringify({ privacy: 'public', title: 'Test Match' }),
    })

    const result = await setMatchPrivacy('match-slug-123', 'public')

    expect(result.success).toBe(true)
    expect(result.message).toContain('public')
  })

  it('should return failure on 400', async () => {
    const api = await getApiMock()
    api.mockResolvedValueOnce({
      status: 400,
      body: JSON.stringify({ detail: 'Bad request' }),
    })

    const result = await setMatchPrivacy('bad-slug', 'private')

    expect(result.success).toBe(false)
    expect(result.message).toContain('Failed to set privacy')
  })
})
