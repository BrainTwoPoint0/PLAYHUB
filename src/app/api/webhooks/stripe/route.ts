import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createServiceClient } from '@/lib/supabase/server'
import { scheduleRecording } from '@/lib/spiideo/schedule-recording'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
})

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!

export async function POST(req: Request) {
  const body = await req.text()
  const headersList = await headers()
  const signature = headersList.get('stripe-signature')!

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // Handle checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session
    const metadata = session.metadata || {}

    // Check if this is a stream access purchase
    if (metadata.type === 'stream_access') {
      return handleStreamAccessPurchase(session, metadata)
    }

    // Check if this is a venue self-service booking
    if (metadata.type === 'venue_booking') {
      return handleVenueBooking(session, metadata)
    }

    // camera_booking is now handled via payment_intent.succeeded (inline payment)

    // Ignore sessions without PLAYHUB metadata (e.g. Stripe Payment Links, subscriptions)
    if (
      !metadata.type &&
      !metadata.product_id &&
      !metadata.match_recording_id
    ) {
      console.log(
        'Ignoring checkout session without PLAYHUB metadata:',
        session.id
      )
      return NextResponse.json({ received: true })
    }

    // Otherwise, handle match recording purchase (existing flow)
    return handleMatchRecordingPurchase(session, metadata)
  }

  // Handle payment_intent.succeeded (inline Stripe Elements payments)
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object as Stripe.PaymentIntent
    const metadata = paymentIntent.metadata || {}

    if (metadata.type === 'camera_booking') {
      return handleVenueBooking(paymentIntent, {
        ...metadata,
        sceneId: metadata.cameraId,
      })
    }
  }

  // Handle invoice payment events (venue billing)
  if (event.type === 'invoice.paid') {
    return handleInvoicePaid(event.data.object as Stripe.Invoice)
  }

  if (event.type === 'invoice.payment_failed') {
    return handleInvoicePaymentFailed(event.data.object as Stripe.Invoice)
  }

  return NextResponse.json({ received: true })
}

// Handle live stream access purchases
async function handleStreamAccessPurchase(
  session: Stripe.Checkout.Session,
  metadata: Record<string, string>
) {
  const { stream_id, access_type, user_id } = metadata

  if (!stream_id || !user_id) {
    console.error('Missing stream_id or user_id in metadata (unrecoverable):', session.id)
    return NextResponse.json({ received: true, error: 'Missing metadata' })
  }

  const supabase = createServiceClient()

  try {
    // Grant access to the stream (type assertion for PLAYHUB tables)
    const { error: accessError } = await (supabase as any)
      .from('playhub_stream_access')
      .upsert(
        {
          stream_id,
          user_id,
          access_source: 'purchase',
          stripe_payment_intent_id: session.payment_intent as string,
          amount_paid: session.amount_total ? session.amount_total / 100 : null,
          is_active: true,
          granted_at: new Date().toISOString(),
        },
        {
          onConflict: 'stream_id,user_id',
        }
      )

    if (accessError) {
      console.error('Error granting stream access:', accessError)
      return NextResponse.json(
        { error: 'Failed to grant access' },
        { status: 500 }
      )
    }

    // If group_unlock, mark the stream as unlocked
    if (access_type === 'group_unlock') {
      const { error: unlockError } = await (supabase as any)
        .from('playhub_live_streams')
        .update({
          is_unlocked: true,
          unlocked_by: user_id,
          unlocked_at: new Date().toISOString(),
        })
        .eq('id', stream_id)
        .eq('access_type', 'group_unlock')

      if (unlockError) {
        console.error('Error unlocking stream:', unlockError)
        // Continue - access was still granted to the purchaser
      } else {
        console.log('Stream unlocked for everyone:', stream_id)
      }
    }

    console.log('Stream access granted:', {
      stream_id,
      user_id,
      access_type,
      payment_intent: session.payment_intent,
    })

    return NextResponse.json({ received: true })
  } catch (error) {
    console.error('Stream access webhook error:', error)
    return NextResponse.json(
      { error: 'Failed to process stream access' },
      { status: 500 }
    )
  }
}

