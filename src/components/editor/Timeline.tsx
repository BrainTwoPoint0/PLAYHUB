'use client'

import { useRef, useCallback, useMemo, useState, useEffect } from 'react'
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ZoomIn,
  ZoomOut,
  Sparkles,
} from 'lucide-react'
import {
  type CropKeyframe,
  SOURCE_WIDTH,
  CROP_WIDTH,
  KEYFRAME_COLORS,
  interpolateCropX,
  formatTime,
} from '@/lib/editor/types'

interface Props {
  duration: number
  currentTime: number
  keyframes: CropKeyframe[]
  sceneChanges: number[]
  selectedIndex: number | null
  isPlaying: boolean
  onSeek: (time: number) => void
  onTogglePlay: () => void
  onStepForward: () => void
  onStepBackward: () => void
  onSelectKeyframe: (index: number | null) => void
  onAddKeyframe: () => void
  onSimplify: () => void
}

const MAX_CROP_X = SOURCE_WIDTH - CROP_WIDTH
const TRACK_HEIGHT = 100
const HEATMAP_HEIGHT = 12
const MIN_ZOOM = 1
const MAX_ZOOM = 20
const DIAMOND_SIZE = 5 // px

export function Timeline({
  duration,
  currentTime,
  keyframes,
  sceneChanges,
  selectedIndex,
  isPlaying,
  onSeek,
  onTogglePlay,
  onStepForward,
  onStepBackward,
  onSelectKeyframe,
  onAddKeyframe,
  onSimplify,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const wasPlayingRef = useRef(false)

  // Auto-scroll to keep playhead visible
  useEffect(() => {
    const el = scrollRef.current
    if (!el || isScrubbing) return
    if (!isPlaying) return
    const playheadPct = currentTime / duration
    const contentWidth = el.scrollWidth
    const viewWidth = el.clientWidth
    const playheadPx = playheadPct * contentWidth
    const scrollLeft = el.scrollLeft

    if (
      playheadPx < scrollLeft + 60 ||
      playheadPx > scrollLeft + viewWidth - 60
    ) {
      el.scrollLeft = playheadPx - viewWidth / 2
    }
  }, [currentTime, duration, isPlaying, isScrubbing])

  // Wheel to zoom (Cmd/Ctrl + scroll) or pan (scroll)
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      setZoom((z) =>
        Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z - e.deltaY * 0.01))
      )
    }
  }, [])

  const zoomIn = useCallback(
    () => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5)),
    []
  )
  const zoomOut = useCallback(
    () => setZoom((z) => Math.max(MIN_ZOOM, z / 1.5)),
    []
  )

  // Convert a clientX position to a time value
  const clientXToTime = useCallback(
    (clientX: number) => {
      const el = scrollRef.current
      if (!el) return 0
      const rect = el.getBoundingClientRect()
      const px = clientX - rect.left + el.scrollLeft
      const contentWidth = el.scrollWidth
      return Math.max(0, Math.min(duration, (px / contentWidth) * duration))
    },
    [duration]
  )

  // Scrub: mousedown starts, mousemove seeks, mouseup stops
  const handleScrubStart = useCallback(
    (clientX: number) => {
      setIsScrubbing(true)
      wasPlayingRef.current = isPlaying
      if (isPlaying) onTogglePlay() // pause during scrub
      onSeek(clientXToTime(clientX))
    },
    [isPlaying, onTogglePlay, onSeek, clientXToTime]
  )

  const handleScrubMove = useCallback(
    (clientX: number) => {
      if (!isScrubbing) return
      onSeek(clientXToTime(clientX))
    },
    [isScrubbing, onSeek, clientXToTime]
  )

  const handleScrubEnd = useCallback(() => {
    if (!isScrubbing) return
    setIsScrubbing(false)
    if (wasPlayingRef.current) onTogglePlay() // resume if was playing
  }, [isScrubbing, onTogglePlay])

  // Mouse handlers
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Ignore if clicking a keyframe diamond
      if ((e.target as HTMLElement).dataset.keyframe) return
      e.preventDefault()
      handleScrubStart(e.clientX)
    },
    [handleScrubStart]
  )

  // Global mousemove/mouseup so scrubbing works even outside the timeline
  useEffect(() => {
    if (!isScrubbing) return
    const onMove = (e: MouseEvent) => handleScrubMove(e.clientX)
    const onUp = () => handleScrubEnd()
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [isScrubbing, handleScrubMove, handleScrubEnd])

  // Touch handlers
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      handleScrubStart(e.touches[0].clientX)
    },
    [handleScrubStart]
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isScrubbing) return
      e.preventDefault()
      handleScrubMove(e.touches[0].clientX)
    },
    [isScrubbing, handleScrubMove]
  )

  const handleTouchEnd = useCallback(() => {
    handleScrubEnd()
  }, [handleScrubEnd])

  const handleKeyframeDotClick = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.stopPropagation()
      onSelectKeyframe(selectedIndex === index ? null : index)
    },
    [selectedIndex, onSelectKeyframe]
  )

  // Build interpolation curve
  const curvePath = useMemo(() => {
    if (keyframes.length === 0 || duration === 0) return ''
    const steps = Math.min(500, Math.ceil(duration / 0.1))
    const points: string[] = []
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * duration
      const cx = interpolateCropX(keyframes, t)
      const xPct = (t / duration) * 100
      const yPct = 8 + ((MAX_CROP_X - cx) / MAX_CROP_X) * 84
      points.push(`${xPct}% ${yPct}%`)
    }
    return points.join(', ')
  }, [keyframes, duration])

  // Time markers — show seconds labels at reasonable intervals
  const timeMarkers = useMemo(() => {
    if (duration === 0) return []
    // Determine spacing based on zoom: at 1x show every 5s, at 5x every 1s, at 10x every 0.5s
    let interval = 5
    if (zoom >= 10) interval = 0.5
    else if (zoom >= 5) interval = 1
    else if (zoom >= 2) interval = 2
    const markers: number[] = []
    for (let t = 0; t <= duration; t += interval) {
      markers.push(t)
    }
    return markers
  }, [duration, zoom])

  const playheadPct = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div
      className="shrink-0 border-t"
      style={{ borderColor: '#1a2520', background: '#0a0f0c' }}
    >
      {/* Transport controls */}
      <div
        className="flex h-9 items-center gap-2 border-b px-3"
        style={{ borderColor: '#1a2520' }}
      >
        <button
          onClick={onStepBackward}
          className="rounded p-2 sm:p-1 text-[var(--timberwolf)] opacity-50 transition-opacity hover:opacity-80"
        >
          <SkipBack size={14} />
        </button>
        <button
          onClick={onTogglePlay}
          className="rounded p-2 sm:p-1 text-[var(--timberwolf)] transition-opacity hover:opacity-80"
        >
          {isPlaying ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <button
          onClick={onStepForward}
          className="rounded p-2 sm:p-1 text-[var(--timberwolf)] opacity-50 transition-opacity hover:opacity-80"
        >
          <SkipForward size={14} />
        </button>

        <span
          className="ml-2 text-[11px] tabular-nums text-cyan-400"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {formatTime(currentTime)}
        </span>
        <span
          className="text-[11px] opacity-30"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          / {formatTime(duration)}
        </span>

        <div className="flex-1" />

        {/* Legend — hidden on mobile */}
        <div className="hidden sm:flex items-center gap-3 text-[9px] opacity-40">
          {(
            [
              ['ai_ball', 'ball'],
              ['ai_tracked', 'tracked'],
              ['ai_cluster', 'cluster'],
              ['user', 'user'],
            ] as const
          ).map(([key, label]) => (
            <span key={key} className="flex items-center gap-1">
              <span
                className="inline-block h-[7px] w-[7px] rotate-45"
                style={{ background: KEYFRAME_COLORS[key] }}
              />
              {label}
            </span>
          ))}
        </div>

        {/* Zoom controls */}
        <div className="ml-2 flex items-center gap-1">
          <button
            onClick={zoomOut}
            className="rounded p-1 opacity-40 hover:opacity-70"
          >
            <ZoomOut size={14} />
          </button>
          <span
            className="w-8 text-center text-[10px] tabular-nums opacity-40"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            {zoom.toFixed(zoom >= 10 ? 0 : 1)}x
          </span>
          <button
            onClick={zoomIn}
            className="rounded p-1 opacity-40 hover:opacity-70"
          >
            <ZoomIn size={14} />
          </button>
        </div>

        <button
          onClick={onSimplify}
          className="ml-2 flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] text-cyan-400 transition-colors hover:bg-cyan-400/10"
        >
          <Sparkles size={12} />
          <span className="hidden sm:inline">Simplify</span>
        </button>

        <button
          onClick={onAddKeyframe}
          className="flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] text-amber-500 transition-colors hover:bg-amber-500/10"
        >
          <span className="inline-block h-[8px] w-[8px] rotate-45 border border-amber-500" />
          <span className="hidden sm:inline">Keyframe</span>
        </button>
      </div>

      {/* Scrollable track area */}
      <div
        ref={scrollRef}
        className="relative overflow-x-auto"
        style={{ cursor: 'crosshair' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
          {/* Time markers */}
          <div
            className="relative h-4 border-b"
            style={{ borderColor: '#1a2520' }}
          >
            {timeMarkers.map((t) => (
              <span
                key={`tm-${t}`}
                className="absolute top-0 text-[9px] opacity-25 -translate-x-1/2"
                style={{
                  left: `${(t / duration) * 100}%`,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {t % 1 === 0 ? `${t}s` : `${t.toFixed(1)}s`}
              </span>
            ))}
          </div>

          {/* Keyframe track */}
          <div className="relative" style={{ height: `${TRACK_HEIGHT}px` }}>
            {/* Grid lines */}
            {timeMarkers.map((t) => (
              <div
                key={`grid-${t}`}
                className="absolute top-0 bottom-0 w-px"
                style={{
                  left: `${(t / duration) * 100}%`,
                  background: '#1a2520',
                }}
              />
            ))}

            {/* Scene change markers */}
            {sceneChanges.map((t, i) => (
              <div
                key={`sc-${i}`}
                className="absolute top-0 bottom-0 w-px opacity-40"
                style={{
                  left: `${(t / duration) * 100}%`,
                  background: '#ef4444',
                }}
              />
            ))}

            {/* Interpolation curve (CSS polygon clip-path on a gradient div) */}
            {curvePath && (
              <svg
                className="absolute inset-0 w-full h-full pointer-events-none"
                preserveAspectRatio="none"
                viewBox="0 0 100 100"
              >
                <polyline
                  points={curvePath
                    .split(', ')
                    .map((p) => {
                      const [x, y] = p.replace(/%/g, '').split(' ')
                      return `${x},${y}`
                    })
                    .join(' ')}
                  fill="none"
                  stroke="#22d3ee"
                  strokeWidth={0.4}
                  opacity={0.3}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}

            {/* Keyframe diamonds */}
            {keyframes.map((kf, i) => {
              const leftPct = (kf.time / duration) * 100
              const topPct = 8 + ((MAX_CROP_X - kf.x) / MAX_CROP_X) * 84
              const isSelected = selectedIndex === i
              const color = KEYFRAME_COLORS[kf.source]
              const size = isSelected ? DIAMOND_SIZE + 3 : DIAMOND_SIZE
              return (
                <div
                  key={`kf-${i}`}
                  className="absolute cursor-pointer"
                  style={{
                    left: `${leftPct}%`,
                    top: `${topPct}%`,
                    transform: 'translate(-50%, -50%) rotate(45deg)',
                    width: `${size}px`,
                    height: `${size}px`,
                    background: color,
                    opacity: kf.source === 'user' ? 1 : 0.75,
                    boxShadow: isSelected
                      ? `0 0 8px ${color}, 0 0 16px ${color}40`
                      : undefined,
                    border: isSelected ? `1px solid ${color}` : undefined,
                    zIndex: isSelected ? 10 : kf.source === 'user' ? 5 : 1,
                  }}
                  onClick={(e) => handleKeyframeDotClick(e, i)}
                />
              )
            })}

            {/* Playhead */}
            <div
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{
                left: `${playheadPct}%`,
                width: '2px',
                background: '#22d3ee',
                transform: 'translateX(-1px)',
                zIndex: 20,
                boxShadow: '0 0 6px rgba(34,211,238,0.4)',
              }}
            >
              {/* Playhead handle */}
              <div
                style={{
                  position: 'absolute',
                  top: -3,
                  left: -4,
                  width: 10,
                  height: 10,
                  background: '#22d3ee',
                  borderRadius: '2px 2px 50% 50%',
                  transform: 'rotate(45deg)',
                }}
              />
            </div>
          </div>

          {/* Confidence heatmap */}
          <div className="relative" style={{ height: `${HEATMAP_HEIGHT}px` }}>
            {keyframes.map((kf, i) => {
              const nextTime =
                i < keyframes.length - 1 ? keyframes[i + 1].time : duration
              const leftPct = (kf.time / duration) * 100
              const widthPct = ((nextTime - kf.time) / duration) * 100
              return (
                <div
                  key={`hm-${i}`}
                  className="absolute top-0 bottom-0"
                  style={{
                    left: `${leftPct}%`,
                    width: `${Math.max(0.1, widthPct)}%`,
                    background: KEYFRAME_COLORS[kf.source],
                    opacity: 0.15 + kf.confidence * 0.35,
                  }}
                />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
