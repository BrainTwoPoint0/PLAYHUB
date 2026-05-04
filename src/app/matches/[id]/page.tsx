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
  let videoUrl: string | null = null
  if (hasAccess && match.s3_key) {
    try {
      videoUrl = await getPlaybackUrl(match.s3_key, 3600)
    } catch (err) {
      console.error('Failed to generate playback URL:', err)
    }
  }

  return (
    <MatchDetailClient
      match={match}
      product={product}
      hasAccess={hasAccess}
      videoUrl={videoUrl}
    />
  )
}
