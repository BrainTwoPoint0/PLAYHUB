'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowLeft } from 'lucide-react'

interface Recording {
  id: string
  title: string
  description: string | null
  matchDate: string
  homeTeam: string
  awayTeam: string
  venue: string | null
  pitchName: string | null
  status: string
  duration: number | null
}

export default function RecordingPage() {
  const params = useParams()
  const router = useRouter()
  const recordingId = params.id as string

  const [recording, setRecording] = useState<Recording | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchRecording()
  }, [recordingId])

  async function fetchRecording() {
    try {
      setLoading(true)
      const res = await fetch(`/api/recordings/${recordingId}`)
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to load recording')
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
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  if (loading) {
    return (
      <div className="container mx-auto p-6 max-w-4xl">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto p-6 max-w-4xl">
        <Card>
          <CardContent className="p-6">
            <p className="text-red-500 mb-4">{error}</p>
            <Button
              variant="outline"
              onClick={() => router.push('/recordings')}
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Recordings
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!recording) {
    return (
      <div className="container mx-auto p-6 max-w-4xl">
        <Card>
          <CardContent className="p-6">
            <p className="text-muted-foreground">Recording not found</p>
            <Button
              variant="outline"
              onClick={() => router.push('/recordings')}
              className="mt-4"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Recordings
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <Button
        variant="ghost"
        onClick={() => router.push('/recordings')}
        className="mb-4"
      >
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to Recordings
      </Button>

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
                className="w-full h-full"
                poster=""
              >
                Your browser does not support the video tag.
              </video>
            </div>
          ) : (
            <div className="aspect-video bg-zinc-900 rounded-lg flex items-center justify-center">
              <p className="text-muted-foreground">
                {recording.status === 'scheduled'
                  ? 'Recording not yet available'
                  : recording.status === 'processing'
                    ? 'Recording is being processed...'
                    : 'Video not available'}
              </p>
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
            {recording.venue && (
              <div>
                <p className="text-sm text-muted-foreground">Venue</p>
                <p className="font-medium">{recording.venue}</p>
              </div>
            )}
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
    </div>
  )
}
