'use client'

import type { RefObject } from 'react'
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
  return (
    <>
      <Button
        onClick={() => apiRef.current?.toggleAuto()}
        size="sm"
        variant="ghost"
        aria-label="Toggle auto-follow"
        aria-pressed={autoFollow}
        title={
          autoFollow
            ? 'Auto-follow on — drag to take control'
            : 'Auto-follow the action'
        }
        className={cn(
          'text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-auto md:px-2 p-0 gap-1 text-xs',
          autoFollow && 'bg-white/15 text-[var(--timberwolf)]'
        )}
      >
        <Crosshair className="h-3.5 w-3.5" />
        <span className="hidden md:inline font-medium">Auto</span>
      </Button>
      <Button
        onClick={() => apiRef.current?.zoomOut()}
        size="sm"
        variant="ghost"
        aria-label="Zoom out"
        title="Zoom out (−)"
        className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
      >
        <Minus className="h-4 w-4" />
      </Button>
      <Button
        onClick={() => apiRef.current?.zoomIn()}
        size="sm"
        variant="ghost"
        aria-label="Zoom in"
        title="Zoom in (+)"
        className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
      >
        <Plus className="h-4 w-4" />
      </Button>
      <Button
        onClick={() => apiRef.current?.reset()}
        size="sm"
        variant="ghost"
        aria-label="Reset view"
        title="Reset view (0)"
        className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
      >
        <Frame className="h-4 w-4" />
      </Button>
    </>
  )
}
