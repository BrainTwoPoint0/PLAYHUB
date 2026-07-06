'use client'

import { useState, type ReactNode } from 'react'
import { Button } from '@braintwopoint0/playback-commons/ui'
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  RotateCcw,
  RotateCw,
  Tag,
  Gauge,
  PictureInPicture2,
  Settings2,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import type { RecordingEvent } from '@/lib/recordings/event-types'
import {
  EVENT_TYPE_COLORS,
  EVENT_TYPE_LABELS,
  formatTimestamp,
} from '@/lib/recordings/event-types'
import type { QualityLevel, PlayerCapabilities } from './player-transport'

// Coach-friendly playback speeds. 0.25× catches a player getting beaten,
// 2× speeds through dead time. YouTube and Vimeo both use this set.
const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const

// Every surface supports the master-clock transport; only quality/PiP are
// exclusive to the flat master video (hidden while de-warping).
const ALL_CAPABLE: PlayerCapabilities = {
  volume: true,
  quality: true,
  pip: true,
  stepFrame: true,
}

interface PlayerControlBarProps {
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  playbackRate: number
  bufferedEnd: number
  isPiP: boolean
  pipSupported: boolean
  qualityLevels: QualityLevel[]
  currentLevel: number
  showControls: boolean
  openMenu: 'speed' | 'quality' | null
  progress: number
  setOpenMenu: (m: 'speed' | 'quality' | null) => void
  togglePlayPause: () => void
  handleProgressClick: (e: React.MouseEvent<HTMLDivElement>) => void
  seekTo: (seconds: number) => void
  skip: (seconds: number) => void
  toggleMute: () => void
  handleVolumeChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  stepFrame: (dir: 1 | -1) => void
  setRate: (rate: number) => void
  setQuality: (level: number) => void
  togglePiP: () => void
  toggleFullscreen: () => void
  // Markers / tagging
  events?: RecordingEvent[]
  highlightedEventId?: string | null
  onMarkerHover?: (eventId: string | null) => void
  canEdit?: boolean
  onAddTag?: (
    timestampSeconds: number,
    videoEl: HTMLVideoElement | null
  ) => void
  videoEl?: HTMLVideoElement | null
  // Surface-specific: hide controls the active surface can't support.
  capabilities?: PlayerCapabilities
  // Slots (right cluster): the flat⇄de-warp toggle, and de-warp-only extras
  // (zoom/reset/auto). Rendered before fullscreen.
  surfaceToggle?: ReactNode
  extras?: ReactNode
}

