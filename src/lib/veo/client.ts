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
  /** Veo's structured assignment: a team UUID (not slug) or null when
   *  unassigned. Used for idempotent re-runs of the assignment pipeline. */
  team?: string | null
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
        // page_size=500 mirrors the members endpoint convention — Veo's
        // default page is small (~20) and silently truncates when the
        // club has more teams than that. Without this, listClubsAndTeams
        // returns an empty teams array for any club past the default
        // page boundary, which broke executor idempotency for LYL (~30+ teams).
        const teamsRes = await session.api(
          'GET',
          `/api/app/clubs/${club.slug}/teams/?page_size=500`
        )
        if (teamsRes.status === 200) {
          const body = parseBody(teamsRes.body)
          // Tolerate both shapes: flat array (small clubs) OR DRF-style
          // paginated `{ count, next, previous, results: [...] }` wrapper.
          teams = Array.isArray(body)
            ? body
            : Array.isArray(body?.results)
              ? body.results
              : []
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
      `/api/app/clubs/${clubSlug}/recordings/?filter=own&fields=privacy&fields=title&fields=slug&fields=duration&fields=thumbnail&fields=uuid&fields=match_date&fields=home_team&fields=away_team&fields=home_score&fields=away_score&fields=processing_status&fields=team&page_size=200`
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
 * Create a team under a club. Veo derives the team slug from `name`
 * (lower-case, hyphenated). Returns the full team object on success;
 * the caller will want `id` (UUID) for later recording-assignment
 * calls and `slug` for any URL-building.
 *
 * Idempotency: Veo allows duplicate team names (each gets a unique
 * auto-suffixed slug). Callers should pre-check via listClubsAndTeams
 * and skip creation when a team with the desired slug already exists.
 *
 * Endpoint reverse-engineered 2026-05-17 via veo-automations capture.
 */
export interface CreateTeamInput {
  clubSlug: string
  name: string
  /** Veo accepts "U6"…"U21" and other custom strings; we use "U7"-"U18"
   *  for LYL. Required by Veo even though some flows don't show it. */
  ageGroup: string
  /** "male" | "female" | "mixed". Required by Veo. LYL pilot uses "male". */
  gender: 'male' | 'female' | 'mixed'
  /** Up to ~3 chars typically (Veo's UI cap). Falls back to the
   *  uppercase initials of `name` if not supplied. */
  shortName?: string
}

export interface VeoTeamFull {
  id: string
  slug: string
  name: string
  age_group: string
  gender: string
  short_name: string
  match_count: number
  member_count: number
  url: string
}

export async function createTeam(
  input: CreateTeamInput
): Promise<VeoResult<{ team: VeoTeamFull }>> {
  // Default short_name to upper-case initials of the team name if the
  // caller didn't supply one — Veo will 400 on missing short_name.
  const shortName =
    input.shortName ??
    input.name
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 6)
  return withSession(async (session) => {
    const res = await session.api('POST', `/api/app/teams/`, {
      club: input.clubSlug,
      name: input.name,
      age_group: input.ageGroup,
      gender: input.gender,
      short_name: shortName,
    })
    if (res.status !== 201 && res.status !== 200) {
      return {
        success: false,
        message: `Failed to create team "${input.name}": ${res.status} ${
          typeof res.body === 'string'
            ? res.body.slice(0, 200)
            : JSON.stringify(res.body).slice(0, 200)
        }`,
      }
    }
    const team = parseBody(res.body) as VeoTeamFull | null
    if (!team || !team.id || !team.slug) {
      return {
        success: false,
        message: `Team creation returned malformed body for "${input.name}"`,
      }
    }
    return {
      success: true,
      message: `Created team ${team.slug} (id=${team.id})`,
      data: { team },
    }
  })
}