// Handle match recording purchases (existing flow)
async function handleMatchRecordingPurchase(
  session: Stripe.Checkout.Session,
  metadata: Record<string, string>
) {
  const { product_id, match_recording_id, user_id, profile_id } = metadata

  if (!product_id || !match_recording_id) {
    console.error(
      'Missing required metadata (product_id or match_recording_id) in session (unrecoverable):',
      session.id
    )
    return NextResponse.json({ received: true, error: 'Missing metadata' })
  }

  // Skip if guest purchase (no user/profile)
  if (user_id === 'guest' || profile_id === 'guest') {
    console.log(
      'Guest purchase - skipping database record creation:',
      session.id
    )
    return NextResponse.json({
      received: true,
      note: 'Guest purchase - no access granted',
    })
  }

  const supabase = createServiceClient()

  // Idempotency: skip if this session was already processed
  const { data: existingPurchase } = await (supabase as any)
    .from('playhub_purchases')
    .select('id')
    .eq('stripe_checkout_session_id', session.id)
    .maybeSingle()

  if (existingPurchase) {
    console.log('Match recording purchase already processed:', session.id)
    return NextResponse.json({ received: true })
  }

  // Look up organization_id from the match recording for revenue attribution
  let organizationId: string | null = null
  if (match_recording_id) {
    const { data: recData } = await (supabase as any)
      .from('playhub_match_recordings')
      .select('organization_id')
      .eq('id', match_recording_id)
      .maybeSingle()
    organizationId = recData?.organization_id || null
  }

  // Create purchase record (type assertion for PLAYHUB tables)
  // Store customer info directly on purchase for audit trail (persists even if user deletes account)
  const { data: purchase, error: purchaseError } = await (supabase as any)
    .from('playhub_purchases')
    .insert({
      profile_id,
      product_id,
      amount_paid: session.amount_total! / 100,
      currency: session.currency!,
      status: 'completed',
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent as string,
      customer_email: session.customer_details?.email || null,
      customer_name: session.customer_details?.name || null,
      organization_id: organizationId,
    })
    .select()
    .single()

  if (purchaseError) {
    console.error('Error creating purchase:', purchaseError)
    return NextResponse.json(
      { error: 'Failed to create purchase' },
      { status: 500 }
    )
  }

  // Grant access to the match (type assertion for PLAYHUB tables)
  const { error: accessError } = await (supabase as any)
    .from('playhub_access_rights')
    .insert({
      user_id,
      profile_id,
      match_recording_id,
      purchase_id: purchase.id,
      access_type: 'purchased',
      expires_at: null, // Lifetime access
    })

  if (accessError) {
    console.error('Error granting access:', accessError)
    return NextResponse.json(
      { error: 'Failed to grant access' },
      { status: 500 }
    )
  }

  console.log('Purchase completed and access granted:', {
    purchase_id: purchase.id,
    match_recording_id,
    profile_id,
  })

  // Send purchase confirmation email
  const customerEmail = session.customer_details?.email
  if (customerEmail && match_recording_id) {
    // Look up recording title for the email
    const { data: rec } = await (supabase as any)
      .from('playhub_match_recordings')
      .select('title, match_date, organizations:organization_id(name)')
      .eq('id', match_recording_id)
      .maybeSingle()

    if (rec) {
      const { sendRecordingAssignedEmail } = await import('@/lib/email')
      sendRecordingAssignedEmail({
        toEmail: customerEmail,
        recordingTitle: rec.title || 'Match Recording',
        matchDate: rec.match_date
          ? new Date(rec.match_date).toLocaleDateString('en-GB')
          : undefined,
        venueName: rec.organizations?.name,
        isReady: true,
      }).catch((err) => console.error('Failed to send purchase confirmation email:', err))
    }
  }

  return NextResponse.json({ received: true })
}

