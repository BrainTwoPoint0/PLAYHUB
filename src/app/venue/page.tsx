'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Skeleton, EmptyState } from '@braintwopoint0/playback-commons/ui'
import { FadeIn } from '@/components/FadeIn'
import { Building2 } from 'lucide-react'

interface Venue {
  id: string
  name: string
  slug: string | null
  logo_url: string | null
}

export default function VenueSelectorPage() {
  const router = useRouter()
  const [venues, setVenues] = useState<Venue[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchVenues()
  }, [])

  async function fetchVenues() {
    try {
      setLoading(true)
      const res = await fetch('/api/venue')
      const data = await res.json()

      if (data.error) {
        setError(data.error)
        return
      }

      const venueList = data.venues || []
      setVenues(venueList)

      // If only one venue, redirect directly to it
      if (venueList.length === 1) {
        router.replace(`/venue/${venueList[0].id}`)
      }
    } catch (err) {
      setError('Failed to load venues')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <div className="mb-10 space-y-3">
          <Skeleton className="h-3 w-[140px]" />
          <Skeleton className="h-9 w-[200px]" />
          <Skeleton className="h-4 w-[300px]" />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-6">
              <div className="flex items-center gap-4 mb-4">
                <Skeleton className="w-12 h-12 rounded-full" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-5 w-[140px]" />
                  <Skeleton className="h-3 w-[100px]" />
                </div>
              </div>
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <div className="rounded-xl border border-border bg-card p-6">
          <p className="text-red-400">{error}</p>
          <Button className="mt-4" variant="outline" onClick={() => router.push('/')}>
            Back to Home
          </Button>
        </div>
      </div>
    )
  }

  if (venues.length === 0) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={<Building2 className="h-10 w-10" />}
          title="No Venues"
          description="You do not have access to manage any venues. To manage a venue, you need to be an admin of an organization with Spiideo integration."
          action={
            <Button variant="outline" onClick={() => router.push('/')}>
              Back to Home
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <FadeIn>
        <p className="text-muted-foreground text-xs font-semibold tracking-[0.25em] uppercase mb-3">
          Venue Management
        </p>
        <h1 className="text-3xl md:text-4xl font-bold text-[var(--timberwolf)] mb-2">
          Your Venues
        </h1>
        <p className="text-muted-foreground mb-10">
          Select a venue to manage recordings and access
        </p>
      </FadeIn>

      <div className="grid gap-4 md:grid-cols-2">
        {venues.map((venue, i) => (
          <FadeIn key={venue.id} delay={i * 100}>
            <div
              className="cursor-pointer rounded-xl border border-border bg-card hover:border-[var(--timberwolf)]/25 hover:bg-muted/50 transition-colors duration-300"
              onClick={() => router.push(`/venue/${venue.id}`)}
            >
              <div className="p-6">
                <div className="flex items-center gap-4 mb-4">
                  {venue.logo_url ? (
                    <img
                      src={venue.logo_url}
                      alt={venue.name}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                      <span className="text-xl font-bold text-[var(--timberwolf)]">
                        {venue.name.charAt(0)}
                      </span>
                    </div>
                  )}
                  <div>
                    <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                      {venue.name}
                    </h2>
                    {venue.slug && (
                      <p className="text-sm text-muted-foreground">{venue.slug.toUpperCase()}</p>
                    )}
                  </div>
                </div>
                <Button variant="outline" className="w-full">
                  Manage Venue
                </Button>
              </div>
            </div>
          </FadeIn>
        ))}
      </div>
    </div>
  )
}
