'use client'

import { useRef } from 'react'
import {
  ArrowLeft,
  Upload,
  FileJson,
  Download,
  Undo2,
  Redo2,
} from 'lucide-react'
import Link from 'next/link'

interface Props {
  filename: string
  hasVideo: boolean
  hasKeyframes: boolean
  keyframeCount: number
  userKeyframeCount: number
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onImportVideo: (file: File) => void
  onImportKeyframes: (file: File) => void
  onExport: () => void
}

export function EditorToolbar({
  filename,
  hasVideo,
  hasKeyframes,
  keyframeCount,
  userKeyframeCount,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onImportVideo,
  onImportKeyframes,
  onExport,
}: Props) {
  const videoInputRef = useRef<HTMLInputElement>(null)
  const jsonInputRef = useRef<HTMLInputElement>(null)

  return (
    <div
      className="flex h-11 shrink-0 items-center gap-3 border-b px-3"
      style={{ borderColor: '#1a2520', background: '#0a0f0c' }}
    >
      <Link
        href="/"
        className="flex items-center gap-1.5 text-xs opacity-50 transition-opacity hover:opacity-80"
      >
        <ArrowLeft size={14} />
        <span className="hidden sm:inline">PLAYHUB</span>
      </Link>

      <div
        className="mx-1 sm:mx-2 h-4 w-px"
        style={{ background: '#1a2520' }}
      />

      <span className="max-w-[120px] truncate text-xs sm:max-w-none sm:text-sm font-medium tracking-tight text-[var(--timberwolf)]">
        {filename || 'Portrait Editor'}
      </span>

      {hasKeyframes && (
        <span
          className="ml-2 hidden sm:inline font-[var(--font-mono)] text-[10px] tracking-wider opacity-40"
          style={{ fontFamily: 'var(--font-mono)' }}
        >
          {keyframeCount} KF
          {userKeyframeCount > 0 && (
            <span className="ml-1 text-amber-500">
              +{userKeyframeCount} edits
            </span>
          )}
        </span>
      )}

      {/* Undo / Redo */}
      {hasKeyframes && (
        <div className="flex items-center gap-0.5 ml-1">
          <button
            onClick={onUndo}
            disabled={!canUndo}
            className="rounded p-1.5 transition-opacity hover:bg-white/5 disabled:opacity-20"
            title="Undo (Cmd+Z)"
          >
            <Undo2 size={14} />
          </button>
          <button
            onClick={onRedo}
            disabled={!canRedo}
            className="rounded p-1.5 transition-opacity hover:bg-white/5 disabled:opacity-20"
            title="Redo (Cmd+Shift+Z)"
          >
            <Redo2 size={14} />
          </button>
        </div>
      )}

      <div className="flex-1" />

      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onImportVideo(f)
        }}
      />
      <input
        ref={jsonInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onImportKeyframes(f)
        }}
      />

      <button
        onClick={() => videoInputRef.current?.click()}
        className="flex items-center gap-1.5 rounded px-2 py-1.5 sm:px-2.5 sm:py-1 text-xs transition-colors hover:bg-white/5"
        style={{ color: hasVideo ? '#6b7280' : '#d6d5c9' }}
      >
        <Upload size={13} />
        <span className="hidden sm:inline">Video</span>
      </button>

      <button
        onClick={() => jsonInputRef.current?.click()}
        className="flex items-center gap-1.5 rounded px-2 py-1.5 sm:px-2.5 sm:py-1 text-xs transition-colors hover:bg-white/5"
        style={{
          color: hasKeyframes ? '#6b7280' : hasVideo ? '#d6d5c9' : '#6b7280',
        }}
      >
        <FileJson size={13} />
        <span className="hidden sm:inline">Keyframes</span>
      </button>

      {hasKeyframes && (
        <button
          onClick={onExport}
          className="flex items-center gap-1.5 rounded px-2 py-1.5 sm:px-2.5 sm:py-1 text-xs text-cyan-400 transition-colors hover:bg-cyan-400/10"
        >
          <Download size={13} />
          <span className="hidden sm:inline">Export</span>
        </button>
      )}
    </div>
  )
}
