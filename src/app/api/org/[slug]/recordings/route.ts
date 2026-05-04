// GET /api/org/[slug]/recordings — Public endpoint: marketplace recordings for an org

import { createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

type RouteContext = { params: Promise<{ slug: string }> }

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const serviceClient = createServiceClient() as any

  // Look up org by slug
  const { data: org, error: orgError } = await serviceClient
    .from('organizations')
    .select('id, name, slug, logo_url')
    .eq('slug', slug)
    .maybeSingle()

  if (orgError || !org) {
    return NextResponse.json(
      { error: 'Organization not found' },
      { status: 404 }
    )
  }

  // Fetch published marketplace recordings with their products.
  // Source of truth for "is this listed?" is playhub_products.is_available,
  // not the denormalised marketplace_enabled flag — we filter the join rows
  // post-query to avoid the dual-write race.
  const { data: recordings, error: recError } = await serviceClient
    .from('playhub_match_recordings')
    .select(
      `
      id,
      title,
      description,
      match_date,
      home_team,
      away_team,
      pitch_name,
      status,
      thumbnail_url,
      playhub_products (
        id,
        price_amount,
        currency,
        is_available
      )
    `
    )
    .eq('organization_id', org.id)
    .eq('status', 'published')
    .order('match_date', { ascending: false })

  if (recError) {
    console.error('Failed to fetch marketplace recordings:', recError)
    return NextResponse.json(
      { error: 'Failed to fetch recordings' },
      { status: 500 }
    )
  }

  // Shape the response — keep only recordings with at least one available
  // product and flatten that product into each recording.
  type RecordingRow = any
  type ProductRow = any
  const items: any[] = []
  for (const r of (recordings || []) as RecordingRow[]) {
    const product = (r.playhub_products || []).find(
      (p: ProductRow) => p.is_available
    ) as ProductRow | undefined
    if (!product) continue
    items.push({
      id: r.id,
      title: r.title,
      description: r.description,
      matchDate: r.match_date,
      homeTeam: r.home_team,
      awayTeam: r.away_team,
      pitchName: r.pitch_name,
      thumbnailUrl: r.thumbnail_url,
      product: {
        id: product.id,
        priceAmount: product.price_amount,
        currency: product.currency,
        isAvailable: product.is_available,
      },
    })
  }

  return NextResponse.json({
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logoUrl: org.logo_url,
    },
    recordings: items,
  })
}
