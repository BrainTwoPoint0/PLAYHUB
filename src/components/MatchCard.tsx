'use client'

import Link from 'next/link'
import Image from 'next/image'
import { motion } from 'motion/react'
import { formatPrice, formatDate } from '@/lib/utils'

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
        <div className="relative bg-black/30 border border-[var(--ash-grey)]/10 rounded-2xl overflow-hidden hover:border-[var(--accent-purple)]/50 hover:shadow-xl hover:shadow-purple-500/10 transition-all">
          {/* Thumbnail */}
          <div className="relative h-56 bg-black/40 overflow-hidden">
            {match.thumbnail_url ? (
              <Image
                src={match.thumbnail_url}
                alt={match.title}
                fill
                className="object-cover group-hover:scale-105 transition-transform duration-700"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-black/40">
                <span className="text-7xl opacity-30">⚽</span>
              </div>
            )}

            {/* Gradient Overlay */}
            <div className="absolute inset-0 bg-gradient-to-t from-[var(--night)] via-[var(--night)]/50 to-transparent" />

            {/* Sport Tag */}
            {match.sport && (
              <div className="absolute top-4 left-4 px-3 py-1 bg-black/60 backdrop-blur-sm border border-[var(--ash-grey)]/20 rounded-lg text-xs font-semibold text-[var(--timberwolf)]">
                {match.sport.name}
              </div>
            )}

            {/* Price Badge */}
            <div className="absolute top-4 right-4 px-4 py-2 bg-gradient-to-r from-[var(--accent-purple)] to-[var(--accent-blue)] text-white rounded-lg font-bold text-lg shadow-lg shadow-purple-500/30">
              {price}
            </div>
          </div>

          {/* Content */}
          <div className="p-5">
            {/* Teams */}
            <h3 className="text-xl font-bold text-[var(--timberwolf)] mb-2 line-clamp-1">
              {match.home_team}{' '}
              <span className="text-[var(--ash-grey)]/50">vs</span>{' '}
              {match.away_team}
            </h3>

            {/* Competition */}
            {match.competition && (
              <p className="text-sm text-[var(--ash-grey)]/80 mb-4 font-medium">
                {match.competition}
              </p>
            )}

            {/* Meta Info */}
            <div className="flex items-center gap-4 text-sm text-[var(--ash-grey)]/60">
              {match.venue && (
                <div className="flex items-center gap-1.5">
                  <svg
                    className="w-4 h-4"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M5.05 4.05a7 7 0 119.9 9.9L10 18.9l-4.95-4.95a7 7 0 010-9.9zM10 11a2 2 0 100-4 2 2 0 000 4z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="line-clamp-1">{match.venue}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5">
                <svg
                  className="w-4 h-4"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z"
                    clipRule="evenodd"
                  />
                </svg>
                <span>{formatDate(match.match_date)}</span>
              </div>
            </div>

            {/* Organization */}
            {match.organization && (
              <div className="mt-4 pt-4 border-t border-[var(--ash-grey)]/10 text-sm text-[var(--ash-grey)]/60">
                {match.organization.name}
              </div>
            )}
          </div>

          {/* Hover Overlay */}
          <div className="absolute inset-0 bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
        </div>
      </motion.div>
    </Link>
  )
}
