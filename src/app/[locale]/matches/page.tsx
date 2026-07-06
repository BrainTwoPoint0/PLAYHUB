'use client'

import { createClient } from '@braintwopoint0/playback-commons/supabase'
import { Skeleton, EmptyState } from '@braintwopoint0/playback-commons/ui'
import MatchCard from '@/components/MatchCard'
import { FadeIn } from '@/components/FadeIn'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Film } from 'lucide-react'

export default function MatchesPage() {
  const t = useTranslations('matches')
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
          organization:organizations!organization_id(name),
          products:playhub_products(id, price_amount, currency, is_available)
        `
        )
        .eq('status', 'published')
        .order('match_date', { ascending: false })

      if (error) {
        console.error('Error fetching matches:', error)
        setLoading(false)
        return
      }

      const publishedMatches =
        data?.filter(
          (match: any) =>
            match.products &&
            match.products.length > 0 &&
            match.products.some((p: any) => p.is_available)
        ) || []

      // Mark recordings the signed-in user already owns so the grid card
      // shows "Bought" instead of the price. Anonymous visitors get no
      // ownership info — same UX as today.
      const {
        data: { user },
      } = await (supabase as any).auth.getUser()
      if (user && publishedMatches.length > 0) {
        const ids = publishedMatches.map((m: any) => m.id)
        const { data: rights } = await (supabase as any)
          .from('playhub_access_rights')
          .select('match_recording_id')
          .eq('user_id', user.id)
          .in('match_recording_id', ids)
        const ownedIds = new Set(
          (rights || []).map((r: any) => r.match_recording_id)
        )
        for (const m of publishedMatches) {
          m.owned = ownedIds.has(m.id)
        }
      }

      setMatches(publishedMatches)
      setLoading(false)
    }

    fetchMatches()
  }, [])

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-12 sm:px-6 lg:px-8">
      <FadeIn className="mb-10">
        <h1 className="text-3xl md:text-4xl font-bold text-[var(--timberwolf)] mb-2">
          {t('title')}
        </h1>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <p className="text-muted-foreground">{t('subtitle')}</p>
          <div className="px-3 py-1.5 rounded-lg border border-border bg-card">
            <span className="text-lg font-bold text-[var(--timberwolf)]">
              {loading ? '...' : matches.length}
            </span>
            <span className="text-muted-foreground ms-2 text-sm">
              {t('matchesWord', { count: matches.length })}
            </span>
          </div>
        </div>
      </FadeIn>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-border bg-card overflow-hidden"
            >
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
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      )}
    </div>
  )
}
