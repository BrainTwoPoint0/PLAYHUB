import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createClient } from '@/lib/supabase/server'

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

    // Otherwise, handle match recording purchase (existing flow)
    return handleMatchRecordingPurchase(session, metadata)
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
    console.error('Missing stream_id or user_id in metadata:', session.id)
    return NextResponse.json({ error: 'Missing metadata' }, { status: 400 })
  }

  const supabase = await createClient()

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
      'Missing required metadata (product_id or match_recording_id) in session:',
      session.id
    )
    return NextResponse.json({ error: 'Missing metadata' }, { status: 400 })
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

  const supabase = await createClient()

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
      stripe_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent as string,
      customer_email: session.customer_details?.email || null,
      customer_name: session.customer_details?.name || null,
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

  return NextResponse.json({ received: true })
}
