/**
 * Stage 3 executor for the LYL Veo team assignment pass.
 *
 * Reads /tmp/lyl-team-assignment-plan.json (produced by
 * plan-lyl-team-assignment.ts), reconciles against the current Veo
 * state, and either prints the action plan (--dry-run, default) or
 * executes the writes (--apply).
 *
 * Actions, in order:
 *   1. Create any teams in `teams_to_create` that don't already exist
 *      in the LYL Veo clubhouse. Team naming format: "<Subclub Display> U<N>"
 *      (e.g. "Barnes Eagles U10"). Veo derives slug from name.
 *   2. For each assignment, assign the recording to its HOME team.
 *   3. For each assignment, share + accept the recording into the AWAY
 *      team's folder so both teams get full Veo functionality (spotlights,
 *      follow-cam, etc).
 *
 * Idempotency:
 *   - Skip team creation if a team with the expected slug already exists.
 *   - Skip home-team assignment if the recording's `team` field already
 *     matches the target team UUID.
 *   - Skip share+accept if a sibling match with the same title already
 *     exists under the away team (heuristic; not perfectly precise).
 *
 * Usage:
 *   Dry-run (default, prints plan, no writes):
 *     cd PLAYHUB && npx tsx scripts/execute-lyl-team-assignment.ts
 *   Execute for real:
 *     cd PLAYHUB && npx tsx scripts/execute-lyl-team-assignment.ts --apply
 *
 * Env: VEO_EMAIL, VEO_PASSWORD, NEXT_PUBLIC_SUPABASE_URL,
 *      SUPABASE_SERVICE_ROLE_KEY (auto-loaded from PLAYHUB/.env)
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'

function loadEnvFile(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const key = t.slice(0, eq).trim()
    let value = t.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}
loadEnvFile(join(__dirname, '..', '.env'))

const TARGET_CLUB = 'london-youth-league'
const PLAN_PATH = '/tmp/lyl-team-assignment-plan.json'
// "Share with Opponent" needs an email recipient. We share to the LYL
// admin's own email so we (as the same Veo user) can immediately accept
// programmatically via acceptShareInvitation — no inbox round-trip.
const SHARE_RECIPIENT_EMAIL =
  process.env.LYL_VEO_ADMIN_EMAIL || process.env.VEO_EMAIL!
const APPLY = process.argv.includes('--apply')

interface PlanAssignment {
  recording_slug: string
  title: string
  match_date: string | null
  home_team_slug: string
  away_team_slug: string
}

interface Plan {
  teams_to_create: string[]
  assignments: PlanAssignment[]
}

interface SubclubRow {
  subclub_slug: string
  display_name: string
}

/** Convert a planner team-slug like "barnes-eagles-u10" into the Veo
 *  team display name. The slug's age-group suffix (`-u<N>`) is split
 *  off and the remainder is matched against the subclub display names
 *  pulled from playhub_academy_subclubs. */
function buildTeamName(
  teamSlug: string,
  subclubsBySlug: Map<string, string>
): { name: string; ageGroup: string; shortName: string; subclubSlug: string } {
  const m = teamSlug.match(/^(.*)-u(\d{1,2})$/)
  if (!m)
    throw new Error(
      `Cannot parse team slug "${teamSlug}" (expected <subclub>-u<N>)`
    )
  const subclubSlug = m[1]
  const ageNumber = m[2]
  const displayName = subclubsBySlug.get(subclubSlug)
  if (!displayName) {
    throw new Error(
      `No display name in playhub_academy_subclubs for "${subclubSlug}"`
    )
  }
  const name = `${displayName} U${ageNumber}`
  // short_name: Veo caps this at 3 chars. Build from subclub initials
  // (treating dots as separators so "N.S.F.C" → "NSF"); when the
  // resulting initials are shorter than 2 chars (single-word subclubs
  // like "Forzaskillz"), fall back to the first 3 letters of the
  // contiguous name. Age group is NOT included — Veo has its own
  // age_group field that carries "U10" / "U11" / etc.
  let shortName = displayName
    .replace(/\./g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 3)
  if (shortName.length < 2) {
    shortName = displayName
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase()
  }
  return { name, ageGroup: `U${ageNumber}`, shortName, subclubSlug }
}

