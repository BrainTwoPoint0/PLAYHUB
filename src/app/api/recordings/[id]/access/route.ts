// GET/POST /api/recordings/[id]/access - List and grant access to a recording

import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  isVenueAdmin,
  listRecordingAccess,
  grantRecordingAccess,
  grantRecordingAccessBulk,
} from '@/lib/recordings/access-control'
import {
  sendRecordingAccessEmail,
  sendRecordingAssignedEmail,
} from '@/lib/email'

export async function GET(
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

  // Get recording to check organization
  const { data: recording, error: recordingError } = await (supabase as any)
    .from('playhub_match_recordings')
    .select('id, organization_id, title')
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
        { error: 'Not authorized to view access for this recording' },
        { status: 403 }
      )
    }
  }

  // Get access list
  const accessList = await listRecordingAccess(recordingId)

  return NextResponse.json({
    recording: {
      id: recording.id,
      title: recording.title,
    },
    access: accessList,
  })
}

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

  // Get recording to check organization
  const { data: recording, error: recordingError } = await (
    serviceClient as any
  )
    .from('playhub_match_recordings')
    .select('id, organization_id, title')
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
        { error: 'Not authorized to grant access for this recording' },
        { status: 403 }
      )
    }
  }

  // Get venue name for email
  let venueName: string | undefined
  if (recording.organization_id) {
    const { data: venue } = await serviceClient
      .from('organizations')
      .select('name')
      .eq('id', recording.organization_id)
      .single()
    venueName = venue?.name
  }

  // Get inviter's name
  const { data: inviterProfile } = await serviceClient
    .from('profiles')
    .select('full_name')
    .eq('user_id', user.id)
    .single()

  const body = await request.json()
  const { emails, email, expiresAt, notes } = body

  // Support both single email and array of emails
  const emailList = emails || (email ? [email] : [])

  if (emailList.length === 0) {
    return NextResponse.json(
      { error: 'At least one email is required' },
      { status: 400 }
    )
  }

  // Validate emails
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const invalidEmails = emailList.filter((e: string) => !emailRegex.test(e))
  if (invalidEmails.length > 0) {
    return NextResponse.json(
      { error: `Invalid emails: ${invalidEmails.join(', ')}` },
      { status: 400 }
    )
  }

  // Grant access
  if (emailList.length === 1) {
    const result = await grantRecordingAccess(recordingId, user.id, {
      email: emailList[0],
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      notes,
    })

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 500 })
    }

    // Send appropriate email based on whether user exists
    if (result.userExists) {
      await sendRecordingAssignedEmail({
        toEmail: emailList[0],
        recordingTitle: recording.title,
        venueName,
        assignedBy: inviterProfile?.full_name || undefined,
      })
    } else {
      await sendRecordingAccessEmail({
        toEmail: emailList[0],
        recordingTitle: recording.title,
        venueName,
        inviterName: inviterProfile?.full_name || undefined,
      })
    }

    return NextResponse.json({
      success: true,
      accessId: result.accessId,
    })
  }

  // Bulk grant
  const result = await grantRecordingAccessBulk(
    recordingId,
    user.id,
    emailList,
    {
      expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      notes,
    }
  )

  // Send email notifications for successful grants
  const successfulResults = result.results.filter((r) => r.success)
  await Promise.all(
    successfulResults.map((r) =>
      r.userExists
        ? sendRecordingAssignedEmail({
            toEmail: r.email,
            recordingTitle: recording.title,
            venueName,
            assignedBy: inviterProfile?.full_name || undefined,
          })
        : sendRecordingAccessEmail({
            toEmail: r.email,
            recordingTitle: recording.title,
            venueName,
            inviterName: inviterProfile?.full_name || undefined,
          })
    )
  )

  return NextResponse.json({
    success: result.success,
    results: result.results,
  })
}
