'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
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
} from 'lucide-react'
import Hls from 'hls.js'
import type { RecordingEvent } from '@/lib/recordings/event-types'
import {
  EVENT_TYPE_COLORS,
  EVENT_TYPE_LABELS,
  formatTimestamp,
} from '@/lib/recordings/event-types'

export interface MediaPack {
  logo_url?: string
  logo_position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  sponsor_logo_url?: string
  sponsor_position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
}

interface VideoPlayerProps {
  src: string
  events?: RecordingEvent[]
  canEdit?: boolean
  onAddTag?: (timestampSeconds: number) => void
  onSeek?: (timestampSeconds: number) => void
  className?: string
  mediaPack?: MediaPack
}

export function VideoPlayer({
  src,
  events = [],
  canEdit = false,
  onAddTag,
  onSeek,
  className = '',
  mediaPack,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [hoveredEvent, setHoveredEvent] = useState<RecordingEvent | null>(null)

  const controlsTimeoutRef = useRef<NodeJS.Timeout>(undefined)

  // HLS setup
  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    const isHls = src.includes('.m3u8')

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: true })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
            hls.recoverMediaError()
          else hls.destroy()
        }
      })
      hlsRef.current = hls
    } else if (isHls && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
    } else {
      video.src = src
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
  }, [src])

  // Video event listeners
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const onLoadedMetadata = () => {
      setDuration(video.duration)
      setIsLoading(false)
    }
    const onTimeUpdate = () => setCurrentTime(video.currentTime)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onEnded = () => setIsPlaying(false)
    const onVolumeChange = () => {
      setVolume(video.volume)
      setIsMuted(video.muted)
    }
    const onWaiting = () => setIsLoading(true)
    const onCanPlay = () => setIsLoading(false)

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded)
    video.addEventListener('volumechange', onVolumeChange)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('canplay', onCanPlay)

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('volumechange', onVolumeChange)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('canplay', onCanPlay)
    }
  }, [])

  // Auto-hide controls
  useEffect(() => {
    if (isPlaying && showControls) {
      controlsTimeoutRef.current = setTimeout(
        () => setShowControls(false),
        3000
      )
    }
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
    }
  }, [isPlaying, showControls])

  const togglePlayPause = () => {
    const video = videoRef.current
    if (!video) return
    if (isPlaying) video.pause()
    else video.play()
  }

  const seekTo = useCallback(
    (seconds: number) => {
      const video = videoRef.current
      if (!video) return
      video.currentTime = seconds
      setCurrentTime(seconds)
      onSeek?.(seconds)
    },
    [onSeek]
  )

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const percent = (e.clientX - rect.left) / rect.width
    seekTo(percent * duration)
  }

  const toggleMute = () => {
    const video = videoRef.current
    if (!video) return
    video.muted = !isMuted
  }

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current
    if (!video) return
    const newVol = parseFloat(e.target.value) / 100
    video.volume = newVol
    video.muted = newVol === 0
  }

  const skip = (seconds: number) => {
    const video = videoRef.current
    if (!video) return
    video.currentTime = Math.max(
      0,
      Math.min(duration, video.currentTime + seconds)
    )
  }

  const toggleFullscreen = () => {
    const video = videoRef.current
    const container = containerRef.current
    const doc = document as any

    // Check if already fullscreen — exit if so
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      ;(doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc)
      return
    }

    // 1. Standard Fullscreen API on container (desktop + Android)
    if (container?.requestFullscreen) {
      container.requestFullscreen()
      return
    }

    // 2. Webkit prefix on container (older Android Chrome)
    if ((container as any)?.webkitRequestFullscreen) {
      ;(container as any).webkitRequestFullscreen()
      return
    }

    // 3. iOS Safari — only supports fullscreen on <video> element
    if ((video as any)?.webkitEnterFullscreen) {
      ;(video as any).webkitEnterFullscreen()
    }
  }

  const handleMouseMove = () => {
    setShowControls(true)
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div
      ref={containerRef}
      className={`relative bg-black rounded-lg overflow-hidden group ${className}`}
      onMouseMove={handleMouseMove}
      onTouchStart={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        playsInline
        preload="metadata"
        onClick={togglePlayPause}
      />

      {/* Media pack overlays */}
      {mediaPack?.logo_url && (
        <img
          src={mediaPack.logo_url}
          alt=""
          className={`absolute pointer-events-none w-12 h-12 md:w-16 md:h-16 object-contain opacity-70 ${
            mediaPack.logo_position === 'top-left' ? 'top-3 left-3' :
            mediaPack.logo_position === 'bottom-left' ? 'bottom-16 left-3' :
            mediaPack.logo_position === 'bottom-right' ? 'bottom-16 right-3' :
            'top-3 right-3'
          }`}
        />
      )}
      {mediaPack?.sponsor_logo_url && (
        <img
          src={mediaPack.sponsor_logo_url}
          alt=""
          className={`absolute pointer-events-none w-12 h-12 md:w-16 md:h-16 object-contain opacity-70 ${
            mediaPack.sponsor_position === 'top-left' ? 'top-3 left-3' :
            mediaPack.sponsor_position === 'top-right' ? 'top-3 right-3' :
            mediaPack.sponsor_position === 'bottom-right' ? 'bottom-16 right-3' :
            'bottom-16 left-3'
          }`}
        />
      )}

      {/* Loading spinner */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 pointer-events-none">
          <div className="w-8 h-8 border-2 border-white border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {/* Play button overlay — pb-14 offsets for the controls bar so the button is visually centered in the video area */}
      {!isPlaying && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30 pb-14">
          <button
            onClick={togglePlayPause}
            className="w-16 h-16 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm flex items-center justify-center transition-colors"
          >
            <Play className="h-8 w-8 text-white ml-1" fill="white" />
          </button>
        </div>
      )}

      {/* Controls overlay */}
      <div
        className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pb-3 pt-8 md:p-4 transition-all duration-300 ${
          showControls || !isPlaying
            ? 'opacity-100'
            : 'opacity-0 pointer-events-none'
        }`}
      >
        {/* Progress bar with event markers */}
        <div className="mb-2 md:mb-3 relative py-2 -my-2 cursor-pointer" onClick={handleProgressClick}>
          <div
            className="relative w-full h-1.5 md:h-2 bg-white/20 rounded-full pointer-events-none"
          >
            {/* Played portion */}
            <div
              className="absolute top-0 left-0 h-full bg-emerald-500 rounded-full pointer-events-none"
              style={{ width: `${progress}%` }}
            />

            {/* Event marker dots */}
            {duration > 0 &&
              events.map((event) => {
                const left = (event.timestamp_seconds / duration) * 100
                return (
                  <div
                    key={event.id}
                    className="absolute top-1/2 w-2.5 h-2.5 md:w-3 md:h-3 rounded-full border border-black/50 pointer-events-auto cursor-pointer z-10 hover:scale-150 transition-transform"
                    style={{
                      left: `${left}%`,
                      backgroundColor: EVENT_TYPE_COLORS[event.event_type],
                      transform: `translateX(-50%) translateY(-50%)`,
                    }}
                    onClick={(e) => {
                      e.stopPropagation()
                      seekTo(event.timestamp_seconds)
                    }}
                    onMouseEnter={() => setHoveredEvent(event)}
                    onMouseLeave={() => setHoveredEvent(null)}
                  />
                )
              })}
          </div>

          {/* Tooltip for hovered event */}
          {hoveredEvent && duration > 0 && (
            <div
              className="absolute bottom-full mb-2 -translate-x-1/2 px-2 py-1 bg-black/90 text-white text-xs rounded whitespace-nowrap pointer-events-none z-20"
              style={{
                left: `${(hoveredEvent.timestamp_seconds / duration) * 100}%`,
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
              className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>

            <Button
              onClick={() => skip(5)}
              size="sm"
              variant="ghost"
              className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
            >
              <RotateCw className="h-4 w-4" />
            </Button>

            {/* Volume — hidden on mobile (use device volume) */}
            <div className="hidden md:flex items-center gap-1 ml-1">
              <Button
                onClick={toggleMute}
                size="sm"
                variant="ghost"
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
                className="w-16 h-1 bg-white/20 rounded-lg appearance-none cursor-pointer"
              />
            </div>

            <span className="text-white text-[10px] md:text-xs ml-1 md:ml-2 tabular-nums">
              {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
            </span>
          </div>

          <div className="flex items-center gap-0.5 md:gap-1">
            {/* Add Tag button — icon only on mobile */}
            {canEdit && onAddTag && (
              <Button
                onClick={() => onAddTag(currentTime)}
                size="sm"
                variant="ghost"
                className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-auto md:px-2 p-0 text-xs gap-1"
              >
                <Tag className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Tag</span>
              </Button>
            )}

            <Button
              onClick={toggleFullscreen}
              size="sm"
              variant="ghost"
              className="text-white hover:bg-white/20 h-9 w-9 md:h-8 md:w-8 p-0"
            >
              <Maximize className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
