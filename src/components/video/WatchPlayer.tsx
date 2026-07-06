'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@braintwopoint0/playback-commons/ui'
import { Play, Compass, Film, Loader2 } from 'lucide-react'
import type { RecordingEvent } from '@/lib/recordings/event-types'
import type { PlayerCapabilities } from './player-transport'
import { useVideoTransport } from './useVideoTransport'
import { PlayerControlBar } from './PlayerControlBar'
import {
  GraphicsOverlay,
  type MediaPack,
  type GraphicPackageOverlay,
} from './GraphicsOverlay'
import { DewarpControls } from './DewarpControls'
import {
  VirtualPanoramaPlayer,
  type DewarpSurfaceApi,
} from './VirtualPanoramaPlayer'

// Capabilities per surface. In de-warp, quality + PiP act on the hidden flat
// master and would confuse (PiP would pop out the flat feed) — hide them. Volume
// (master audio) and step-frame (master clock) stay useful.
const FLAT_CAPS: PlayerCapabilities = {
  volume: true,
  quality: true,
  pip: true,
  stepFrame: true,
}
const DEWARP_CAPS: PlayerCapabilities = {
  volume: true,
  quality: false,
  pip: false,
  stepFrame: true,
}

type ExploreState =
  | 'idle'
  | 'loading'
  | 'pending'
  | 'unavailable'
  | 'timeout'
  | 'error'

interface WatchPlayerProps {
  // The flat production (Spiideo Play) — the MASTER clock/audio + default view.
  src: string
  events?: RecordingEvent[]
  canEdit?: boolean
  onAddTag?: (
    timestampSeconds: number,
    videoEl: HTMLVideoElement | null
  ) => void
  onSeek?: (timestampSeconds: number) => void
  className?: string
  mediaPack?: MediaPack
  graphicPackage?: GraphicPackageOverlay
  posterUrl?: string | null
  highlightedEventId?: string | null
  onMarkerHover?: (eventId: string | null) => void
  initialTimeSeconds?: number
  onProgressUpdate?: (currentSeconds: number, durationSeconds: number) => void
  // De-warp surface: the published mesh + the (lazily-captured) raw-VP URL, plus
  // the capture poll state and its trigger (owned by WatchClient).
  meshBaseUrl?: string | null
  panoramaSrc?: string | null
  exploreState?: ExploreState
  onExplore?: () => void
}

