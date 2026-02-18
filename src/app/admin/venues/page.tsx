'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
} from '@braintwopoint0/playback-commons/ui'

interface Venue {
  id: string
  name: string
  slug: string | null
  logo_url: string | null
  created_at: string
  adminCount: number
  recordingCount: number
}

export default function AdminVenuesPage() {
  const [venues, setVenues] = useState<Venue[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchVenues()
  }, [])

  async function fetchVenues() {
    try {
      const res = await fetch('/api/admin?section=venues')
      const data = await res.json()
      setVenues(data.venues || [])
    } catch (err) {
      console.error('Failed to fetch venues:', err)
    } finally {
      setLoading(false)
    }
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  if (loading) {
    return <p className="text-muted-foreground">Loading venues...</p>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Venues</h1>
        <p className="text-muted-foreground">{venues.length} total</p>
      </div>

      {venues.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">No venues found</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {venues.map((venue) => (
            <Card key={venue.id}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    {venue.logo_url ? (
                      <img
                        src={venue.logo_url}
                        alt={venue.name}
                        className="w-12 h-12 rounded-lg object-cover"
                      />
                    ) : (
                      <div className="w-12 h-12 rounded-lg bg-zinc-800 flex items-center justify-center text-xl">
                        🏟️
                      </div>
                    )}
                    <div>
                      <h3 className="font-semibold text-lg">{venue.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {venue.slug ? `/${venue.slug}` : 'No slug'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-6">
                    <div className="text-center">
                      <p className="text-2xl font-bold">{venue.adminCount}</p>
                      <p className="text-xs text-muted-foreground">Admins</p>
                    </div>
                    <div className="text-center">
                      <p className="text-2xl font-bold">
                        {venue.recordingCount}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Recordings
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-muted-foreground">
                        Created {formatDate(venue.created_at)}
                      </p>
                      <Link href={`/venue/${venue.id}`}>
                        <Button variant="outline" size="sm" className="mt-2">
                          Manage
                        </Button>
                      </Link>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
