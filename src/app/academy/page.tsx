'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@braintwopoint0/playback-commons/ui'
import { FadeIn } from '@/components/FadeIn'

interface Club {
  slug: string
  name: string
  logoUrl?: string | null
}

export default function AcademySelectorPage() {
  const router = useRouter()
  const [clubs, setClubs] = useState<Club[]>([])
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

      // If only one club, redirect directly
      if (clubList.length === 1) {
        router.replace(`/academy/${clubList[0].slug}`)
      }
    } catch (err) {
      setError('Failed to load clubs')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl animate-pulse">
          <div className="mb-10 space-y-3">
            <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-[140px]" />
            <div className="bg-[var(--ash-grey)]/10 rounded h-9 w-[200px]" />
            <div className="bg-[var(--ash-grey)]/10 rounded h-4 w-[300px]" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-6"
              >
                <div className="flex items-center gap-4 mb-4">
                  <div className="w-12 h-12 rounded-full bg-[var(--ash-grey)]/10" />
                  <div className="space-y-2 flex-1">
                    <div className="bg-[var(--ash-grey)]/10 rounded h-5 w-[140px]" />
                    <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-[100px]" />
                  </div>
                </div>
                <div className="bg-[var(--ash-grey)]/10 rounded h-10 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl">
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-6">
            <p className="text-red-400">{error}</p>
            <Button
              className="mt-4 border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10"
              variant="outline"
              onClick={() => router.push('/')}
            >
              Back to Home
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (clubs.length === 0) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl">
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6 pb-3">
              <h1 className="text-2xl font-bold text-[var(--timberwolf)]">
                No Clubs
              </h1>
              <p className="text-sm text-[var(--ash-grey)] mt-1">
                You do not have access to any academy clubs.
              </p>
            </div>
            <div className="px-6 pb-6">
              <Button
                variant="outline"
                onClick={() => router.push('/')}
                className="border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10"
              >
                Back to Home
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--night)]">
      <div className="container mx-auto px-5 py-16 max-w-4xl">
        <FadeIn>
          <p className="text-[var(--ash-grey)] text-xs font-semibold tracking-[0.25em] uppercase mb-3">
            Academy Subscriptions
          </p>
          <h1 className="text-3xl md:text-4xl font-bold text-[var(--timberwolf)] mb-2">
            Your Clubs
          </h1>
          <p className="text-[var(--ash-grey)] mb-10">
            Select a club to view subscription analytics
          </p>
        </FadeIn>

        <div className="grid gap-4 md:grid-cols-2">
          {clubs.map((club, i) => (
            <FadeIn key={club.slug} delay={i * 100}>
              <div
                className="cursor-pointer rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] hover:border-[var(--timberwolf)]/25 hover:bg-white/[0.035] transition-colors duration-300"
                onClick={() => router.push(`/academy/${club.slug}/access`)}
              >
                <div className="p-6">
                  <div className="flex items-center gap-4 mb-4">
                    {club.logoUrl ? (
                      <img
                        src={club.logoUrl}
                        alt={club.name}
                        className="w-12 h-12 rounded-full object-cover"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-full bg-[var(--timberwolf)]/20 flex items-center justify-center">
                        <span className="text-xl font-bold text-[var(--timberwolf)]">
                          {club.name.charAt(0)}
                        </span>
                      </div>
                    )}
                    <div>
                      <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                        {club.name}
                      </h2>
                      <p className="text-sm text-[var(--ash-grey)]">
                        {club.slug}
                      </p>
                    </div>
                  </div>
                  <Button className="w-full bg-white/10 hover:bg-white/20 text-[var(--timberwolf)] border border-[var(--ash-grey)]/20">
                    Veo Access Audit
                  </Button>
                </div>
              </div>
            </FadeIn>
          ))}
        </div>
      </div>
    </div>
  )
}
