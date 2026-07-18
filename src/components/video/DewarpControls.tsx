'use client'

import type { RefObject } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@braintwopoint0/playback-commons/ui'
import {
  Minus,
  Plus,
  Frame,
  LocateFixed,
  UserSearch,
  Focus,
} from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'
import type { DewarpSurfaceApi } from './VirtualPanoramaPlayer'

// De-warp extras: zoom + reset (+ Auto-follow when a reg-SIFT aim track
// exists, + Spotlight when a tracklets artifact exists), styled to match
// PlayerControlBar's ghost buttons. Rendered in the shared bar's `extras`
// slot when the de-warp surface is active, so the user keeps the full
// transport row AND gets pan/zoom in one chrome.
// The Auto-follow toggle only appears for recordings with a computed aim track
// (Spiideo's own recovered camera path); the client MOTION driver stays hidden
// here — it's inferior to the Play production, which IS the default "Video" view.
interface DewarpControlsProps {
  apiRef: RefObject<DewarpSurfaceApi | null>
  /** A reg-SIFT aim track loaded for this recording — show the Auto-follow toggle. */
  hasAimTrack?: boolean
  /** Live auto-follow state (reported by the surface; dragging turns it off). */
  autoFollow?: boolean
  /** A per-player tracklets artifact loaded — show the Spotlight toggle. */
  hasTracklets?: boolean
  /** Live spotlight-armed state (reported by the surface). */
  spotlight?: boolean
  /** A player is currently selected — show the zoom-Lock toggle. */
  hasSelection?: boolean
  /** Live zoom-lock state (reported by the surface). */
  lock?: boolean
}

export function DewarpControls({
  apiRef,
  hasAimTrack = false,
  autoFollow = false,
  hasTracklets = false,
  spotlight = false,
  hasSelection = false,
  lock = false,
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
            'text-white hover:bg-white/20 h-9 gap-1.5 px-2 md:h-8',
            // Same active treatment as the player's internal chrome — a plain
            // bg-white/20 is indistinguishable from an inactive button's hover.
            autoFollow &&
              'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
          )}
        >
          <LocateFixed className="h-4 w-4" />
          <span className="hidden text-xs font-medium md:inline">
            {t('auto')}
          </span>
        </Button>
      )}
      {hasTracklets && (
        <Button
          onClick={() => apiRef.current?.toggleSpotlight()}
          size="sm"
          variant="ghost"
          aria-label={t('spotlightToggle')}
          aria-pressed={spotlight}
          title={spotlight ? t('spotlightOnTitle') : t('spotlightOffTitle')}
          className={cn(
            'text-white hover:bg-white/20 h-9 gap-1.5 px-2 md:h-8',
            spotlight &&
              'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
          )}
        >
          <UserSearch className="h-4 w-4" />
          <span className="hidden text-xs font-medium md:inline">
            {t('spotlight')}
          </span>
        </Button>
      )}
      {/* Reserved once Spotlight is armed (disabled until a player is selected)
          so it never pops in or shifts the zoom/reset cluster mid-session. */}
      {hasTracklets && spotlight && (
        <Button
          onClick={() => apiRef.current?.toggleLock()}
          size="sm"
          variant="ghost"
          disabled={!hasSelection}
          aria-label={t('lockToggle')}
          aria-pressed={lock}
          title={
            !hasSelection
              ? t('lockDisabledTitle')
              : lock
                ? t('lockOnTitle')
                : t('lockOffTitle')
          }
          className={cn(
            'text-white hover:bg-white/20 h-9 gap-1.5 px-2 md:h-8 disabled:opacity-40',
            lock && 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
          )}
        >
          <Focus className="h-4 w-4" />
          <span className="hidden text-xs font-medium md:inline">
            {t('lock')}
          </span>
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
