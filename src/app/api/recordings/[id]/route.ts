// GET/PATCH/DELETE /api/recordings/[id]
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import {
  checkRecordingAccess,
  isVenueAdmin,
} from '@/lib/recordings/access-control'
import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

const s3Client = new S3Client({
  region: process.env.PLAYHUB_AWS_REGION || 'eu-west-2',
  credentials: {
    accessKeyId: process.env.PLAYHUB_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY!,
  },
})

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { user } = await getAuthUser()

  // Check access
  const accessResult = await checkRecordingAccess(id, user?.id || null)
  if (!accessResult.hasAccess) {
    return NextResponse.json({ error: accessResult.reason }, { status: 403 })
  }

  // Get recording details
  const serviceClient = createServiceClient()
  const { data: recording, error } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  // Generate signed URL for video if s3_key exists
  let videoUrl = null
  if (recording.s3_key && recording.s3_bucket) {
    try {
      const command = new GetObjectCommand({
        Bucket: recording.s3_bucket,
        Key: recording.s3_key,
      })
      videoUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 })
    } catch (err) {
      console.error('Failed to generate signed URL:', err)
    }
  }

  // Fetch graphic package: recording's package → org default → venue media_pack
  let graphicPackage = null
  let mediaPack = null

  if (recording.graphic_package_id) {
    const { data: gp } = await (serviceClient as any)
      .from('playhub_graphic_packages')
      .select('*')
      .eq('id', recording.graphic_package_id)
      .maybeSingle()
    if (gp) graphicPackage = gp
  }

  if (!graphicPackage && recording.organization_id) {
    // Try org's default graphic package
    const { data: gp } = await (serviceClient as any)
      .from('playhub_graphic_packages')
      .select('*')
      .eq('organization_id', recording.organization_id)
      .eq('is_default', true)
      .maybeSingle()
    if (gp) graphicPackage = gp
  }

  // Fallback: check parent org's default graphic package (e.g. Li3ib → Nazwa)
  if (!graphicPackage && recording.organization_id) {
    const { data: org } = await (serviceClient as any)
      .from('organizations')
      .select('parent_organization_id')
      .eq('id', recording.organization_id)
      .maybeSingle()
    if (org?.parent_organization_id) {
      const { data: gp } = await (serviceClient as any)
        .from('playhub_graphic_packages')
        .select('*')
        .eq('organization_id', org.parent_organization_id)
        .eq('is_default', true)
        .maybeSingle()
      if (gp) graphicPackage = gp
    }
  }

  if (!graphicPackage && recording.organization_id) {
    // Final fallback: venue media_pack
    const { data: billingCfg } = await (serviceClient as any)
      .from('playhub_venue_billing_config')
      .select('media_pack')
      .eq('organization_id', recording.organization_id)
      .maybeSingle()
    if (
      billingCfg?.media_pack &&
      Object.keys(billingCfg.media_pack).length > 0
    ) {
      mediaPack = billingCfg.media_pack
    }
  }

  return NextResponse.json({
    recording: {
      id: recording.id,
      title: recording.title,
      description: recording.description,
      matchDate: recording.match_date,
      homeTeam: recording.home_team,
      awayTeam: recording.away_team,
      venue: recording.venue,
      pitchName: recording.pitch_name,
      status: recording.status,
      duration: recording.duration_seconds,
    },
    videoUrl,
    access: accessResult,
    graphicPackage,
    mediaPack,
  })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Get the recording to find its organization_id
  const serviceClient = createServiceClient()
  const { data: recording } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .select('organization_id, collected_by')
    .eq('id', id)
    .single()

  if (!recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  const isAdmin = await isVenueAdmin(user.id, recording.organization_id)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  const body = await request.json()
  const allowedFields = [
    'title',
    'home_team',
    'away_team',
    'is_billable',
    'billable_amount',
  ]
  const updates: Record<string, any> = {}

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates[field] = body[field]
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: 'No valid fields to update' },
      { status: 400 }
    )
  }

  // Prevent editing billable_amount on playhub-collected recordings (verified Stripe transactions)
  if (
    updates.billable_amount !== undefined &&
    recording.collected_by === 'playhub'
  ) {
    return NextResponse.json(
      {
        error: 'Cannot edit amount for recordings with a verified transaction',
      },
      { status: 403 }
    )
  }

  updates.updated_at = new Date().toISOString()

  const { data: updated, error } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    console.error('Failed to update recording:', error)
    return NextResponse.json(
      { error: 'Failed to update recording' },
      { status: 500 }
    )
  }

  return NextResponse.json({ recording: updated })
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceClient = createServiceClient()
  const { data: recording } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .select('organization_id, s3_key, s3_bucket')
    .eq('id', id)
    .single()

  if (!recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  const isAdmin = await isVenueAdmin(user.id, recording.organization_id)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 })
  }

  // Delete S3 object if it exists
  if (recording.s3_key && recording.s3_bucket) {
    try {
      await s3Client.send(
        new DeleteObjectCommand({
          Bucket: recording.s3_bucket,
          Key: recording.s3_key,
        })
      )
    } catch (s3Err) {
      console.error(
        'Failed to delete S3 object (continuing with DB delete):',
        s3Err
      )
    }
  }

  const { error } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .delete()
    .eq('id', id)

  if (error) {
    console.error('Failed to delete recording:', error)
    return NextResponse.json(
      { error: 'Failed to delete recording' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true })
}
