import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import MatchCard from '@/components/MatchCard'

export default async function LibraryPage() {
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/auth/login')
  }

  // Fetch user's purchased matches
  const { data: purchases, error } = await supabase
    .from('playhub_purchases')
    .select(`
      *,
      match_recording:playhub_match_recordings(
        *,
        sport:sports(name),
        organization:organizations(name),
        products:playhub_products(id, price_amount, currency, is_available)
      )
    `)
    .eq('user_id', user.id)
    .eq('status', 'completed')
    .order('purchased_at', { ascending: false })

  if (error) {
    console.error('Error fetching library:', error)
  }

  const purchasedMatches = purchases?.map(p => p.match_recording).filter(Boolean) || []

  return (
    <div className="container mx-auto px-5 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-[var(--timberwolf)] mb-2">
          My Library
        </h1>
        <p className="text-[var(--ash-grey)]">
          Access your purchased match recordings
        </p>
      </div>

      {/* Stats */}
      <div className="mb-8 p-4 bg-zinc-900 border border-[var(--ash-grey)]/20 rounded-lg">
        <p className="text-[var(--ash-grey)]">
          <span className="text-[var(--timberwolf)] font-semibold">{purchasedMatches.length}</span>{' '}
          {purchasedMatches.length === 1 ? 'match' : 'matches'} in your library
        </p>
      </div>

      {/* Matches Grid */}
      {purchasedMatches.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {purchasedMatches.map((match: any) => (
            <MatchCard key={match.id} match={match} />
          ))}
        </div>
      ) : (
        <div className="text-center py-16">
          <p className="text-xl text-[var(--ash-grey)] mb-4">
            Your library is empty
          </p>
          <p className="text-sm text-[var(--ash-grey)] mb-6">
            Purchase matches to add them to your library
          </p>
          <a
            href="/matches"
            className="inline-block px-6 py-3 bg-[var(--timberwolf)] text-[var(--night)] rounded-md hover:bg-[var(--ash-grey)] transition-colors"
          >
            Browse Matches
          </a>
        </div>
      )}
    </div>
  )
}
