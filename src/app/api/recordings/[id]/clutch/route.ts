// GET   /api/recordings/[id]/clutch — stats, players (crops + labels), clips
// PATCH /api/recordings/[id]/clutch — label players (name ↔ Clutch track id)
// PATCH has per-player MERGE semantics (null deletes that label) — contrast
// with jersey-map's PUT, which is a full replacement.
//
// Clutch recordings carry AI extras mirrored to S3 by the clutch-sync Lambda
// under dirname(recording.s3_key): match.json (stats), players.index.json
// (crop S3 keys), highlights.index.json (clip S3 keys). This route signs the
// keys per request and merges in the labels from playhub_clutch_player_labels.
// Everything degrades per-part: pre-feature recordings have no index files
// (clips: null), empty-court recordings have nothing at all.
//
// Labeling is open to anyone with recording access — padel purchasers ARE
// the players on court; restricting to venue admins would orphan the flow.

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { checkRecordingAccess } from '@/lib/recordings/access-control'
import { getJsonObject, getPlaybackUrl } from '@/lib/s3/client'
import { rejectCrossOrigin } from '@/lib/security/origin-check'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLAYER_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_LABELS = 30
const NAME_MAX = 60
const SIGN_TTL_SECONDS = 4 * 60 * 60

type RouteContext = { params: Promise<{ id: string }> }

// ── S3 index/document shapes (written by the clutch-sync Lambda) ────

interface PlayersIndexDoc {
  players?: Array<{
    playerId?: string
    isGroundTruth?: boolean
    cropKey?: string | null
  }>
}

interface ClipEntryDoc {
  clip?: string
  thumb?: string | null
}

interface HighlightsIndexDoc {
  full?: Record<string, ClipEntryDoc>
  selectors?: Record<string, Record<string, ClipEntryDoc[]>>
}

interface MatchJsonDoc {
  match_stats?: Record<string, number>
  player_stats?: Record<
    string,
    {
      distance_run_meters?: number
      n_shots?: number
      winner_shots?: number
      error_shots?: number
      rating?: number
    }
  >
  player_ids_mapping_to_pair?: Record<string, string[]>
}

// ── Shared loading ──────────────────────────────────────────────────

async function loadClutchRecording(recordingId: string) {
  const serviceClient = createServiceClient()
  const { data: recording } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .select('id, s3_key, status, clutch_video_id')
    .eq('id', recordingId)
    .single()

  if (
    !recording ||
    !recording.clutch_video_id ||
    recording.status !== 'published' ||
    !recording.s3_key ||
    !recording.s3_key.includes('/')
  ) {
    return null
  }
  const prefix = recording.s3_key.slice(0, recording.s3_key.lastIndexOf('/'))
  return { recording, prefix, serviceClient }
}

async function loadIndexes(prefix: string) {
  const [playersIndex, highlightsIndex, matchJson] = await Promise.all([
    getJsonObject<PlayersIndexDoc>(`${prefix}/players.index.json`),
    getJsonObject<HighlightsIndexDoc>(`${prefix}/highlights.index.json`),
    getJsonObject<MatchJsonDoc>(`${prefix}/match.json`),
  ])
  return { playersIndex, highlightsIndex, matchJson }
}

/** Union of player ids known from the crops index and the match stats. */
function knownPlayerIds(
  playersIndex: PlayersIndexDoc | null,
  matchJson: MatchJsonDoc | null
): Set<string> {
  const ids = new Set<string>()
  for (const p of playersIndex?.players || []) {
    if (typeof p.playerId === 'string') ids.add(p.playerId)
  }
  for (const id of Object.keys(matchJson?.player_stats || {})) {
    ids.add(id)
  }
  return ids
}

