// GET /api/recordings/[id]/check-access - Check if current user has access to a recording

import { getAuthUser } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { checkRecordingAccess } from '@/lib/recordings/access-control'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: recordingId } = await params
  const { user } = await getAuthUser()

  // Check access
  const result = await checkRecordingAccess(recordingId, user?.id || null)

  return NextResponse.json({
    recordingId,
    ...result,
  })
}
