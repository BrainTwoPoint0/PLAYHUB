// Veo Clubhouse sync — matching and filtering logic
// Extracted so it can be tested independently of the HTTP route

import type { VeoMember, VeoTeam } from './client'
import type { AcademySubscriber } from '@/lib/academy/stripe'

export interface RemovableEntry {
  email: string
  name: string
  teamSlug: string
  teamName: string
}

export interface ExceptedEntry {
  email: string
  name: string
  teamSlug: string
}

export interface SyncResult {
  removable: RemovableEntry[]
  excepted: ExceptedEntry[]
  stats: {
    totalVeoMembers: number
    totalSubscribers: number
    removableCount: number
    exceptedCount: number
  }
}

/**
 * Determine which Veo members should be removed based on Stripe subscription status.
 * Returns removable members (canceled, non-scholarship, non-excepted) and excepted ones.
 */
export function findRemovableMembers(
  teams: (VeoTeam & { members: VeoMember[] })[],
  subscribers: AcademySubscriber[],
  exceptionEmails: Set<string>
): SyncResult {
  // Build email → best subscriber status lookup
  const statusPriority: Record<string, number> = {
    active: 0,
    trialing: 1,
    past_due: 2,
    canceled: 3,
  }
  const subsByEmail = new Map<
    string,
    { status: string; isScholarship: boolean }
  >()
  for (const sub of subscribers) {
    if (sub.customerEmail) {
      const email = sub.customerEmail.toLowerCase()
      const existing = subsByEmail.get(email)
      if (
        !existing ||
        (statusPriority[sub.status] ?? 9) <
          (statusPriority[existing.status] ?? 9)
      ) {
        subsByEmail.set(email, {
          status: sub.status,
          isScholarship: sub.isScholarship,
        })
      }
    }
  }

  const playerRoles = new Set(['viewer'])
  const removable: RemovableEntry[] = []
  const excepted: ExceptedEntry[] = []

  for (const team of teams) {
    for (const member of team.members) {
      if (!member.email) continue
      const email = member.email.toLowerCase()
      const isPlayer = playerRoles.has(member.permission_role)
      if (!isPlayer) continue

      const stripeSub = subsByEmail.get(email)
      if (!stripeSub) continue
      if (stripeSub.status !== 'canceled') continue
      if (stripeSub.isScholarship) continue

      if (exceptionEmails.has(email)) {
        excepted.push({ email, name: member.name, teamSlug: team.slug })
        continue
      }

      removable.push({
        email,
        name: member.name,
        teamSlug: team.slug,
        teamName: team.name,
      })
    }
  }

  return {
    removable,
    excepted,
    stats: {
      totalVeoMembers: teams.reduce((sum, t) => sum + t.members.length, 0),
      totalSubscribers: subscribers.length,
      removableCount: removable.length,
      exceptedCount: excepted.length,
    },
  }
}