/**
 * Upload a new crest (team logo) for a team.
 *
 * Endpoint reverse-engineered 2026-05-17 via veo-automations capture
 * (`capture-team-logo-upload.mjs` → /tmp/veo-team-logo-capture.json).
 *
 * Endpoint: POST /api/app/clubs/{clubSlug}/teams/{teamSlug}/crest/
 * Body: multipart/form-data with a single file part. Field name presumed
 * `crest` (matches the endpoint path; Playwright's `postDataBuffer()`
 * returned null for the captured upload so we couldn't read the field
 * name directly — first failure with a 400 should switch to `image` or
 * `file`). Response is the new asset URL string (NOT a JSON object).
 *
 * Permission gate: `teams.update_team_crest` on the team detail response.
 * Throws if the team detail's permission flag is false.
 *
 * @param input.clubSlug Veo club slug (e.g. 'london-youth-league')
 * @param input.teamSlug Veo team slug (e.g. 'barnes-eagles-u10')
 * @param input.imageBytes Raw image bytes (PNG / JPG / WebP)
 * @param input.mimeType MIME type matching the bytes
 * @param input.filename Filename to send with the part (cosmetic on Veo's side, but they store it). Defaults to `crest.<ext>`.
 */
// Defense-in-depth allowlists at the call boundary. Today's callers
// pass safe inputs, but these functions are exported and reusable;
// the next caller might not. Per 2026-05-17 security review.
const VEO_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/
const ALLOWED_CREST_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

export async function uploadTeamCrest(input: {
  clubSlug: string
  teamSlug: string
  imageBytes: Buffer
  mimeType: string
  filename?: string
}): Promise<VeoResult<{ crestUrl: string }>> {
  // Slug shape check — rejects path traversal / weird characters before
  // they hit the URL interpolation.
  if (!VEO_SLUG_RE.test(input.clubSlug) || !VEO_SLUG_RE.test(input.teamSlug)) {
    return { success: false, message: 'uploadTeamCrest: invalid slug shape' }
  }
  // MIME allowlist — Veo accepts more than this (and re-encodes), but
  // we lock to safe raster formats so a stray image/svg+xml can't get
  // through and become an XSS surface elsewhere.
  if (!ALLOWED_CREST_MIME.has(input.mimeType)) {
    return {
      success: false,
      message: `uploadTeamCrest: mime "${input.mimeType}" not in allowlist`,
    }
  }
  const ext = input.mimeType.split('/')[1] || 'png'
  const filename = input.filename ?? `crest.${ext}`
  return withSession(async (session) => {
    const res = await session.apiMultipart(
      'POST',
      `/api/app/clubs/${input.clubSlug}/teams/${input.teamSlug}/crest/`,
      [
        {
          name: 'crest',
          filename,
          mimeType: input.mimeType,
          buffer: input.imageBytes,
        },
      ]
    )
    if (res.status !== 200 && res.status !== 201) {
      // Strip non-printable bytes from the preview — if Veo echoes the
      // upload payload back in an error response, we don't want raw
      // image bytes corrupting our logs.
      const rawPreview =
        typeof res.body === 'string'
          ? res.body.slice(0, 300)
          : JSON.stringify(res.body).slice(0, 300)
      const preview = rawPreview.replace(/[^\x20-\x7e]/g, '?')
      return {
        success: false,
        message: `Failed to upload crest for ${input.clubSlug}/${input.teamSlug}: ${res.status} ${preview}`,
      }
    }
    // Veo returns the asset URL as a JSON-quoted string body (not an
    // object). Strip the surrounding quotes if present.
    const raw = typeof res.body === 'string' ? res.body.trim() : ''
    const crestUrl =
      raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
    // Validate the returned URL is actually a Veo asset — protects any
    // downstream code that persists / renders this URL from an
    // unexpected Veo response redirecting to an arbitrary host.
    if (!/^https:\/\/[^/]*(?:veo\.co|veocdn\.com)\//.test(crestUrl)) {
      return {
        success: false,
        message: `Crest upload returned unexpected URL for ${input.teamSlug}: ${raw.slice(0, 200)}`,
      }
    }
    return {
      success: true,
      message: `Uploaded crest for ${input.teamSlug}`,
      data: { crestUrl },
    }
  })
}

