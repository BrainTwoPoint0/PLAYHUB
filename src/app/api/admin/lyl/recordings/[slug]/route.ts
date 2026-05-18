// PATCH /api/admin/lyl/recordings/[slug]
//
// Operator override of a recording's assignment. Two flavours, exclusive:
//
//   { home_subclub_slug, home_age_group, away_subclub_slug, away_age_group }
//     → sets parse_method='manual', status='operator_locked'. The cron
//       skips operator_locked rows on subsequent runs.
//
//   { clear_override: true }
//     → resets status back to 'pending' so the cron re-processes from
//       scratch on next run.
//
// Validates: slugs match playhub_academy_subclubs (allowlist), age groups
// in U5..U21. Slug + age fields all required when overriding.
//
// Note: this endpoint only updates the assignment row. It does NOT
// re-execute Veo writes — the operator should also press "Re-trigger"
// (POST /retrigger) after editing if they want the new mapping applied
// to Veo immediately. We keep the steps separate so an edit can be
// staged + reviewed before being pushed to Veo.

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'

const LEAGUE_CLUB_SLUG = 'lyl'
// Slug + age regex mirror the parser's bounds for consistency.
const SUBCLUB_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const AGE_GROUP_RE = /^u(5|6|7|8|9|1[0-9]|2[01])$/

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { user } = await getAuthUserStrict()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { slug } = await params
  // Path-param shape check before any DB call.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(slug)) {
    return NextResponse.json({ error: 'invalid_slug' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
  }
  const b = body as Record<string, unknown>

  const supabase = createServiceClient() as any

  // Clear-override branch: reset to pending so cron re-processes.
  if (b.clear_override === true) {
    const { data, error } = await supabase
      .from('playhub_recording_assignments')
      .update({
        status: 'pending',
        parse_method: null,
        // Don't null parsed_* — keep the previous parse as audit trail;
        // cron's allowLlmFallback gate will re-derive based on title.
        last_processed_at: new Date().toISOString(),
      })
      .eq('league_club_slug', LEAGUE_CLUB_SLUG)
      .eq('recording_slug', slug)
      .select('*')
      .maybeSingle()
    if (error) {
      // Don't leak Postgres error text — log server-side, generic to client.
      console.error('PATCH /api/admin/lyl/recordings/[slug]: update failed', error)
      return NextResponse.json({ error: 'update_failed' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    return NextResponse.json({ recording: data })
  }

  // Override branch: all 4 fields required + allowlist-checked.
  const homeSubclub = typeof b.home_subclub_slug === 'string' ? b.home_subclub_slug : null
  const awaySubclub = typeof b.away_subclub_slug === 'string' ? b.away_subclub_slug : null
  const homeAge = typeof b.home_age_group === 'string' ? b.home_age_group : null
  const awayAge = typeof b.away_age_group === 'string' ? b.away_age_group : null
  if (!homeSubclub || !awaySubclub || !homeAge || !awayAge) {
    return NextResponse.json(
      { error: 'missing_fields', message: 'all four of home_subclub_slug, away_subclub_slug, home_age_group, away_age_group required' },
      { status: 400 }
    )
  }
  if (!SUBCLUB_SLUG_RE.test(homeSubclub) || !SUBCLUB_SLUG_RE.test(awaySubclub)) {
    return NextResponse.json({ error: 'invalid_subclub_slug_shape' }, { status: 400 })
  }
  if (!AGE_GROUP_RE.test(homeAge) || !AGE_GROUP_RE.test(awayAge)) {
    return NextResponse.json({ error: 'invalid_age_group' }, { status: 400 })
  }

  // Allowlist check — the supplied subclub slugs must exist + be active
  // for this league. Prevents the operator from typoing a slug that
  // would later fail the cron's FK validation.
  const { data: subclubs, error: subclubsErr } = await supabase
    .from('playhub_academy_subclubs')
    .select('subclub_slug')
    .eq('club_slug', LEAGUE_CLUB_SLUG)
    .eq('is_active', true)
    .in('subclub_slug', [homeSubclub, awaySubclub])
  if (subclubsErr) {
    console.error('PATCH /api/admin/lyl/recordings/[slug]: subclub check failed', subclubsErr)
    return NextResponse.json({ error: 'subclub_check_failed' }, { status: 500 })
  }
  const found = new Set((subclubs as { subclub_slug: string }[]).map((s) => s.subclub_slug))
  if (!found.has(homeSubclub) || !found.has(awaySubclub)) {
    return NextResponse.json(
      {
        error: 'unknown_subclub',
        message: `subclub(s) not found or inactive: ${[homeSubclub, awaySubclub]
          .filter((s) => !found.has(s))
          .join(', ')}`,
      },
      { status: 400 }
    )
  }

  const { data, error } = await supabase
    .from('playhub_recording_assignments')
    .update({
      parsed_home_subclub_slug: homeSubclub,
      parsed_away_subclub_slug: awaySubclub,
      parsed_home_age_group: homeAge,
      parsed_away_age_group: awayAge,
      parse_method: 'manual',
      parse_confidence: null,
      parse_reasoning: null,
      status: 'operator_locked',
      failure_stage: null,
      last_error: null,
      last_processed_at: new Date().toISOString(),
    })
    .eq('league_club_slug', LEAGUE_CLUB_SLUG)
    .eq('recording_slug', slug)
    .select('*')
    .maybeSingle()
  if (error) {
    return NextResponse.json(
      { error: 'update_failed', message: error.message },
      { status: 500 }
    )
  }
  if (!data) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  return NextResponse.json({ recording: data })
}
