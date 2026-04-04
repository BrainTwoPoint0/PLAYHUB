// GET /api/watch/[token] - Get recording by public share token (no auth required)
import { createServiceClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getPlaybackUrl } from '@/lib/s3/client'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  if (!token || token.length < 10) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 400 })
  }

  const serviceClient = createServiceClient()

  // Find recording by share token
  const { data: recording, error } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .select('*')
    .eq('share_token', token)
    .single()

  if (error || !recording) {
    return NextResponse.json({ error: 'Recording not found' }, { status: 404 })
  }

  // Check if recording is published
  if (recording.status !== 'published') {
    return NextResponse.json(
      { error: 'Recording not yet available', status: recording.status },
      { status: 404 }
    )
  }

  // Generate signed URL for video
  let videoUrl = null
  if (recording.s3_key) {
    try {
      videoUrl = await getPlaybackUrl(recording.s3_key, 3600)
    } catch (err) {
      console.error('Failed to generate signed URL:', err)
    }
  }

  // Fetch public events for this recording
  const { data: events } = await (serviceClient as any)
    .from('playhub_recording_events')
    .select('*')
    .eq('match_recording_id', recording.id)
    .eq('visibility', 'public')
    .order('timestamp_seconds', { ascending: true })

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
    },
    videoUrl,
    events: events || [],
    graphicPackage,
    mediaPack,
  })
}
