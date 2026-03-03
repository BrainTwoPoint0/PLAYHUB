'use client'

import Link from 'next/link'
import Image from 'next/image'
import { motion } from 'motion/react'
import { formatPrice, formatDate } from '@braintwopoint0/playback-commons/utils'
import { MapPin, Calendar } from 'lucide-react'

interface MatchCardProps {
  match: {
    id: string
    title: string
    description?: string
    home_team: string
    away_team: string
    match_date: string
    venue?: string
    competition?: string
    thumbnail_url?: string
    sport?: {
      name: string
    }
    organization?: {
      name: string
    }
    products?: Array<{
      id: string
      price_amount: number
      currency: string
    }>
  }
}

export default function MatchCard({ match }: MatchCardProps) {
  const product = match.products?.[0]
  const price = product
    ? formatPrice(product.price_amount, product.currency)
    : 'N/A'

  return (
    <Link href={`/matches/${match.id}`}>
      <motion.div
        whileHover={{ y: -4 }}
        transition={{ duration: 0.2 }}
        className="group cursor-pointer"
      >
        <div className="relative border border-border bg-card rounded-xl overflow-hidden hover:border-[var(--timberwolf)]/25 transition-all">
          {/* Thumbnail */}
          <div className="relative h-56 bg-muted overflow-hidden">
            {match.thumbnail_url ? (
              <Image
                src={match.thumbnail_url}
                alt={match.title}
                fill
                className="object-cover group-hover:scale-105 transition-transform duration-700"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center">
                <span className="text-4xl font-bold text-muted-foreground/30">
                  {match.home_team.charAt(0)} v {match.away_team.charAt(0)}
                </span>
              </div>
            )}

            {/* Gradient Overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-[var(--night)] via-[var(--night)]/50 to-transparent" />

            {/* Sport Tag */}
            {match.sport && (
              <div className="absolute top-3 left-3 px-2.5 py-1 bg-black/60 backdrop-blur-sm border border-border rounded-md text-xs font-medium text-[var(--timberwolf)]">
                {match.sport.name}
              </div>
            )}

            {/* Price Badge */}
            <div className="absolute top-3 right-3 px-3 py-1.5 bg-[var(--timberwolf)] text-[var(--night)] rounded-md font-bold text-sm">
              {price}
            </div>
          </div>

          {/* Content */}
          <div className="p-4">
            {/* Teams */}
            <h3 className="text-lg font-semibold text-[var(--timberwolf)] mb-1 line-clamp-1">
              {match.home_team}{' '}
              <span className="text-muted-foreground">vs</span>{' '}
              {match.away_team}
            </h3>

            {/* Competition */}
            {match.competition && (
              <p className="text-sm text-muted-foreground mb-3 font-medium">
                {match.competition}
              </p>
            )}

            {/* Meta Info */}
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              {match.venue && (
                <div className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5" />
                  <span className="line-clamp-1">{match.venue}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                <span>{formatDate(match.match_date)}</span>
              </div>
            </div>

            {/* Organization */}
            {match.organization && (
              <div className="mt-3 pt-3 border-t border-border text-xs text-muted-foreground">
                {match.organization.name}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </Link>
  )
}
