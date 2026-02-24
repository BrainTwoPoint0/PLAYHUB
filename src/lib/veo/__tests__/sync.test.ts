import { describe, it, expect } from 'vitest'
import { findRemovableMembers } from '../sync'
import type { VeoMember, VeoTeam } from '../client'
import type { AcademySubscriber } from '@/lib/academy/stripe'

// Helper to build a minimal VeoMember
function member(overrides: Partial<VeoMember> & { email: string }): VeoMember {
  return {
    id: overrides.id || overrides.email,
    name: overrides.name || overrides.email.split('@')[0],
    status: 'active',
    permission_role: overrides.permission_role || 'viewer',
    ...overrides,
  }
}

// Helper to build a minimal team with members
function team(
  slug: string,
  name: string,
  members: VeoMember[]
): VeoTeam & { members: VeoMember[] } {
  return { id: slug, slug, name, member_count: members.length, members }
}

// Helper to build a minimal AcademySubscriber
function sub(
  email: string,
  status: string,
  isScholarship = false
): AcademySubscriber {
  return {
    subscriptionId: `sub_${email}`,
    customerEmail: email,
    customerName: null,
    teamName: 'test',
    registrationTeam: null,
    subscriberType: null,
    isScholarship,
    additionalTeams: null,
    status,
    amount: 2000,
    currency: 'gbp',
    interval: 'month',
    currentPeriodStart: '2025-01-01T00:00:00Z',
    currentPeriodEnd: '2025-02-01T00:00:00Z',
    canceledAt: status === 'canceled' ? '2025-01-15T00:00:00Z' : null,
    createdAt: '2024-06-01T00:00:00Z',
  }
}

describe('findRemovableMembers', () => {
  it('marks canceled players as removable', () => {
    const teams = [
      team('team-a', 'Team A', [member({ email: 'alice@test.com' })]),
    ]
    const subscribers = [sub('alice@test.com', 'canceled')]

    const result = findRemovableMembers(teams, subscribers, new Set())

    expect(result.removable).toHaveLength(1)
    expect(result.removable[0].email).toBe('alice@test.com')
    expect(result.excepted).toHaveLength(0)
  })

  it('does NOT mark active subscribers as removable', () => {
    const teams = [
      team('team-a', 'Team A', [member({ email: 'active@test.com' })]),
    ]
    const subscribers = [sub('active@test.com', 'active')]

    const result = findRemovableMembers(teams, subscribers, new Set())

    expect(result.removable).toHaveLength(0)
  })

  it('does NOT mark scholarship users as removable even if canceled', () => {
    const teams = [
      team('team-a', 'Team A', [member({ email: 'scholar@test.com' })]),
    ]
    const subscribers = [sub('scholar@test.com', 'canceled', true)]

    const result = findRemovableMembers(teams, subscribers, new Set())

    expect(result.removable).toHaveLength(0)
  })

  it('moves excepted users to excepted list instead of removable', () => {
    const teams = [
      team('team-a', 'Team A', [member({ email: 'excepted@test.com' })]),
    ]
    const subscribers = [sub('excepted@test.com', 'canceled')]
    const exceptions = new Set(['excepted@test.com'])

    const result = findRemovableMembers(teams, subscribers, exceptions)

    expect(result.removable).toHaveLength(0)
    expect(result.excepted).toHaveLength(1)
    expect(result.excepted[0].email).toBe('excepted@test.com')
  })

  it('does NOT mark staff (non-viewer roles) as removable', () => {
    const teams = [
      team('team-a', 'Team A', [
        member({ email: 'coach@test.com', permission_role: 'coach' }),
      ]),
    ]
    const subscribers = [sub('coach@test.com', 'canceled')]

    const result = findRemovableMembers(teams, subscribers, new Set())

    expect(result.removable).toHaveLength(0)
  })

  it('skips members with no Stripe subscription record', () => {
    const teams = [
      team('team-a', 'Team A', [member({ email: 'unknown@test.com' })]),
    ]

    const result = findRemovableMembers(teams, [], new Set())

    expect(result.removable).toHaveLength(0)
  })

  it('uses best status when subscriber has multiple entries', () => {
    const teams = [
      team('team-a', 'Team A', [member({ email: 'multi@test.com' })]),
    ]
    // Same email with both active and canceled — active should win
    const subscribers = [
      sub('multi@test.com', 'canceled'),
      sub('multi@test.com', 'active'),
    ]

    const result = findRemovableMembers(teams, subscribers, new Set())

    expect(result.removable).toHaveLength(0) // active wins, so not removable
  })

  it('handles case-insensitive email matching', () => {
    const teams = [
      team('team-a', 'Team A', [member({ email: 'Alice@Test.COM' })]),
    ]
    const subscribers = [sub('alice@test.com', 'canceled')]

    const result = findRemovableMembers(teams, subscribers, new Set())

    expect(result.removable).toHaveLength(1)
  })

  it('handles members across multiple teams', () => {
    const teams = [
      team('team-a', 'Team A', [
        member({ email: 'alice@test.com' }),
        member({ email: 'bob@test.com' }),
      ]),
      team('team-b', 'Team B', [member({ email: 'charlie@test.com' })]),
    ]
    const subscribers = [
      sub('alice@test.com', 'canceled'),
      sub('bob@test.com', 'active'),
      sub('charlie@test.com', 'canceled'),
    ]

    const result = findRemovableMembers(teams, subscribers, new Set())

    expect(result.removable).toHaveLength(2)
    expect(result.removable.map((r) => r.email).sort()).toEqual([
      'alice@test.com',
      'charlie@test.com',
    ])
    expect(result.stats.totalVeoMembers).toBe(3)
    expect(result.stats.totalSubscribers).toBe(3)
  })

  it('returns correct stats', () => {
    const teams = [
      team('team-a', 'Team A', [
        member({ email: 'a@t.com' }),
        member({ email: 'b@t.com' }),
        member({ email: 'c@t.com' }),
        member({ email: 'd@t.com', permission_role: 'coach' }),
      ]),
    ]
    const subscribers = [
      sub('a@t.com', 'canceled'),
      sub('b@t.com', 'active'),
      sub('c@t.com', 'canceled'),
    ]
    const exceptions = new Set(['c@t.com'])

    const result = findRemovableMembers(teams, subscribers, exceptions)

    expect(result.stats).toEqual({
      totalVeoMembers: 4,
      totalSubscribers: 3,
      removableCount: 1,
      exceptedCount: 1,
    })
  })
})
