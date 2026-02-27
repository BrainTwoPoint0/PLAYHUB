'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
  Badge,
} from '@braintwopoint0/playback-commons/ui'
import { useAuth } from '@braintwopoint0/playback-commons/auth'
import { Bookmark, BookmarkCheck, Loader2 } from 'lucide-react'
import { VideoPlayer } from '@/components/video/VideoPlayer'
import type { RecordingEvent } from '@/lib/recordings/event-types'
import {
  EVENT_TYPE_LABELS,
  EVENT_TYPE_COLORS,
  formatTimestamp,
} from '@/lib/recordings/event-types'

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
              <VideoPlayer
                src={videoUrl}
                events={events}
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

            {/* Event Tags */}
            {events.length > 0 && (
              <div className="pt-4 border-t">
                <h3 className="text-sm font-semibold text-[var(--timberwolf)] mb-3">
                  Event Tags
                </h3>
                <div className="space-y-1.5">
                  {events.map((event) => (
                    <div
                      key={event.id}
                      className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-white/[0.03] transition-colors"
                    >
                      <div
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: EVENT_TYPE_COLORS[event.event_type] }}
                      />
                      <button
                        onClick={() => {
                          const video = document.querySelector('video')
                          if (video) video.currentTime = event.timestamp_seconds
                        }}
                        className="text-xs font-mono text-emerald-400 hover:text-emerald-300 w-14 text-left flex-shrink-0"
                      >
                        {formatTimestamp(event.timestamp_seconds)}
                      </button>
                      <Badge
                        variant="outline"
                        className="text-xs flex-shrink-0"
                        style={{
                          backgroundColor: EVENT_TYPE_COLORS[event.event_type] + '20',
                          color: EVENT_TYPE_COLORS[event.event_type],
                          borderColor: EVENT_TYPE_COLORS[event.event_type] + '40',
                        }}
                      >
                        {EVENT_TYPE_LABELS[event.event_type]}
                      </Badge>
                      {event.team && (
                        <span className="text-xs text-[var(--ash-grey)]">
                          {event.team === 'home' ? recording.homeTeam : recording.awayTeam}
                        </span>
                      )}
                      {event.label && (
                        <span className="text-xs text-[var(--timberwolf)] truncate">
                          {event.label}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
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
