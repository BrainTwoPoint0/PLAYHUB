// POST /api/recordings/[id]/marketplace — list (or update listing of) an
//   existing recording on the marketplace. Creates or updates a row in
//   playhub_products. The product's `is_available` flag is the single source
//   of truth for "this recording is for sale" — `playhub_match_recordings.
//   marketplace_enabled` is denormalized/legacy and is no longer written here
//   to avoid the dual-write race two parallel admin requests can hit.
//
// DELETE /api/recordings/[id]/marketplace — unlist. Marks the product row
//   as unavailable (preserved for purchase-history integrity).
//
// Auth: venue admin only — same gate the share-token endpoint uses.
// Service-role client bypasses RLS; isVenueAdmin is the authorisation gate.

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

const SUPPORTED_CURRENCIES = ['KWD', 'EUR', 'AED'] as const
type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number]

const MAX_PRICE = 100_000

interface ListingBody {
  price_amount?: unknown
  currency?: unknown
  is_available?: unknown
}

function parseBody(
  body: ListingBody
):
  | {
      ok: true
      price: number
      currency: SupportedCurrency
      isAvailable: boolean
    }
  | { ok: false; error: string } {
  const price = Number(body.price_amount)
  if (!Number.isFinite(price) || price <= 0 || price > MAX_PRICE) {
    return {
      ok: false,
      error: `price_amount must be a positive number under ${MAX_PRICE}`,
    }
  }
  const currency =
    typeof body.currency === 'string' ? body.currency.toUpperCase() : ''
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(currency)) {
    return {
      ok: false,
      error: `currency must be one of ${SUPPORTED_CURRENCIES.join(', ')}`,
    }
  }
  const isAvailable =
    body.is_available === undefined ? true : Boolean(body.is_available)
  return {
    ok: true,
    price,
    currency: currency as SupportedCurrency,
    isAvailable,
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient() as any

  const { data: recording } = await serviceClient
    .from('playhub_match_recordings')
    .select('id, organization_id, title, description, status')
    .eq('id', id)
    .maybeSingle()

  if (!recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  if (
    !recording.organization_id ||
    !(await isVenueAdmin(user.id, recording.organization_id))
  ) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  if (recording.status !== 'published') {
    return NextResponse.json(
      { error: 'Only published recordings can be listed for sale' },
      { status: 400 }
    )
  }

  let body: ListingBody
  try {
    body = (await request.json()) as ListingBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = parseBody(body)
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
  }

  // UPSERT: one product row per recording.
  const { data: existing } = await serviceClient
    .from('playhub_products')
    .select('id')
    .eq('match_recording_id', id)
    .maybeSingle()

  const productPayload = {
    match_recording_id: id,
    name: recording.title,
    description: recording.description ?? null,
    price_amount: parsed.price,
    currency: parsed.currency,
    is_available: parsed.isAvailable,
  }

  let product
  if (existing) {
    const { data, error } = await serviceClient
      .from('playhub_products')
      .update(productPayload)
      .eq('id', existing.id)
      .select('*')
      .single()
    if (error) {
      console.error('Failed to update marketplace product:', error)
      return NextResponse.json(
        { error: 'Failed to update listing' },
        { status: 500 }
      )
    }
    product = data
  } else {
    const { data, error } = await serviceClient
      .from('playhub_products')
      .insert(productPayload)
      .select('*')
      .single()
    if (error) {
      console.error('Failed to create marketplace product:', error)
      return NextResponse.json(
        { error: 'Failed to create listing' },
        { status: 500 }
      )
    }
    product = data
  }

  // Best-effort denormalised flag for legacy reads. Not authoritative —
  // playhub_products.is_available is the source of truth. Failure here is
  // logged but not surfaced.
  const { error: flagError } = await serviceClient
    .from('playhub_match_recordings')
    .update({ marketplace_enabled: parsed.isAvailable })
    .eq('id', id)
  if (flagError) {
    console.error(
      `[recording ${id}] best-effort marketplace_enabled flip failed:`,
      flagError
    )
  }

  return NextResponse.json({ product })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient() as any

  const { data: recording } = await serviceClient
    .from('playhub_match_recordings')
    .select('id, organization_id')
    .eq('id', id)
    .maybeSingle()

  if (!recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  if (
    !recording.organization_id ||
    !(await isVenueAdmin(user.id, recording.organization_id))
  ) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  // Mark all product rows for this recording unavailable (typically just one).
  // Keep the rows so historical purchases continue to reference the listing.
  const { error: productError } = await serviceClient
    .from('playhub_products')
    .update({ is_available: false })
    .eq('match_recording_id', id)

  if (productError) {
    console.error(
      `[recording ${id}] failed to mark product unavailable:`,
      productError
    )
    return NextResponse.json({ error: 'Failed to unlist' }, { status: 500 })
  }

  await serviceClient
    .from('playhub_match_recordings')
    .update({ marketplace_enabled: false })
    .eq('id', id)

  return NextResponse.json({ success: true })
}
