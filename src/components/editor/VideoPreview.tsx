'use client'

import { useRef, useEffect, useCallback, useState } from 'react'
import { SOURCE_WIDTH, SOURCE_HEIGHT, CROP_WIDTH } from '@/lib/editor/types'

interface Props {
  videoUrl: string
  videoRef: React.RefObject<HTMLVideoElement | null>
  cropX: number
  onCropDrag: (x: number) => void
  onDragEnd: () => void
}

const CROP_PCT = (CROP_WIDTH / SOURCE_WIDTH) * 100

export function VideoPreview({
  videoUrl,
  videoRef,
  cropX,
  onCropDrag,
  onDragEnd,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const portraitRef = useRef<HTMLCanvasElement>(null)
  const cropXRef = useRef(cropX)
  const [isDragging, setIsDragging] = useState(false)
  const dragOffsetRef = useRef(0)

  cropXRef.current = cropX
  const leftPct = (cropX / SOURCE_WIDTH) * 100
  const rightPct = 100 - leftPct - CROP_PCT

  // Portrait preview animation loop
  useEffect(() => {
    const video = videoRef.current
    const canvas = portraitRef.current
    if (!video || !canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = CROP_WIDTH / 2
    canvas.height = SOURCE_HEIGHT / 2

    let rafId: number
    const draw = () => {
      if (video.readyState >= 2) {
        ctx.drawImage(
          video,
          cropXRef.current,
          0,
          CROP_WIDTH,
          SOURCE_HEIGHT,
          0,
          0,
          canvas.width,
          canvas.height
        )
      }
      rafId = requestAnimationFrame(draw)
    }
    rafId = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafId)
  }, [videoRef])

  const screenXToCropX = useCallback((clientX: number) => {
    const container = containerRef.current
    if (!container) return 0
    const rect = container.getBoundingClientRect()
    const relX = clientX - rect.left
    const scale = SOURCE_WIDTH / rect.width
    const newCropX = Math.round(
      Math.max(
        0,
        Math.min(
          SOURCE_WIDTH - CROP_WIDTH,
          relX * scale - dragOffsetRef.current
        )
      )
    )
    return newCropX
  }, [])

  const startDrag = useCallback((clientX: number) => {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const relX = clientX - rect.left
    const scale = SOURCE_WIDTH / rect.width
    const mouseSourceX = relX * scale

    if (
      mouseSourceX >= cropXRef.current &&
      mouseSourceX <= cropXRef.current + CROP_WIDTH
    ) {
      dragOffsetRef.current = mouseSourceX - cropXRef.current
      setIsDragging(true)
    }
  }, [])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      startDrag(e.clientX)
      e.preventDefault()
    },
    [startDrag]
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDragging) return
      onCropDrag(screenXToCropX(e.clientX))
    },
    [isDragging, screenXToCropX, onCropDrag]
  )

  const handleMouseUp = useCallback(() => {
    if (isDragging) {
      setIsDragging(false)
      onDragEnd()
    }
  }, [isDragging, onDragEnd])

  // Touch handlers for mobile
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0]
      startDrag(touch.clientX)
    },
    [startDrag]
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isDragging) return
      e.preventDefault()
      onCropDrag(screenXToCropX(e.touches[0].clientX))
    },
    [isDragging, screenXToCropX, onCropDrag]
  )

  const handleTouchEnd = useCallback(() => {
    if (isDragging) {
      setIsDragging(false)
      onDragEnd()
    }
  }, [isDragging, onDragEnd])

  return (
    <div className="flex flex-1 gap-3 overflow-hidden">
      {/* Landscape video with crop overlay */}
      <div className="relative flex-1 min-w-0">
        <div
          ref={containerRef}
          className="relative mx-auto aspect-video max-h-full overflow-hidden rounded"
          style={{ background: '#000' }}
        >
          <video
            ref={videoRef}
            src={videoUrl}
            className="h-full w-full object-contain"
            playsInline
            preload="auto"
          />

          {/* Dark overlays */}
          <div
            className="absolute inset-y-0 left-0 pointer-events-none"
            style={{ width: `${leftPct}%`, background: 'rgba(0,0,0,0.6)' }}
          />
          <div
            className="absolute inset-y-0 right-0 pointer-events-none"
            style={{
              width: `${Math.max(0, rightPct)}%`,
              background: 'rgba(0,0,0,0.6)',
            }}
          />

          {/* Crop window border */}
          <div
            className="absolute inset-y-0 pointer-events-none"
            style={{
              left: `${leftPct}%`,
              width: `${CROP_PCT}%`,
              border: '2px solid #22d3ee',
              boxShadow: isDragging
                ? '0 0 20px rgba(34,211,238,0.3)'
                : '0 0 8px rgba(34,211,238,0.1)',
              transition: isDragging ? 'none' : 'box-shadow 0.2s',
            }}
          />

          {/* Drag handle overlay (invisible, captures events) */}
          <div
            className="absolute inset-0 touch-none"
            style={{
              cursor: isDragging ? 'grabbing' : 'grab',
            }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          />

          {/* Crop position readout */}
          <div
            className="absolute bottom-2 right-2 rounded px-1.5 py-0.5 text-[10px] opacity-60"
            style={{
              fontFamily: 'var(--font-mono)',
              background: 'rgba(0,0,0,0.7)',
              color: '#22d3ee',
            }}
          >
            x:{cropX}
          </div>
        </div>
      </div>

      {/* Portrait preview — hidden on mobile */}
      <div className="hidden md:flex w-[120px] shrink-0 flex-col items-center gap-1">
        <span
          className="text-[9px] uppercase tracking-widest opacity-30"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          9:16 Preview
        </span>
        <div
          className="overflow-hidden rounded"
          style={{ border: '1px solid #1a2520', background: '#000' }}
        >
          <canvas
            ref={portraitRef}
            className="w-full"
            style={{ aspectRatio: `${CROP_WIDTH} / ${SOURCE_HEIGHT}` }}
          />
        </div>
      </div>
    </div>
  )
}
