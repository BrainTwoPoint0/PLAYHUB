// POST /api/org/[slug]/graphic-packages/upload — Upload a logo/sponsor image to Supabase Storage

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { isPlatformAdmin } from '@/lib/admin/auth'

type RouteContext = { params: Promise<{ slug: string }> }

const BUCKET = 'graphic-packages'
const MAX_SIZE = 5 * 1024 * 1024 // 5MB
const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp']
const ALLOWED_TYPE_PARAMS = ['logo', 'sponsor']

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { slug } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Resolve org
  const serviceClient = createServiceClient() as any
  const { data: org } = await serviceClient
    .from('organizations')
    .select('id')
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

  const formData = await request.formData()
  const file = formData.get('file') as File | null
  const rawType = formData.get('type') as string

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 })
  }

  // Validate by MIME type or file extension (file.type can be empty in some environments)
  const fileExt = file.name.split('.').pop()?.toLowerCase() || ''
  if (!ALLOWED_MIME_TYPES.includes(file.type) && !ALLOWED_EXTENSIONS.includes(fileExt)) {
    return NextResponse.json(
      { error: 'File must be PNG, JPEG, or WebP' },
      { status: 400 }
    )
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: 'File must be under 5MB' },
      { status: 400 }
    )
  }

  // Validate type param against allowlist
  const typeParam = ALLOWED_TYPE_PARAMS.includes(rawType) ? rawType : 'logo'

  // Validate and sanitize extension — must match allowed list
  const rawExt = file.name.split('.').pop()?.toLowerCase() || ''
  const ext = ALLOWED_EXTENSIONS.includes(rawExt) ? rawExt : 'png'

  // Use timestamp-based filename to prevent path traversal
  const filePath = `${org.id}/${typeParam}_${Date.now()}.${ext}`

  const { error: uploadError } = await serviceClient.storage
    .from(BUCKET)
    .upload(filePath, file, {
      cacheControl: '3600',
      upsert: false,
    })

  if (uploadError) {
    console.error('Failed to upload graphic:', uploadError)
    return NextResponse.json(
      { error: 'Failed to upload file' },
      { status: 500 }
    )
  }

  const { data: urlData } = serviceClient.storage
    .from(BUCKET)
    .getPublicUrl(filePath)

  return NextResponse.json({ url: urlData.publicUrl })
}
