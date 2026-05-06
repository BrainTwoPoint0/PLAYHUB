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
  Gauge,
  PictureInPicture2,
  Settings2,
  ChevronLeft,
  ChevronRight,
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

export interface GraphicPackageOverlay {
  logo_url: string | null
  logo_position: string
  logo_x?: number | null
  logo_y?: number | null
  logo_scale?: number | null
  sponsor_logo_url: string | null
  sponsor_position: string
  sponsor_x?: number | null
  sponsor_y?: number | null
  sponsor_scale?: number | null
}

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
  // the player alone. Setting this later does NOT re-seek (would fight the
  // user). The parent decides "is this the user's last position".
  initialTimeSeconds?: number
  // Periodic progress emit so the parent can persist watch position. Fires
  // on play/pause/seek + ~every 5s while playing + on unmount. Caller is
  // responsible for debouncing network calls if needed.
  onProgressUpdate?: (currentSeconds: number, durationSeconds: number) => void
}

// Coach-friendly playback speeds. 0.25× catches a player getting beaten,
// 2× speeds through dead time. YouTube and Vimeo both use this set.
const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const

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
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // Held in a ref so the keyboard handler doesn't re-attach every render
  // when toggleFullscreen's identity changes. Declared up here BEFORE the
  // keyboard useEffect that reads it, so the read-order is unambiguous.
  const toggleFullscreenRef = useRef<(() => void) | null>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [hasPlayedOnce, setHasPlayedOnce] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
  const [hoveredEvent, setHoveredEvent] = useState<RecordingEvent | null>(null)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [bufferedEnd, setBufferedEnd] = useState(0)
  const [isPiP, setIsPiP] = useState(false)
  // Picture-in-picture availability — read in an effect, not during render,
  // to avoid an SSR/hydration mismatch (server has no `document`).
  const [pipSupported, setPipSupported] = useState(false)
  // Quality menu surfaces hls.js levels. -1 = auto.
  const [qualityLevels, setQualityLevels] = useState<
    { index: number; height: number; bitrate: number }[]
  >([])
  const [currentLevel, setCurrentLevel] = useState<number>(-1)
  // Single open menu at a time (speed | quality | null) to keep chrome tidy.
  const [openMenu, setOpenMenu] = useState<'speed' | 'quality' | null>(null)

  const controlsTimeoutRef = useRef<NodeJS.Timeout>(undefined)

  // HLS setup
  useEffect(() => {
    const video = videoRef.current
    if (!video || !src) return

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    // Clear stale quality state — the new manifest will repopulate via
    // MANIFEST_PARSED. Without this the menu shows the old levels until
    // the new parse completes.
    setQualityLevels([])
    setCurrentLevel(-1)

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
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Surface quality rungs once HLS has parsed the manifest. Sorted
        // descending so the dropdown reads 1080 → 720 → 360.
        const levels = hls.levels
          .map((lvl, index) => ({
            index,
            height: lvl.height || 0,
            bitrate: lvl.bitrate || 0,
          }))
          .sort((a, b) => b.height - a.height)
        setQualityLevels(levels)
        setCurrentLevel(hls.currentLevel)
      })
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        setCurrentLevel(data.level)
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

    // First-load resume: seek once on metadata-loaded if a starting point
    // was passed. Guard with a flag so a later prop change doesn't yank
    // the user's playhead mid-watch.
    let didResumeSeek = false
    const onLoadedMetadata = () => {
      setDuration(video.duration)
      setIsLoading(false)
      if (
        !didResumeSeek &&
        typeof initialTimeSeconds === 'number' &&
        initialTimeSeconds > 0 &&
        // Don't restore at the very end — user wants a fresh watch.
        initialTimeSeconds < video.duration - 5
      ) {
        video.currentTime = initialTimeSeconds
        didResumeSeek = true
      }
    }
    const onTimeUpdate = () => setCurrentTime(video.currentTime)
    const onPlay = () => {
      setIsPlaying(true)
      setHasPlayedOnce(true)
    }
    const onPause = () => setIsPlaying(false)
    const onEnded = () => setIsPlaying(false)
    const onVolumeChange = () => {
      setVolume(video.volume)
      setIsMuted(video.muted)
    }
    const onWaiting = () => setIsLoading(true)
    const onCanPlay = () => setIsLoading(false)
    const onProgress = () => {
      const buf = video.buffered
      if (buf.length > 0) setBufferedEnd(buf.end(buf.length - 1))
    }
    const onRateChange = () => setPlaybackRate(video.playbackRate)
    const onPiPEnter = () => setIsPiP(true)
    const onPiPLeave = () => setIsPiP(false)

    video.addEventListener('loadedmetadata', onLoadedMetadata)
    video.addEventListener('timeupdate', onTimeUpdate)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded)
    video.addEventListener('volumechange', onVolumeChange)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('canplay', onCanPlay)
    video.addEventListener('progress', onProgress)
    video.addEventListener('ratechange', onRateChange)
    video.addEventListener('enterpictureinpicture', onPiPEnter)
    video.addEventListener('leavepictureinpicture', onPiPLeave)

    return () => {
      video.removeEventListener('loadedmetadata', onLoadedMetadata)
      video.removeEventListener('timeupdate', onTimeUpdate)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('volumechange', onVolumeChange)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('canplay', onCanPlay)
      video.removeEventListener('progress', onProgress)
      video.removeEventListener('ratechange', onRateChange)
      video.removeEventListener('enterpictureinpicture', onPiPEnter)
      video.removeEventListener('leavepictureinpicture', onPiPLeave)
    }
  }, [])

  // Auto-hide controls — but ONLY after the user has actually started
  // playing once. Idle-flash on initial mount is jarring; keep chrome
  // visible until first play, then enter the auto-hide regime. Also
  // suppressed while a settings menu is open.
  useEffect(() => {
    if (isPlaying && hasPlayedOnce && showControls && openMenu === null) {
      controlsTimeoutRef.current = setTimeout(
        () => setShowControls(false),
        3000
      )
    }
    return () => {
      if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
    }
  }, [isPlaying, showControls, hasPlayedOnce, openMenu])

  // Periodic progress emit for view-history persistence. Fires while playing
  // every 5s, plus on pause/seek (via the dependency on isPlaying), plus
  // once on unmount so we capture the final position. Skipped while paused
  // to avoid spamming the API.
  useEffect(() => {
    if (!onProgressUpdate) return
    const tick = () => {
      const v = videoRef.current
      if (!v || !v.duration) return
      onProgressUpdate(v.currentTime, v.duration)
    }
    let interval: ReturnType<typeof setInterval> | null = null
    if (isPlaying) {
      interval = setInterval(tick, 5000)
    } else {
      // Capture position on pause too — most accurate signal of "user
      // walked away" or "user closed the tab" before unmount fires.
      tick()
    }
    return () => {
      if (interval) clearInterval(interval)
      // Final flush on unmount.
      tick()
    }
  }, [isPlaying, onProgressUpdate])

  // Player keyboard shortcuts. YouTube/Vimeo/Veo standard set, plus T for
  // tagging which is PLAYHUB-specific. Skip when focus is in a real input
  // so typing in a comment/search box doesn't hijack keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.isContentEditable)
      )
        return
      const v = videoRef.current
      if (!v) return
      const k = e.key

      // Tagging — only when permitted.
      if ((k === 't' || k === 'T') && canEdit && onAddTag) {
        e.preventDefault()
        onAddTag(v.currentTime, v)
        return
      }

      // Play/pause
      if (k === ' ' || k === 'k' || k === 'K') {
        e.preventDefault()
        if (v.paused) v.play()
        else v.pause()
        return
      }

      // Seek 5s
      if (k === 'ArrowLeft' || k === 'j' || k === 'J') {
        e.preventDefault()
        v.currentTime = Math.max(0, v.currentTime - 5)
        return
      }
      if (k === 'ArrowRight' || k === 'l' || k === 'L') {
        e.preventDefault()
        v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5)
        return
      }

      // Frame-step (assumes ~30fps; adequate for tactical review).
      if (k === ',') {
        e.preventDefault()
        if (!v.paused) v.pause()
        v.currentTime = Math.max(0, v.currentTime - 1 / 30)
        return
      }
      if (k === '.') {
        e.preventDefault()
        if (!v.paused) v.pause()
        v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 1 / 30)
        return
      }

      // Volume
      if (k === 'ArrowUp') {
        e.preventDefault()
        v.volume = Math.min(1, v.volume + 0.1)
        return
      }
      if (k === 'ArrowDown') {
        e.preventDefault()
        v.volume = Math.max(0, v.volume - 0.1)
        return
      }

      // Mute
      if (k === 'm' || k === 'M') {
        e.preventDefault()
        v.muted = !v.muted
        return
      }

      // Fullscreen
      if (k === 'f' || k === 'F') {
        e.preventDefault()
        toggleFullscreenRef.current?.()
        return
      }

      // Jump to 0–90% via digit keys.
      if (/^[0-9]$/.test(k) && v.duration) {
        e.preventDefault()
        const pct = parseInt(k, 10) / 10
        v.currentTime = v.duration * pct
        return
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [canEdit, onAddTag])

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

  const setRate = (rate: number) => {
    const v = videoRef.current
    if (!v) return
    v.playbackRate = rate
    setOpenMenu(null)
  }

  const setQuality = (levelIndex: number) => {
    const hls = hlsRef.current
    if (!hls) return
    hls.currentLevel = levelIndex
    setCurrentLevel(levelIndex)
    setOpenMenu(null)
  }

  const togglePiP = async () => {
    const v = videoRef.current
    if (!v || !document.pictureInPictureEnabled) return
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture()
      } else {
        await v.requestPictureInPicture()
      }
    } catch {
      // PiP can be refused by browser policy (e.g. tab not focused).
      // Silently ignore — the button's still discoverable.
    }
  }

  const stepFrame = (direction: 1 | -1) => {
    const v = videoRef.current
    if (!v) return
    if (!v.paused) v.pause()
    v.currentTime = Math.max(
      0,
      Math.min(duration, v.currentTime + direction * (1 / 30))
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

    // 3. iOS Safari — native video fullscreen (standard approach used by YouTube/Vimeo)
    if ((video as any)?.webkitEnterFullscreen) {
      ;(video as any).webkitEnterFullscreen()
    }
  }

  // Sync the keyboard-shortcut handler's reference to toggleFullscreen.
  // Direct assignment during render is the standard React pattern for
  // ref-as-latest-callback — no effect needed.
  toggleFullscreenRef.current = toggleFullscreen

  // PiP capability detected client-side after mount.
  useEffect(() => {
    setPipSupported(!!document.pictureInPictureEnabled)
  }, [])

  // Dismiss the speed/quality menu on Escape or click outside the chrome.
  useEffect(() => {
    if (openMenu === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpenMenu(null)
      }
    }
    const onClickOutside = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (target && containerRef.current?.contains(target)) {
        // Inside the player container — only close if the click landed
        // outside any menu (menu items handle their own selection).
        const menuEl = (target as HTMLElement).closest?.('[role="menu"]')
        if (!menuEl) setOpenMenu(null)
      } else {
        setOpenMenu(null)
      }
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClickOutside)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onClickOutside)
    }
  }, [openMenu])

  const handleMouseMove = () => {
    setShowControls(true)
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current)
  }

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div
      ref={containerRef}
      className={`relative bg-black rounded-lg overflow-hidden group aspect-video ${className}`}
      onMouseMove={handleMouseMove}
      onTouchStart={handleMouseMove}
      onMouseLeave={() => isPlaying && setShowControls(false)}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-contain"
        playsInline
        preload="metadata"
        poster={posterUrl || undefined}
        onClick={togglePlayPause}
      />

      {/* Graphics overlay — prefer graphicPackage over legacy mediaPack */}
      {(() => {
        const logoUrl = graphicPackage?.logo_url || mediaPack?.logo_url
        const sponsorUrl =
          graphicPackage?.sponsor_logo_url || mediaPack?.sponsor_logo_url

        // Use percentage-based positioning if available, else fall back to corner positions
        const hasPercentPos = graphicPackage?.logo_x != null
        const logoX = graphicPackage?.logo_x ?? 85
        const logoY = graphicPackage?.logo_y ?? 3
        const logoScale = graphicPackage?.logo_scale ?? 8
        const sponsorX = graphicPackage?.sponsor_x ?? 3
        const sponsorY = graphicPackage?.sponsor_y ?? 85
        const sponsorScale = graphicPackage?.sponsor_scale ?? 10

        if (hasPercentPos) {
          return (
            <>
              {logoUrl && (
                <img
                  src={logoUrl}
                  alt=""
                  className="absolute pointer-events-none object-contain opacity-80"
                  style={{
                    left: `${logoX}%`,
                    top: `${logoY}%`,
                    width: `${logoScale}%`,
                    maxWidth: '250px',
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              )}
              {sponsorUrl && (
                <img
                  src={sponsorUrl}
                  alt=""
                  className="absolute pointer-events-none object-contain opacity-80"
                  style={{
                    left: `${sponsorX}%`,
                    top: `${sponsorY}%`,
                    width: `${sponsorScale}%`,
                    maxWidth: '250px',
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              )}
            </>
          )
        }

        // Legacy fallback: fixed corner positions from mediaPack
        const logoPos = mediaPack?.logo_position || 'top-right'
        const sponsorPos = mediaPack?.sponsor_position || 'bottom-left'
        const posClass = (pos: string) =>
          pos === 'top-left'
            ? 'top-3 left-3'
            : pos === 'top-right'
              ? 'top-3 right-3'
              : pos === 'bottom-left'
                ? 'bottom-16 left-3'
                : 'bottom-16 right-3'
        return (
          <>
            {logoUrl && (
              <img
                src={logoUrl}
                alt=""
                className={`absolute pointer-events-none w-12 h-12 md:w-16 md:h-16 object-contain opacity-70 ${posClass(logoPos)}`}
              />
            )}
            {sponsorUrl && (
              <img
                src={sponsorUrl}
                alt=""
                className={`absolute pointer-events-none w-12 h-12 md:w-16 md:h-16 object-contain opacity-70 ${posClass(sponsorPos)}`}
              />
            )}
          </>
        )
      })()}

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

            <span className="text-white text-[10px] md:text-xs ml-1 md:ml-2 tabular-nums">
              {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
            </span>
          </div>

          <div className="flex items-center gap-0.5 md:gap-1">
            {/* Frame-step pair — desktop only; coaches scrubbing for tactical
                review. Mobile users have less precision so we hide. */}
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

            {/* Playback speed menu */}
            <div className="relative">
              <Button
                onClick={() =>
                  setOpenMenu(openMenu === 'speed' ? null : 'speed')
                }
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
            {qualityLevels.length > 1 && (
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
            {pipSupported && (
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
                  onClick={() => onAddTag(currentTime, videoRef.current)}
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
    </div>
  )
}