/**
 * Assign a recording to a team. The recording is addressed by its UUID
 * (not slug — Veo's `/api/app/matches/{uuid}/` endpoint requires the UUID
 * even though the consumer URLs use slugs). `teamUUID` is the team's `id`
 * field as returned by createTeam / listClubsAndTeams.
 *
 * Endpoint reverse-engineered 2026-05-17 via veo-automations capture.
 * Note: Veo's data model only allows ONE assigned team per recording
 * (the `team` field is a single FK, not an array). To assign a match to
 * BOTH the home + away age-group folders, we need to call this once with
 * the home team UUID — see the executor for the second-side strategy.
 */
export async function assignRecordingToTeam(
  recordingUUID: string,
  teamUUID: string | null
): Promise<VeoResult<{ recording: { id: string; team: string | null } }>> {
  return withSession(async (session) => {
    const res = await session.api(
      'PATCH',
      `/api/app/matches/${recordingUUID}/`,
      { team: teamUUID }
    )
    if (res.status !== 200) {
      return {
        success: false,
        message: `Failed to assign recording ${recordingUUID} → team ${teamUUID ?? '<unassigned>'}: ${res.status}`,
      }
    }
    const body = parseBody(res.body) as {
      id: string
      team: string | null
    } | null
    return {
      success: true,
      message: `Assigned recording ${recordingUUID} → team ${teamUUID ?? '<unassigned>'}`,
      data: { recording: body ?? { id: recordingUUID, team: teamUUID } },
    }
  })
}

/**
 * Send a share invitation for a recording. Veo's "Share with Opponent"
 * feature; creates a pending invitation tied to the recipient email and
 * returns a `key` used by the accept endpoint.
 *
 * The returned URL pattern is:
 *   https://app.veo.co/matches/{recordingSlug}/share-invitations/{key}/
 * The recipient (or the LYL admin acting as recipient) accepts via that
 * URL, which fires acceptShareInvitation() below.
 *
 * Endpoint reverse-engineered 2026-05-17 via veo-automations capture.
 */
export interface CreateShareInvitationInput {
  /** The slug of the recording to share (NOT the UUID — Veo uses the
   *  slug on this endpoint, unlike the assign-team PATCH). */
  recordingSlug: string
  email: string
}

export interface VeoShareInvitation {
  key: string
  email: string
  accepted: boolean
  /** Populated only AFTER acceptance — UUID of the new match record
   *  Veo creates in the recipient's clubhouse. */
  output_recording: string | null
  output_club: string | null
  output_user: string | null
}

export async function createShareInvitation(
  input: CreateShareInvitationInput
): Promise<VeoResult<{ invitation: VeoShareInvitation }>> {
  return withSession(async (session) => {
    const res = await session.api(
      'POST',
      `/api/app/matches/${input.recordingSlug}/share-invitations/`,
      { email: input.email }
    )
    if (res.status !== 201 && res.status !== 200) {
      return {
        success: false,
        message: `Failed to share ${input.recordingSlug} → ${input.email}: ${res.status}`,
      }
    }
    const body = parseBody(res.body) as VeoShareInvitation | null
    if (!body?.key) {
      return {
        success: false,
        message: `Share invitation for ${input.recordingSlug} returned no key`,
      }
    }
    return {
      success: true,
      message: `Shared ${input.recordingSlug} → ${input.email} (key=${body.key.slice(0, 8)}…)`,
      data: { invitation: body },
    }
  })
}

/**
 * Accept a share invitation, duplicating the recording into another
 * team's folder. The team can be in the SAME club (which is what we
 * want for LYL where home + away are both LYL teams) or a different
 * club. Returns the new match record's UUID.
 *
 * Programmatic acceptance avoids the email-delivery round trip — once
 * we have the `key` from createShareInvitation(), we can immediately
 * accept on the same Veo session.
 *
 * Endpoint reverse-engineered 2026-05-17 via veo-automations capture.
 */
