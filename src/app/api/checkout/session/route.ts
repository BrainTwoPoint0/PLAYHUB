import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-02-24.acacia',
})

// GET - for match recording purchases (existing flow)
export async function GET(request: NextRequest) {
  try {
    const supabase = (await createClient()) as any
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

// POST - for live stream purchases
export async function POST(request: NextRequest) {
  try {
    const supabase = (await createClient()) as any
    const body = await request.json()

    const { stream_id, success_url, cancel_url } = body

    if (!stream_id) {
      return NextResponse.json(
        { error: 'stream_id is required' },
        { status: 400 }
      )
    }

    // Get current user - required for stream purchases
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      )
    }

    // Get stream details
    const { data: streamData, error: streamError } = await supabase
      .from('playhub_live_streams')
      .select('*')
      .eq('id', stream_id)
      .single()

    if (streamError || !streamData) {
      return NextResponse.json({ error: 'Stream not found' }, { status: 404 })
    }

    // Type assertion for the stream data
    const stream = streamData as {
      id: string
      title: string
      home_team: string | null
      away_team: string | null
      access_type: string
      price_amount: number | null
      currency: string
      is_unlocked: boolean
    }

    // Check if stream is purchasable
    if (!['pay_per_view', 'group_unlock'].includes(stream.access_type)) {
      return NextResponse.json(
        { error: 'This stream is not available for purchase' },
        { status: 400 }
      )
    }

    if (!stream.price_amount) {
      return NextResponse.json(
        { error: 'Stream has no price set' },
        { status: 400 }
      )
    }

    // Check if user already has access
    const { data: existingAccess } = await supabase
      .from('playhub_stream_access')
      .select('id')
      .eq('stream_id', stream_id)
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single()

    if (existingAccess) {
      return NextResponse.json(
        { error: 'You already have access to this stream' },
        { status: 400 }
      )
    }

    // For group_unlock, check if already unlocked
    if (stream.access_type === 'group_unlock' && stream.is_unlocked) {
      return NextResponse.json(
        { error: 'This stream has already been unlocked' },
        { status: 400 }
      )
    }

    // Build product name
    const productName =
      stream.home_team && stream.away_team
        ? `${stream.home_team} vs ${stream.away_team}`
        : stream.title

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: user.email,
      line_items: [
        {
          price_data: {
            currency: stream.currency.toLowerCase(),
            product_data: {
              name: productName,
              description:
                stream.access_type === 'group_unlock'
                  ? `Unlock for everyone: ${stream.title}`
                  : `Stream access: ${stream.title}`,
            },
            unit_amount: Math.round(stream.price_amount * 100), // Convert to cents
          },
          quantity: 1,
        },
      ],
      metadata: {
        type: 'stream_access',
        stream_id: stream.id,
        access_type: stream.access_type,
        user_id: user.id,
      },
      success_url:
        success_url ||
        `${request.nextUrl.origin}/streams/${stream_id}?purchased=true`,
      cancel_url:
        cancel_url ||
        `${request.nextUrl.origin}/streams/${stream_id}?canceled=true`,
    })

    return NextResponse.json({ url: session.url })
  } catch (error) {
    console.error('Stream checkout error:', error)
    return NextResponse.json(
      { error: 'Failed to create checkout session' },
      { status: 500 }
    )
  }
}
