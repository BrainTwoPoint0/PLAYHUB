// POST   /api/profile/[id]/verify   — club admin issues a verification edge
// DELETE /api/profile/[id]/verify   — club admin revokes their org's verification
//
// Verifications are per-(profile, org) edges, NOT a boolean on the profile.
// Multi-club verifications stack (CFA + SEFA can both verify the same player).
// A revoked verification keeps the historical row; the badge query filters to
// revoked_at IS NULL.

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { rejectCrossOrigin } from '@/lib/security/origin-check'
import { NextRequest, NextResponse } from 'next/server'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEASON_LABEL_MAX = 64

type RouteContext = { params: Promise<{ id: string }> }

interface VerifyBody {
  organizationId: string
  profileVariantId?: string | null
  seasonLabel?: string | null
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const csrf = rejectCrossOrigin(request)
  if (csrf) return csrf

  const { id: profileId } = await params
  if (!UUID_RE.test(profileId)) {
    return NextResponse.json({ error: 'Invalid profile id' }, { status: 400 })
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

  let body: VerifyBody
  try {
    body = (await request.json()) as VerifyBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.organizationId || !UUID_RE.test(body.organizationId)) {
    return NextResponse.json(
      { error: 'Valid organizationId required' },
      { status: 400 }
    )
  }
  if (
    body.profileVariantId !== undefined &&
    body.profileVariantId !== null &&
    !UUID_RE.test(body.profileVariantId)
  ) {
    return NextResponse.json(
      { error: 'profileVariantId must be a valid UUID or null' },
      { status: 400 }
    )
  }
  if (body.seasonLabel !== undefined && body.seasonLabel !== null) {
    if (
      typeof body.seasonLabel !== 'string' ||
      body.seasonLabel.length > SEASON_LABEL_MAX
    ) {
      return NextResponse.json(
        { error: `seasonLabel must be a string ≤${SEASON_LABEL_MAX} chars` },
        { status: 400 }
      )
    }
  }

  const isAdmin =
    (await isVenueAdmin(user.id, body.organizationId)) ||
    (await isPlatformAdmin(user.id))
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  const supabase = createServiceClient() as any

  // Cross-org abuse gate: only allow verifying a profile that's actually on
  // this org's roster (active organization_members row). Without this, any
  // club admin could issue verifications against arbitrary profiles in the
  // database — making "Verified by CFA" worthless as a trust signal.
  const { data: rosterRow } = await supabase
    .from('organization_members')
    .select('id')
    .eq('organization_id', body.organizationId)
    .eq('profile_id', profileId)
    .eq('is_active', true)
    .maybeSingle()
  if (!rosterRow) {
    return NextResponse.json(
      { error: 'Profile is not on this organization roster' },
      { status: 409 }
    )
  }

  // Find the membership row that's issuing this verification, so verification
  // ownership survives a member's deactivation (FK is ON DELETE SET NULL).
  const { data: profileRow } = await supabase
    .from('profiles')
    .select('id')
    .eq('user_id', user.id)
    .single()
  if (!profileRow) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
  }

  const { data: membershipRow } = await supabase
    .from('organization_members')
    .select('id')
    .eq('organization_id', body.organizationId)
    .eq('profile_id', profileRow.id)
    .eq('is_active', true)
    .maybeSingle()

  // Reject duplicate active verification by the same org for the same profile
  // (or variant if scoped). Idempotent: returns 200 + existing row.
  const dupQuery = supabase
    .from('profile_verifications')
    .select('id, season_label, verified_at, revoked_at')
    .eq('profile_id', profileId)
    .eq('verifying_org_id', body.organizationId)
    .is('revoked_at', null)
    .order('verified_at', { ascending: false })
    .limit(1)
  if (body.profileVariantId) {
    dupQuery.eq('profile_variant_id', body.profileVariantId)
  } else {
    dupQuery.is('profile_variant_id', null)
  }
  const { data: existing } = await dupQuery
  if (existing && existing.length > 0) {
    return NextResponse.json({ verification: existing[0], existed: true })
  }

  const { data: inserted, error } = await supabase
    .from('profile_verifications')
    .insert({
      profile_id: profileId,
      profile_variant_id: body.profileVariantId ?? null,
      verifying_org_id: body.organizationId,
      verified_by_membership_id: membershipRow?.id ?? null,
      season_label: body.seasonLabel ?? null,
    })
    .select('id, season_label, verified_at, revoked_at')
    .single()

  if (error || !inserted) {
    // SQLSTATE 23505 = unique_violation. Two concurrent POSTs both passed the
    // dup-check SELECT and both INSERTed; the partial unique index killed the
    // loser. Re-fetch the winning row and return idempotent success so the
    // API contract holds under load.
    if (error && (error as any).code === '23505') {
      const { data: winner } = await dupQuery
      if (winner && winner.length > 0) {
        return NextResponse.json({ verification: winner[0], existed: true })
      }
    }
    console.error('verify insert failed', error)
    return NextResponse.json(
      { error: 'Failed to issue verification' },
      { status: 500 }
    )
  }

  return NextResponse.json({ verification: inserted, existed: false })
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const csrf = rejectCrossOrigin(request)
  if (csrf) return csrf

  const { id: profileId } = await params
  if (!UUID_RE.test(profileId)) {
    return NextResponse.json({ error: 'Invalid profile id' }, { status: 400 })
  }

  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const orgId = request.nextUrl.searchParams.get('organizationId')
  if (!orgId || !UUID_RE.test(orgId)) {
    return NextResponse.json(
      { error: 'Valid organizationId required' },
      { status: 400 }
    )
  }

  const isAdmin =
    (await isVenueAdmin(user.id, orgId)) ||
    (await isPlatformAdmin(user.id))
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  const supabase = createServiceClient() as any

  const { error } = await supabase
    .from('profile_verifications')
    .update({ revoked_at: new Date().toISOString() })
    .eq('profile_id', profileId)
    .eq('verifying_org_id', orgId)
    .is('revoked_at', null)

  if (error) {
    return NextResponse.json(
      { error: 'Failed to revoke verification' },
      { status: 500 }
    )
  }

  return NextResponse.json({ ok: true })
}
