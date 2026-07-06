'use client'

/**
 * FlatZoomPlayer — digital zoom/pan over an already-de-warped full-pitch video
 * (Spiideo's "Play" render). The whole pitch is visible at zoom 1×; drag and
 * wheel/buttons/keys zoom+pan into any area. NO WebGL mesh — the source is
 * already a clean rectilinear full-pitch image, so any de-warp would only
 * distort it. (The WebGL PanoramaPlayer is for TRUE raw fisheye feeds — the
 * any-camera path.)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import Hls from 'hls.js'
import { Button } from '@braintwopoint0/playback-commons/ui'
import {
  Play,
  Pause,
  Maximize,
  Minus,
  Plus,
  Frame,
  Loader2,
  AlertTriangle,
  Move,
} from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'

interface FlatZoomPlayerProps {
  /** Full-pitch recording URL (HLS `.m3u8` or progressive mp4). */
  src: string
  posterUrl?: string | null
  /** Max digital zoom factor. */
  maxZoom?: number
  className?: string
}

const KEY_PAN_STEP_PX = 40
const ZOOM_STEP = 1.25

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v))

/** Clamp a pan offset so the scaled content never reveals empty space. */
function clampOffset(x: number, y: number, zoom: number, w: number, h: number) {
  const maxX = Math.max(0, ((zoom - 1) * w) / 2)
  const maxY = Math.max(0, ((zoom - 1) * h) / 2)
  return { x: clamp(x, -maxX, maxX), y: clamp(y, -maxY, maxY) }
}

