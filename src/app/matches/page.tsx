'use client'

import { createClient } from '@braintwopoint0/playback-commons/supabase'
import MatchCard from '@/components/MatchCard'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'

export default function MatchesPage() {
  const [matches, setMatches] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function fetchMatches() {
      const supabase = createClient()

      // Type assertion for PLAYHUB tables
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
    <div className="min-h-screen bg-[var(--night)]">
      <div className="container mx-auto px-5 py-16">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-12"
        >
          <h1 className="text-5xl md:text-6xl font-bold text-[var(--timberwolf)] mb-4">
            Match Marketplace
          </h1>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <p className="text-xl text-[var(--ash-grey)]">
              Browse professional match recordings
            </p>
            <div className="px-4 py-2 bg-black/30 border border-[var(--ash-grey)]/20 rounded-xl">
              <span className="text-2xl font-bold text-[var(--timberwolf)]">
                {loading ? '...' : matches.length}
              </span>
              <span className="text-[var(--ash-grey)]/60 ml-2">
                {matches.length === 1 ? 'match' : 'matches'}
              </span>
            </div>
          </div>
        </motion.div>

        {/* Matches Grid */}
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 0.3, y: 0 }}
                transition={{ duration: 0.4, delay: i * 0.05 }}
                className="h-[400px] bg-black/20 border border-[var(--ash-grey)]/10 rounded-2xl animate-pulse"
              />
            ))}
          </div>
        ) : matches && matches.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {matches.map((match: any, idx: number) => (
              <motion.div
                key={match.id}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: idx * 0.05 }}
              >
                <MatchCard match={match} />
              </motion.div>
            ))}
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="text-center py-24"
          >
            <div className="text-7xl mb-6 opacity-30">🎬</div>
            <p className="text-3xl font-bold text-[var(--timberwolf)] mb-3">
              No matches yet
            </p>
            <p className="text-lg text-[var(--ash-grey)]/60">
              Check back soon for new recordings
            </p>
          </motion.div>
        )}
      </div>
    </div>
  )
}
