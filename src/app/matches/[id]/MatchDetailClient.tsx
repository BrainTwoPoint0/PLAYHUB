'use client'

import Image from 'next/image'
import Link from 'next/link'
import { motion } from 'motion/react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatPrice, formatDate } from '@/lib/utils'
import { useState } from 'react'

interface MatchDetailClientProps {
  match: any
  product: any
  hasAccess: boolean
}

export default function MatchDetailClient({
  match,
  product,
  hasAccess,
}: MatchDetailClientProps) {
  const [isLoading, setIsLoading] = useState(false)

  const handlePurchase = async () => {
    setIsLoading(true)
    try {
      window.location.href = `/api/checkout/session?productId=${product.id}`
    } catch (error) {
      console.error('Purchase error:', error)
      setIsLoading(false)
    }
  }
  return (
    <div className="container mx-auto px-5 py-12">
      {/* Back Button */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.3 }}
      >
        <Link
          href="/matches"
          className="text-[var(--ash-grey)] hover:text-[var(--timberwolf)] mb-8 inline-flex items-center text-lg transition-colors duration-300"
        >
          ← Back to Matches
        </Link>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-10 mt-8">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-8">
          {/* Hero Thumbnail with Play Button */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="relative h-[500px] bg-zinc-900 rounded-2xl overflow-hidden border border-[var(--ash-grey)]/20 group"
          >
            {/* Gradient Overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-zinc-900 via-transparent to-transparent z-10" />

            {match.thumbnail_url ? (
              <Image
                src={match.thumbnail_url}
                alt={match.title}
                fill
                className="object-cover group-hover:scale-105 transition-transform duration-700"
                priority
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[var(--ash-grey)] bg-gradient-to-br from-zinc-800 to-zinc-900">
                <span className="text-9xl">⚽</span>
              </div>
            )}

            {/* Sport Badge */}
            {match.sport && (
              <Badge className="absolute top-6 left-6 bg-zinc-900/90 backdrop-blur-sm text-[var(--timberwolf)] border-[var(--ash-grey)]/30 shadow-xl text-base px-4 py-2 z-20">
                {match.sport.name}
              </Badge>
            )}

            {/* Play Button Overlay */}
            {!hasAccess && (
              <div className="absolute inset-0 flex items-center justify-center z-20 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <motion.div
                  initial={{ scale: 0.9 }}
                  whileHover={{ scale: 1.1 }}
                  className="w-24 h-24 rounded-full bg-[var(--timberwolf)]/95 backdrop-blur-sm flex items-center justify-center shadow-2xl"
                >
                  <span className="text-5xl text-[var(--night)] ml-1">▶</span>
                </motion.div>
              </div>
            )}
          </motion.div>

          {/* Match Info Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <Card className="bg-zinc-900 border-[var(--ash-grey)]/20 shadow-xl">
              <CardHeader className="pb-6">
                <CardTitle className="text-4xl md:text-5xl text-[var(--timberwolf)] font-bold">
                  {match.home_team}{' '}
                  <span className="text-[var(--ash-grey)]">vs</span>{' '}
                  {match.away_team}
                </CardTitle>
                {match.competition && (
                  <p className="text-xl text-[var(--ash-grey)] mt-3 font-medium">
                    {match.competition}
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="grid grid-cols-2 gap-6">
                  <div className="p-4 bg-zinc-800 rounded-lg">
                    <p className="text-[var(--ash-grey)] mb-2 text-sm uppercase tracking-wide">
                      Date
                    </p>
                    <p className="text-[var(--timberwolf)] font-semibold text-lg">
                      {formatDate(match.match_date)}
                    </p>
                  </div>
                  {match.venue && (
                    <div className="p-4 bg-zinc-800 rounded-lg">
                      <p className="text-[var(--ash-grey)] mb-2 text-sm uppercase tracking-wide">
                        Venue
                      </p>
                      <p className="text-[var(--timberwolf)] font-semibold text-lg">
                        {match.venue}
                      </p>
                    </div>
                  )}
                  {match.organization && (
                    <div className="p-4 bg-zinc-800 rounded-lg">
                      <p className="text-[var(--ash-grey)] mb-2 text-sm uppercase tracking-wide">
                        Organization
                      </p>
                      <p className="text-[var(--timberwolf)] font-semibold text-lg">
                        {match.organization.name}
                      </p>
                    </div>
                  )}
                  {match.duration_seconds && (
                    <div className="p-4 bg-zinc-800 rounded-lg">
                      <p className="text-[var(--ash-grey)] mb-2 text-sm uppercase tracking-wide">
                        Duration
                      </p>
                      <p className="text-[var(--timberwolf)] font-semibold text-lg">
                        {Math.floor(match.duration_seconds / 60)} minutes
                      </p>
                    </div>
                  )}
                </div>

                {match.description && (
                  <div className="pt-6 border-t border-[var(--ash-grey)]/10">
                    <h3 className="text-xl font-bold text-[var(--timberwolf)] mb-3">
                      About This Match
                    </h3>
                    <p className="text-[var(--ash-grey)] leading-relaxed text-lg">
                      {match.description}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* Sidebar - Purchase Card */}
        <motion.div
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="lg:col-span-1"
        >
          <div className="sticky top-8">
            <Card className="bg-zinc-900 border-[var(--ash-grey)]/20 shadow-2xl overflow-hidden">
              {/* Gradient Background */}
              <div className="absolute inset-0 bg-gradient-to-br from-[var(--ash-grey)]/5 to-transparent pointer-events-none" />

              <CardHeader className="relative">
                <CardTitle className="text-2xl text-[var(--timberwolf)]">
                  {hasAccess ? '✓ You own this match' : 'Purchase Access'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6 relative">
                {product && (
                  <>
                    {/* Price */}
                    <div className="text-center py-6 bg-zinc-800 rounded-xl">
                      <p className="text-5xl font-bold text-[var(--timberwolf)] mb-2">
                        {formatPrice(product.price_amount, product.currency)}
                      </p>
                      <p className="text-base text-[var(--ash-grey)] mt-2">
                        {product.access_duration_days
                          ? `${product.access_duration_days} days access`
                          : '🎉 Lifetime access'}
                      </p>
                    </div>

                    {/* CTA Button */}
                    {hasAccess ? (
                      <Button
                        className="w-full bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)] text-lg py-6 shadow-lg"
                        asChild
                      >
                        <Link href={`/library`}>Watch Now →</Link>
                      </Button>
                    ) : (
                      <motion.div
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                      >
                        <Button
                          onClick={handlePurchase}
                          disabled={isLoading}
                          className="w-full bg-gradient-to-r from-[var(--accent-purple)] to-[var(--accent-blue)] text-white hover:opacity-90 text-lg py-6 shadow-xl hover:shadow-2xl shadow-purple-500/30 transition-all duration-300 disabled:opacity-50"
                        >
                          {isLoading ? 'Processing...' : 'Purchase Now →'}
                        </Button>
                      </motion.div>
                    )}

                    {/* Features List */}
                    <div className="pt-6 border-t border-[var(--ash-grey)]/10 space-y-3">
                      {[
                        { icon: '⚡', text: 'Instant access after purchase' },
                        { icon: '🎬', text: 'Stream in HD quality' },
                        { icon: '♾️', text: 'Watch unlimited times' },
                        { icon: '🔒', text: 'Secure payment with Stripe' },
                      ].map((feature, idx) => (
                        <motion.div
                          key={idx}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.3, delay: 0.3 + idx * 0.1 }}
                          className="flex items-center text-[var(--ash-grey)] group hover:text-[var(--timberwolf)] transition-colors duration-300"
                        >
                          <span className="mr-3 text-xl">{feature.icon}</span>
                          <span className="text-base">{feature.text}</span>
                        </motion.div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </motion.div>
      </div>
    </div>
  )
}
