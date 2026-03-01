// GET  /api/org/[slug]/graphic-packages/import — List Spiideo graphic packages available for import
// POST /api/org/[slug]/graphic-packages/import — Import a Spiideo package as a local record

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { getGraphicPackages, getAccountConfig } from '@/lib/spiideo/client'

type RouteContext = { params: Promise<{ slug: string }> }

async function resolveOrg(slug: string) {
  const serviceClient = createServiceClient() as any
  const { data } = await serviceClient
    .from('organizations')
    .select('id')
    .eq('slug', slug)
    .maybeSingle()
  return data?.id as string | null
}

// GET — list available Spiideo graphic packages (not yet imported)
export async function GET(request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const orgId = await resolveOrg(slug)
  if (!orgId) {
    return NextResponse.json(
      { error: 'Organization not found' },
      { status: 404 }
    )
  }

  const isAdmin = await isVenueAdmin(user.id, orgId)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  try {
    const config = getAccountConfig()
    const spiideoPackages = await getGraphicPackages({
      accountId: config.accountId,
      includePublic: true,
    })

    // Get already-imported Spiideo IDs
    const serviceClient = createServiceClient() as any
    const { data: existing } = await serviceClient
      .from('playhub_graphic_packages')
      .select('spiideo_graphic_package_id')
      .eq('organization_id', orgId)
      .not('spiideo_graphic_package_id', 'is', null)

    const importedIds = new Set(
      (existing || []).map((e: any) => e.spiideo_graphic_package_id)
    )

    const available = (spiideoPackages.content || []).map((pkg) => ({
      ...pkg,
      alreadyImported: importedIds.has(pkg.id),
    }))

    return NextResponse.json({ packages: available })
  } catch (err) {
    console.error('Failed to fetch Spiideo graphic packages:', err)
    return NextResponse.json(
      { error: 'Failed to fetch from Spiideo' },
      { status: 500 }
    )
  }
}

// POST — import a specific Spiideo package
export async function POST(request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const orgId = await resolveOrg(slug)
  if (!orgId) {
    return NextResponse.json(
      { error: 'Organization not found' },
      { status: 404 }
    )
  }

  const isAdmin = await isVenueAdmin(user.id, orgId)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  let body: any
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { spiideoId, name } = body

  if (!spiideoId || !name) {
    return NextResponse.json(
      { error: 'spiideoId and name are required' },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient() as any

  // Check if already imported
  const { data: existing } = await serviceClient
    .from('playhub_graphic_packages')
    .select('id')
    .eq('organization_id', orgId)
    .eq('spiideo_graphic_package_id', spiideoId)
    .maybeSingle()

  if (existing) {
    return NextResponse.json(
      { error: 'This package has already been imported' },
      { status: 409 }
    )
  }

  const { data, error } = await serviceClient
    .from('playhub_graphic_packages')
    .insert({
      organization_id: orgId,
      name,
      spiideo_graphic_package_id: spiideoId,
      is_default: false,
    })
    .select()
    .single()

  if (error) {
    console.error('Failed to import graphic package:', error)
    return NextResponse.json(
      { error: 'Failed to import package' },
      { status: 500 }
    )
  }

  return NextResponse.json({ package: data }, { status: 201 })
}