export function PlayerControlBar({
  isPlaying,
  currentTime,
  duration,
  volume,
  isMuted,
  playbackRate,
  bufferedEnd,
  isPiP,
  pipSupported,
  qualityLevels,
  currentLevel,
  showControls,
  openMenu,
  progress,
  setOpenMenu,
  togglePlayPause,
  handleProgressClick,
  seekTo,
  skip,
  toggleMute,
  handleVolumeChange,
  stepFrame,
  setRate,
  setQuality,
  togglePiP,
  toggleFullscreen,
  events = [],
  highlightedEventId = null,
  onMarkerHover,
  canEdit = false,
  onAddTag,
  videoEl = null,
  capabilities = ALL_CAPABLE,
  surfaceToggle,
  extras,
}: PlayerControlBarProps) {
  const [hoveredEvent, setHoveredEvent] = useState<RecordingEvent | null>(null)

  return (
    <div
      className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pb-3 pt-8 md:p-4 transition-all duration-300 ${
        showControls || !isPlaying
          ? 'opacity-100'
          : 'opacity-0 pointer-events-none'
      }`}
    >
      {/* Progress bar with event markers — keyboard accessible via the
          arrow-key shortcuts on the document; here it's a div with slider
          semantics for screen readers. */}
      <div
        className="mb-2 md:mb-3 relative py-2 -my-2 cursor-pointer"
        onClick={handleProgressClick}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.floor(duration)}
        aria-valuenow={Math.floor(currentTime)}
        aria-valuetext={`${formatTimestamp(currentTime)} of ${formatTimestamp(duration)}`}
      >
        <div className="relative w-full h-1.5 md:h-2 bg-white/20 rounded-full pointer-events-none">
          {/* Buffered range — lighter than the played portion, sits behind it. */}
          {duration > 0 && bufferedEnd > 0 && (
            <div
              className="absolute top-0 left-0 h-full bg-white/30 rounded-full pointer-events-none"
              style={{ width: `${(bufferedEnd / duration) * 100}%` }}
              aria-hidden
            />
          )}
          {/* Played portion */}
          <div
            className="absolute top-0 left-0 h-full bg-emerald-500 rounded-full pointer-events-none"
            style={{ width: `${progress}%` }}
          />

          {/* Event marker dots */}
          {duration > 0 &&
            events.map((event) => {
              const left = (event.timestamp_seconds / duration) * 100
              const isHighlighted = highlightedEventId === event.id
              const color = EVENT_TYPE_COLORS[event.event_type]
              return (
                <div
                  key={event.id}
                  className={`absolute top-1/2 w-2.5 h-2.5 md:w-3 md:h-3 rounded-full border border-black/50 pointer-events-auto cursor-pointer z-10 hover:scale-150 transition-transform ${
                    isHighlighted ? 'scale-150 ring-2 ring-white/70' : ''
                  }`}
                  style={{
                    left: `${left}%`,
                    backgroundColor: color,
                    transform: `translateX(-50%) translateY(-50%)`,
                    boxShadow: isHighlighted
                      ? `0 0 12px ${color}, 0 0 4px ${color}`
                      : undefined,
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    seekTo(event.timestamp_seconds)
                  }}
                  onMouseEnter={() => {
                    setHoveredEvent(event)
                    onMarkerHover?.(event.id)
                  }}
                  onMouseLeave={() => {
                    setHoveredEvent(null)
                    onMarkerHover?.(null)
                  }}
                />
              )
            })}
        </div>

        {/* Tooltip for hovered event — clamp so markers near the edges
            don't render their tooltip off-screen. */}
        {hoveredEvent && duration > 0 && (
          <div
            className="absolute bottom-full mb-2 -translate-x-1/2 px-2 py-1 bg-black/90 text-white text-xs rounded whitespace-nowrap pointer-events-none z-20"
            style={{
              left: `${Math.min(
                92,
                Math.max(8, (hoveredEvent.timestamp_seconds / duration) * 100)
              )}%`,
            }}
          >
            <span
              className="inline-block w-2 h-2 rounded-full mr-1"
              style={{
                backgroundColor: EVENT_TYPE_COLORS[hoveredEvent.event_type],
              }}
            />
            {EVENT_TYPE_LABELS[hoveredEvent.event_type]}
            {hoveredEvent.label && ` — ${hoveredEvent.label}`}
            <span className="ml-1 text-white/60">
              {formatTimestamp(hoveredEvent.timestamp_seconds)}
            </span>
          </div>
        )}
      </div>

      {/* Control buttons */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-0.5 md:gap-1">
          <Button
            onClick={togglePlayPause}
            size="sm"
            variant="ghost"
            aria-label={isPlaying ? 'Pause' : 'Play'}
            title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
          >
            {isPlaying ? (
              <Pause className="h-4 w-4" />
            ) : (
              <Play className="h-4 w-4" />
            )}
          </Button>

          <Button
            onClick={() => skip(-5)}
            size="sm"
            variant="ghost"
            aria-label="Rewind 5 seconds"
            title="Rewind 5s (←)"
            className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>

          <Button
            onClick={() => skip(5)}
            size="sm"
            variant="ghost"
            aria-label="Forward 5 seconds"
            title="Forward 5s (→)"
            className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
          >
            <RotateCw className="h-4 w-4" />
          </Button>

          {/* Volume — hidden on mobile (use device volume). Slider branded
              with timberwolf accent so it doesn't look like a default
              browser control. */}
          {capabilities.volume && (
            <div className="hidden md:flex items-center gap-1 ml-1 group/vol">
              <Button
                onClick={toggleMute}
                size="sm"
                variant="ghost"
                aria-label={isMuted ? 'Unmute' : 'Mute'}
                title={isMuted ? 'Unmute (M)' : 'Mute (M)'}
                className="text-white hover:bg-white/20 h-8 w-8 p-0"
              >
                {isMuted || volume === 0 ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </Button>
              <input
                type="range"
                min="0"
                max="100"
                value={isMuted ? 0 : volume * 100}
                onChange={handleVolumeChange}
                aria-label="Volume"
                style={{
                  background: `linear-gradient(to right, var(--timberwolf) 0%, var(--timberwolf) ${
                    isMuted ? 0 : volume * 100
                  }%, rgba(255,255,255,0.18) ${
                    isMuted ? 0 : volume * 100
                  }%, rgba(255,255,255,0.18) 100%)`,
                }}
                className="w-16 h-1.5 rounded-lg appearance-none cursor-pointer accent-[var(--timberwolf)] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--timberwolf)] [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--timberwolf)] [&::-moz-range-thumb]:border-0"
              />
            </div>
          )}

          <span className="text-white text-[10px] md:text-xs ml-1 md:ml-2 tabular-nums">
            {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
          </span>
        </div>

        <div className="flex items-center gap-0.5 md:gap-1">
          {/* Frame-step pair — desktop only; coaches scrubbing for tactical
              review. Mobile users have less precision so we hide. */}
          {capabilities.stepFrame && (
            <>
              <Button
                onClick={() => stepFrame(-1)}
                size="sm"
                variant="ghost"
                aria-label="Previous frame"
                title="Previous frame (,)"
                className="hidden md:flex text-white hover:bg-white/20 h-8 w-8 p-0"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                onClick={() => stepFrame(1)}
                size="sm"
                variant="ghost"
                aria-label="Next frame"
                title="Next frame (.)"
                className="hidden md:flex text-white hover:bg-white/20 h-8 w-8 p-0"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </>
          )}

          {/* Playback speed menu */}
          <div className="relative">
            <Button
              onClick={() => setOpenMenu(openMenu === 'speed' ? null : 'speed')}
              size="sm"
              variant="ghost"
              aria-label="Playback speed"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'speed'}
              title="Playback speed"
              className={`text-white hover:bg-white/20 h-9 md:h-8 p-0 font-mono tabular-nums text-[10px] md:text-xs ${
                playbackRate === 1 ? 'w-9 md:w-8' : 'px-2 gap-1'
              }`}
            >
              <Gauge className="h-3.5 w-3.5" />
              {playbackRate !== 1 && <span>{playbackRate}×</span>}
            </Button>
            {openMenu === 'speed' && (
              <div
                role="menu"
                className="absolute bottom-full right-0 mb-2 w-[88px] md:w-[120px] rounded-lg border border-white/[0.08] bg-[rgba(15,21,18,0.95)] backdrop-blur-md shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)] p-1"
              >
                {PLAYBACK_RATES.map((rate) => (
                  <button
                    key={rate}
                    role="menuitemradio"
                    aria-checked={playbackRate === rate}
                    onClick={() => setRate(rate)}
                    className={`flex w-full items-center justify-center md:justify-between gap-2 rounded px-2 py-1 md:py-1.5 text-[11px] md:text-xs font-mono tabular-nums transition-colors ${
                      playbackRate === rate
                        ? 'bg-white/[0.08] text-[var(--timberwolf)]'
                        : 'text-muted-foreground hover:bg-white/[0.04] hover:text-[var(--timberwolf)]'
                    }`}
                  >
                    <span>{rate}×</span>
                    {rate === 1 && (
                      <span className="hidden md:inline text-[9px] text-muted-foreground/60 font-sans">
                        Normal
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Quality menu — only when HLS exposes more than one rung */}
          {capabilities.quality && qualityLevels.length > 1 && (
            <div className="relative hidden md:block">
              <Button
                onClick={() =>
                  setOpenMenu(openMenu === 'quality' ? null : 'quality')
                }
                size="sm"
                variant="ghost"
                aria-label="Quality"
                aria-haspopup="menu"
                aria-expanded={openMenu === 'quality'}
                title="Quality"
                className="text-white hover:bg-white/20 h-8 w-8 p-0"
              >
                <Settings2 className="h-4 w-4" />
              </Button>
              {openMenu === 'quality' && (
                <div
                  role="menu"
                  className="absolute bottom-full right-0 mb-2 min-w-[140px] rounded-lg border border-white/[0.08] bg-[rgba(15,21,18,0.95)] backdrop-blur-md shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)] p-1"
                >
                  <button
                    role="menuitemradio"
                    aria-checked={currentLevel === -1}
                    onClick={() => setQuality(-1)}
                    className={`flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-xs transition-colors ${
                      currentLevel === -1
                        ? 'bg-white/[0.08] text-[var(--timberwolf)]'
                        : 'text-muted-foreground hover:bg-white/[0.04] hover:text-[var(--timberwolf)]'
                    }`}
                  >
                    <span>Auto</span>
                  </button>
                  {qualityLevels.map((lvl) => (
                    <button
                      key={lvl.index}
                      role="menuitemradio"
                      aria-checked={currentLevel === lvl.index}
                      onClick={() => setQuality(lvl.index)}
                      className={`flex w-full items-center justify-between gap-3 rounded px-2.5 py-1.5 text-xs transition-colors ${
                        currentLevel === lvl.index
                          ? 'bg-white/[0.08] text-[var(--timberwolf)]'
                          : 'text-muted-foreground hover:bg-white/[0.04] hover:text-[var(--timberwolf)]'
                      }`}
                    >
                      <span>
                        {lvl.height ? `${lvl.height}p` : `Level ${lvl.index}`}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Picture-in-picture — desktop only; mobile browsers expose it
              in their own native chrome so we'd duplicate. Capability is
              detected post-mount to avoid an SSR/hydration mismatch. */}
          {capabilities.pip && pipSupported && (
            <Button
              onClick={togglePiP}
              size="sm"
              variant="ghost"
              aria-label={
                isPiP ? 'Exit picture-in-picture' : 'Picture-in-picture'
              }
              title="Picture-in-picture"
              className={`hidden md:flex text-white hover:bg-white/20 h-8 w-8 p-0 ${
                isPiP ? 'bg-white/15' : ''
              }`}
            >
              <PictureInPicture2 className="h-4 w-4" />
            </Button>
          )}

          {/* Add Tag button — icon only on mobile */}
          {canEdit && onAddTag && (
            <>
              <Button
                onClick={() => onAddTag(currentTime, videoEl)}
                size="sm"
                variant="ghost"
                aria-label="Tag this moment"
                title="Tag this moment (T)"
                className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-auto md:px-2 p-0 text-xs gap-1"
              >
                <Tag className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Tag</span>
              </Button>
              {/* Keyboard shortcut hint, hidden on mobile (no kbd) */}
              <span
                aria-hidden
                className="hidden md:inline-flex items-center text-[10px] text-white/50 ml-0.5"
              >
                <kbd className="px-1 py-0.5 rounded bg-white/[0.08] font-mono leading-none">
                  T
                </kbd>
              </span>
            </>
          )}

          {/* De-warp-only extras (zoom / reset / auto) then the flat⇄de-warp
              toggle, injected by WatchPlayer. Absent on the standalone player. */}
          {extras}
          {surfaceToggle}

          <Button
            onClick={toggleFullscreen}
            size="sm"
            variant="ghost"
            aria-label="Fullscreen"
            title="Fullscreen (F)"
            className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
          >
            <Maximize className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
