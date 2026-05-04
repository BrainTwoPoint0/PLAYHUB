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
import {
  checkRecordingAccess,
  isVenueAdmin,
} from '@/lib/recordings/access-control'
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

  // Access resolution. Track HOW the visitor got in so the client component
  // can offer a "Save to library" CTA only when access is bearer-only.
  const tokenMatches = !!(
    token &&
    recording.share_token &&
    token === recording.share_token
  )

  const { user } = await getAuthUser()
  let userHasGrant = false
  if (user) {
    const result = await checkRecordingAccess(id, user.id)
    userHasGrant = result.hasAccess
  }

  const hasAccess = tokenMatches || userHasGrant
  if (!hasAccess) notFound()

  // canSave: viewer is authenticated, accessed via the public token only,
  // and doesn't yet have a permanent grant. Clicking save converts the
  // bearer access into a durable access_rights row that survives token
  // revocation. Anonymous viewers see a sign-in prompt instead.
  const canSave = !!user && tokenMatches && !userHasGrant
  const canSignInToSave = !user && tokenMatches

  // Tagging permissions:
  //   canTag      — signed in + has a real grant (admin / access_rights via
  //                  email-keyed or purchase). Bearer-only viewers must save
  //                  to library first.
  //   canPublish  — venue admin OR paid buyer. Everyone else gets their
  //                  visibility=public requests downgraded server-side; we
  //                  reflect that in the UI so the toggle isn't misleading.
  const canTag = !!user && userHasGrant
  let canPublish = false
  // Track admin status separately from publish rights — admins can delete any
  // tag on their venue's recordings (including AI-generated and other staff's
  // tags), buyers cannot.
  let isAdmin = false
  if (canTag && user) {
    isAdmin = recording.organization_id
      ? await isVenueAdmin(user.id, recording.organization_id)
      : false
    if (isAdmin) {
      canPublish = true
    } else {
      const { data: purchase } = await serviceClient
        .from('playhub_purchases')
        .select('id')
        .eq('user_id', user.id)
        .eq('match_recording_id', id)
        .eq('status', 'completed')
        .maybeSingle()
      canPublish = !!purchase
    }
  }

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

  // Fetch events. Public events show to everyone with access; private
  // events show only to their creator. Build the union manually since we
  // are using the service client (RLS bypassed) — apply the visibility
  // filter explicitly.
  const { data: publicEvents } = await serviceClient
    .from('playhub_recording_events')
    .select('*')
    .eq('match_recording_id', recording.id)
    .eq('visibility', 'public')
    .order('timestamp_seconds', { ascending: true })

  let privateEvents: any[] = []
  if (user) {
    const { data: priv } = await serviceClient
      .from('playhub_recording_events')
      .select('*')
      .eq('match_recording_id', recording.id)
      .eq('visibility', 'private')
      .eq('created_by', user.id)
      .order('timestamp_seconds', { ascending: true })
    privateEvents = priv || []
  }

  const events = [...(publicEvents || []), ...privateEvents].sort(
    (a, b) => a.timestamp_seconds - b.timestamp_seconds
  )

  // Resume position: read the user's most recent view-history row for this
  // recording, fall back to 0 (start). Bearer-only viewers don't persist
  // history (the API route returns 204 for anonymous), so they never resume.
  let resumeSeconds = 0
  if (user) {
    const { data: lastView } = await serviceClient
      .from('playhub_view_history')
      .select('watched_duration_seconds, total_duration_seconds')
      .eq('user_id', user.id)
      .eq('match_recording_id', id)
      .order('last_position_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()
    if (
      lastView?.watched_duration_seconds &&
      lastView.watched_duration_seconds > 5 &&
      // Don't resume if we were within 10s of the end last time — let the
      // user start fresh rather than dropping them at the closing whistle.
      (!lastView.total_duration_seconds ||
        lastView.watched_duration_seconds <
          lastView.total_duration_seconds - 10)
    ) {
      resumeSeconds = lastView.watched_duration_seconds
    }
  }

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
        competition: recording.competition,
        durationSeconds: recording.duration_seconds,
        shareToken: recording.share_token,
        thumbnailUrl: recording.thumbnail_url,
      }}
      resumeSeconds={resumeSeconds}
      videoUrl={videoUrl}
      events={events}
      graphicPackage={graphicPackage}
      mediaPack={mediaPack}
      from={from || null}
      token={token || null}
      canSave={canSave}
      canSignInToSave={canSignInToSave}
      canTag={canTag}
      canPublish={canPublish}
      isAdmin={isAdmin}
      currentUserId={user?.id || null}
    />
  )
}
