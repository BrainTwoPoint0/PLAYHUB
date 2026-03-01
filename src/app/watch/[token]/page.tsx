'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
} from '@braintwopoint0/playback-commons/ui'
import { useAuth } from '@braintwopoint0/playback-commons/auth'
import { Bookmark, BookmarkCheck, Loader2 } from 'lucide-react'
import { LoadingSpinner } from '@/components/ui/loading'
import { VideoPlayer, type MediaPack, type GraphicPackageOverlay } from '@/components/video/VideoPlayer'
import { EventTagsList } from '@/components/EventTagsList'
import { MatchDetails } from '@/components/MatchDetails'
import type { RecordingEvent } from '@/lib/recordings/event-types'

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
  const router = useRouter()
  const token = params.token as string
  const { user, loading: authLoading } = useAuth()

  const [recording, setRecording] = useState<Recording | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [events, setEvents] = useState<RecordingEvent[]>([])
  const [mediaPack, setMediaPack] = useState<MediaPack | undefined>(undefined)
  const [graphicPackage, setGraphicPackage] = useState<GraphicPackageOverlay | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [checkingAccess, setCheckingAccess] = useState(false)

  useEffect(() => {
    fetchRecording()
  }, [token])

  // Check if user already has access when they're signed in and recording is loaded
  useEffect(() => {
    if (user && recording && !authLoading) {
      checkExistingAccess(recording.id)
    }
  }, [user, recording, authLoading])

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
      setEvents(data.events || [])
      if (data.graphicPackage) setGraphicPackage(data.graphicPackage)
      if (data.mediaPack) setMediaPack(data.mediaPack)
    } catch (err) {
      setError('Failed to load recording')
    } finally {
      setLoading(false)
    }
  }

  async function checkExistingAccess(recordingId: string) {
    try {
      setCheckingAccess(true)
      const res = await fetch(`/api/recordings/${recordingId}/check-access`)
      if (res.ok) {
        const data = await res.json()
        if (data.hasAccess) {
          setSaved(true)
        }
      }
    } catch {
      // Ignore errors - just means we can't check, button stays as "Save"
    } finally {
      setCheckingAccess(false)
    }
  }

  async function handleSave() {
    if (!user) {
      // Redirect to login with return URL
      router.push(`/auth/login?redirect=/watch/${token}`)
      return
    }

    if (!recording) return

    try {
      setSaving(true)
      const res = await fetch(`/api/recordings/${recording.id}/save`, {
        method: 'POST',
      })

      if (res.ok) {
        setSaved(true)
      }
    } catch {
      // Silently fail - user can try again
    } finally {
      setSaving(false)
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
        <LoadingSpinner size="lg" className="text-muted-foreground" />
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
              <VideoPlayer
                src={videoUrl}
                events={events}
                graphicPackage={graphicPackage}
                mediaPack={mediaPack}
                className="w-full aspect-video rounded-lg"
              />
            ) : (
              <div className="aspect-video bg-zinc-900 rounded-lg flex items-center justify-center">
                <p className="text-muted-foreground">Video not available</p>
              </div>
            )}

            {/* Save to Library Button */}
            {!authLoading && (
              <div className="flex justify-center pt-2">
                {saved ? (
                  <Button variant="outline" disabled className="gap-2">
                    <BookmarkCheck className="h-4 w-4" />
                    Saved to Library
                  </Button>
                ) : (
                  <Button
                    onClick={handleSave}
                    disabled={saving || checkingAccess}
                    className="gap-2"
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Bookmark className="h-4 w-4" />
                    )}
                    {saving ? 'Saving...' : 'Save to My Library'}
                  </Button>
                )}
              </div>
            )}

            <MatchDetails
              homeTeam={recording.homeTeam}
              awayTeam={recording.awayTeam}
              pitchName={recording.pitchName}
              description={recording.description}
            />

            {/* Event Tags */}
            {events.length > 0 && (
              <div className="pt-4 border-t">
                <h3 className="text-sm font-semibold text-[var(--timberwolf)] mb-3">
                  Event Tags
                </h3>
                <EventTagsList
                  events={events}
                  homeTeam={recording.homeTeam}
                  awayTeam={recording.awayTeam}
                />
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
