// Veo ClubHouse API Client
// Typed functions for each Veo operation
// Uses the auth module for authenticated API calls

import { getVeoSession, type VeoSession } from './auth'

// ============================================================================
// Types
// ============================================================================

export interface VeoResult<T = unknown> {
  success: boolean
  message: string
  data?: T
}

export interface VeoClub {
  id: string
  slug: string
  name: string
  team_count: number
  is_club_admin: boolean
}

export interface VeoTeam {
  id: string
  slug: string
  name: string
  member_count: number
}

export interface VeoMember {
  id: string
  email: string
  name: string
  status: string
  permission_role: string
}

export interface VeoRecording {
  slug: string
  title: string
  duration: number
  privacy: string
  thumbnail: string
}

export interface VeoInvitation {
  id?: string
  public_identifier?: string
  email?: string
}

// ============================================================================
// Helper: run an operation within a Veo session
// ============================================================================

async function withSession<T>(
  fn: (session: VeoSession) => Promise<T>
): Promise<T> {
  const session = await getVeoSession()
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

function parseBody(body: string): any {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

// ============================================================================
// Core Operations
// ============================================================================

/**
 * Invite a player to a Veo team by email
 */
export async function invitePlayer(
  clubSlug: string,
  teamSlug: string,
  email: string
): Promise<VeoResult> {
  return withSession(async (session) => {
    const res = await session.api(
      'POST',
      `/api/app/clubs/${clubSlug}/teams/${teamSlug}/addressed-invitations/`,
      {
        invitations: [{ email, permission_role: 'viewer' }],
      }
    )

    const data = parseBody(res.body)

    if (res.status === 201) {
      return {
        success: true,
        message: `Invitation sent to ${email}`,
        data,
      }
    }

    if (res.status === 200 && data?.existing_invitations?.length > 0) {
      return {
        success: true,
        message: `${email} already has a pending invitation`,
        data,
      }
    }

    return {
      success: false,
      message: `Failed to invite ${email}: ${res.status} - ${res.body.substring(0, 200)}`,
    }
  })
}

/**
 * Remove a member from a Veo team by email.
 * Checks active members first, then pending invitations.
 */
export async function removeMember(
  clubSlug: string,
  teamSlug: string,
  email: string
): Promise<VeoResult> {
  return withSession(async (session) => {
    const basePath = `/api/app/clubs/${clubSlug}/teams/${teamSlug}`

    // Step 1: Check active members
    const membersRes = await session.api(
      'GET',
      `${basePath}/members/?status=active`
    )
    if (membersRes.status === 200) {
      const members: VeoMember[] = parseBody(membersRes.body) || []
      const member = members.find(
        (m) => m.email?.toLowerCase() === email.toLowerCase()
      )

      if (member) {
        const deleteRes = await session.api(
          'DELETE',
          `${basePath}/members/${member.id}/`
        )
        if (deleteRes.status === 204 || deleteRes.status === 200) {
          return {
            success: true,
            message: `Removed ${email} from team`,
            data: { memberId: member.id },
          }
        }
        return {
          success: false,
          message: `Failed to delete member ${member.id}: ${deleteRes.status}`,
        }
      }
    }

    // Step 2: Check all members (may include non-active)
    const allMembersRes = await session.api('GET', `${basePath}/members/`)
    if (allMembersRes.status === 200) {
      const allMembers: VeoMember[] = parseBody(allMembersRes.body) || []
      const member = allMembers.find(
        (m) => m.email?.toLowerCase() === email.toLowerCase()
      )

      if (member) {
        const deleteRes = await session.api(
          'DELETE',
          `${basePath}/members/${member.id}/`
        )
        if (deleteRes.status === 204 || deleteRes.status === 200) {
          return {
            success: true,
            message: `Removed ${email} from team (status: ${member.status})`,
            data: { memberId: member.id },
          }
        }
        return {
          success: false,
          message: `Failed to delete member ${member.id}: ${deleteRes.status}`,
        }
      }
    }

    // Step 3: Check pending invitations
    const invRes = await session.api('GET', `${basePath}/invitations/`)
    if (invRes.status === 200) {
      const invitations: VeoInvitation[] = parseBody(invRes.body) || []
      const invitation = invitations.find((i) =>
        JSON.stringify(i).toLowerCase().includes(email.toLowerCase())
      )

      if (invitation) {
        const invId = invitation.public_identifier || invitation.id
        const deleteRes = await session.api(
          'DELETE',
          `${basePath}/invitations/${invId}/`
        )
        if (deleteRes.status === 204 || deleteRes.status === 200) {
          return {
            success: true,
            message: `Revoked invitation for ${email}`,
            data: { invitationId: invId },
          }
        }
        return {
          success: false,
          message: `Failed to revoke invitation ${invId}: ${deleteRes.status}`,
        }
      }
    }

    // Step 4: Check addressed invitations
    const addrInvRes = await session.api(
      'GET',
      `${basePath}/addressed-invitations/`
    )
    if (addrInvRes.status === 200) {
      const invitations: VeoInvitation[] = parseBody(addrInvRes.body) || []
      const invitation = invitations.find((i) =>
        JSON.stringify(i).toLowerCase().includes(email.toLowerCase())
      )

      if (invitation) {
        const invId = invitation.public_identifier || invitation.id
        const deleteRes = await session.api(
          'DELETE',
          `${basePath}/addressed-invitations/${invId}/`
        )
        if (deleteRes.status === 204 || deleteRes.status === 200) {
          return {
            success: true,
            message: `Revoked addressed invitation for ${email}`,
            data: { invitationId: invId },
          }
        }
        return {
          success: false,
          message: `Failed to revoke addressed invitation ${invId}: ${deleteRes.status}`,
        }
      }
    }

    return {
      success: false,
      message: `${email} not found in team members or invitations`,
    }
  })
}

/**
 * Set the privacy of a Veo match
 */
export async function setMatchPrivacy(
  matchSlug: string,
  privacy: 'public' | 'private'
): Promise<VeoResult> {
  return withSession(async (session) => {
    const res = await session.api('PATCH', `/api/app/matches/${matchSlug}/`, {
      privacy,
    })

    const data = parseBody(res.body)

    if (res.status === 200) {
      return {
        success: true,
        message: `Match privacy set to "${privacy}"`,
        data,
      }
    }

    return {
      success: false,
      message: `Failed to set privacy: ${res.status} - ${res.body.substring(0, 200)}`,
    }
  })
}

// ============================================================================
// Utility Operations
// ============================================================================

/**
 * List all clubs and their teams
 */
export async function listClubsAndTeams(): Promise<
  VeoResult<{ clubs: (VeoClub & { teams: VeoTeam[] })[] }>
> {
  return withSession(async (session) => {
    const clubsRes = await session.api(
      'GET',
      `/api/app/clubs/?filter=own&fields=crest&fields=slug&fields=name&fields=url&fields=is_club_admin&fields=team_count&fields=id&fields=support_id&page_size=500`
    )

    if (clubsRes.status !== 200) {
      return {
        success: false,
        message: `Failed to list clubs: ${clubsRes.status}`,
      }
    }

    const clubs: VeoClub[] = parseBody(clubsRes.body) || []
    const result: (VeoClub & { teams: VeoTeam[] })[] = []

    for (const club of clubs) {
      let teams: VeoTeam[] = []
      if (club.team_count > 0) {
        const teamsRes = await session.api(
          'GET',
          `/api/app/clubs/${club.slug}/teams/`
        )
        if (teamsRes.status === 200) {
          teams = parseBody(teamsRes.body) || []
        }
      }
      result.push({ ...club, teams })
    }

    return {
      success: true,
      message: `Found ${clubs.length} clubs`,
      data: { clubs: result },
    }
  })
}

/**
 * List recordings for a club
 */
export async function listRecordings(
  clubSlug: string
): Promise<VeoResult<{ recordings: VeoRecording[] }>> {
  return withSession(async (session) => {
    const res = await session.api(
      'GET',
      `/api/app/clubs/${clubSlug}/recordings/?filter=own&fields=privacy&fields=title&fields=slug&fields=duration&fields=thumbnail&page_size=50`
    )

    if (res.status !== 200) {
      return {
        success: false,
        message: `Failed to list recordings: ${res.status}`,
      }
    }

    const recordings: VeoRecording[] = parseBody(res.body) || []
    return {
      success: true,
      message: `Found ${recordings.length} recordings`,
      data: { recordings },
    }
  })
}

/**
 * List team members
 */
export async function listTeamMembers(
  clubSlug: string,
  teamSlug: string
): Promise<VeoResult<{ members: VeoMember[] }>> {
  return withSession(async (session) => {
    const res = await session.api(
      'GET',
      `/api/app/clubs/${clubSlug}/teams/${teamSlug}/members/?status=active&page_size=500`
    )

    if (res.status !== 200) {
      return {
        success: false,
        message: `Failed to list members: ${res.status}`,
      }
    }

    const members: VeoMember[] = parseBody(res.body) || []
    return {
      success: true,
      message: `Found ${members.length} members`,
      data: { members },
    }
  })
}

/**
 * List all teams and their members for a single club (single session)
 */
export async function listClubTeamsWithMembers(
  clubSlug: string
): Promise<
  VeoResult<{ clubName: string; teams: (VeoTeam & { members: VeoMember[] })[] }>
> {
  return withSession(async (session) => {
    // Fetch teams
    const teamsRes = await session.api(
      'GET',
      `/api/app/clubs/${clubSlug}/teams/`
    )

    if (teamsRes.status !== 200) {
      return {
        success: false,
        message: `Failed to list teams: ${teamsRes.status}`,
      }
    }

    const teams: VeoTeam[] = parseBody(teamsRes.body) || []
    const result: (VeoTeam & { members: VeoMember[] })[] = []

    // Fetch members for each team within the same session
    for (const team of teams) {
      const membersRes = await session.api(
        'GET',
        `/api/app/clubs/${clubSlug}/teams/${team.slug}/members/?status=active&page_size=500`
      )
      const members: VeoMember[] =
        membersRes.status === 200 ? parseBody(membersRes.body) || [] : []
      result.push({ ...team, members })
    }

    return {
      success: true,
      message: `Found ${teams.length} teams`,
      data: { clubName: clubSlug, teams: result },
    }
  })
}

// ============================================================================
// Export Client Object
// ============================================================================

export const veoClient = {
  invitePlayer,
  removeMember,
  setMatchPrivacy,
  listClubsAndTeams,
  listRecordings,
  listTeamMembers,
}