async function main() {
  console.log(
    `Mode: ${APPLY ? 'APPLY (will write to Veo)' : 'DRY-RUN (no writes)'}\n`
  )

  // --- Load plan ---
  const planRaw = readFileSync(PLAN_PATH, 'utf8')
  const plan = JSON.parse(planRaw) as Plan
  console.log(
    `Plan: ${plan.teams_to_create.length} teams to create, ${plan.assignments.length} assignments`
  )

  // --- Pull subclub display names from Supabase (one query) ---
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
  const { data: subclubRows, error: subErr } = await supabase
    .from('playhub_academy_subclubs')
    .select('subclub_slug, display_name')
    .eq('club_slug', 'lyl')
  if (subErr) throw new Error(`Subclub lookup failed: ${subErr.message}`)
  const subclubsBySlug = new Map<string, string>(
    (subclubRows as SubclubRow[]).map((r) => [r.subclub_slug, r.display_name])
  )
  console.log(
    `Loaded ${subclubsBySlug.size} subclub display names from Supabase`
  )

  // --- Pull existing Veo state ---
  const veo = await import('../src/lib/veo/client')
  console.log('Fetching Veo clubs/teams + recordings…')
  const teamsResult = await veo.listClubsAndTeams()
  if (!teamsResult.success)
    throw new Error(`Veo listClubsAndTeams: ${teamsResult.message}`)
  const lylClub = teamsResult.data!.clubs.find((c) => c.slug === TARGET_CLUB)
  if (!lylClub) throw new Error(`LYL club not found in Veo`)
  const existingTeamsBySlug = new Map(lylClub.teams.map((t) => [t.slug, t]))
  console.log(`LYL Veo: ${lylClub.teams.length} existing teams`)

  const recordingsResult = await veo.listRecordings(TARGET_CLUB)
  if (!recordingsResult.success)
    throw new Error(`Veo listRecordings: ${recordingsResult.message}`)
  const recordingsBySlug = new Map(
    recordingsResult.data!.recordings.map((r) => [r.slug, r])
  )
  console.log(`LYL Veo: ${recordingsBySlug.size} recordings`)

  // The listing endpoint doesn't return the recording UUID under any
  // field name we've found (`uuid`, `id`, `identifier` all empty in our
  // captures). We MUST hit getMatchDetails per-slug to resolve UUIDs +
  // start/end timestamps used by the assign + accept calls.
  //
  // Cache once upfront to keep phases 2 + 3 fast.
  const detailsCache = new Map<
    string,
    {
      id: string
      team: string | null
      start: string
      end: string
      title: string
    }
  >()
  console.log(
    `Fetching match details for ${plan.assignments.length} recordings…`
  )
  for (const a of plan.assignments) {
    if (detailsCache.has(a.recording_slug)) continue
    const d = await veo.getMatchDetails(a.recording_slug)
    if (!d.success || !d.data) {
      console.error(`  ✗ ${a.recording_slug}: ${d.message}`)
      continue
    }
    const body = d.data as any
    if (!body.id || !body.start || !body.end) {
      console.error(`  ✗ ${a.recording_slug}: details missing id/start/end`)
      continue
    }
    detailsCache.set(a.recording_slug, {
      id: body.id,
      team: body.team ?? null,
      start: body.start,
      end: body.end,
      title: body.title ?? a.title,
    })
  }
  console.log(
    `Resolved UUIDs for ${detailsCache.size}/${plan.assignments.length}\n`
  )

  // ========================================================================
  // PHASE 1: Create teams
  // ========================================================================
  const newTeamUUIDs = new Map<string, string>() // teamSlug → UUID
  // Seed with already-existing teams so phase 2 can find them.
  for (const [slug, team] of existingTeamsBySlug) {
    newTeamUUIDs.set(slug, team.id)
  }

  console.log(
    `=== Phase 1: create ${plan.teams_to_create.length} planned teams ===`
  )
  for (const teamSlug of plan.teams_to_create) {
    const meta = buildTeamName(teamSlug, subclubsBySlug)
    if (existingTeamsBySlug.has(teamSlug)) {
      console.log(
        `  [skip ] ${teamSlug.padEnd(28)} already exists (id=${existingTeamsBySlug.get(teamSlug)!.id.slice(0, 8)}…)`
      )
      continue
    }
    console.log(
      `  [${APPLY ? 'CREATE' : 'plan  '}] ${teamSlug.padEnd(28)} → name="${meta.name}", age=${meta.ageGroup}, short="${meta.shortName}"`
    )
    if (!APPLY) continue
    const r = await veo.createTeam({
      clubSlug: TARGET_CLUB,
      name: meta.name,
      ageGroup: meta.ageGroup,
      gender: 'male',
      shortName: meta.shortName,
    })
    if (!r.success || !r.data) {
      console.error(`    ✗ ${r.message}`)
      continue
    }
    newTeamUUIDs.set(r.data.team.slug, r.data.team.id)
    console.log(
      `    ✓ created (id=${r.data.team.id.slice(0, 8)}…, actual slug=${r.data.team.slug})`
    )
  }

  // ========================================================================
  // PHASE 2: Assign each recording to its HOME team (single PATCH)
  // ========================================================================
  console.log(
    `\n=== Phase 2: home-team assignment for ${plan.assignments.length} recordings ===`
  )
  for (const a of plan.assignments) {
    const details = detailsCache.get(a.recording_slug)
    if (!details) {
      console.error(
        `  [miss ] ${a.recording_slug} has no resolved details — skip`
      )
      continue
    }
    const homeTeamUUID = newTeamUUIDs.get(a.home_team_slug)
    if (!homeTeamUUID && !APPLY) {
      // In dry-run, planned teams from phase 1 aren't actually created
      // yet so their UUIDs are unknown. Show the intent.
      console.log(
        `  [plan  ] ${a.recording_slug.slice(0, 32).padEnd(32)} → ${a.home_team_slug} (team will be created in phase 1)`
      )
      continue
    }
    if (!homeTeamUUID) {
      console.error(
        `  [miss ] home team "${a.home_team_slug}" not in Veo teams (create failed?) — skip`
      )
      continue
    }
    if (details.team === homeTeamUUID) {
      console.log(
        `  [skip ] ${a.recording_slug.slice(0, 32).padEnd(32)} already assigned to ${a.home_team_slug}`
      )
      continue
    }
    console.log(
      `  [${APPLY ? 'ASSIGN' : 'plan  '}] ${a.recording_slug.slice(0, 32).padEnd(32)} → ${a.home_team_slug}`
    )
    if (!APPLY) continue
    const r = await veo.assignRecordingToTeam(details.id, homeTeamUUID)
    if (!r.success) {
      console.error(`    ✗ ${r.message}`)
      continue
    }
    console.log(`    ✓ ${r.message}`)
  }

  // ========================================================================
  // PHASE 3: Share + accept for AWAY team
  // ========================================================================
  console.log(
    `\n=== Phase 3: share + accept duplicates for ${plan.assignments.length} away-team copies ===`
  )
  // Refresh recordings post-phase-2 so we can detect existing away-side
  // duplicates and avoid double-creating them. The away-side copies have
  // the SAME title as the original (Veo's "Add recording" form re-uses
  // the source title); we detect duplicates by (title, team).
  let refreshedRecordings = recordingsBySlug
  if (APPLY) {
    const fresh = await veo.listRecordings(TARGET_CLUB)
    if (fresh.success)
      refreshedRecordings = new Map(
        fresh.data!.recordings.map((r) => [r.slug, r])
      )
  }
  // Build a (title → teams) index for idempotency check.
  const titleTeams = new Map<string, Set<string>>()
  for (const r of refreshedRecordings.values()) {
    if (!r.title) continue
    if (!r.team) continue
    const set = titleTeams.get(r.title) ?? new Set()
    set.add(r.team)
    titleTeams.set(r.title, set)
  }

  for (const a of plan.assignments) {
    const details = detailsCache.get(a.recording_slug)
    if (!details) {
      console.error(
        `  [miss ] ${a.recording_slug} has no resolved details — skip`
      )
      continue
    }
    // Intra-team scrimmage: when home and away parse to the SAME team
    // (e.g. "ELA U11 C vs ELA U11 B" both → ela-u11), assigning the
    // recording to that team in Phase 2 already covers both sides. Sharing
    // back to itself would create a pointless duplicate.
    if (a.home_team_slug === a.away_team_slug) {
      console.log(
        `  [skip ] ${a.recording_slug.slice(0, 32).padEnd(32)} intra-team match (${a.home_team_slug}) — Phase 2 assignment covers both sides`
      )
      continue
    }
    const awayTeamUUID = newTeamUUIDs.get(a.away_team_slug)
    if (!awayTeamUUID && !APPLY) {
      console.log(
        `  [plan  ] ${a.recording_slug.slice(0, 32).padEnd(32)} → share+accept into ${a.away_team_slug} (team will be created in phase 1)`
      )
      continue
    }
    if (!awayTeamUUID) {
      console.error(
        `  [miss ] away team "${a.away_team_slug}" not in Veo — skip`
      )
      continue
    }
    // Idempotency: does a recording with this title already exist under
    // the away team? If yes, the share+accept already happened.
    const teamsForTitle = titleTeams.get(details.title) ?? new Set()
    if (teamsForTitle.has(awayTeamUUID)) {
      console.log(
        `  [skip ] ${a.recording_slug.slice(0, 32).padEnd(32)} away copy already under ${a.away_team_slug}`
      )
      continue
    }
    console.log(
      `  [${APPLY ? 'SHARE ' : 'plan  '}] ${a.recording_slug.slice(0, 32).padEnd(32)} → share+accept into ${a.away_team_slug}`
    )
    if (!APPLY) continue

    // 3a. Send the share invitation
    const shareR = await veo.createShareInvitation({
      recordingSlug: a.recording_slug,
      email: SHARE_RECIPIENT_EMAIL,
    })
    if (!shareR.success || !shareR.data) {
      console.error(`    ✗ share failed: ${shareR.message}`)
      continue
    }
    const key = shareR.data.invitation.key

    // 3b. Accept it — programmatically, against the away team UUID.
    const acceptR = await veo.acceptShareInvitation({
      shareKey: key,
      ownClubSlug: TARGET_CLUB,
      teamUUID: awayTeamUUID,
      title: details.title,
      start: details.start,
      end: details.end,
      ownTeamHomeOrAway: 'away',
      privacy: 'private',
      opponentClubName: lylClub.name,
    })
    if (!acceptR.success) {
      console.error(`    ✗ accept failed: ${acceptR.message}`)
      continue
    }
    console.log(`    ✓ ${acceptR.message}`)
  }

  console.log(
    `\nDone. ${APPLY ? 'Writes committed to Veo.' : 'Dry-run only — pass --apply to execute.'}`
  )
}

main()
  .catch((err) => {
    console.error('Unhandled:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    // Tear down the cached Playwright session so the process can exit.
    // Without this the script hangs on the open browser.
    const { shutdownVeoSession } = await import('../src/lib/veo/auth')
    await shutdownVeoSession()
  })
