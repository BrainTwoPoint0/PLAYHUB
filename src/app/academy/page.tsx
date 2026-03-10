'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Skeleton,
  EmptyState,
} from '@braintwopoint0/playback-commons/ui'
import { FadeIn } from '@/components/FadeIn'
import { Building2 } from 'lucide-react'

interface Club {
  slug: string
  name: string
  logoUrl?: string | null
}

export default function AcademySelectorPage() {
  const router = useRouter()
  const [clubs, setClubs] = useState<Club[]>([])
  const [role, setRole] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchClubs()
  }, [])

  async function fetchClubs() {
    try {
      setLoading(true)
      const res = await fetch('/api/academy')
      const data = await res.json()

      if (data.error) {
        setError(data.error)
        return
      }

      const clubList = data.clubs || []
      setClubs(clubList)
      setRole(data.role || null)

      // If only one club, redirect directly to content
      if (clubList.length === 1) {
        router.replace(`/academy/${clubList[0].slug}/content`)
      }
    } catch (err) {
      setError('Failed to load clubs')
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
            <div
              key={i}
              className="rounded-xl border border-border bg-card p-6"
            >
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
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => router.push('/')}
          >
            Back to Home
          </Button>
        </div>
      </div>
    )
  }

  if (clubs.length === 0) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <EmptyState
          icon={<Building2 className="h-10 w-10" />}
          title="No Clubs"
          description="You do not have access to any academy clubs."
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
          Academy Subscriptions
        </p>
        <h1 className="text-3xl md:text-4xl font-bold text-[var(--timberwolf)] mb-2">
          Your Clubs
        </h1>
        <p className="text-muted-foreground mb-10">
          Select a club to manage content and subscriptions
        </p>
      </FadeIn>

      <div className="grid gap-4 md:grid-cols-2">
        {clubs.map((club, i) => (
          <FadeIn key={club.slug} delay={i * 100}>
            <div className="rounded-xl border border-border bg-card hover:border-[var(--timberwolf)]/25 transition-colors duration-300">
              <div className="p-6">
                <div className="flex items-center gap-4 mb-4">
                  {club.logoUrl ? (
                    <img
                      src={club.logoUrl}
                      alt={club.name}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                      <span className="text-xl font-bold text-[var(--timberwolf)]">
                        {club.name.charAt(0)}
                      </span>
                    </div>
                  )}
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                        {club.name}
                      </h2>
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${role === 'platform_admin' ? 'bg-amber-500/15 text-amber-400' : 'bg-muted text-muted-foreground'}`}
                      >
                        {role === 'platform_admin' ? 'Admin' : 'Viewer'}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {club.slug.toUpperCase()}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => router.push(`/academy/${club.slug}/content`)}
                  >
                    Content
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => router.push(`/academy/${club.slug}/access`)}
                  >
                    Access Audit
                  </Button>
                </div>
              </div>
            </div>
          </FadeIn>
        ))}
      </div>
    </div>
  )
}