// ── GET ─────────────────────────────────────────────────────────────

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { id: recordingId } = await params
  if (!UUID_RE.test(recordingId)) {
    return NextResponse.json({ error: 'Invalid recording id' }, { status: 400 })
  }

  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    )
  }

  const access = await checkRecordingAccess(recordingId, user.id)
  if (!access.hasAccess) {
    return NextResponse.json({ error: access.reason }, { status: 403 })
  }

  const loaded = await loadClutchRecording(recordingId)
  if (!loaded) {
    return NextResponse.json(
      { error: 'No Clutch data for this recording' },
      { status: 404 }
    )
  }
  const { prefix, serviceClient } = loaded

  const [{ playersIndex, highlightsIndex, matchJson }, labelsResult] =
    await Promise.all([
      loadIndexes(prefix),
      (serviceClient as any)
        .from('playhub_clutch_player_labels')
        .select('provider_player_id, display_name')
        .eq('match_recording_id', recordingId),
    ])

  // A labels query failure degrades to unlabeled rather than 500ing the
  // whole stats/clips payload.
  if (labelsResult?.error) {
    console.error('Failed to load player labels:', labelsResult.error)
  }
  const labels = new Map<string, string>(
    (labelsResult?.data || []).map((l: any) => [
      l.provider_player_id,
      l.display_name,
    ])
  )

  // Sign a key → URL, caching within this request (crops can repeat).
  // Prefix containment: index docs are Lambda-written, but never sign a key
  // outside this recording's own prefix — one index-injection bug elsewhere
  // must not become an arbitrary-bucket-key signing oracle.
  const signed = new Map<string, string>()
  const sign = async (key: string | null | undefined) => {
    if (!key || !key.startsWith(`${prefix}/`)) return null
    if (!signed.has(key)) {
      try {
        signed.set(key, await getPlaybackUrl(key, SIGN_TTL_SECONDS))
      } catch (err) {
        console.error(`Failed to sign ${key}:`, err)
        return null
      }
    }
    return signed.get(key)!
  }

  // players: union of crops index + stats ids, every part nullable
  const pairByPlayer = new Map<string, string>()
  for (const [pair, ids] of Object.entries(
    matchJson?.player_ids_mapping_to_pair || {}
  )) {
    if (Array.isArray(ids)) for (const id of ids) pairByPlayer.set(id, pair)
  }

  const cropByPlayer = new Map<string, string | null>(
    (playersIndex?.players || [])
      .filter((p) => typeof p.playerId === 'string')
      .map((p) => [p.playerId!, p.cropKey ?? null])
  )
  const groundTruth = new Set(
    (playersIndex?.players || [])
      .filter((p) => p.isGroundTruth === true && typeof p.playerId === 'string')
      .map((p) => p.playerId!)
  )

  const players = await Promise.all(
    Array.from(knownPlayerIds(playersIndex, matchJson)).map(async (id) => {
      const stats = matchJson?.player_stats?.[id]
      return {
        playerId: id,
        displayName: labels.get(id) ?? null,
        isGroundTruth: groundTruth.has(id),
        cropUrl: await sign(cropByPlayer.get(id)),
        pair: pairByPlayer.get(id) ?? null,
        stats: stats
          ? {
              distanceRunMeters: stats.distance_run_meters ?? null,
              nShots: stats.n_shots ?? null,
              winnerShots: stats.winner_shots ?? null,
              errorShots: stats.error_shots ?? null,
              rating: stats.rating ?? null,
            }
          : null,
      }
    })
  )

  // clips: signed entries mirroring the index structure
  let clips: any = null
  if (highlightsIndex) {
    const signEntry = async (entry: ClipEntryDoc | undefined) =>
      entry?.clip
        ? { url: await sign(entry.clip), thumbUrl: await sign(entry.thumb) }
        : null

    const full: Record<string, unknown> = {}
    const fullKeyMap: Record<string, string> = {
      match_wo_breaks: 'matchWoBreaks',
      clutch_autopan: 'clutchAutopan',
      clutch_landscape: 'clutchLandscape',
    }
    for (const [rawKey, camelKey] of Object.entries(fullKeyMap)) {
      const entry = await signEntry(highlightsIndex.full?.[rawKey])
      if (entry) full[camelKey] = entry
    }

    const selectors: Record<string, Record<string, unknown[]>> = {}
    for (const surface of ['autopan', 'landscape']) {
      selectors[surface] = {}
      const bySelector = highlightsIndex.selectors?.[surface] || {}
      for (const [selector, entries] of Object.entries(bySelector)) {
        selectors[surface][selector] = (
          await Promise.all((entries || []).map(signEntry))
        ).filter(Boolean)
      }
    }
    clips = { full, selectors }
  }

  const stats = matchJson?.match_stats
    ? {
        matchTimeMinutes: matchJson.match_stats.match_time_minutes ?? null,
        matchTimeInPlayMinutes:
          matchJson.match_stats.match_time_in_play_minutes ?? null,
        avgRallyShots: matchJson.match_stats.avg_rally_shots ?? null,
        avgRallySeconds: matchJson.match_stats.avg_rally_seconds ?? null,
        longestRallyShots: matchJson.match_stats.longest_rally_shots ?? null,
        longestRallySeconds:
          matchJson.match_stats.longest_rally_seconds ?? null,
      }
    : null

  return NextResponse.json(
    { stats, players, clips },
    // Signed URLs are per-viewer secrets — never cache
    { headers: { 'Cache-Control': 'private, no-store' } }
  )
}

