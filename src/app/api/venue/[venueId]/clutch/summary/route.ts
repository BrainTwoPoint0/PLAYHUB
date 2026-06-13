// GET /api/venue/[venueId]/clutch/summary — venue-level padel analytics.
// Aggregates the clutch_match_stats jsonb the sync Lambda denormalizes at
// publish, entirely in route code (venues have at most hundreds of Clutch
// rows — same pattern as billing/daily-stats; no RPC needed).

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'

type RouteContext = { params: Promise<{ venueId: string }> }

const WINDOW_DAYS = 30

interface ClutchStatsDoc {
  match_time_minutes?: number
  match_time_in_play_minutes?: number
  avg_rally_shots?: number
  avg_rally_seconds?: number
  longest_rally_shots?: number
  longest_rally_seconds?: number
  players?: number
}

interface ClutchRow {
  id: string
  title: string
  match_date: string
  pitch_name: string | null
  clutch_match_stats: ClutchStatsDoc | null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, venueId),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const serviceClient = createServiceClient() as any

  // Group orgs aggregate their child venues, same as the recordings route —
  // Masaha-style venues live under a group parent (Li3ib).
  const { data: orgInfo } = await serviceClient
    .from('organizations')
    .select('type')
    .eq('id', venueId)
    .single()

  let orgIds = [venueId]
  if (orgInfo?.type === 'group') {
    const { data: children } = await serviceClient
      .from('organizations')
      .select('id')
      .eq('parent_organization_id', venueId)
      .eq('is_active', true)
    if (children) {
      orgIds = [venueId, ...children.map((c: any) => c.id)]
    }
  }

  // 1000 is PostgREST's db-max-rows ceiling — a higher .limit() would be
  // silently clamped. Newest-first so if a venue ever exceeds it, truncation
  // sheds the oldest data (the 30-day chart stays correct).
  const { data, error } = await serviceClient
    .from('playhub_match_recordings')
    .select('id, title, match_date, pitch_name, clutch_match_stats')
    .in('organization_id', orgIds)
    .not('clutch_video_id', 'is', null)
    .eq('status', 'published')
    .order('match_date', { ascending: false })
    .limit(1000)

  if (error) {
    console.error('Failed to load clutch recordings:', error)
    return NextResponse.json(
      { error: 'Failed to load padel analytics' },
      { status: 500 }
    )
  }

  const rows = (data || []) as ClutchRow[]

  // ── headline aggregates (rows without stats count in totals only) ──
  let totalInPlayMinutes = 0
  let rallyShotsSum = 0
  let rallyShotsCount = 0
  let rallySecondsSum = 0
  let rallySecondsCount = 0
  let withStats = 0
  let longestRally: {
    shots: number
    seconds: number | null
    recordingId: string
    title: string
    matchDate: string
  } | null = null

  for (const row of rows) {
    const stats = row.clutch_match_stats
    if (!stats) continue
    withStats++

    const inPlay = finite(stats.match_time_in_play_minutes)
    if (inPlay !== null) totalInPlayMinutes += inPlay

    const avgShots = finite(stats.avg_rally_shots)
    if (avgShots !== null) {
      rallyShotsSum += avgShots
      rallyShotsCount++
    }
    const avgSeconds = finite(stats.avg_rally_seconds)
    if (avgSeconds !== null) {
      rallySecondsSum += avgSeconds
      rallySecondsCount++
    }

    const shots = finite(stats.longest_rally_shots)
    if (
      shots !== null &&
      (!longestRally ||
        shots > longestRally.shots ||
        (shots === longestRally.shots &&
          row.match_date > longestRally.matchDate))
    ) {
      longestRally = {
        shots,
        seconds: finite(stats.longest_rally_seconds),
        recordingId: row.id,
        title: row.title,
        matchDate: row.match_date,
      }
    }
  }

  // ── day × court grid, zero-filled for the last WINDOW_DAYS ─────────
  const dayMap = new Map<
    string,
    { total: number; byCourt: Record<string, number> }
  >()
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
    dayMap.set(date, { total: 0, byCourt: {} })
  }
  // Courts scoped to the chart window so idle courts don't render as
  // flat-zero series. Sorted for stable chart colors across refreshes.
  const courts = new Set<string>()
  for (const row of rows) {
    const court = row.pitch_name || 'Unknown'
    const date = new Date(row.match_date).toISOString().slice(0, 10)
    const bucket = dayMap.get(date)
    if (!bucket) continue // outside the window — still in totals above
    courts.add(court)
    bucket.total++
    bucket.byCourt[court] = (bucket.byCourt[court] || 0) + 1
  }

  // ── named players (distinct, case/whitespace-insensitive) ──────────
  // Batched: hundreds of UUIDs in one .in() would blow PostgREST's GET
  // query-string limits. Analytics must not 500 on a label hiccup.
  let namedPlayers = 0
  if (rows.length > 0) {
    const names = new Set<string>()
    const ids = rows.map((r) => r.id)
    const BATCH = 200
    try {
      for (let i = 0; i < ids.length; i += BATCH) {
        const { data: labels, error: labelsError } = await serviceClient
          .from('playhub_clutch_player_labels')
          .select('display_name')
          .in('match_recording_id', ids.slice(i, i + BATCH))
        if (labelsError) throw labelsError
        for (const l of labels || []) {
          const name = String(l.display_name || '')
            .trim()
            .toLowerCase()
          if (name) names.add(name)
        }
      }
      namedPlayers = names.size
    } catch (labelsError) {
      console.error('Failed to load player labels:', labelsError)
      namedPlayers = 0
    }
  }

  return NextResponse.json(
    {
      totalRecordings: rows.length,
      withStats,
      totalInPlayMinutes: round1(totalInPlayMinutes),
      avgRallyShots: rallyShotsCount
        ? round1(rallyShotsSum / rallyShotsCount)
        : null,
      avgRallySeconds: rallySecondsCount
        ? round1(rallySecondsSum / rallySecondsCount)
        : null,
      longestRally,
      namedPlayers,
      courts: Array.from(courts),
      days: Array.from(dayMap.entries()).map(([date, bucket]) => ({
        date,
        ...bucket,
      })),
    },
    { headers: { 'Cache-Control': 'private, no-store' } }
  )
}
