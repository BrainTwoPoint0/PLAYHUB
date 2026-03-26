// DELETE /api/recordings/[id]/access/[accessId] - Revoke access to a recording

import { getAuthUser } from '@/lib/supabase/server'
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
  const { user, supabase } = await getAuthUser()

  if (!user) {
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

  // Only venue admins can revoke access
  if (
    !recording.organization_id ||
    !(await isVenueAdmin(user.id, recording.organization_id))
  ) {
    return NextResponse.json(
      { error: 'Not authorized to revoke access for this recording' },
      { status: 403 }
    )
  }

  // Verify the accessId actually belongs to this recording (prevent IDOR)
  const { data: accessRecord } = await (supabase as any)
    .from('playhub_access_rights')
    .select('id')
    .eq('id', accessId)
    .eq('match_recording_id', recordingId)
    .single()

  if (!accessRecord) {
    return NextResponse.json(
      { error: 'Access record not found for this recording' },
      { status: 404 }
    )
  }

  // Revoke access
  const result = await revokeRecordingAccess(accessId, user.id)

  if (!result.success) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
