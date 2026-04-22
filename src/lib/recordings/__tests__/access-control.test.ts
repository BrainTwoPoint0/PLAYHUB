import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockIsPlatformAdmin, mockServiceFrom } = vi.hoisted(() => ({
  mockIsPlatformAdmin: vi.fn(),
  mockServiceFrom: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: (...args: any[]) => mockServiceFrom(...args),
  }),
}))

vi.mock('@/lib/admin/auth', () => ({
  isPlatformAdmin: (...args: any[]) => mockIsPlatformAdmin(...args),
}))

import { isVenueAdmin, getManagedVenues } from '@/lib/recordings/access-control'

function chain(result: { data: any; error?: any }) {
  const c: any = {}
  c.select = vi.fn().mockReturnValue(c)
  c.eq = vi.fn().mockReturnValue(c)
  c.in = vi.fn().mockReturnValue(c)
  c.single = vi.fn().mockResolvedValue(result)
  c.then = (resolve: any) => resolve(result)
  return c
}

beforeEach(() => {
  mockIsPlatformAdmin.mockReset()
  mockServiceFrom.mockReset()
})

describe('isVenueAdmin', () => {
  it('returns true when user is a platform admin, without consulting membership tables', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true)

    const result = await isVenueAdmin('user-1', 'org-1')

    expect(result).toBe(true)
    expect(mockIsPlatformAdmin).toHaveBeenCalledWith('user-1')
    expect(mockServiceFrom).not.toHaveBeenCalled()
  })

  it('returns false when user is not a platform admin and has no profile', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false)
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: null })
      throw new Error(`unexpected table ${table}`)
    })

    const result = await isVenueAdmin('user-2', 'org-2')

    expect(result).toBe(false)
  })

  it('returns true when user has direct admin membership', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false)
    const calls: string[] = []
    mockServiceFrom.mockImplementation((table: string) => {
      calls.push(table)
      if (table === 'profiles') return chain({ data: { id: 'profile-1' } })
      if (table === 'organization_members')
        return chain({ data: { role: 'admin' } })
      throw new Error(`unexpected table ${table}`)
    })

    const result = await isVenueAdmin('user-3', 'org-3')

    expect(result).toBe(true)
    expect(calls).toContain('organization_members')
  })

  it('falls through to parent-org admin when direct membership is missing', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false)
    const orgResponses: Record<string, any> = {
      profiles: chain({ data: { id: 'profile-2' } }),
      organization_members_direct: chain({ data: null }),
      organizations: chain({ data: { parent_organization_id: 'parent-1' } }),
      organization_members_parent: chain({ data: { role: 'manager' } }),
    }
    let memberCall = 0
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return orgResponses.profiles
      if (table === 'organization_members') {
        memberCall += 1
        return memberCall === 1
          ? orgResponses.organization_members_direct
          : orgResponses.organization_members_parent
      }
      if (table === 'organizations') return orgResponses.organizations
      throw new Error(`unexpected table ${table}`)
    })

    const result = await isVenueAdmin('user-4', 'child-org')

    expect(result).toBe(true)
  })
})

describe('getManagedVenues', () => {
  it('returns all active venues when caller is a platform admin', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true)
    const all = [
      { id: 'v1', name: 'Venue One', slug: 'v1', logo_url: null },
      { id: 'v2', name: 'Venue Two', slug: 'v2', logo_url: null },
    ]
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'organizations') return chain({ data: all })
      throw new Error(`unexpected table ${table}`)
    })

    const result = await getManagedVenues('admin-user')

    expect(result).toEqual(all)
    expect(mockServiceFrom).toHaveBeenCalledWith('organizations')
  })

  it('returns empty array when non-admin has no profile', async () => {
    mockIsPlatformAdmin.mockResolvedValue(false)
    mockServiceFrom.mockImplementation((table: string) => {
      if (table === 'profiles') return chain({ data: null })
      throw new Error(`unexpected table ${table}`)
    })

    const result = await getManagedVenues('no-profile')

    expect(result).toEqual([])
  })
})
