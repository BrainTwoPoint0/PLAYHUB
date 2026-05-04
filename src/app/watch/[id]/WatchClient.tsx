'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Card, CardContent } from '@braintwopoint0/playback-commons/ui'
import { formatDate } from '@braintwopoint0/playback-commons/utils'
import {
  VideoPlayer,
  type MediaPack,
  type GraphicPackageOverlay,
} from '@/components/video/VideoPlayer'
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

interface WatchClientProps {
  recording: Recording
  videoUrl: string | null
  events: RecordingEvent[]
  graphicPackage: GraphicPackageOverlay | null
  mediaPack: MediaPack | null
  from: string | null
}

// `from` is a soft hint set by the linking page so the back link reads
// naturally. Nothing security-sensitive — anyone can fake the query param;
// it just controls the label.
function backLink(from: string | null): { href: string; label: string } {
  if (from === 'matches') return { href: '/matches', label: 'Back to Matches' }
  if (from === 'recordings')
    return { href: '/recordings', label: 'Back to My Recordings' }
  if (from?.startsWith('venue:'))
    return { href: `/venue/${from.slice(6)}`, label: 'Back to venue' }
  return { href: '/', label: 'PLAYHUB' }
}

export default function WatchClient({
  recording,
  videoUrl,
  events,
  graphicPackage,
  mediaPack,
  from,
}: WatchClientProps) {
  const back = backLink(from)

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={back.href}
        className="text-muted-foreground hover:text-[var(--timberwolf)] mb-6 inline-flex items-center text-sm transition-colors duration-300 gap-2"
      >
        <ArrowLeft className="h-4 w-4" />
        {back.label}
      </Link>

      <div className="rounded-xl overflow-hidden border border-border bg-muted">
        {videoUrl ? (
          <VideoPlayer
            src={videoUrl}
            events={events}
            mediaPack={mediaPack || undefined}
            graphicPackage={graphicPackage || undefined}
            className="rounded-xl"
          />
        ) : (
          <div className="aspect-video flex items-center justify-center text-muted-foreground text-sm">
            Video unavailable. Try refreshing.
          </div>
        )}
      </div>

      <Card className="bg-card border-border mt-6">
        <CardContent className="p-6 space-y-3">
          <h1 className="text-xl md:text-2xl font-semibold text-[var(--timberwolf)]">
            {recording.homeTeam}{' '}
            <span className="text-muted-foreground">vs</span>{' '}
            {recording.awayTeam}
          </h1>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                Date
              </p>
              <p className="text-[var(--timberwolf)] font-medium">
                {formatDate(recording.matchDate)}
              </p>
            </div>
            {recording.venue && (
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                  Venue
                </p>
                <p className="text-[var(--timberwolf)] font-medium">
                  {recording.venue}
                </p>
              </div>
            )}
            {recording.pitchName && (
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground mb-1 text-xs uppercase tracking-wide">
                  Pitch
                </p>
                <p className="text-[var(--timberwolf)] font-medium">
                  {recording.pitchName}
                </p>
              </div>
            )}
          </div>
          {recording.description && (
            <div className="pt-3 border-t border-border">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {recording.description}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
