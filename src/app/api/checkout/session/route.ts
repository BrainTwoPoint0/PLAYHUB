import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
})

export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const searchParams = request.nextUrl.searchParams
    const productId = searchParams.get('productId')

    if (!productId) {
      return NextResponse.json(
        { error: 'Product ID is required' },
        { status: 400 }
      )
    }

    // Get current user (optional for now - can purchase without auth)
    const {
      data: { user },
    } = await supabase.auth.getUser()

    let profile: any = null
    if (user) {
      // Get user's profile if authenticated
      const { data: profileData } = await supabase
        .from('profiles')
        .select('id')
        .eq('user_id', user.id)
        .single()
      profile = profileData
    }

    // Get product and match details
    const { data: product, error: productError } = await supabase
      .from('playhub_products')
      .select(
        `
        *,
        match_recording:playhub_match_recordings(
          id,
          title,
          home_team,
          away_team
        )
      `
      )
      .eq('id', productId)
      .eq('is_available', true)
      .single()

    if (productError || !product) {
      return NextResponse.json(
        { error: 'Product not found or unavailable' },
        { status: 404 }
      )
    }

    // Type assertion for nested relation
    const productData = product as any
    const match = productData.match_recording

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: productData.currency.toLowerCase(),
            product_data: {
              name: `${match.home_team} vs ${match.away_team}`,
              description: productData.description || match.title,
            },
            unit_amount: Math.round(productData.price_amount * 100), // Convert to cents
          },
          quantity: 1,
        },
      ],
      metadata: {
        product_id: productData.id,
        match_recording_id: match.id,
        user_id: user?.id || 'guest',
        profile_id: profile?.id || 'guest',
      },
      success_url: `${request.nextUrl.origin}/purchase/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${request.nextUrl.origin}/matches/${match.id}?canceled=true`,
    })

    // Redirect to Stripe checkout
    return NextResponse.redirect(session.url!)
  } catch (error) {
    console.error('Checkout session error:', error)
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    )
  }
}
