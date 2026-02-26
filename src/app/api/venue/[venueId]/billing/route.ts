// GET/PUT /api/venue/[venueId]/billing
// Venue billing configuration

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'

type RouteContext = { params: Promise<{ venueId: string }> }

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Venue admin or platform admin
  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, venueId),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const serviceClient = createServiceClient() as any

  const { data, error } = await serviceClient
    .from('playhub_venue_billing_config')
    .select('*')
    .eq('organization_id', venueId)
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Return config or defaults
  return NextResponse.json({
    config: data || {
      organization_id: venueId,
      billing_model: 'per_recording',
      default_billable_amount: 5.0,
      currency: 'KWD',
      daily_recording_target: 0,
      is_active: false,
    },
    exists: !!data,
  })
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Platform admin only for billing config changes
  const isPlatform = await isPlatformAdmin(user.id)
  if (!isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const {
    billing_model,
    default_billable_amount,
    currency,
    fixed_cost_per_recording,
    venue_profit_share_pct,
    stripe_customer_id,
    daily_recording_target,
    is_active,
  } = body

  const serviceClient = createServiceClient() as any

  const { data, error } = await serviceClient
    .from('playhub_venue_billing_config')
    .upsert(
      {
        organization_id: venueId,
        billing_model: billing_model || 'per_recording',
        default_billable_amount: default_billable_amount ?? 5.0,
        currency: currency || 'KWD',
        fixed_cost_per_recording: fixed_cost_per_recording ?? 0.0,
        venue_profit_share_pct: venue_profit_share_pct ?? 30.0,
        stripe_customer_id: stripe_customer_id || null,
        daily_recording_target: daily_recording_target ?? 0,
        is_active: is_active ?? true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id' }
    )
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ config: data })
}
