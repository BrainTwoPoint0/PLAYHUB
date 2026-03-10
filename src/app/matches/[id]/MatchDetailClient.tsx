'use client'

import Image from 'next/image'
import Link from 'next/link'
import { motion } from 'motion/react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  Button,
} from '@braintwopoint0/playback-commons/ui'
import { formatPrice, formatDate } from '@braintwopoint0/playback-commons/utils'
import { useState } from 'react'
import {
  ArrowLeft,
  Zap,
  Film,
  Repeat,
  ShieldCheck,
  Play,
  CheckCircle,
} from 'lucide-react'

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
    <div className="mx-auto max-w-screen-xl px-4 py-12 sm:px-6 lg:px-8">
      {/* Back Button */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.3 }}
      >
        <Link
          href="/matches"
          className="text-muted-foreground hover:text-[var(--timberwolf)] mb-8 inline-flex items-center text-sm transition-colors duration-300 gap-2"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Matches
        </Link>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 mt-6">
        {/* Main Content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Hero Thumbnail */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="relative h-[400px] lg:h-[500px] bg-muted rounded-xl overflow-hidden border border-border group"
          >
            <div className="absolute inset-0 bg-gradient-to-t from-[var(--night)] via-transparent to-transparent z-10" />

            {match.thumbnail_url ? (
              <Image
                src={match.thumbnail_url}
                alt={match.title}
                fill
                className="object-cover group-hover:scale-105 transition-transform duration-700"
                priority
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-muted">
                <span className="text-5xl font-bold text-muted-foreground/30">
                  {match.home_team?.charAt(0)} v {match.away_team?.charAt(0)}
                </span>
              </div>
            )}

            {/* Sport Badge */}
            {match.sport && (
              <Badge className="absolute top-4 left-4 bg-black/60 backdrop-blur-sm text-[var(--timberwolf)] border-border z-20 px-3 py-1.5">
                {match.sport.name}
              </Badge>
            )}

            {/* Play Button Overlay */}
            {!hasAccess && (
              <div className="absolute inset-0 flex items-center justify-center z-20 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <div className="w-16 h-16 rounded-full bg-[var(--timberwolf)]/90 backdrop-blur-sm flex items-center justify-center">
                  <Play className="h-7 w-7 text-[var(--night)] ml-0.5" />
                </div>
              </div>
            )}
          </motion.div>

          {/* Match Info Card */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
          >
            <Card className="bg-card border-border">
              <CardHeader className="pb-4">
                <CardTitle className="text-2xl md:text-3xl text-[var(--timberwolf)]">
                  {match.home_team}{' '}
                  <span className="text-muted-foreground">vs</span>{' '}
                  {match.away_team}
                </CardTitle>
                {match.competition && (
                  <p className="text-base text-muted-foreground mt-1 font-medium">
                    {match.competition}
                  </p>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 bg-muted rounded-lg">
                    <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                      Date
                    </p>
                    <p className="text-[var(--timberwolf)] font-medium text-sm">
                      {formatDate(match.match_date)}
                    </p>
                  </div>
                  {match.venue && (
                    <div className="p-3 bg-muted rounded-lg">
                      <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                        Venue
                      </p>
                      <p className="text-[var(--timberwolf)] font-medium text-sm">
                        {match.venue}
                      </p>
                    </div>
                  )}
                  {match.organization && (
                    <div className="p-3 bg-muted rounded-lg">
                      <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                        Organization
                      </p>
                      <p className="text-[var(--timberwolf)] font-medium text-sm">
                        {match.organization.name}
                      </p>
                    </div>
                  )}
                  {match.duration_seconds && (
                    <div className="p-3 bg-muted rounded-lg">
                      <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                        Duration
                      </p>
                      <p className="text-[var(--timberwolf)] font-medium text-sm">
                        {Math.floor(match.duration_seconds / 60)} minutes
                      </p>
                    </div>
                  )}
                </div>

                {match.description && (
                  <div className="pt-4 border-t border-border">
                    <h3 className="text-sm font-semibold text-[var(--timberwolf)] mb-2">
                      About This Match
                    </h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
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
            <Card className="bg-card border-border overflow-hidden">
              <CardHeader>
                <CardTitle className="text-lg text-[var(--timberwolf)] flex items-center gap-2">
                  {hasAccess && (
                    <CheckCircle className="h-5 w-5 text-emerald-400" />
                  )}
                  {hasAccess ? 'You own this match' : 'Purchase Access'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-5">
                {product && (
                  <>
                    {/* Price */}
                    <div className="text-center py-5 bg-muted rounded-lg">
                      <p className="text-4xl font-bold text-[var(--timberwolf)] mb-1">
                        {formatPrice(product.price_amount, product.currency)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {product.access_duration_days
                          ? `${product.access_duration_days} days access`
                          : 'Lifetime access'}
                      </p>
                    </div>

                    {/* CTA Button */}
                    {hasAccess ? (
                      <Button className="w-full" asChild>
                        <Link href={`/library`}>Watch Now</Link>
                      </Button>
                    ) : (
                      <Button
                        onClick={handlePurchase}
                        disabled={isLoading}
                        className="w-full bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]"
                      >
                        {isLoading ? 'Processing...' : 'Purchase Now'}
                      </Button>
                    )}

                    {/* Features List */}
                    <div className="pt-4 border-t border-border space-y-3">
                      {[
                        { icon: Zap, text: 'Instant access after purchase' },
                        { icon: Film, text: 'Stream in HD quality' },
                        { icon: Repeat, text: 'Watch unlimited times' },
                        {
                          icon: ShieldCheck,
                          text: 'Secure payment with Stripe',
                        },
                      ].map((feature, idx) => (
                        <div
                          key={idx}
                          className="flex items-center text-muted-foreground text-sm gap-3"
                        >
                          <feature.icon className="h-4 w-4 flex-shrink-0" />
                          <span>{feature.text}</span>
                        </div>
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
