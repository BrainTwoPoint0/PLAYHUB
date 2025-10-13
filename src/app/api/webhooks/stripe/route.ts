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

    const { product_id, match_recording_id, user_id, profile_id } =
      session.metadata || {}

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
    const { data: purchase, error: purchaseError } = await (supabase as any)
      .from('playhub_purchases')
      .insert({
        profile_id,
        product_id,
        amount: session.amount_total! / 100,
        currency: session.currency!,
        status: 'completed',
        stripe_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent as string,
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
  }

  return NextResponse.json({ received: true })
}