const fmtTime = (s: number): string => {
  if (!Number.isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export function FlatZoomPlayer({
  src,
  posterUrl,
  maxZoom = 6,
  className = '',
}: FlatZoomPlayerProps) {
  const t = useTranslations('player')
  const containerRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showHint, setShowHint] = useState(true)
  const [retry, setRetry] = useState(0)

  const dismissHint = useCallback(() => setShowHint(false), [])
  const reload = useCallback(() => {
    setError(null)
    setIsLoading(true)
    setRetry((r) => r + 1)
  }, [])

  const stageSize = () => {
    const el = stageRef.current
    return { w: el?.clientWidth ?? 0, h: el?.clientHeight ?? 0 }
  }

  // --- HLS / <video> setup (mirrors VideoPlayer's proven pattern) ---
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const isHls = src.includes('.m3u8')
    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true })
      hls.loadSource(src)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad()
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
          hls.recoverMediaError()
        else {
          hls.destroy()
          setIsLoading(false)
          setError(t('loadFailed'))
        }
      })
      hlsRef.current = hls
    } else {
      video.src = src
    }

    const onLoaded = () => {
      setDuration(video.duration || 0)
      setIsLoading(false)
    }
    const onTime = () => setCurrentTime(video.currentTime)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onError = () => {
      setIsLoading(false)
      setError(t('loadFailed'))
    }
    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('error', onError)

    return () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('error', onError)
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [src, retry])

  useEffect(() => {
    if (!showHint) return
    const t = setTimeout(() => setShowHint(false), 4500)
    return () => clearTimeout(t)
  }, [showHint])

  // --- zoom + pan ---
  const applyZoom = useCallback(
    (factor: number) => {
      const { w, h } = stageSize()
      setZoom((z) => {
        const next = clamp(z * factor, 1, maxZoom)
        setOffset((o) => clampOffset(o.x, o.y, next, w, h))
        return next
      })
    },
    [maxZoom]
  )

  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom <= 1) return // nothing to pan when the whole pitch is in frame
    dragRef.current = { x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    dismissHint()
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const start = dragRef.current
    if (!start) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    dragRef.current = { x: e.clientX, y: e.clientY }
    const { w, h } = stageSize()
    setOffset((o) => clampOffset(o.x + dx, o.y + dy, zoom, w, h))
  }
  const endDrag = (e: React.PointerEvent) => {
    dragRef.current = null
    ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  // native, non-passive wheel so zoom doesn't scroll the page
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      applyZoom(Math.exp(-e.deltaY * 0.0015))
      dismissHint()
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [applyZoom, dismissHint])

  const resetView = () => {
    setZoom(1)
    setOffset({ x: 0, y: 0 })
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const { w, h } = stageSize()
    let handled = true
    switch (e.key) {
      case 'ArrowLeft':
        setOffset((o) => clampOffset(o.x + KEY_PAN_STEP_PX, o.y, zoom, w, h))
        break
      case 'ArrowRight':
        setOffset((o) => clampOffset(o.x - KEY_PAN_STEP_PX, o.y, zoom, w, h))
        break
      case 'ArrowUp':
        setOffset((o) => clampOffset(o.x, o.y + KEY_PAN_STEP_PX, zoom, w, h))
        break
      case 'ArrowDown':
        setOffset((o) => clampOffset(o.x, o.y - KEY_PAN_STEP_PX, zoom, w, h))
        break
      case '+':
      case '=':
        applyZoom(ZOOM_STEP)
        break
      case '-':
      case '_':
        applyZoom(1 / ZOOM_STEP)
        break
      case '0':
      case 'Home':
        resetView()
        break
      default:
        handled = false
    }
    if (handled) {
      e.preventDefault()
      dismissHint()
    }
  }

  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) void v.play().catch(() => {})
    else v.pause()
  }
  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Number(e.target.value)
    setCurrentTime(v.currentTime)
  }
  const toggleFullscreen = () => {
    const el = containerRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }
  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])

  const seekPct =
    duration > 0 ? (Math.min(currentTime, duration) / duration) * 100 : 0
  const canInteract = !isLoading && !error
  const zoomPct = Math.round(zoom * 100)

  return (
    <div
      ref={containerRef}
      // Media-player chrome stays LTR by convention (seek bar, time readout).
      dir="ltr"
      className={cn(
        'relative w-full overflow-hidden rounded-lg bg-[#050907] select-none',
        className
      )}
    >
      <div className="relative aspect-video w-full">
        {/* zoom/pan stage — the video is transformed inside it */}
        <div
          ref={stageRef}
          role="application"
          aria-label={t('flatZoomAria')}
          tabIndex={canInteract ? 0 : -1}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
          className={cn(
            'absolute inset-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--timberwolf)]',
            zoom > 1 ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
          )}
        >
          <video
            ref={videoRef}
            playsInline
            poster={posterUrl ?? undefined}
            className="absolute inset-0 h-full w-full object-cover"
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              willChange: 'transform',
            }}
          />
        </div>

        {isLoading && !error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#050907]">
            {posterUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={posterUrl}
                alt=""
                className="h-full w-full object-cover opacity-40"
              />
            ) : null}
            <Loader2 className="absolute h-8 w-8 animate-spin text-[var(--timberwolf)]" />
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#050907] px-6 text-center">
            <AlertTriangle className="h-6 w-6 text-[var(--ash-grey)]" />
            <p className="text-sm text-[var(--timberwolf)]">{error}</p>
            <Button variant="outline" size="sm" onClick={reload}>
              {t('tryAgain')}
            </Button>
          </div>
        )}

        {canInteract && !isPlaying && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label={t('play')}
            className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/20 text-white backdrop-blur-sm transition hover:bg-white/30"
          >
            <Play className="h-7 w-7 translate-x-0.5" />
          </button>
        )}

        {showHint && canInteract && (
          <div className="pointer-events-none absolute inset-x-0 top-4 flex justify-center">
            <div className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-sm text-[var(--timberwolf)] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-2">
              <Move className="h-4 w-4" />
              {t('flatZoomHint')}
            </div>
          </div>
        )}

        <div
          className={cn(
            'pointer-events-none absolute right-3 top-3 rounded-md bg-black/50 px-2 py-1 text-xs font-medium text-[var(--timberwolf)] tabular-nums transition-opacity',
            zoomPct <= 100 ? 'opacity-0' : 'opacity-100'
          )}
        >
          {zoomPct}%
        </div>

        {canInteract && (
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-gradient-to-t from-black/80 via-black/40 to-transparent px-3 pb-2 pt-6">
            <input
              type="range"
              min={0}
              max={duration || 0}
              step={0.1}
              value={Math.min(currentTime, duration || 0)}
              onChange={onSeek}
              aria-label={t('seek')}
              aria-valuetext={t('seekValue', {
                current: fmtTime(currentTime),
                duration: fmtTime(duration),
              })}
              style={{
                background: `linear-gradient(to right, #10b981 ${seekPct}%, rgba(255,255,255,0.25) ${seekPct}%)`,
              }}
              className="-my-2 h-1 w-full cursor-pointer appearance-none rounded-full py-2 accent-emerald-500"
            />
            <div className="flex items-center gap-2 text-white">
              <Button
                variant="ghost"
                size="icon"
                onClick={togglePlay}
                aria-label={isPlaying ? t('pause') : t('play')}
                className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
              >
                {isPlaying ? (
                  <Pause className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
              </Button>
              <span className="text-xs tabular-nums text-[var(--ash-grey)]">
                {fmtTime(currentTime)} / {fmtTime(duration)}
              </span>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => applyZoom(1 / ZOOM_STEP)}
                  aria-label={t('zoomOut')}
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Minus className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => applyZoom(ZOOM_STEP)}
                  aria-label={t('zoomIn')}
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={resetView}
                  aria-label={t('resetView')}
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Frame className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleFullscreen}
                  aria-label={
                    isFullscreen ? t('exitFullscreen') : t('fullscreen')
                  }
                  className="h-9 w-9 text-white hover:bg-white/20 md:h-8 md:w-8"
                >
                  <Maximize className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
