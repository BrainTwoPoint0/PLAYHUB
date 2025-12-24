// POST /api/recordings/[id]/share-token - Generate or get public share token
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { isVenueAdmin } from '@/lib/recordings/access-control'
import { randomBytes } from 'crypto'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient()

  // Get recording to check ownership
  const { data: recording } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .select('id, organization_id, share_token')
    .eq('id', id)
    .single()

  if (!recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  // Check if user is admin for this venue
  if (recording.organization_id) {
    const isAdmin = await isVenueAdmin(user.id, recording.organization_id)
    if (!isAdmin) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }
  }

  // If token already exists, return it
  if (recording.share_token) {
    return NextResponse.json({
      token: recording.share_token,
      shareUrl: `${process.env.NEXT_PUBLIC_APP_URL || ''}/watch/${recording.share_token}`,
    })
  }

  // Generate new token
  const token = randomBytes(16).toString('hex')

  const { error } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .update({ share_token: token })
    .eq('id', id)

  if (error) {
    return NextResponse.json(
      { error: 'Failed to generate token' },
      { status: 500 }
    )
  }

  return NextResponse.json({
    token,
    shareUrl: `${process.env.NEXT_PUBLIC_APP_URL || ''}/watch/${token}`,
  })
}

// DELETE /api/recordings/[id]/share-token - Revoke public share token
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient()

  const { data: recording } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .select('id, organization_id')
    .eq('id', id)
    .single()

  if (!recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  if (recording.organization_id) {
    const isAdmin = await isVenueAdmin(user.id, recording.organization_id)
    if (!isAdmin) {
      return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
    }
  }

  await (serviceClient as any)
    .from('playhub_match_recordings')
    .update({ share_token: null })
    .eq('id', id)

  return NextResponse.json({ success: true })
}
