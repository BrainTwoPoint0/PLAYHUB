'use client'

import { Trash2, RotateCcw, X } from 'lucide-react'
import {
  type CropKeyframe,
  KEYFRAME_COLORS,
  formatTime,
  SOURCE_WIDTH,
  CROP_WIDTH,
} from '@/lib/editor/types'

interface Props {
  keyframes: CropKeyframe[]
  selectedIndex: number | null
  currentTime: number
  cropX: number
  isOpen: boolean
  onClose: () => void
  onDeleteKeyframe: (index: number) => void
  onResetKeyframe: (index: number) => void
}

const SOURCE_LABELS: Record<CropKeyframe['source'], string> = {
  ai_ball: 'AI (ball)',
  ai_tracked: 'AI (tracked)',
  ai_cluster: 'AI (cluster)',
  user: 'User edit',
}

export function PropertiesPanel({
  keyframes,
  selectedIndex,
  currentTime,
  cropX,
  isOpen,
  onClose,
  onDeleteKeyframe,
  onResetKeyframe,
}: Props) {
  const selected = selectedIndex !== null ? keyframes[selectedIndex] : null

  // Find nearby keyframes (5 around current time)
  const nearbyStart = keyframes.findIndex((kf) => kf.time >= currentTime - 1)
  const nearby =
    nearbyStart >= 0
      ? keyframes.slice(
          Math.max(0, nearbyStart - 2),
          Math.min(keyframes.length, nearbyStart + 5)
        )
      : []

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={onClose}
        />
      )}
      <div
        className={`
          fixed inset-x-0 bottom-0 z-50 flex max-h-[60vh] flex-col rounded-t-xl
          transition-transform duration-200 ease-out
          md:static md:inset-auto md:z-auto md:max-h-none md:w-[240px] md:shrink-0 md:rounded-none md:border-l md:translate-y-0
          ${isOpen ? 'translate-y-0' : 'translate-y-full md:translate-y-0'}
        `}
        style={{ borderColor: '#1a2520', background: '#0a0f0c' }}
      >
        {/* Mobile drag handle + close */}
        <div className="flex items-center justify-between px-3 pt-2 pb-0 md:hidden">
          <div className="mx-auto h-1 w-8 rounded-full bg-white/20" />
          <button
            onClick={onClose}
            className="absolute right-2 top-2 rounded p-1 opacity-50 hover:opacity-80"
          >
            <X size={14} />
          </button>
        </div>
        {/* Current position */}
        <div className="border-b p-3" style={{ borderColor: '#1a2520' }}>
          <div
            className="mb-2 text-[9px] uppercase tracking-widest opacity-30"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Current
          </div>
          <div
            className="grid grid-cols-2 gap-y-1.5 text-[11px]"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            <span className="opacity-40">Time</span>
            <span className="text-cyan-400">{formatTime(currentTime)}</span>
            <span className="opacity-40">Crop X</span>
            <span className="text-[var(--timberwolf)]">{cropX} px</span>
            <span className="opacity-40">Range</span>
            <span className="opacity-50">
              {cropX}..{cropX + CROP_WIDTH} / {SOURCE_WIDTH}
            </span>
          </div>
        </div>

        {/* Selected keyframe */}
        {selected && selectedIndex !== null && (
          <div className="border-b p-3" style={{ borderColor: '#1a2520' }}>
            <div
              className="mb-2 text-[9px] uppercase tracking-widest opacity-30"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              Selected Keyframe
            </div>
            <div
              className="grid grid-cols-2 gap-y-1.5 text-[11px]"
              style={{ fontFamily: 'var(--font-mono)' }}
            >
              <span className="opacity-40">Time</span>
              <span className="text-cyan-400">{formatTime(selected.time)}</span>
              <span className="opacity-40">X</span>
              <span>{selected.x} px</span>
              <span className="opacity-40">Source</span>
              <span style={{ color: KEYFRAME_COLORS[selected.source] }}>
                {SOURCE_LABELS[selected.source]}
              </span>
              <span className="opacity-40">Conf</span>
              <span>{selected.confidence.toFixed(3)}</span>
            </div>

            <div className="mt-3 flex gap-2">
              {selected.source === 'user' && (
                <button
                  onClick={() => onResetKeyframe(selectedIndex)}
                  className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-blue-400 transition-colors hover:bg-blue-400/10"
                >
                  <RotateCcw size={11} />
                  Reset to AI
                </button>
              )}
              <button
                onClick={() => onDeleteKeyframe(selectedIndex)}
                className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-red-400 transition-colors hover:bg-red-400/10"
              >
                <Trash2 size={11} />
                Delete
              </button>
            </div>
          </div>
        )}

        {/* Nearby keyframes */}
        <div className="flex-1 overflow-auto p-3">
          <div
            className="mb-2 text-[9px] uppercase tracking-widest opacity-30"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Nearby
          </div>
          <div className="flex flex-col gap-0.5">
            {nearby.map((kf, i) => {
              const globalIdx = keyframes.indexOf(kf)
              const isActive = Math.abs(kf.time - currentTime) < 0.05
              return (
                <div
                  key={`nearby-${i}`}
                  className="flex items-center gap-2 rounded px-1.5 py-0.5 text-[10px] transition-colors hover:bg-white/5"
                  style={{
                    fontFamily: 'var(--font-mono)',
                    background: isActive ? 'rgba(34,211,238,0.05)' : undefined,
                    opacity: globalIdx === selectedIndex ? 1 : 0.6,
                  }}
                >
                  <span
                    className="inline-block h-[6px] w-[6px] shrink-0 rotate-45"
                    style={{ background: KEYFRAME_COLORS[kf.source] }}
                  />
                  <span className="tabular-nums text-cyan-400/70">
                    {formatTime(kf.time)}
                  </span>
                  <span className="tabular-nums">x={kf.x}</span>
                  <span className="opacity-40">{kf.confidence.toFixed(2)}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Keyboard shortcuts — desktop only */}
        <div
          className="hidden md:block border-t p-3"
          style={{ borderColor: '#1a2520' }}
        >
          <div
            className="mb-1.5 text-[9px] uppercase tracking-widest opacity-30"
            style={{ fontFamily: 'var(--font-mono)' }}
          >
            Shortcuts
          </div>
          <div className="grid grid-cols-2 gap-y-0.5 text-[10px] opacity-40">
            <span>Space</span>
            <span>Play / Pause</span>
            <span className="font-mono">&larr; &rarr;</span>
            <span>Step 0.2s</span>
            <span>Shift + arrows</span>
            <span>Step 1s</span>
            <span>K</span>
            <span>Add keyframe</span>
            <span>Del</span>
            <span>Remove keyframe</span>
          </div>
        </div>
      </div>
    </>
  )
}
