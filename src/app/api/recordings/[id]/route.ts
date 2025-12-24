// GET /api/recordings/[id] - Get recording details with signed video URL
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { checkRecordingAccess } from '@/lib/recordings/access-control'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
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
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()

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
  })
}
