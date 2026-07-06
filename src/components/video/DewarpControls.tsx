'use client'

import type { RefObject } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@braintwopoint0/playback-commons/ui'
import { Minus, Plus, Frame } from 'lucide-react'
import type { DewarpSurfaceApi } from './VirtualPanoramaPlayer'

// De-warp extras: zoom + reset, styled to match PlayerControlBar's ghost buttons.
// Rendered in the shared bar's `extras` slot when the de-warp surface is active,
// so the user keeps the full transport row AND gets pan/zoom in one chrome.
// NOTE: no "auto-follow" button here — our motion driver is inferior to Spiideo's
// Play production, which IS the default "Video" view. The de-warp is for manual
// drag-to-explore; for auto-follow the user toggles back to Video.
interface DewarpControlsProps {
  apiRef: RefObject<DewarpSurfaceApi | null>
}

export function DewarpControls({ apiRef }: DewarpControlsProps) {
  const t = useTranslations('player')
  return (
    <>
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
