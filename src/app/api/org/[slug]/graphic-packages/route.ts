// CRUD /api/org/[slug]/graphic-packages — Manage graphic packages for an org

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'

type RouteContext = { params: Promise<{ slug: string }> }

const VALID_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

function isValidHttpUrl(str: string): boolean {
  try {
    const url = new URL(str)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

// Helper: resolve org slug to org id
async function resolveOrg(slug: string) {
  const serviceClient = createServiceClient() as any
  const { data, error } = await serviceClient
    .from('organizations')
    .select('id')
    .eq('slug', slug)
    .maybeSingle()
  if (error || !data) return null
  return data.id as string
}

// GET — list graphic packages for an org
export async function GET(_request: NextRequest, { params }: RouteContext) {
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

  const serviceClient = createServiceClient() as any
  const { data, error } = await serviceClient
    .from('playhub_graphic_packages')
    .select('*')
    .eq('organization_id', orgId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) {
    console.error('Failed to fetch graphic packages:', error)
    return NextResponse.json(
      { error: 'Failed to fetch graphic packages' },
      { status: 500 }
    )
  }

  return NextResponse.json({ packages: data || [] })
}

// POST — create a new graphic package
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

  const {
    name,
    logo_url,
    logo_position,
    sponsor_logo_url,
    sponsor_position,
    is_default,
    spiideo_graphic_package_id,
  } = body

  if (
    !name ||
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > 200
  ) {
    return NextResponse.json(
      { error: 'Name is required and must be under 200 characters' },
      { status: 400 }
    )
  }
  if (logo_url && !isValidHttpUrl(logo_url)) {
    return NextResponse.json({ error: 'Invalid logo URL' }, { status: 400 })
  }
  if (sponsor_logo_url && !isValidHttpUrl(sponsor_logo_url)) {
    return NextResponse.json(
      { error: 'Invalid sponsor logo URL' },
      { status: 400 }
    )
  }
  if (logo_position && !VALID_POSITIONS.includes(logo_position)) {
    return NextResponse.json(
      { error: 'Invalid logo position' },
      { status: 400 }
    )
  }
  if (sponsor_position && !VALID_POSITIONS.includes(sponsor_position)) {
    return NextResponse.json(
      { error: 'Invalid sponsor position' },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient() as any

  // If setting as default, unset any existing default first
  if (is_default) {
    await serviceClient
      .from('playhub_graphic_packages')
      .update({ is_default: false })
      .eq('organization_id', orgId)
      .eq('is_default', true)
  }

  const { data, error } = await serviceClient
    .from('playhub_graphic_packages')
    .insert({
      organization_id: orgId,
      name,
      logo_url: logo_url || null,
      logo_position: logo_position || 'top-right',
      sponsor_logo_url: sponsor_logo_url || null,
      sponsor_position: sponsor_position || 'bottom-left',
      is_default: is_default || false,
      spiideo_graphic_package_id: spiideo_graphic_package_id || null,
    })
    .select()
    .single()

  if (error) {
    console.error('Failed to create graphic package:', error)
    return NextResponse.json(
      { error: 'Failed to create graphic package' },
      { status: 500 }
    )
  }

  return NextResponse.json({ package: data }, { status: 201 })
}

// PATCH — update a graphic package
export async function PATCH(request: NextRequest, { params }: RouteContext) {
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

  const { id, ...fields } = body

  if (!id) {
    return NextResponse.json(
      { error: 'Package id is required' },
      { status: 400 }
    )
  }

  // Validate individual fields
  if (
    fields.name !== undefined &&
    (typeof fields.name !== 'string' ||
      fields.name.trim().length === 0 ||
      fields.name.length > 200)
  ) {
    return NextResponse.json(
      { error: 'Name must be under 200 characters' },
      { status: 400 }
    )
  }
  if (fields.logo_url && !isValidHttpUrl(fields.logo_url)) {
    return NextResponse.json({ error: 'Invalid logo URL' }, { status: 400 })
  }
  if (fields.sponsor_logo_url && !isValidHttpUrl(fields.sponsor_logo_url)) {
    return NextResponse.json(
      { error: 'Invalid sponsor logo URL' },
      { status: 400 }
    )
  }
  if (fields.logo_position && !VALID_POSITIONS.includes(fields.logo_position)) {
    return NextResponse.json(
      { error: 'Invalid logo position' },
      { status: 400 }
    )
  }
  if (
    fields.sponsor_position &&
    !VALID_POSITIONS.includes(fields.sponsor_position)
  ) {
    return NextResponse.json(
      { error: 'Invalid sponsor position' },
      { status: 400 }
    )
  }

  const allowedFields = [
    'name',
    'logo_url',
    'logo_position',
    'sponsor_logo_url',
    'sponsor_position',
    'is_default',
  ]
  const updates: Record<string, any> = {}
  for (const field of allowedFields) {
    if (fields[field] !== undefined) {
      updates[field] = fields[field]
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: 'No valid fields to update' },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient() as any

  // If setting as default, unset any existing default first
  if (updates.is_default === true) {
    await serviceClient
      .from('playhub_graphic_packages')
      .update({ is_default: false })
      .eq('organization_id', orgId)
      .eq('is_default', true)
  }

  updates.updated_at = new Date().toISOString()

  const { data, error } = await serviceClient
    .from('playhub_graphic_packages')
    .update(updates)
    .eq('id', id)
    .eq('organization_id', orgId)
    .select()
    .single()

  if (error) {
    console.error('Failed to update graphic package:', error)
    return NextResponse.json(
      { error: 'Failed to update graphic package' },
      { status: 500 }
    )
  }

  return NextResponse.json({ package: data })
}

// DELETE — delete a graphic package
export async function DELETE(request: NextRequest, { params }: RouteContext) {
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

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  if (!id) {
    return NextResponse.json(
      { error: 'Package id is required' },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient() as any
  const { error } = await serviceClient
    .from('playhub_graphic_packages')
    .delete()
    .eq('id', id)
    .eq('organization_id', orgId)

  if (error) {
    console.error('Failed to delete graphic package:', error)
    return NextResponse.json(
      { error: 'Failed to delete graphic package' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}
