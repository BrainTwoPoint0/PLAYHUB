'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import {
  Button,
  Skeleton,
  EmptyState,
} from '@braintwopoint0/playback-commons/ui'
import { FadeIn } from '@/components/FadeIn'
import Image from 'next/image'
import { Film } from 'lucide-react'

interface OrgInfo {
  id: string
  name: string
  slug: string
  logoUrl: string | null
}

interface MarketplaceRecording {
  id: string
  title: string
  description: string | null
  matchDate: string
  homeTeam: string
  awayTeam: string
  pitchName: string | null
  thumbnailUrl: string | null
  product: {
    id: string
    priceAmount: number
    currency: string
    isAvailable: boolean
  } | null
}

export default function OrgMarketplacePage() {
  const params = useParams()
  const slug = params.slug as string

  const [org, setOrg] = useState<OrgInfo | null>(null)
  const [recordings, setRecordings] = useState<MarketplaceRecording[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchData()
  }, [slug])

  async function fetchData() {
    try {
      setLoading(true)
      const res = await fetch(`/api/org/${slug}/recordings`)
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Not found')
        return
      }

      setOrg(data.organization)
      setRecordings(data.recordings)
    } catch {
      setError('Failed to load')
    } finally {
      setLoading(false)
    }
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  }

  function formatPrice(amount: number, currency: string) {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount)
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <div className="flex items-center gap-4 mb-10">
          <Skeleton className="w-16 h-16 rounded-full" />
          <Skeleton className="h-8 w-[200px]" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-border bg-card overflow-hidden"
            >
              <Skeleton className="aspect-video w-full rounded-none" />
              <div className="p-4 space-y-2">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error || !org) {
    return (
      <div className="min-h-[50vh] flex items-center justify-center">
        <p className="text-muted-foreground">{error || 'Not found'}</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      {/* Org Header */}
      <FadeIn>
        <div className="flex items-center gap-4 mb-10">
          {org.logoUrl ? (
            <Image
              src={org.logoUrl}
              alt={org.name}
              width={64}
              height={64}
              className="w-16 h-16 rounded-full object-cover border border-border"
            />
          ) : (
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center text-2xl font-bold text-[var(--timberwolf)]">
              {org.name.charAt(0)}
            </div>
          )}
          <div>
            <h1 className="text-2xl font-bold text-[var(--timberwolf)]">
              {org.name}
            </h1>
            <p className="text-sm text-muted-foreground">Match Recordings</p>
          </div>
        </div>
      </FadeIn>

      {/* Recordings Grid */}
      {recordings.length === 0 ? (
        <EmptyState
          icon={<Film className="h-10 w-10" />}
          title="No recordings available"
          description="Check back soon for new content"
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {recordings.map((rec, i) => (
            <FadeIn key={rec.id} delay={50 * i}>
              <div className="rounded-xl border border-border bg-card overflow-hidden hover:border-[var(--timberwolf)]/20 transition-colors">
                {/* Thumbnail */}
                <div className="aspect-video bg-muted flex items-center justify-center">
                  {rec.thumbnailUrl ? (
                    <Image
                      src={rec.thumbnailUrl}
                      alt={rec.title}
                      width={400}
                      height={225}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {rec.homeTeam} vs {rec.awayTeam}
                    </span>
                  )}
                </div>

                {/* Info */}
                <div className="p-4 space-y-2">
                  <h3 className="text-sm font-semibold text-[var(--timberwolf)] line-clamp-1">
                    {rec.title}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(rec.matchDate)}
                    {rec.pitchName && ` — ${rec.pitchName}`}
                  </p>

                  {/* Price + Buy */}
                  {rec.product && rec.product.isAvailable ? (
                    <div className="flex items-center justify-between pt-2">
                      <span className="text-lg font-bold text-[var(--timberwolf)]">
                        {formatPrice(
                          rec.product.priceAmount,
                          rec.product.currency
                        )}
                      </span>
                      <Button
                        size="sm"
                        className="bg-emerald-600 hover:bg-emerald-700 text-white"
                        onClick={() => {
                          window.location.href = `/api/checkout/session?productId=${rec.product!.id}`
                        }}
                      >
                        Buy
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground pt-2">
                      Coming soon
                    </p>
                  )}
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      )}

      <p className="text-center text-xs text-muted-foreground mt-12">
        Powered by PLAYHUB
      </p>
    </div>
  )
}
