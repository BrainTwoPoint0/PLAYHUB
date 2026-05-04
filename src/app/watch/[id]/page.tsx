// /watch/[id] — canonical watch surface for any audience that has access to
// the recording. Resolves access via three channels:
//   1. ?token=<x>           — bearer match against recording.share_token
//   2. signed-in user       — checkRecordingAccess() (admin / user_id grant /
//                             email-keyed grant; already implemented)
//   3. otherwise             — 404
//
// All other entry points (matches detail, library, venue admin, post-purchase
// email) link here. Editing remains on /recordings/[id].

import { notFound, redirect } from 'next/navigation'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { getPlaybackUrl } from '@/lib/s3/client'
import { checkRecordingAccess } from '@/lib/recordings/access-control'
import WatchClient from './WatchClient'

// Legacy /watch/<32-hex-share-token> URLs (still in admin clipboards and the
// Sharjah Uni email) are forwarded to /watch/<recording.id>?token=<token>.
// UUIDs go through the normal lookup; non-UUID strings fall back to a
// share_token resolution before 404'ing.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The rendered HTML embeds a 1h signed S3 URL; CDNs / corporate proxies must
// not cache one buyer's URL into another buyer's response.
export const dynamic = 'force-dynamic'

export default async function WatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ token?: string; from?: string }>
}) {
  const { id } = await params
  const { token, from } = await searchParams
  const serviceClient = createServiceClient() as any

  // Backward compat: if the path segment isn't a UUID, treat it as a legacy
  // share_token, look up the underlying recording, and 302 to the canonical
  // /watch/<id>?token=<token> form. Old links keep working untouched.
  if (!UUID_RE.test(id)) {
    const { data: legacy } = await serviceClient
      .from('playhub_match_recordings')
      .select('id')
      .eq('share_token', id)
      .maybeSingle()
    if (legacy?.id) {
      redirect(`/watch/${legacy.id}?token=${id}`)
    }
    notFound()
  }

  const { data: recording, error } = await serviceClient
    .from('playhub_match_recordings')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error || !recording) notFound()
  if (recording.status !== 'published') notFound()

  // Access resolution — channel 1: bearer token query param.
  let hasAccess = false
  if (token && recording.share_token && token === recording.share_token) {
    hasAccess = true
  }

  // Access resolution — channel 2 + 3: signed-in user via existing helper
  // (covers venue admin, user_id grant, and email-keyed grant in one call).
  const { user } = await getAuthUser()
  if (!hasAccess && user) {
    const result = await checkRecordingAccess(id, user.id)
    if (result.hasAccess) hasAccess = true
  }

  if (!hasAccess) notFound()

  // Generate signed S3 URL + fetch overlay assets. Mirrors what the legacy
  // /api/watch/[token] endpoint did so the player gets the full overlay set.
  let videoUrl: string | null = null
  if (recording.s3_key) {
    try {
      videoUrl = await getPlaybackUrl(recording.s3_key, 3600)
    } catch (err) {
      console.error('Failed to generate playback URL:', err)
    }
  }

  const { data: events } = await serviceClient
    .from('playhub_recording_events')
    .select('*')
    .eq('match_recording_id', recording.id)
    .eq('visibility', 'public')
    .order('timestamp_seconds', { ascending: true })

  let graphicPackage: any = null
  let mediaPack: any = null

  if (recording.graphic_package_id) {
    const { data: gp } = await serviceClient
      .from('playhub_graphic_packages')
      .select('*')
      .eq('id', recording.graphic_package_id)
      .maybeSingle()
    if (gp) graphicPackage = gp
  }
  if (!graphicPackage && recording.organization_id) {
    const { data: gp } = await serviceClient
      .from('playhub_graphic_packages')
      .select('*')
      .eq('organization_id', recording.organization_id)
      .eq('is_default', true)
      .maybeSingle()
    if (gp) graphicPackage = gp
  }
  if (!graphicPackage && recording.organization_id) {
    const { data: org } = await serviceClient
      .from('organizations')
      .select('parent_organization_id')
      .eq('id', recording.organization_id)
      .maybeSingle()
    if (org?.parent_organization_id) {
      const { data: gp } = await serviceClient
        .from('playhub_graphic_packages')
        .select('*')
        .eq('organization_id', org.parent_organization_id)
        .eq('is_default', true)
        .maybeSingle()
      if (gp) graphicPackage = gp
    }
  }
  if (!graphicPackage && recording.organization_id) {
    const { data: cfg } = await serviceClient
      .from('playhub_venue_billing_config')
      .select('media_pack')
      .eq('organization_id', recording.organization_id)
      .maybeSingle()
    if (cfg?.media_pack && Object.keys(cfg.media_pack).length > 0) {
      mediaPack = cfg.media_pack
    }
  }

  return (
    <WatchClient
      recording={{
        id: recording.id,
        title: recording.title,
        description: recording.description,
        matchDate: recording.match_date,
        homeTeam: recording.home_team,
        awayTeam: recording.away_team,
        venue: recording.venue,
        pitchName: recording.pitch_name,
      }}
      videoUrl={videoUrl}
      events={events || []}
      graphicPackage={graphicPackage}
      mediaPack={mediaPack}
      from={from || null}
    />
  )
}