export function WatchPlayer({
  src,
  events = [],
  canEdit = false,
  onAddTag,
  onSeek,
  className = '',
  mediaPack,
  graphicPackage,
  posterUrl,
  highlightedEventId = null,
  onMarkerHover,
  initialTimeSeconds,
  onProgressUpdate,
  meshBaseUrl,
  panoramaSrc,
  exploreState = 'idle',
  onExplore,
}: WatchPlayerProps) {
  const t = useVideoTransport({
    src,
    initialTimeSeconds,
    onProgressUpdate,
    onSeek,
    canEdit,
    onAddTag,
  })
  const { state, commands } = t
  const tw = useTranslations('watch')
  const tp = useTranslations('player')

  const [surface, setSurface] = useState<'flat' | 'dewarp'>('flat')
  // Intent to switch once the capture is ready (the toggle can be clicked before
  // the raw VP finishes materializing).
  const [wantDewarp, setWantDewarp] = useState(false)
  const dewarpApiRef = useRef<DewarpSurfaceApi | null>(null)

  const dewarpReady = Boolean(meshBaseUrl && panoramaSrc)
  const capturing = exploreState === 'loading' || exploreState === 'pending'
  const showToggle = Boolean(meshBaseUrl) && exploreState !== 'unavailable'

  // Flip to the de-warp surface as soon as the capture is ready, if the user
  // asked for it while it was still materializing.
  useEffect(() => {
    if (wantDewarp && dewarpReady && surface === 'flat') {
      setSurface('dewarp')
      setWantDewarp(false)
    }
  }, [wantDewarp, dewarpReady, surface])

  // Safety: if the de-warp source disappears, fall back to the flat surface.
  useEffect(() => {
    if (surface === 'dewarp' && !dewarpReady) setSurface('flat')
  }, [surface, dewarpReady])

  // A capture that fails/times out must release the "want de-warp" intent, or the
  // toggle stays stuck disabled on "Preparing…" and the Retry affordance is
  // unreachable (the only escape would be a reload).
  useEffect(() => {
    if (
      exploreState === 'timeout' ||
      exploreState === 'error' ||
      exploreState === 'unavailable'
    )
      setWantDewarp(false)
  }, [exploreState])

  const onToggleSurface = () => {
    if (surface === 'dewarp') {
      setSurface('flat')
      setWantDewarp(false)
      return
    }
    if (dewarpReady) {
      setSurface('dewarp')
    } else {
      // Not captured yet (or a prior attempt timed out) — (re)trigger + switch
      // when it lands.
      setWantDewarp(true)
      onExplore?.()
    }
  }

  const isDewarp = surface === 'dewarp'
  const busy = !isDewarp && (capturing || (wantDewarp && !dewarpReady))
  const retryable =
    !isDewarp && (exploreState === 'timeout' || exploreState === 'error')

  const surfaceToggle = showToggle ? (
    <Button
      onClick={onToggleSurface}
      size="sm"
      variant="ghost"
      disabled={busy}
      aria-pressed={isDewarp}
      aria-label={isDewarp ? tw('explore.backLabel') : tw('explore.cta')}
      title={isDewarp ? tw('explore.backTitle') : tw('explore.title')}
      className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-auto md:px-2 p-0 gap-1 text-xs disabled:opacity-80"
    >
      {busy ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span className="hidden md:inline">
            {tw('explore.preparingLabel')}
          </span>
        </>
      ) : isDewarp ? (
        <>
          <Film className="h-3.5 w-3.5" />
          <span className="hidden md:inline">{tw('explore.videoLabel')}</span>
        </>
      ) : (
        <>
          <Compass className="h-3.5 w-3.5" />
          <span className="hidden md:inline">
            {retryable ? tw('explore.retryLabel') : tw('explore.exploreLabel')}
          </span>
        </>
      )}
    </Button>
  ) : null

  return (
    <div
      ref={t.containerRef}
      // Media-player chrome stays LTR by convention (progress fills left→right).
      dir="ltr"
      className={`relative bg-black rounded-lg overflow-hidden group aspect-video ${className}`}
      onMouseMove={t.handleMouseMove}
      onTouchStart={t.handleMouseMove}
      onMouseLeave={() => state.isPlaying && t.setShowControls(false)}
    >
      {/* MASTER — the flat production. Always mounted (clock + audio); the de-warp
          canvas covers it when active. */}
      <video
        ref={t.videoRef}
        className="absolute inset-0 w-full h-full object-contain"
        playsInline
        preload="metadata"
        poster={posterUrl || undefined}
        onClick={commands.togglePlayPause}
      />

      {!isDewarp && (
        <GraphicsOverlay
          graphicPackage={graphicPackage}
          mediaPack={mediaPack}
        />
      )}

      {/* De-warp SURFACE — WebGL canvas slaved to the master clock. Lazily
          mounted only while active, so the 4K raw VP only decodes on demand. */}
      {isDewarp && dewarpReady && (
        <div className="absolute inset-0">
          <VirtualPanoramaPlayer
            src={panoramaSrc as string}
            meshBaseUrl={meshBaseUrl as string}
            masterVideoRef={t.videoRef}
            hideChrome
            apiRef={dewarpApiRef}
            className="h-full w-full"
          />
        </div>
      )}

      {/* Flat-surface overlays (the de-warp has its own loading/poster). */}
      {!isDewarp && state.isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-none">
          <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}
      {!isDewarp && !state.isPlaying && !state.isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 pb-14">
          <button
            onClick={commands.togglePlayPause}
            aria-label={tp('play')}
            className="w-16 h-16 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center transition-colors"
          >
            <Play className="h-8 w-8 text-white ml-1" fill="white" />
          </button>
        </div>
      )}

      <PlayerControlBar
        isPlaying={state.isPlaying}
        currentTime={state.currentTime}
        duration={state.duration}
        volume={state.volume}
        isMuted={state.isMuted}
        playbackRate={state.playbackRate}
        bufferedEnd={state.bufferedEnd}
        isPiP={state.isPiP}
        pipSupported={state.pipSupported}
        qualityLevels={state.qualityLevels}
        currentLevel={state.currentLevel}
        showControls={state.showControls}
        openMenu={state.openMenu}
        progress={state.progress}
        setOpenMenu={t.setOpenMenu}
        togglePlayPause={commands.togglePlayPause}
        handleProgressClick={commands.handleProgressClick}
        seekTo={commands.seekTo}
        skip={commands.skip}
        toggleMute={commands.toggleMute}
        handleVolumeChange={commands.handleVolumeChange}
        stepFrame={commands.stepFrame}
        setRate={commands.setRate}
        setQuality={commands.setQuality}
        togglePiP={commands.togglePiP}
        toggleFullscreen={commands.toggleFullscreen}
        events={events}
        highlightedEventId={highlightedEventId}
        onMarkerHover={onMarkerHover}
        canEdit={canEdit}
        onAddTag={onAddTag}
        videoEl={t.videoRef.current}
        capabilities={isDewarp ? DEWARP_CAPS : FLAT_CAPS}
        surfaceToggle={surfaceToggle}
        extras={isDewarp ? <DewarpControls apiRef={dewarpApiRef} /> : null}
      />
    </div>
  )
}
