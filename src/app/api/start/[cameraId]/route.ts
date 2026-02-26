// GET /api/start/[cameraId] — Public booking config (resolves camera → venue)
// POST /api/start/[cameraId] — Create Stripe PaymentIntent for inline payment

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
})

type RouteContext = { params: Promise<{ cameraId: string }> }

// Stripe UK doesn't support KWD — charge in EUR instead
const CHARGE_CURRENCY = 'eur'

// In-memory FX rate cache (1 hour TTL)
let cachedRate: { rate: number; fetchedAt: number } | null = null
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

const FALLBACK_KWD_TO_EUR_RATE = 2.95

async function getKwdToEurRate(): Promise<number> {
  if (cachedRate && Date.now() - cachedRate.fetchedAt < CACHE_TTL_MS) {
    return cachedRate.rate
  }

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/KWD', {
      signal: AbortSignal.timeout(5000),
    })
    const data = await res.json()

    if (data.result !== 'success' || !data.rates?.EUR) {
      return cachedRate?.rate ?? FALLBACK_KWD_TO_EUR_RATE
    }

    cachedRate = { rate: data.rates.EUR, fetchedAt: Date.now() }
    return cachedRate.rate
  } catch {
    return cachedRate?.rate ?? FALLBACK_KWD_TO_EUR_RATE
  }
}

// Resolve camera (scene_id) → venue info + billing config
async function resolveCamera(cameraId: string) {
  const serviceClient = createServiceClient() as any

  // Look up scene → venue mapping
  const { data: mapping } = await serviceClient
    .from('playhub_scene_venue_mapping')
    .select('organization_id, scene_name')
    .eq('scene_id', cameraId)
    .maybeSingle()

  if (!mapping) return null

  // Get venue info from organizations table
  const { data: venue } = await serviceClient
    .from('organizations')
    .select('id, name')
    .eq('id', mapping.organization_id)
    .single()

  if (!venue) return null

  // Get billing config
  const { data: config } = await serviceClient
    .from('playhub_venue_billing_config')
    .select(
      'default_billable_amount, currency, booking_durations, booking_enabled'
    )
    .eq('organization_id', mapping.organization_id)
    .maybeSingle()

  return { mapping, venue, config }
}

// GET — Return venue info + booking config (public, no auth)
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { cameraId } = await params

  const resolved = await resolveCamera(cameraId)

  if (!resolved) {
    return NextResponse.json({ error: 'Camera not found' }, { status: 404 })
  }

  const { mapping, venue, config } = resolved

  if (!config?.booking_enabled) {
    return NextResponse.json(
      { error: 'Self-service booking not enabled for this venue' },
      { status: 404 }
    )
  }

  const price = Number(config.default_billable_amount) || 5
  const currency = config.currency || 'KWD'

  // If venue currency isn't supported by Stripe UK, provide EUR equivalent
  let chargePrice = price
  let chargeCurrency = currency
  if (currency.toUpperCase() === 'KWD') {
    const rate = await getKwdToEurRate()
    chargePrice = Math.round(price * rate * 100) / 100 // round to 2 decimals
    chargeCurrency = 'EUR'
  }

  return NextResponse.json({
    venueName: venue.name,
    sceneName: mapping.scene_name || 'Pitch',
    durations: config.booking_durations || [60],
    price,
    currency,
    chargePrice,
    chargeCurrency,
  })
}

// POST — Create Stripe PaymentIntent for inline payment (public, no auth)
export async function POST(request: NextRequest, { params }: RouteContext) {
  const { cameraId } = await params

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { durationMinutes } = body
  const email = body.email?.trim().toLowerCase()

  if (!durationMinutes || !email) {
    return NextResponse.json(
      { error: 'durationMinutes and email are required' },
      { status: 400 }
    )
  }

  // Basic email validation
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json(
      { error: 'Invalid email address' },
      { status: 400 }
    )
  }

  const resolved = await resolveCamera(cameraId)

  if (!resolved) {
    return NextResponse.json({ error: 'Camera not found' }, { status: 404 })
  }

  const { mapping, venue, config } = resolved

  if (!config?.booking_enabled) {
    return NextResponse.json(
      { error: 'Self-service booking not enabled' },
      { status: 404 }
    )
  }

  // Validate duration is allowed
  const allowedDurations: number[] = config.booking_durations || [60]
  if (!allowedDurations.includes(durationMinutes)) {
    return NextResponse.json(
      {
        error: `Duration must be one of: ${allowedDurations.join(', ')} minutes`,
      },
      { status: 400 }
    )
  }

  // Calculate price (flat rate per recording regardless of duration)
  const price = Number(config.default_billable_amount) || 5
  const venueCurrency = (config.currency || 'KWD').toUpperCase()

  // Convert to EUR if venue currency not supported by Stripe UK
  let chargeAmount: number
  let chargeCurrency: string
  if (venueCurrency === 'KWD') {
    const rate = await getKwdToEurRate()
    const eurPrice = price * rate
    chargeAmount = Math.round(eurPrice * 100) // EUR uses 2 decimal places
    chargeCurrency = CHARGE_CURRENCY
  } else {
    chargeAmount = Math.round(price * 100)
    chargeCurrency = venueCurrency.toLowerCase()
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: chargeAmount,
      currency: chargeCurrency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        type: 'camera_booking',
        cameraId,
        venueId: venue.id,
        durationMinutes: String(durationMinutes),
        email,
        sceneName: mapping.scene_name || 'Pitch',
      },
      receipt_email: email,
      description: `${venue.name} — ${mapping.scene_name || 'Pitch'} Recording (${durationMinutes} min)`,
    })

    return NextResponse.json({ clientSecret: paymentIntent.client_secret })
  } catch (error) {
    console.error('Stripe PaymentIntent error:', error)
    return NextResponse.json(
      { error: 'Failed to create payment' },
      { status: 500 }
    )
  }
}
