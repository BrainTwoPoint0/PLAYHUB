'use client'

import { useState, useEffect } from 'react'
import { useParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface Recording {
  id: string
  title: string
  description: string | null
  matchDate: string
  homeTeam: string
  awayTeam: string
  venue: string | null
  pitchName: string | null
}

export default function PublicWatchPage() {
  const params = useParams()
  const token = params.token as string

  const [recording, setRecording] = useState<Recording | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchRecording()
  }, [token])

  async function fetchRecording() {
    try {
      setLoading(true)
      const res = await fetch(`/api/watch/${token}`)
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Recording not found')
        return
      }

      setRecording(data.recording)
      setVideoUrl(data.videoUrl)
    } catch (err) {
      setError('Failed to load recording')
    } finally {
      setLoading(false)
    }
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <Card className="max-w-md w-full">
          <CardContent className="p-6 text-center">
            <p className="text-red-500 mb-2">{error}</p>
            <p className="text-sm text-muted-foreground">
              This link may be invalid or the recording is not yet available.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!recording) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Recording not found</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-6 max-w-4xl">
        <Card>
          <CardHeader>
            <CardTitle>{recording.title}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {formatDate(recording.matchDate)}
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Video Player */}
            {videoUrl ? (
              <div className="aspect-video bg-black rounded-lg overflow-hidden">
                <video
                  src={videoUrl}
                  controls
                  autoPlay
                  className="w-full h-full"
                >
                  Your browser does not support the video tag.
                </video>
              </div>
            ) : (
              <div className="aspect-video bg-zinc-900 rounded-lg flex items-center justify-center">
                <p className="text-muted-foreground">Video not available</p>
              </div>
            )}

            {/* Match Info */}
            <div className="grid grid-cols-2 gap-4 pt-4">
              <div>
                <p className="text-sm text-muted-foreground">Home Team</p>
                <p className="font-medium">{recording.homeTeam}</p>
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Away Team</p>
                <p className="font-medium">{recording.awayTeam}</p>
              </div>
              {recording.pitchName && (
                <div>
                  <p className="text-sm text-muted-foreground">Pitch</p>
                  <p className="font-medium">{recording.pitchName}</p>
                </div>
              )}
            </div>

            {recording.description && (
              <div className="pt-4 border-t">
                <p className="text-sm text-muted-foreground">Description</p>
                <p>{recording.description}</p>
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Powered by PLAYHUB
        </p>
      </div>
    </div>
  )
}
