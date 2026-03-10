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
  uuid?: string
  match_date?: string
  home_team?: string | null
  away_team?: string | null
  home_score?: number | null
  away_score?: number | null
  processing_status?: string
}

export interface VeoVideo {
  id: string
  url: string
  type?: string
  width?: number
  height?: number
}

export interface VeoHighlight {
  id: string
  start: number
  duration: number
  tags: string[]
  team_association?: string
  thumbnail?: string
  videos?: VeoVideo[]
  is_ai_generated?: boolean
}

export interface VeoMatchStats {
  [key: string]: unknown
}

export interface MatchContent {
  videos: VeoVideo[]
  highlights: VeoHighlight[]
  stats: VeoMatchStats | null
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
      `/api/app/clubs/${clubSlug}/recordings/?filter=own&fields=privacy&fields=title&fields=slug&fields=duration&fields=thumbnail&fields=uuid&fields=match_date&fields=home_team&fields=away_team&fields=home_score&fields=away_score&fields=processing_status&page_size=50`
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

/**
 * Remove multiple members from Veo teams using a SINGLE browser session.
 * This is much faster than calling removeMember() N times (which creates N sessions).
 */
export async function removeMembersInBulk(
  clubSlug: string,
  targets: { email: string; teamSlug: string }[]
): Promise<
  { email: string; teamSlug: string; success: boolean; message: string }[]
> {
  if (targets.length === 0) return []

  return withSession(async (session) => {
    const results: {
      email: string
      teamSlug: string
      success: boolean
      message: string
    }[] = []

    for (const target of targets) {
      const basePath = `/api/app/clubs/${clubSlug}/teams/${target.teamSlug}`
      let removed = false

      // Step 1: Check active members
      const membersRes = await session.api(
        'GET',
        `${basePath}/members/?status=active`
      )
      if (membersRes.status === 200) {
        const members: VeoMember[] = parseBody(membersRes.body) || []
        const member = members.find(
          (m) => m.email?.toLowerCase() === target.email.toLowerCase()
        )
        if (member) {
          const deleteRes = await session.api(
            'DELETE',
            `${basePath}/members/${member.id}/`
          )
          if (deleteRes.status === 204 || deleteRes.status === 200) {
            results.push({
              ...target,
              success: true,
              message: `Removed ${target.email} from team`,
            })
            removed = true
          } else {
            results.push({
              ...target,
              success: false,
              message: `Failed to delete member ${member.id}: ${deleteRes.status}`,
            })
            removed = true // attempted
          }
        }
      }

      if (removed) continue

      // Step 2: Check all members (may include non-active)
      const allMembersRes = await session.api('GET', `${basePath}/members/`)
      if (allMembersRes.status === 200) {
        const allMembers: VeoMember[] = parseBody(allMembersRes.body) || []
        const member = allMembers.find(
          (m) => m.email?.toLowerCase() === target.email.toLowerCase()
        )
        if (member) {
          const deleteRes = await session.api(
            'DELETE',
            `${basePath}/members/${member.id}/`
          )
          if (deleteRes.status === 204 || deleteRes.status === 200) {
            results.push({
              ...target,
              success: true,
              message: `Removed ${target.email} from team (status: ${member.status})`,
            })
          } else {
            results.push({
              ...target,
              success: false,
              message: `Failed to delete member ${member.id}: ${deleteRes.status}`,
            })
          }
          continue
        }
      }

      // Step 3: Check pending invitations
      const invRes = await session.api('GET', `${basePath}/invitations/`)
      if (invRes.status === 200) {
        const invitations: VeoInvitation[] = parseBody(invRes.body) || []
        const invitation = invitations.find((i) =>
          JSON.stringify(i).toLowerCase().includes(target.email.toLowerCase())
        )
        if (invitation) {
          const invId = invitation.public_identifier || invitation.id
          const deleteRes = await session.api(
            'DELETE',
            `${basePath}/invitations/${invId}/`
          )
          if (deleteRes.status === 204 || deleteRes.status === 200) {
            results.push({
              ...target,
              success: true,
              message: `Revoked invitation for ${target.email}`,
            })
          } else {
            results.push({
              ...target,
              success: false,
              message: `Failed to revoke invitation ${invId}: ${deleteRes.status}`,
            })
          }
          continue
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
          JSON.stringify(i).toLowerCase().includes(target.email.toLowerCase())
        )
        if (invitation) {
          const invId = invitation.public_identifier || invitation.id
          const deleteRes = await session.api(
            'DELETE',
            `${basePath}/addressed-invitations/${invId}/`
          )
          if (deleteRes.status === 204 || deleteRes.status === 200) {
            results.push({
              ...target,
              success: true,
              message: `Revoked addressed invitation for ${target.email}`,
            })
          } else {
            results.push({
              ...target,
              success: false,
              message: `Failed to revoke addressed invitation ${invId}: ${deleteRes.status}`,
            })
          }
          continue
        }
      }

      results.push({
        ...target,
        success: false,
        message: `${target.email} not found in team members or invitations`,
      })
    }

    return results
  })
}

/**
 * Get full match details for a single match (probe for CDN/video URLs)
 * Returns the raw Veo response so we can inspect all available fields
 */
export async function getMatchDetails(
  matchSlug: string
): Promise<VeoResult<Record<string, unknown>>> {
  return withSession(async (session) => {
    const res = await session.api('GET', `/api/app/matches/${matchSlug}/`)

    if (res.status !== 200) {
      return {
        success: false,
        message: `Failed to get match details: ${res.status} - ${res.body.substring(0, 200)}`,
      }
    }

    const data = parseBody(res.body)
    return {
      success: true,
      message: 'Match details retrieved',
      data,
    }
  })
}

/**
 * Probe multiple sub-endpoints of a match to find full video URLs.
 */
export async function probeMatchVideos(
  matchSlug: string
): Promise<VeoResult<Record<string, unknown>>> {
  return withSession(async (session) => {
    const endpoints = [
      `/api/app/matches/${matchSlug}/videos/`,
      `/api/app/matches/${matchSlug}/periods/`,
      `/api/app/matches/${matchSlug}/highlights/?include_ai=true&fields=id&fields=start&fields=duration&fields=tags&fields=team_association&fields=thumbnail&fields=videos&fields=is_ai_generated`,
      `/api/app/matches/${matchSlug}/lineup/`,
      `/api/app/matches/${matchSlug}/stats/`,
      `/api/app/matches/${matchSlug}/bookmarks/`,
    ]

    const results: Record<string, unknown> = {}

    for (const endpoint of endpoints) {
      const res = await session.api('GET', endpoint)
      const name = endpoint.split('/').filter(Boolean).pop() || endpoint
      results[name] = {
        status: res.status,
        data: res.status === 200 ? parseBody(res.body) : null,
      }
    }

    return {
      success: true,
      message: 'Probe complete',
      data: results,
    }
  })
}

/**
 * Login to Veo via browser, navigate to a match page, and intercept all API
 * calls to discover endpoints used for Player Spotlight / Player Moments.
 */
export async function probeMatchBrowser(
  matchSlug: string
): Promise<VeoResult<Record<string, unknown>>> {
  const { chromium } = await import('playwright')

  const email = process.env.VEO_EMAIL!
  const password = process.env.VEO_PASSWORD!

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()

  const capturedRequests: { method: string; url: string; status?: number; body?: string }[] = []

  // Intercept all API responses
  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('/api/') || url.includes('veocdn.com')) {
      let body: string | undefined
      try {
        const text = await response.text()
        body = text.substring(0, 5000)
      } catch { /* stream responses */ }
      capturedRequests.push({
        method: response.request().method(),
        url,
        status: response.status(),
        body,
      })
    }
  })

  try {
    // Step 1: Login
    await page.goto('https://app.veo.co', { waitUntil: 'commit', timeout: 30000 })
    await page.waitForURL('**/auth.veo.co/**', { timeout: 20000 })

    const emailInput = await page.waitForSelector(
      'input[type="email"], input[name="email"], input[type="text"]',
      { timeout: 15000 }
    )
    const passwordInput = await page.waitForSelector('input[type="password"]', { timeout: 5000 })

    await emailInput!.fill(email)
    await passwordInput!.fill(password)
    await (await page.$('button[type="submit"]'))?.click()

    // Wait for login redirect
    await page.waitForURL('**/app.veo.co/**', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(3000)

    // Step 2: Navigate to the match page (now authenticated)
    // Clear previous captured requests from login
    capturedRequests.length = 0

    await page.goto(`https://app.veo.co/matches/${matchSlug}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForTimeout(10000)

    // Step 3: Look for and click Player Spotlight / Player Moments UI
    const spotlightSelectors = [
      'text=Player Spotlight',
      'text=Player Moments',
      'text=Spotlight',
      'text=Moments',
      'button:has-text("Player")',
      'a:has-text("Player")',
      '[data-testid*="player"]',
      '[data-testid*="spotlight"]',
      '[data-testid*="moment"]',
    ]

    let clickedElement = ''
    for (const selector of spotlightSelectors) {
      const el = await page.$(selector)
      if (el) {
        const text = await el.textContent().catch(() => '')
        clickedElement = `${selector} (${text})`
        await el.click().catch(() => {})
        await page.waitForTimeout(5000)
        break
      }
    }

    // Step 4: Also grab page text to see what UI elements exist
    const pageButtons = await page.$$eval(
      'button, a, [role="tab"], [role="button"]',
      (els) => els.map((e) => e.textContent?.trim()).filter(Boolean).slice(0, 50)
    )

    await browser.close()

    return {
      success: true,
      message: `Captured ${capturedRequests.length} API requests. Clicked: ${clickedElement || 'nothing found'}`,
      data: {
        uiElements: pageButtons,
        requests: capturedRequests.map((r) => ({
          method: r.method,
          url: r.url,
          status: r.status,
          bodyPreview: r.body?.substring(0, 500),
        })),
      },
    }
  } catch (error) {
    await browser.close()
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Get videos, highlights, and stats for a single match (combined in one session)
 */
export async function getMatchContent(
  matchSlug: string
): Promise<VeoResult<MatchContent>> {
  return withSession(async (session) => {
    const [videosRes, highlightsRes, statsRes] = await Promise.all([
      session.api('GET', `/api/app/matches/${matchSlug}/videos/`),
      session.api(
        'GET',
        `/api/app/matches/${matchSlug}/highlights/?include_ai=true&fields=id&fields=start&fields=duration&fields=tags&fields=team_association&fields=thumbnail&fields=videos&fields=is_ai_generated`
      ),
      session.api('GET', `/api/app/matches/${matchSlug}/stats/`),
    ])

    const videos: VeoVideo[] =
      videosRes.status === 200 ? parseBody(videosRes.body) || [] : []
    const highlights: VeoHighlight[] =
      highlightsRes.status === 200 ? parseBody(highlightsRes.body) || [] : []
    const stats: VeoMatchStats | null =
      statsRes.status === 200 ? parseBody(statsRes.body) : null

    return {
      success: true,
      message: `Found ${videos.length} videos, ${highlights.length} highlights`,
      data: { videos, highlights, stats },
    }
  })
}

// ============================================================================
// Export Client Object
// ============================================================================

export const veoClient = {
  invitePlayer,
  removeMember,
  removeMembersInBulk,
  setMatchPrivacy,
  listClubsAndTeams,
  listRecordings,
  listTeamMembers,
  getMatchDetails,
  getMatchContent,
}