export interface AcceptShareInvitationInput {
  shareKey: string
  /** Which club the duplicate match should land in. For LYL → 'london-youth-league' */
  ownClubSlug: string
  /** Team UUID (from createTeam or listClubsAndTeams) the duplicate should be assigned to. */
  teamUUID: string
  /** Title for the new match record. Typically copy from the source recording. */
  title: string
  /** ISO timestamps from the source recording. Required by the endpoint. */
  start: string
  end: string
  /** "home" or "away" — describes which side OWNS this duplicate. For
   *  cross-team sharing within LYL, the receiving (away) team is the
   *  owner of the new copy, so the canonical value is "away". */
  ownTeamHomeOrAway?: 'home' | 'away'
  /** Defaults to "private" matching the Veo UI default. */
  privacy?: 'private' | 'public'
  /** Name of the originating club (shown in the new match metadata).
   *  Defaults to the same club's title — for LYL this is "London Youth League". */
  opponentClubName?: string
}

export interface VeoMatchCreated {
  id: string
  slug: string
  title: string
  team: string
}

export async function acceptShareInvitation(
  input: AcceptShareInvitationInput
): Promise<VeoResult<{ match: VeoMatchCreated }>> {
  return withSession(async (session) => {
    const res = await session.api('POST', `/api/app/matches/`, {
      signup_token: {
        key: input.shareKey,
        type: 'recordingshareinvitation',
      },
      team: input.teamUUID,
      own_club: input.ownClubSlug,
      own_team_home_or_away: input.ownTeamHomeOrAway ?? 'away',
      title: input.title,
      start: input.start,
      end: input.end,
      opponent_club_name: input.opponentClubName ?? '',
      privacy: input.privacy ?? 'private',
    })
    if (res.status !== 201 && res.status !== 200) {
      return {
        success: false,
        message: `Failed to accept share ${input.shareKey.slice(0, 8)}…: ${res.status} ${
          typeof res.body === 'string'
            ? res.body.slice(0, 200)
            : JSON.stringify(res.body).slice(0, 200)
        }`,
      }
    }
    // Tolerant body parse: Veo's accept response shape isn't fully
    // documented; the response may use `id` + `slug` (the create-match
    // shape) OR a wrapper around it. Treat 2xx as authoritative success
    // and pass through whatever id/slug we can find — both are
    // informational for our purposes (the actual side-effect, creating
    // the new match assigned to the target team, has already happened).
    const body = parseBody(res.body) as Partial<VeoMatchCreated> | null
    const id = body?.id ?? 'unknown'
    const slug = body?.slug ?? 'unknown'
    return {
      success: true,
      message: `Accepted share → new match ${slug} (id=${id}) assigned to team ${input.teamUUID}`,
      data: {
        match: {
          id,
          slug,
          title: body?.title ?? input.title,
          team: body?.team ?? input.teamUUID,
        },
      },
    }
  })
}

/**
 * Delete a team from a club. Used to clean up the capture-test-team
 * created during the Veo API reverse-engineering capture; also useful
 * for ops removal of mis-spelled team rows before they collect members.
 */
export async function deleteTeam(
  clubSlug: string,
  teamSlug: string
): Promise<VeoResult> {
  return withSession(async (session) => {
    const res = await session.api(
      'DELETE',
      `/api/app/clubs/${clubSlug}/teams/${teamSlug}/`
    )
    // 204 (no content) is Veo's standard delete success. Some Veo
    // endpoints return 200 — accept both.
    if (res.status !== 204 && res.status !== 200) {
      return {
        success: false,
        message: `Failed to delete team ${clubSlug}/${teamSlug}: ${res.status}`,
      }
    }
    return {
      success: true,
      message: `Deleted team ${clubSlug}/${teamSlug}`,
    }
  })
}

/**
 * Delete a recording (match) by its slug.
 *
 * Used to clean up "entry-without-content" share-copies — away-folder copies
 * that Veo created before the source finished processing, leaving an empty
 * "NOT SET" entry with no playable video. Mirrors deleteTeam: DELETE against
 * the match resource, accepting Veo's standard 204 (or 200) success.
 *
 * NOTE: this is a destructive op. Callers must resolve the slug to a genuine
 * empty share-copy first (see lyl-sync/audit.ts) — never delete originals.
 */
