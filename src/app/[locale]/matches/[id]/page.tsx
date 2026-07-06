import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import MatchDetailClient from './MatchDetailClient'

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

  // No inline player on this surface — the canonical watch URL is /watch/[id].
  // Buyers (and venue admins) follow the "Watch" CTA on the sidebar, which
  // navigates to /watch/[id]?from=matches. Single VideoPlayer mount across
  // the codebase, single access-resolution code path.
  return (
    <MatchDetailClient match={match} product={product} hasAccess={hasAccess} />
  )
}
