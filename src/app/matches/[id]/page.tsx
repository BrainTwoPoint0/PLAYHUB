import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import MatchDetailClient from './MatchDetailClient'

export default async function MatchDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const supabase = await createClient()

  // Fetch match with all details
  const { data: match, error } = await supabase
    .from('playhub_match_recordings')
    .select(`
      *,
      sport:sports(name),
      organization:organizations(name),
      products:playhub_products(*)
    `)
    .eq('id', params.id)
    .eq('status', 'published')
    .single()

  if (error || !match) {
    notFound()
  }

  const product = match.products?.[0]

  // Check if user has access
  let hasAccess = false

  const { data: { user } } = await supabase.auth.getUser()

  if (user) {
    // Get user's profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('user_id', user.id)
      .single()

    if (profile) {
      // Check if user has purchased this match
      const { data: access } = await supabase
        .from('playhub_access_rights')
        .select('id')
        .eq('profile_id', profile.id)
        .eq('match_recording_id', params.id)
        .single()

      hasAccess = !!access
    }
  }

  return <MatchDetailClient match={match} product={product} hasAccess={hasAccess} />
}
