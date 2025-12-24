'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

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
      <div className="container mx-auto p-6 max-w-4xl">
        <div className="flex items-center justify-center min-h-[400px]">
          <p className="text-muted-foreground">Loading venues...</p>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto p-6 max-w-4xl">
        <Card>
          <CardContent className="p-6">
            <p className="text-red-500">{error}</p>
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => router.push('/')}
            >
              Back to Home
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (venues.length === 0) {
    return (
      <div className="container mx-auto p-6 max-w-4xl">
        <Card>
          <CardHeader>
            <CardTitle>No Venues</CardTitle>
            <CardDescription>
              You do not have access to manage any venues.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-4">
              To manage a venue, you need to be an admin of an organization with
              Spiideo integration.
            </p>
            <Button variant="outline" onClick={() => router.push('/')}>
              Back to Home
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <h1 className="text-3xl font-bold mb-2">Venue Management</h1>
      <p className="text-muted-foreground mb-8">
        Select a venue to manage recordings and access
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        {venues.map((venue) => (
          <Card
            key={venue.id}
            className="cursor-pointer hover:border-primary transition-colors"
            onClick={() => router.push(`/venue/${venue.id}`)}
          >
            <CardHeader>
              <div className="flex items-center gap-4">
                {venue.logo_url ? (
                  <img
                    src={venue.logo_url}
                    alt={venue.name}
                    className="w-12 h-12 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-primary/20 flex items-center justify-center">
                    <span className="text-xl font-bold text-primary">
                      {venue.name.charAt(0)}
                    </span>
                  </div>
                )}
                <div>
                  <CardTitle className="text-lg">{venue.name}</CardTitle>
                  {venue.slug && (
                    <CardDescription>{venue.slug}</CardDescription>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Button className="w-full">Manage Venue</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
