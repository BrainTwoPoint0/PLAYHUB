'use client'

import type { RefObject } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@braintwopoint0/playback-commons/ui'
import { Minus, Plus, Frame, LocateFixed } from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'
import type { DewarpSurfaceApi } from './VirtualPanoramaPlayer'

// De-warp extras: zoom + reset (+ Auto-follow when a reg-SIFT aim track
// exists), styled to match PlayerControlBar's ghost buttons. Rendered in the
// shared bar's `extras` slot when the de-warp surface is active, so the user
// keeps the full transport row AND gets pan/zoom in one chrome.
// The Auto-follow toggle only appears for recordings with a computed aim track
// (Spiideo's own recovered camera path); the client MOTION driver stays hidden
// here — it's inferior to the Play production, which IS the default "Video" view.
interface DewarpControlsProps {
  apiRef: RefObject<DewarpSurfaceApi | null>
  /** A reg-SIFT aim track loaded for this recording — show the Auto-follow toggle. */
  hasAimTrack?: boolean
  /** Live auto-follow state (reported by the surface; dragging turns it off). */
  autoFollow?: boolean
}

export function DewarpControls({
  apiRef,
  hasAimTrack = false,
  autoFollow = false,
}: DewarpControlsProps) {
  const t = useTranslations('player')
  return (
    <>
      {hasAimTrack && (
        <Button
          onClick={() => apiRef.current?.toggleAuto()}
          size="sm"
          variant="ghost"
          aria-label={t('autoFollowToggle')}
          aria-pressed={autoFollow}
          title={autoFollow ? t('autoFollowOnTitle') : t('autoFollowOffTitle')}
          className={cn(
            'text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0',
            autoFollow && 'bg-white/20'
          )}
        >
          <LocateFixed className="h-4 w-4" />
        </Button>
      )}
      <Button
        onClick={() => apiRef.current?.zoomOut()}
        size="sm"
        variant="ghost"
        aria-label={t('zoomOut')}
        title={t('zoomOut')}
        className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
      >
        <Minus className="h-4 w-4" />
      </Button>
      <Button
        onClick={() => apiRef.current?.zoomIn()}
        size="sm"
        variant="ghost"
        aria-label={t('zoomIn')}
        title={t('zoomIn')}
        className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
      >
        <Plus className="h-4 w-4" />
      </Button>
      <Button
        onClick={() => apiRef.current?.reset()}
        size="sm"
        variant="ghost"
        aria-label={t('resetView')}
        title={t('resetView')}
        className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
      >
        <Frame className="h-4 w-4" />
      </Button>
    </>
  )
}
