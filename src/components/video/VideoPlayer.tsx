'use client'

import { Play } from 'lucide-react'
import type { RecordingEvent } from '@/lib/recordings/event-types'
import { useVideoTransport } from './useVideoTransport'
import { PlayerControlBar } from './PlayerControlBar'
import {
  GraphicsOverlay,
  type MediaPack,
  type GraphicPackageOverlay,
} from './GraphicsOverlay'

// Re-exported so existing importers (`import { MediaPack } from '.../VideoPlayer'`)
// keep working after the overlay types moved to GraphicsOverlay.
export type { MediaPack, GraphicPackageOverlay }

interface VideoPlayerProps {
  src: string
  events?: RecordingEvent[]
  canEdit?: boolean
  // Tagging contract: parent receives the timestamp + the underlying video
  // element so it can advance the pinned timestamp in "Save & continue"
  // mode. We do not pause on tag click — let the player's own controls
  // handle pausing if the user wants it.
  onAddTag?: (
    timestampSeconds: number,
    videoEl: HTMLVideoElement | null
  ) => void
  onSeek?: (timestampSeconds: number) => void
  className?: string
  mediaPack?: MediaPack
  graphicPackage?: GraphicPackageOverlay
  // Poster image shown before metadata loads / after error. Falls back to
  // a black frame if absent. Big quality-of-life win on slow connections.
  posterUrl?: string | null
  // Highlighted event marker: when set, that marker pulses so a parent-
  // rendered tag rail can crosslink visually with the timeline.
  highlightedEventId?: string | null
  // Crosslink callback: parent gets notified when the user hovers a marker
  // so the corresponding tag row in the rail can highlight in sync.
  onMarkerHover?: (eventId: string | null) => void
  // Resume support: seek to this timestamp once on first load, then leave
  // the player alone.
  initialTimeSeconds?: number
  // Periodic progress emit so the parent can persist watch position.
  onProgressUpdate?: (currentSeconds: number, durationSeconds: number) => void
}

export function VideoPlayer({
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
}: VideoPlayerProps) {
  const t = useVideoTransport({
    src,
    initialTimeSeconds,
    onProgressUpdate,
    onSeek,
    canEdit,
    onAddTag,
  })
  const { state, commands } = t

  return (
    <div
      ref={t.containerRef}
      className={`relative bg-black rounded-lg overflow-hidden group aspect-video ${className}`}
      onMouseMove={t.handleMouseMove}
      onTouchStart={t.handleMouseMove}
      onMouseLeave={() => state.isPlaying && t.setShowControls(false)}
    >
      <video
        ref={t.videoRef}
        className="absolute inset-0 w-full h-full object-contain"
        playsInline
        preload="metadata"
        poster={posterUrl || undefined}
        onClick={commands.togglePlayPause}
      />

      <GraphicsOverlay graphicPackage={graphicPackage} mediaPack={mediaPack} />

      {/* Loading spinner */}
      {state.isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-none">
          <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Play button overlay — pb-14 offsets for the controls bar so the button is visually centered in the video area */}
      {!state.isPlaying && !state.isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 pb-14">
          <button
            onClick={commands.togglePlayPause}
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
      />
    </div>
  )
}
