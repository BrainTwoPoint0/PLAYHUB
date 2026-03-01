// GET/PUT /api/org/[slug]/marketplace — Org-level marketplace settings

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

type RouteContext = { params: Promise<{ slug: string }> }

async function resolveOrg(slug: string) {
  const serviceClient = createServiceClient() as any
  const { data } = await serviceClient
    .from('organizations')
    .select('id, marketplace_enabled, default_price_amount, default_price_currency')
    .eq('slug', slug)
    .maybeSingle()
  return data
}

// GET — read marketplace settings for an org
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const org = await resolveOrg(slug)
  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  const isAdmin = await isVenueAdmin(user.id, org.id)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  return NextResponse.json({
    marketplace_enabled: org.marketplace_enabled || false,
    default_price_amount: org.default_price_amount,
    default_price_currency: org.default_price_currency || 'AED',
  })
}

// PUT — update marketplace settings
export async function PUT(request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const supabase = await createClient()

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const org = await resolveOrg(slug)
  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
  }

  const isAdmin = await isVenueAdmin(user.id, org.id)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const VALID_CURRENCIES = ['AED', 'USD', 'GBP', 'EUR', 'KWD']
  const updates: Record<string, unknown> = {}

  if (body.marketplace_enabled !== undefined) {
    if (typeof body.marketplace_enabled !== 'boolean') {
      return NextResponse.json({ error: 'marketplace_enabled must be a boolean' }, { status: 400 })
    }
    updates.marketplace_enabled = body.marketplace_enabled
  }
  if (body.default_price_amount !== undefined) {
    const amount = Number(body.default_price_amount)
    if (body.default_price_amount !== null && (isNaN(amount) || amount < 0 || amount > 100000)) {
      return NextResponse.json({ error: 'Invalid price amount' }, { status: 400 })
    }
    updates.default_price_amount = body.default_price_amount === null ? null : amount
  }
  if (body.default_price_currency !== undefined) {
    if (!VALID_CURRENCIES.includes(body.default_price_currency)) {
      return NextResponse.json({ error: 'Invalid currency' }, { status: 400 })
    }
    updates.default_price_currency = body.default_price_currency
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  const serviceClient = createServiceClient() as any
  const { data, error } = await serviceClient
    .from('organizations')
    .update(updates)
    .eq('id', org.id)
    .select('marketplace_enabled, default_price_amount, default_price_currency')
    .single()

  if (error) {
    console.error('Failed to update marketplace settings:', error)
    return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  }

  return NextResponse.json(data)
}
