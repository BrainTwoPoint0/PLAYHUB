'use client'

import { createClient } from '@braintwopoint0/playback-commons/supabase'
import { Skeleton, EmptyState } from '@braintwopoint0/playback-commons/ui'
import MatchCard from '@/components/MatchCard'
import { FadeIn } from '@/components/FadeIn'
import { useEffect, useState } from 'react'
import { Film } from 'lucide-react'

export default function MatchesPage() {
  const [matches, setMatches] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchMatches() {
      const supabase = createClient()

      const { data, error } = await (supabase as any)
        .from('playhub_match_recordings')
        .select(
          `
          *,
          sport:sports(name),
          organization:organizations(name),
          products:playhub_products(id, price_amount, currency, is_available)
        `
        )
        .eq('status', 'published')
        .order('match_date', { ascending: false })

      if (error) {
        console.error('Error fetching matches:', error)
      } else {
        const publishedMatches =
          data?.filter(
            (match: any) =>
              match.products &&
              match.products.length > 0 &&
              match.products.some((p: any) => p.is_available)
          ) || []
        setMatches(publishedMatches)
      }
      setLoading(false)
    }

    fetchMatches()
  }, [])

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-12 sm:px-6 lg:px-8">
      <FadeIn className="mb-10">
        <h1 className="text-3xl md:text-4xl font-bold text-[var(--timberwolf)] mb-2">
          Match Marketplace
        </h1>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <p className="text-muted-foreground">
            Browse professional match recordings
          </p>
          <div className="px-3 py-1.5 rounded-lg border border-border bg-card">
            <span className="text-lg font-bold text-[var(--timberwolf)]">
              {loading ? '...' : matches.length}
            </span>
            <span className="text-muted-foreground ml-2 text-sm">
              {matches.length === 1 ? 'match' : 'matches'}
            </span>
          </div>
        </div>
      </FadeIn>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="rounded-xl border border-border bg-card overflow-hidden">
              <Skeleton className="h-56 w-full rounded-none" />
              <div className="p-4 space-y-2">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : matches.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {matches.map((match: any, idx: number) => (
            <FadeIn key={match.id} delay={idx * 50}>
              <MatchCard match={match} />
            </FadeIn>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Film className="h-10 w-10" />}
          title="No matches yet"
          description="Check back soon for new recordings"
        />
      )}
    </div>
  )
}
