'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Button } from '@braintwopoint0/playback-commons/ui'
import { FadeIn } from '@/components/FadeIn'
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
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl animate-pulse">
          {/* Back button skeleton */}
          <div className="bg-[var(--ash-grey)]/10 rounded h-9 w-[170px] mb-6" />
          {/* Card skeleton */}
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-black/20">
            <div className="p-6 pb-3 space-y-2">
              <div className="bg-[var(--ash-grey)]/10 rounded h-7 w-[260px]" />
              <div className="bg-[var(--ash-grey)]/10 rounded h-4 w-[200px]" />
            </div>
            <div className="px-6 pb-6 space-y-4">
              {/* Video placeholder */}
              <div className="aspect-video bg-black/30 rounded-lg" />
              {/* Info grid skeleton */}
              <div className="grid grid-cols-2 gap-4 pt-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="space-y-2">
                    <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-[80px]" />
                    <div className="bg-[var(--ash-grey)]/10 rounded h-5 w-[120px]" />
                  </div>
                ))}
              </div>
            </div>
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
            <p className="text-red-400 mb-4">{error}</p>
            <Button
              variant="outline"
              onClick={() => router.push('/recordings')}
              className="border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Recordings
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (!recording) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl">
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-6">
            <p className="text-[var(--ash-grey)]">Recording not found</p>
            <Button
              variant="outline"
              onClick={() => router.push('/recordings')}
              className="mt-4 border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Recordings
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--night)]">
      <div className="container mx-auto px-5 py-16 max-w-4xl">
        <Button
          variant="ghost"
          onClick={() => router.push('/recordings')}
          className="mb-6 text-[var(--timberwolf)] hover:bg-white/10"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Recordings
        </Button>

        <FadeIn>
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6 pb-3">
              <h1 className="text-2xl md:text-3xl font-bold text-[var(--timberwolf)]">
                {recording.title}
              </h1>
              <p className="text-sm text-[var(--ash-grey)] mt-1">
                {formatDate(recording.matchDate)}
              </p>
            </div>
            <div className="px-6 pb-6 space-y-4">
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
                <div className="aspect-video bg-black/30 rounded-lg flex items-center justify-center border border-[var(--ash-grey)]/10">
                  <p className="text-[var(--ash-grey)]">
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
                  <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                    Home Team
                  </p>
                  <p className="font-medium text-[var(--timberwolf)]">
                    {recording.homeTeam}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                    Away Team
                  </p>
                  <p className="font-medium text-[var(--timberwolf)]">
                    {recording.awayTeam}
                  </p>
                </div>
                {recording.venue && (
                  <div>
                    <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                      Venue
                    </p>
                    <p className="font-medium text-[var(--timberwolf)]">
                      {recording.venue}
                    </p>
                  </div>
                )}
                {recording.pitchName && (
                  <div>
                    <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                      Pitch
                    </p>
                    <p className="font-medium text-[var(--timberwolf)]">
                      {recording.pitchName}
                    </p>
                  </div>
                )}
              </div>

              {recording.description && (
                <div className="pt-4 border-t border-[var(--ash-grey)]/10">
                  <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                    Description
                  </p>
                  <p className="text-[var(--timberwolf)]">
                    {recording.description}
                  </p>
                </div>
              )}
            </div>
          </div>
        </FadeIn>
      </div>
    </div>
  )
}