export async function deleteRecording(matchSlug: string): Promise<VeoResult> {
  // Defense-in-depth: validate the slug shape before interpolating into the
  // DELETE path (matches uploadTeamCrest's VEO_SLUG_RE guard). Today's callers
  // pass Veo-API-derived slugs, but a future caller passing '../' or '' must
  // not reach a destructive request. Veo share-copy slugs are longer than the
  // 80-char team-slug cap, so allow a wider bound here.
  if (!/^[a-z0-9][a-z0-9-]{0,200}$/.test(matchSlug)) {
    return { success: false, message: `Invalid recording slug: ${matchSlug}` }
  }
  return withSession(async (session) => {
    const res = await session.api('DELETE', `/api/app/matches/${matchSlug}/`)
    if (res.status !== 204 && res.status !== 200) {
      return {
        success: false,
        message: `Failed to delete recording ${matchSlug}: ${res.status} - ${res.body.substring(0, 200)}`,
      }
    }
    return {
      success: true,
      message: `Deleted recording ${matchSlug}`,
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
 * Count the actual video segments + periods a recording has.
 *
 * This is the GROUND TRUTH for "does this recording have playable footage" —
 * unlike `processing_status`/`thumbnail`/`duration`, which a share-copy
 * inherits from its parent's metadata and which therefore read "ready" even
 * when the copy has no video (created before the source finished uploading).
 * Empirically (2026-05-31): a healthy LYL recording returns videos≈3 +
 * periods≈2; a broken share-copy returns videos=0 + periods=0 while still
 * reporting is_accessible=true, processing_status={}, a thumbnail and a
 * duration. `{videos:0, periods:0}` is the reliable "no content" signal.
 *
 * Two sequential GETs on the cached session (NOT concurrent — Veo's single
 * Playwright session doesn't tolerate parallel page.evaluate calls).
 */
export async function getRecordingContentCounts(
  matchSlug: string
): Promise<VeoResult<{ videos: number; periods: number }>> {
  return withSession(async (session) => {
    const v = await session.api('GET', `/api/app/matches/${matchSlug}/videos/`)
    const p = await session.api('GET', `/api/app/matches/${matchSlug}/periods/`)
    const count = (status: number, body: string): number => {
      if (status !== 200) return 0
      const parsed = parseBody(body)
      return Array.isArray(parsed) ? parsed.length : 0
    }
    return {
      success: true,
      message: 'Content counts retrieved',
      data: {
        videos: count(v.status, v.body),
        periods: count(p.status, p.body),
      },
    }
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
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  const capturedRequests: {
    method: string
    url: string
    status?: number
    body?: string
  }[] = []

  // Intercept all API responses
  page.on('response', async (response) => {
    const url = response.url()
    if (url.includes('/api/') || url.includes('veocdn.com')) {
      let body: string | undefined
      try {
        const text = await response.text()
        body = text.substring(0, 5000)
      } catch {
        /* stream responses */
      }
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
    await page.goto('https://app.veo.co', {
      waitUntil: 'commit',
      timeout: 30000,
    })
    await page.waitForURL('**/auth.veo.co/**', { timeout: 20000 })

    const emailInput = await page.waitForSelector(
      'input[type="email"], input[name="email"], input[type="text"]',
      { timeout: 15000 }
    )
    const passwordInput = await page.waitForSelector('input[type="password"]', {
      timeout: 5000,
    })

    await emailInput!.fill(email)
    await passwordInput!.fill(password)
    await (await page.$('button[type="submit"]'))?.click()

    // Wait for login redirect
    await page
      .waitForURL('**/app.veo.co/**', { timeout: 15000 })
      .catch(() => {})
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
      (els) =>
        els
          .map((e) => e.textContent?.trim())
          .filter(Boolean)
          .slice(0, 50)
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
