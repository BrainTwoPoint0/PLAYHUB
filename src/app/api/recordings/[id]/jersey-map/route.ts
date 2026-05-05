// GET  /api/recordings/[id]/jersey-map  — read existing map for a recording
// PUT  /api/recordings/[id]/jersey-map  — replace + lock map (triggers attribution)
//
// The jersey map is the connective tissue between PLAYHUB recordings and
// PLAYBACK profiles. A coach maps shirt-N → player_id once per match; the
// `derive_clip_attributions_from_jersey_map` trigger then fans out attribution
// to every clip on the recording whose metadata.jersey_number matches.
//
// PUT semantics: full replacement (matches the editor's "save & lock" flow).
// Locked rows can still be edited later but shouldn't be — corrections in v1
// rewrite the row in place, audit table is v1.1.

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { rejectCrossOrigin } from '@/lib/security/origin-check'
import { NextRequest, NextResponse } from 'next/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_ENTRIES = 60 // Squad + bench buffer; rejects pathological payloads.
const NOTES_MAX = 500

type RouteContext = { params: Promise<{ id: string }> }

interface JerseyMapEntry {
  jerseyNumber: number
  profileId: string | null
  notes?: string | null
}

interface PutBody {
  entries: JerseyMapEntry[]
  lock?: boolean
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id: recordingId } = await params
  if (!UUID_RE.test(recordingId)) {
    return NextResponse.json({ error: 'Invalid recording id' }, { status: 400 })
  }
  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient() as any

  const { data: recording } = await supabase
    .from('playhub_match_recordings')
    .select('id, organization_id, title, match_date, home_team, away_team')
    .eq('id', recordingId)
    .maybeSingle()
  if (!recording || !recording.organization_id) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  const isAdmin =
    (await isVenueAdmin(user.id, recording.organization_id)) ||
    (await isPlatformAdmin(user.id))
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  const { data: entries } = await supabase
    .from('match_jersey_maps')
    .select(
      'id, jersey_number, profile_id, notes, locked_at, mapped_at, mapped_by_membership_id'
    )
    .eq('recording_id', recordingId)
    .eq('club_org_id', recording.organization_id)
    .order('jersey_number', { ascending: true })

  return NextResponse.json({
    recording: {
      id: recording.id,
      title: recording.title,
      matchDate: recording.match_date,
      homeTeam: recording.home_team,
      awayTeam: recording.away_team,
      organizationId: recording.organization_id,
    },
    entries: entries ?? [],
  })
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const csrf = rejectCrossOrigin(request)
  if (csrf) return csrf

  const { id: recordingId } = await params
  if (!UUID_RE.test(recordingId)) {
    return NextResponse.json({ error: 'Invalid recording id' }, { status: 400 })
  }

  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const ct = request.headers.get('content-type') ?? ''
  if (!ct.toLowerCase().startsWith('application/json')) {
    return NextResponse.json(
      { error: 'Content-Type must be application/json' },
      { status: 415 }
    )
  }

  let body: PutBody
  try {
    body = (await request.json()) as PutBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (!Array.isArray(body.entries)) {
    return NextResponse.json(
      { error: 'entries must be an array' },
      { status: 400 }
    )
  }
  if (body.entries.length > MAX_ENTRIES) {
    return NextResponse.json(
      { error: `entries cannot exceed ${MAX_ENTRIES}` },
      { status: 400 }
    )
  }
  for (const e of body.entries) {
    if (
      typeof e.jerseyNumber !== 'number' ||
      e.jerseyNumber < 0 ||
      e.jerseyNumber > 99 ||
      !Number.isInteger(e.jerseyNumber)
    ) {
      return NextResponse.json(
        { error: 'jerseyNumber must be an integer 0-99' },
        { status: 400 }
      )
    }
    if (e.profileId !== null && (typeof e.profileId !== 'string' || !UUID_RE.test(e.profileId))) {
      return NextResponse.json(
        { error: 'profileId must be a valid UUID or null' },
        { status: 400 }
      )
    }
    if (
      e.notes !== undefined &&
      e.notes !== null &&
      (typeof e.notes !== 'string' || e.notes.length > NOTES_MAX)
    ) {
      return NextResponse.json(
        { error: `notes must be a string ≤${NOTES_MAX} chars or null` },
        { status: 400 }
      )
    }
  }
  // Reject duplicate jersey numbers in the same payload.
  const jerseyNumbers = body.entries.map((e) => e.jerseyNumber)
  if (new Set(jerseyNumbers).size !== jerseyNumbers.length) {
    return NextResponse.json(
      { error: 'duplicate jersey numbers in payload' },
      { status: 400 }
    )
  }

  const supabase = createServiceClient() as any

  const { data: recording } = await supabase
    .from('playhub_match_recordings')
    .select('id, organization_id')
    .eq('id', recordingId)
    .maybeSingle()
  if (!recording || !recording.organization_id) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  const orgId = recording.organization_id as string
  const isAdmin =
    (await isVenueAdmin(user.id, orgId)) ||
    (await isPlatformAdmin(user.id))
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  const { data: profileRow } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single()
  const { data: membershipRow } = await supabase
    .from('organization_members')
    .select('id')
    .eq('organization_id', orgId)
    .eq('profile_id', profileRow?.id ?? '')
    .eq('is_active', true)
    .maybeSingle()

  const lockedAt = body.lock ? new Date().toISOString() : null

  // Replace strategy: upsert each entry, then delete any rows for this recording
  // not in the new payload. This keeps the editor's "save what's on screen"
  // mental model. The (recording_id, club_org_id, jersey_number) UNIQUE drives
  // the upsert key.
  const rows = body.entries.map((e) => ({
    recording_id: recordingId,
    club_org_id: orgId,
    jersey_number: e.jerseyNumber,
    profile_id: e.profileId,
    notes: e.notes ?? null,
    mapped_by_membership_id: membershipRow?.id ?? null,
    mapped_at: new Date().toISOString(),
    locked_at: lockedAt,
  }))

  const { error: upsertError } = await supabase
    .from('match_jersey_maps')
    .upsert(rows, { onConflict: 'recording_id,club_org_id,jersey_number' })

  if (upsertError) {
    // Don't surface the raw PG error to the client — it leaks schema.
    console.error('jersey-map upsert failed', upsertError)
    return NextResponse.json(
      { error: 'Failed to save jersey map' },
      { status: 500 }
    )
  }

  if (rows.length > 0) {
    // Build a parenthesised list of integers manually since values are
    // already validated as 0-99 integers above. Using `.in()`-then-negate
    // isn't expressible in supabase-js; this is the documented pattern.
    const keepNumbers = rows.map((r) => Number(r.jersey_number))
    await supabase
      .from('match_jersey_maps')
      .delete()
      .eq('recording_id', recordingId)
      .eq('club_org_id', orgId)
      .not('jersey_number', 'in', `(${keepNumbers.join(',')})`)
  } else {
    // Empty payload = clear the whole map for this recording.
    await supabase
      .from('match_jersey_maps')
      .delete()
      .eq('recording_id', recordingId)
      .eq('club_org_id', orgId)
  }

  return NextResponse.json({ ok: true, count: rows.length, locked: !!lockedAt })
}
