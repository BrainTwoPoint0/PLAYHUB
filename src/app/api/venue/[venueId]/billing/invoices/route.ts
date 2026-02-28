// GET/POST /api/venue/[venueId]/billing/invoices
// List invoices and generate invoice for a given month

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { generateMonthlyInvoice } from '@/lib/billing/generate-invoice'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
})

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

  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, venueId),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const serviceClient = createServiceClient() as any

  const { data: invoices, error } = await serviceClient
    .from('playhub_venue_invoices')
    .select('*')
    .eq('organization_id', venueId)
    .order('period_start', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ invoices: invoices || [] })
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { venueId } = await params
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Platform admin only
  const isPlatform = await isPlatformAdmin(user.id)
  if (!isPlatform) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { year, month } = body // month is 1-12

  if (!year || !month) {
    return NextResponse.json(
      { error: 'year and month are required' },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient() as any

  // Check billing config exists first (for better error message)
  const { data: config } = await serviceClient
    .from('playhub_venue_billing_config')
    .select('id')
    .eq('organization_id', venueId)
    .single()

  if (!config) {
    return NextResponse.json(
      { error: 'No billing config for this venue' },
      { status: 404 }
    )
  }

  try {
    const result = await generateMonthlyInvoice(venueId, year, month, {
      supabase: serviceClient,
      stripe,
    })

    if (!result) {
      return NextResponse.json(
        { error: 'Invoice already exists for this period' },
        { status: 409 }
      )
    }

    return NextResponse.json(result)
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
