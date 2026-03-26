// POST /api/recordings/[id]/save - Self-grant access from a public share link

import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { grantRecordingAccess } from '@/lib/recordings/access-control'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: recordingId } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Require the share token in the request body
  let token: string | undefined
  try {
    const body = await request.json()
    token = body.token
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!token) {
    return NextResponse.json(
      { error: 'Share token is required' },
      { status: 400 }
    )
  }

  const serviceClient = createServiceClient()

  // Verify recording exists, is published, and the token matches
  const { data: recording, error: recordingError } = await (
    serviceClient as any
  )
    .from('playhub_match_recordings')
    .select('id, status, share_token')
    .eq('id', recordingId)
    .single()

  if (recordingError || !recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  if (recording.status !== 'published') {
    return NextResponse.json(
      { error: 'Recording is not available' },
      { status: 400 }
    )
  }

  if (!recording.share_token || recording.share_token !== token) {
    return NextResponse.json({ error: 'Invalid share token' }, { status: 403 })
  }

  // Self-grant access (share token validated above)
  const result = await grantRecordingAccess(recordingId, user.id, {
    userId: user.id,
    notes: 'Saved from public share link',
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({ success: true, accessId: result.accessId })
}
