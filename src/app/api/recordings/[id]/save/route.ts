// POST /api/recordings/[id]/save - Self-grant access from a public share link

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { grantRecordingAccess } from '@/lib/recordings/access-control'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: recordingId } = await params
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient()

  // Verify recording exists, is published, and has a share_token
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

  if (!recording.share_token) {
    return NextResponse.json(
      { error: 'Recording is not publicly shared' },
      { status: 400 }
    )
  }

  // Self-grant access (the share token IS the authorization)
  const result = await grantRecordingAccess(recordingId, user.id, {
    userId: user.id,
    notes: 'Saved from public share link',
  })

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({ success: true, accessId: result.accessId })
}
