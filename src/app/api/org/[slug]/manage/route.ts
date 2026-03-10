// GET /api/org/[slug]/manage — Get org info for manage page (admin only)

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'

type RouteContext = { params: Promise<{ slug: string }> }

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient() as any
  const { data: org } = await serviceClient
    .from('organizations')
    .select(
      'id, name, slug, type, logo_url, feature_recordings, feature_streaming, feature_graphic_packages, marketplace_enabled'
    )
    .eq('slug', slug)
    .maybeSingle()

  if (!org) {
    return NextResponse.json(
      { error: 'Organization not found' },
      { status: 404 }
    )
  }

  const [isAdmin, isPlatform] = await Promise.all([
    isVenueAdmin(user.id, org.id),
    isPlatformAdmin(user.id),
  ])
  if (!isAdmin && !isPlatform) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  return NextResponse.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    type: org.type,
    logoUrl: org.logo_url,
    featureRecordings: org.feature_recordings ?? false,
    featureStreaming: org.feature_streaming ?? false,
    featureGraphicPackages: org.feature_graphic_packages ?? false,
    marketplaceEnabled: org.marketplace_enabled ?? false,
  })
}
