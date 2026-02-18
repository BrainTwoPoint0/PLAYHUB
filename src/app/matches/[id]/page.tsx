import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import MatchDetailClient from './MatchDetailClient'

export default async function MatchDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = await createClient()

  // Fetch match with all details (type assertion for PLAYHUB tables)
  const { data: match, error } = await (supabase as any)
    .from('playhub_match_recordings')
    .select(
      `
      *,
      sport:sports(name),
      organization:organizations(name),
      products:playhub_products(*)
    `
    )
    .eq('id', id)
    .eq('status', 'published')
    .single()

  if (error || !match) {
    notFound()
  }

  const product = match.products?.[0]

  // Check if user has access
  let hasAccess = false

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    // Get user's profile (type assertion)
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .single()

    const profileData = profile as any

    if (profileData) {
      // Check if user has purchased this match (type assertion for PLAYHUB tables)
      const { data: access } = await (supabase as any)
        .from('playhub_access_rights')
        .select('id')
        .eq('profile_id', profileData.id)
        .eq('match_recording_id', id)
        .single()

      hasAccess = !!access
    }
  }

  return (
    <MatchDetailClient match={match} product={product} hasAccess={hasAccess} />
  )
}
