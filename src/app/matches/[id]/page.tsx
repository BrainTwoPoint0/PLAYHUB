import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { getPlaybackUrl } from '@/lib/s3/client'
import MatchDetailClient from './MatchDetailClient'

// The rendered HTML embeds a 1h signed S3 URL when the visitor has access.
// Disable shared caching so a CDN or corporate proxy never serves buyer A's
// signed URL to buyer B.
export const dynamic = 'force-dynamic'

export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const serviceClient = createServiceClient()

  // Fetch match with all details (type assertion for PLAYHUB tables)
  const { data: match, error } = await (serviceClient as any)
    .from('playhub_match_recordings')
    .select(
      `
      *,
      sport:sports(name),
      organization:organizations!organization_id(name),
      products:playhub_products(*)
    `
    )
    .eq('id', id)
    .eq('status', 'published')
    .single()

  if (error || !match) {
    notFound()
  }

  // Pick the first available product. Unlisted (soft-deleted) products are
  // intentionally hidden from the buy CTA — checkout itself also rejects
  // them, but filtering here avoids a confusing 404 after click-through.
  const product =
    (match.products || []).find((p: any) => p.is_available) || null

  // Check if user has access (use getAuthUser for JWT verification)
  let hasAccess = false
  const { user } = await getAuthUser()

  if (user) {
    // Check access by both user_id and profile_id to cover all grant types
    const { data: accessByUser } = await (serviceClient as any)
      .from('playhub_access_rights')
      .select('id')
      .eq('user_id', user.id)
      .eq('match_recording_id', id)
      .maybeSingle()

    if (accessByUser) {
      hasAccess = true
    } else {
      // Fallback: check by profile_id for older grants
      const { data: profile } = await (serviceClient as any)
        .from('profiles')
        .select('id')
        .eq('user_id', user.id)
        .maybeSingle()

      if (profile) {
        const { data: accessByProfile } = await (serviceClient as any)
          .from('playhub_access_rights')
          .select('id')
          .eq('profile_id', profile.id)
          .eq('match_recording_id', id)
          .maybeSingle()

        hasAccess = !!accessByProfile
      }
    }
  }

  // Paid buyers get an inline player on this auth-gated page. The signed S3
  // URL is short-lived (1h) and is regenerated on each page load — there is
  // no bearer token persisted on the recording for the buyer, so revoking
  // the venue admin's separate `share_token` cannot kick a paying buyer out.
  // Also fetch the events + graphic package + media pack so the same
  // PLAYHUB VideoPlayer used by /watch can render with full overlays here.
  let videoUrl: string | null = null
  let events: any[] = []
  let graphicPackage: any = null
  let mediaPack: any = null
  if (hasAccess && match.s3_key) {
    try {
      videoUrl = await getPlaybackUrl(match.s3_key, 3600)
    } catch (err) {
      console.error('Failed to generate playback URL:', err)
    }

    const { data: ev } = await (serviceClient as any)
      .from('playhub_recording_events')
      .select('*')
      .eq('match_recording_id', match.id)
      .eq('visibility', 'public')
      .order('timestamp_seconds', { ascending: true })
    events = ev || []

    if (match.graphic_package_id) {
      const { data: gp } = await (serviceClient as any)
        .from('playhub_graphic_packages')
        .select('*')
        .eq('id', match.graphic_package_id)
        .maybeSingle()
      if (gp) graphicPackage = gp
    }
    if (!graphicPackage && match.organization_id) {
      const { data: gp } = await (serviceClient as any)
        .from('playhub_graphic_packages')
        .select('*')
        .eq('organization_id', match.organization_id)
        .eq('is_default', true)
        .maybeSingle()
      if (gp) graphicPackage = gp
    }
    if (!graphicPackage && match.organization_id) {
      const { data: cfg } = await (serviceClient as any)
        .from('playhub_venue_billing_config')
        .select('media_pack')
        .eq('organization_id', match.organization_id)
        .maybeSingle()
      if (cfg?.media_pack && Object.keys(cfg.media_pack).length > 0) {
        mediaPack = cfg.media_pack
      }
    }
  }

  return (
    <MatchDetailClient
      match={match}
      product={product}
      hasAccess={hasAccess}
      videoUrl={videoUrl}
      events={events}
      graphicPackage={graphicPackage}
      mediaPack={mediaPack}
    />
  )
}