// Handle venue self-service QR booking
async function handleVenueBooking(
  event: Stripe.Checkout.Session | Stripe.PaymentIntent,
  metadata: Record<string, string>
) {
  const { venueId, sceneId, durationMinutes, email, sceneName } = metadata

  if (!venueId || !sceneId || !durationMinutes || !email) {
    console.error('Missing venue booking metadata (unrecoverable):', event.id)
    return NextResponse.json({ received: true, error: 'Missing metadata' })
  }

  // Idempotency: check if we already processed this payment
  // For checkout sessions, payment_intent can be null — fall back to session ID
  const paymentIntentId =
    ('payment_intent' in event && event.payment_intent
      ? (event.payment_intent as string)
      : null) || event.id

  const supabase = createServiceClient()

  // Check 1: by stripe_payment_intent_id (works for new records that store it)
  if (paymentIntentId) {
    const { data: existing } = await (supabase as any)
      .from('playhub_match_recordings')
      .select('id')
      .eq('stripe_payment_intent_id', paymentIntentId)
      .maybeSingle()

    if (existing) {
      console.log(
        'Venue booking already processed (by payment ID):',
        paymentIntentId
      )
      return NextResponse.json({ received: true })
    }
  }

  // Check 2: by venue + scene + recent time window (catches retries for records
  // created before the payment ID fix, or when payment_intent was null)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const { data: recentDup } = await (supabase as any)
    .from('playhub_match_recordings')
    .select('id')
    .eq('organization_id', venueId)
    .eq('pitch_name', sceneName || 'Pitch')
    .gte('created_at', fiveMinAgo)
    .maybeSingle()

  if (recentDup) {
    console.log(
      'Venue booking already processed (by recent duplicate check):',
      event.id
    )
    return NextResponse.json({ received: true })
  }

  const resolvedSceneName = sceneName || 'Pitch'
  const duration = parseInt(durationMinutes)

  try {
    const now = new Date()
    const result = await scheduleRecording({
      venueId,
      sceneId,
      sceneName: resolvedSceneName,
      durationMinutes: duration,
      title: `Self-service: ${resolvedSceneName} — ${now.toLocaleDateString('en-GB')}`,
      description: `Booked by ${email}`,
      email,
      collectedBy: 'playhub',
      startBufferMs: 60_000,
      stripePaymentIntentId: paymentIntentId || undefined,
    })

    console.log('Venue booking completed:', {
      venueId,
      sceneId,
      gameId: result.gameId,
      recordingId: result.recordingId,
      email,
      duration: durationMinutes,
      collected_by: 'playhub',
    })

    // Fire-and-forget: look up venue name and send booking confirmation email
    ;(async () => {
      let venueName = 'your venue'
      try {
        const { data: venue } = await supabase
          .from('organizations')
          .select('name')
          .eq('id', venueId)
          .single()
        if (venue?.name) venueName = venue.name
      } catch {
        // Use fallback name
      }

      const { sendBookingConfirmationEmail } = await import('@/lib/email')
      await sendBookingConfirmationEmail({
        toEmail: email,
        venueName,
        pitchName: resolvedSceneName,
        durationMinutes: duration,
      })
    })().catch((err) => console.error('Failed to send booking confirmation email:', err))

    return NextResponse.json({ received: true })
  } catch (error) {
    // Return 200 to prevent Stripe retries — Spiideo game may already be created,
    // and retrying would schedule duplicates
    console.error('Venue booking webhook error (acknowledged):', error)

    // Fire-and-forget: alert that customer paid but recording didn't schedule
    const alertEmail = process.env.ALERT_EMAIL
    if (alertEmail) {
      const { sendSchedulingFailureAlert } = await import('@/lib/email')
      sendSchedulingFailureAlert({
        toEmail: alertEmail,
        venueId,
        sceneName: resolvedSceneName,
        customerEmail: email,
        durationMinutes: duration,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      }).catch((err) => console.error('Failed to send scheduling failure alert:', err))
    } else {
      console.error('ALERT_EMAIL not configured — cannot send scheduling failure alert')
    }

    return NextResponse.json({ received: true, error: 'Failed to process venue booking' })
  }
}

// Handle invoice.paid — update venue invoice status to 'paid'
async function handleInvoicePaid(invoice: Stripe.Invoice) {
  const stripeInvoiceId = invoice.id
  const serviceClient = createServiceClient() as any

  const { error } = await serviceClient
    .from('playhub_venue_invoices')
    .update({ status: 'paid' })
    .eq('stripe_invoice_id', stripeInvoiceId)

  if (error) {
    console.error('Failed to mark invoice as paid:', error)
    return NextResponse.json(
      { error: 'Failed to update invoice status' },
      { status: 500 }
    )
  }

  console.log('Invoice marked as paid:', stripeInvoiceId)
  return NextResponse.json({ received: true })
}

// Handle invoice.payment_failed — update venue invoice status to 'overdue'
async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const stripeInvoiceId = invoice.id
  const serviceClient = createServiceClient() as any

  const { error } = await serviceClient
    .from('playhub_venue_invoices')
    .update({ status: 'overdue' })
    .eq('stripe_invoice_id', stripeInvoiceId)

  if (error) {
    console.error('Failed to mark invoice as overdue:', error)
    return NextResponse.json(
      { error: 'Failed to update invoice status' },
      { status: 500 }
    )
  }

  console.log('Invoice marked as overdue:', stripeInvoiceId)
  return NextResponse.json({ received: true })
}
