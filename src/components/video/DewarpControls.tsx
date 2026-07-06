'use client'

import type { RefObject } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@braintwopoint0/playback-commons/ui'
import { Crosshair, Minus, Plus, Frame } from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'
import type { DewarpSurfaceApi } from './VirtualPanoramaPlayer'

// The de-warp-only extras (auto-follow, zoom, reset), styled to match
// PlayerControlBar's ghost buttons. Rendered in the shared bar's `extras` slot
// when the de-warp surface is active, so the user keeps the full transport row
// AND gets pan/zoom controls in one consistent chrome. Drives the WebGL surface
// through its imperative handle; `autoFollow` reflects the surface's live state.
interface DewarpControlsProps {
  apiRef: RefObject<DewarpSurfaceApi | null>
  autoFollow: boolean
}

export function DewarpControls({ apiRef, autoFollow }: DewarpControlsProps) {
  const t = useTranslations('player')
  return (
    <>
      <Button
        onClick={() => apiRef.current?.toggleAuto()}
        size="sm"
        variant="ghost"
        aria-label={t('autoFollowToggle')}
        aria-pressed={autoFollow}
        title={autoFollow ? t('autoFollowOnTitle') : t('autoFollowOffTitle')}
        className={cn(
          'text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-auto md:px-2 p-0 gap-1 text-xs',
          autoFollow && 'bg-white/15 text-[var(--timberwolf)]'
        )}
      >
        <Crosshair className="h-3.5 w-3.5" />
        <span className="hidden md:inline font-medium">{t('auto')}</span>
      </Button>
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
