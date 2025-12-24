// DELETE /api/recordings/[id]/access/[accessId] - Revoke access to a recording

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  isVenueAdmin,
  revokeRecordingAccess,
} from '@/lib/recordings/access-control'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; accessId: string }> }
) {
  const { id: recordingId, accessId } = await params
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get recording to check organization
  const { data: recording, error: recordingError } = await (supabase as any)
    .from('playhub_match_recordings')
    .select('id, organization_id')
    .eq('id', recordingId)
    .single()

  if (recordingError || !recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  // Check if user is admin for this venue
  if (recording.organization_id) {
    const isAdmin = await isVenueAdmin(user.id, recording.organization_id)
    if (!isAdmin) {
      return NextResponse.json(
        { error: 'Not authorized to revoke access for this recording' },
        { status: 403 }
      )
    }
  }

  // Revoke access
  const result = await revokeRecordingAccess(accessId, user.id)

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