// ── PATCH ───────────────────────────────────────────────────────────

interface PutLabel {
  playerId: string
  displayName: string | null
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const crossOrigin = rejectCrossOrigin(request)
  if (crossOrigin) return crossOrigin

  const { id: recordingId } = await params
  if (!UUID_RE.test(recordingId)) {
    return NextResponse.json({ error: 'Invalid recording id' }, { status: 400 })
  }

  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json(
      { error: 'Authentication required' },
      { status: 401 }
    )
  }

  const access = await checkRecordingAccess(recordingId, user.id)
  if (!access.hasAccess) {
    return NextResponse.json({ error: access.reason }, { status: 403 })
  }

  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return NextResponse.json(
      { error: 'Content-Type must be application/json' },
      { status: 415 }
    )
  }

  let body: { labels?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!Array.isArray(body.labels) || body.labels.length === 0) {
    return NextResponse.json(
      { error: 'labels must be a non-empty array' },
      { status: 400 }
    )
  }
  if (body.labels.length > MAX_LABELS) {
    return NextResponse.json(
      { error: `At most ${MAX_LABELS} labels per request` },
      { status: 400 }
    )
  }

  const loaded = await loadClutchRecording(recordingId)
  if (!loaded) {
    return NextResponse.json(
      { error: 'No Clutch data for this recording' },
      { status: 404 }
    )
  }
  const { prefix, serviceClient } = loaded

  // Validate against the server-side player universe — never trust the
  // client's player list.
  const { playersIndex, matchJson } = await loadIndexes(prefix)
  const validIds = knownPlayerIds(playersIndex, matchJson)

  const seen = new Set<string>()
  const labels: PutLabel[] = []
  for (const raw of body.labels as unknown[]) {
    const entry = raw as { playerId?: unknown; displayName?: unknown }
    if (
      typeof entry?.playerId !== 'string' ||
      !PLAYER_ID_RE.test(entry.playerId)
    ) {
      return NextResponse.json({ error: 'Invalid playerId' }, { status: 400 })
    }
    if (!validIds.has(entry.playerId)) {
      return NextResponse.json(
        { error: `Unknown playerId: ${entry.playerId}` },
        { status: 400 }
      )
    }
    if (seen.has(entry.playerId)) {
      return NextResponse.json(
        { error: `Duplicate playerId: ${entry.playerId}` },
        { status: 400 }
      )
    }
    seen.add(entry.playerId)

    if (entry.displayName === null) {
      labels.push({ playerId: entry.playerId, displayName: null })
      continue
    }
    if (typeof entry.displayName !== 'string') {
      return NextResponse.json(
        { error: 'displayName must be a string or null' },
        { status: 400 }
      )
    }
    // Strip control/invisible codepoints (RTL overrides, zero-width chars)
    // and collapse whitespace — name spoofing hygiene, not XSS (React
    // escapes on render).
    const trimmed = entry.displayName
      .replace(/\p{C}/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (trimmed.length < 1 || trimmed.length > NAME_MAX) {
      return NextResponse.json(
        { error: `displayName must be 1-${NAME_MAX} characters` },
        { status: 400 }
      )
    }
    labels.push({ playerId: entry.playerId, displayName: trimmed })
  }

  const upserts = labels
    .filter((l) => l.displayName !== null)
    .map((l) => ({
      match_recording_id: recordingId,
      provider_player_id: l.playerId,
      display_name: l.displayName,
      labeled_by: user.id,
      updated_at: new Date().toISOString(),
    }))
  const deletions = labels
    .filter((l) => l.displayName === null)
    .map((l) => l.playerId)

  if (upserts.length > 0) {
    const { error } = await (serviceClient as any)
      .from('playhub_clutch_player_labels')
      .upsert(upserts, { onConflict: 'match_recording_id,provider_player_id' })
    if (error) {
      console.error('Failed to upsert player labels:', error)
      return NextResponse.json(
        { error: 'Failed to save labels' },
        { status: 500 }
      )
    }
  }

  if (deletions.length > 0) {
    const { error } = await (serviceClient as any)
      .from('playhub_clutch_player_labels')
      .delete()
      .eq('match_recording_id', recordingId)
      .in('provider_player_id', deletions)
    if (error) {
      console.error('Failed to clear player labels:', error)
      return NextResponse.json(
        { error: 'Failed to save labels' },
        { status: 500 }
      )
    }
  }

  return NextResponse.json({
    ok: true,
    labels: labels.map((l) => ({
      playerId: l.playerId,
      displayName: l.displayName,
    })),
  })
}
