'use client'

import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { motion, AnimatePresence } from 'motion/react'
import {
  type CropKeyframe,
  detectionsToCropKeyframes,
  parseKeyframesJson,
  interpolateCropX,
  SOURCE_WIDTH,
  CROP_WIDTH,
  formatTime,
  KEYFRAME_COLORS,
} from '@/lib/editor/types'
import { simplifyCropKeyframes } from '@/lib/editor/simplify'
import {
  Upload,
  FileJson,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Download,
  Plus,
  Trash2,
  Undo2,
  Redo2,
  Loader2,
  ChevronLeft,
  ChevronRight,
  Minimize2,
  Maximize2,
  RotateCcw,
  Sparkles,
  Keyboard,
  X,
  GripVertical,
  Scissors,
  Save,
  Check,
  AlertTriangle,
} from 'lucide-react'

/* ───────── constants ───────── */
const CROP_RATIO = CROP_WIDTH / SOURCE_WIDTH
const MAX_VIDEO_SIZE = 500 * 1024 * 1024 // 500MB

export default function EditorPage() {
  const searchParams = useSearchParams()
  const fromAcademy = searchParams.get('from') === 'academy'

  /* ───────── state ───────── */
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [videoFilename, setVideoFilename] = useState('')
  const [isUrlSource, setIsUrlSource] = useState(false)
  const [duration, setDuration] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [keyframes, setKeyframes] = useState<CropKeyframe[]>([])
  const [sceneChanges, setSceneChanges] = useState<number[]>([])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [dragCropX, setDragCropX] = useState<number | null>(null)
  const [history, setHistory] = useState<CropKeyframe[][]>([])
  const [future, setFuture] = useState<CropKeyframe[][]>([])
  const [processing, setProcessing] = useState(false)
  const [processingStatus, setProcessingStatus] = useState('')
  const [previewMode, setPreviewMode] = useState<'split' | 'portrait'>('split')
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const [posterUrl, setPosterUrl] = useState<string | null>(null)
  const [trimStart, setTrimStart] = useState(0)
  const [trimEnd, setTrimEnd] = useState(0) // 0 = use full duration
  const [outroFile, setOutroFile] = useState<File | null>(null)
  const [outroThumb, setOutroThumb] = useState<string | null>(null)

  /* ───────── Phase 3: portrait-crop persistence state ───────── */
  // recordingId is the stable anchor for save/load; when present the job
  // becomes a recording-linked row visible to org teammates (read-only).
  const recordingId = searchParams.get('recordingId')
  const [jobId, setJobId] = useState<string | null>(null)
  // null = still checking the kill-switch; false = banner + disable CTAs.
  const [portraitCropEnabled, setPortraitCropEnabled] = useState<
    boolean | null
  >(null)
  // Metadata captured from the Modal detect response — fed through to save
  // so the DB has codec fingerprints for the Veo-encoder-drift canary.
  const lastDetectionMetaRef = useRef<{
    codecFingerprint: Record<string, unknown> | null
    modalInferenceMs: number | null
    modalAppVersion: string | null
  }>({ codecFingerprint: null, modalInferenceMs: null, modalAppVersion: null })
  // Snapshot of the keyframes at the moment the AI produced them. Kept even
  // across saves so the feedback log distinguishes "original detection vs
  // current state" rather than "last save vs current state" — matters because
  // resuming a saved edited job would otherwise record `accepted` on re-save.
  const originallyDetectedRef = useRef<CropKeyframe[] | null>(null)
  // Per-session dirty bit — flips true on any user-driven edit. Reset on
  // detect / resume / successful save. Guards against the case where a user
  // reopens a previously-edited job and re-saves without touching anything.
  const sessionDirtyRef = useRef<boolean>(false)
  const [saving, setSaving] = useState(false)
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const videoFileRef = useRef<File | null>(null)
  const videoUrlRef = useRef<string | null>(null) // for cleanup on unmount
  const videoRef = useRef<HTMLVideoElement>(null)
  const timelineRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const jsonInputRef = useRef<HTMLInputElement>(null)
  const outroInputRef = useRef<HTMLInputElement>(null)

  const effectiveCropX =
    dragCropX ?? interpolateCropX(keyframes, currentTime, sceneChanges)
  const cropPercent = effectiveCropX / (SOURCE_WIDTH - CROP_WIDTH)

  /* ───────── auto-detect mobile ───────── */
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // Default to portrait mode on mobile
  useEffect(() => {
    if (isMobile) setPreviewMode('portrait')
  }, [isMobile])

  /* ───────── cleanup object URL on unmount ───────── */
  useEffect(() => {
    return () => {
      if (videoUrlRef.current && !isUrlSource)
        URL.revokeObjectURL(videoUrlRef.current)
    }
  }, [isUrlSource])

  /* ───────── load video from URL param ───────── */
  useEffect(() => {
    const paramUrl = searchParams.get('videoUrl')
    const title = searchParams.get('title')
    if (paramUrl && !videoUrl) {
      // Proxy through our API to avoid CORS issues
      const proxyUrl = `/api/veo/proxy?url=${encodeURIComponent(paramUrl)}`
      setVideoUrl(proxyUrl)
      setVideoFilename(title || 'Veo Highlight')
      setIsUrlSource(true)
    }
  }, [searchParams])

  /* ───────── Phase 3: feature-flag gate + resume existing job ───────── */
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const statusRes = await fetch('/api/editor/status', {
          cache: 'no-store',
        })
        if (!statusRes.ok) {
          if (!cancelled) setPortraitCropEnabled(false)
          return
        }
        const statusBody = await statusRes.json()
        const enabled = Boolean(statusBody.portraitCropEnabled)
        if (cancelled) return
        setPortraitCropEnabled(enabled)

        // Only attempt to resume a job when the editor is gated ON and a
        // recording anchor is present. Ad-hoc local-file sessions have no
        // stable identity and aren't persisted in Phase 3.
        if (!enabled || !recordingId) return
        const loadRes = await fetch(
          `/api/editor/load?recordingId=${encodeURIComponent(recordingId)}`,
          { cache: 'no-store' }
        )
        if (loadRes.status === 404) return
        if (!loadRes.ok) return
        const loadBody = (await loadRes.json()) as {
          job: {
            id: string
            scene_changes: number[]
            codec_fingerprint: Record<string, unknown> | null
            modal_inference_ms: number | null
            modal_app_version: string | null
            updated_at: string
          }
          keyframes: Array<{
            time_seconds: number
            x_pixels: number
            source: CropKeyframe['source']
            confidence: number
            edited_by_user: boolean
            edited_at: string | null
          }>
        }
        if (cancelled) return
        setJobId(loadBody.job.id)
        setSceneChanges(loadBody.job.scene_changes ?? [])
        lastDetectionMetaRef.current = {
          codecFingerprint: loadBody.job.codec_fingerprint,
          modalInferenceMs: loadBody.job.modal_inference_ms,
          modalAppVersion: loadBody.job.modal_app_version,
        }
        const restoredKfs: CropKeyframe[] = loadBody.keyframes.map((kf) => ({
          time: kf.time_seconds,
          x: kf.x_pixels,
          source: kf.source,
          confidence: kf.confidence,
        }))
        if (cancelled) return
        setKeyframes(restoredKfs)
        // Don't treat resumed keyframes as "originally detected" — we don't
        // know the pre-edit baseline for a job created in a prior session.
        // Leave the ref null; session-dirty bit decides the feedback action.
        sessionDirtyRef.current = false
        setLastSavedAt(new Date(loadBody.job.updated_at).getTime())
      } catch {
        if (!cancelled) setPortraitCropEnabled(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordingId])

  /* ───────── beforeunload warning ───────── */
  useEffect(() => {
    if (keyframes.length === 0) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [keyframes.length])

  /* ───────── undo/redo ───────── */
  const updateKeyframes = useCallback(
    (updater: (prev: CropKeyframe[]) => CropKeyframe[]) => {
      setKeyframes((prev) => {
        const next = updater(prev)
        if (next === prev) return prev
        // Any real change in this session counts as a dirty edit for
        // feedback-action reporting.
        sessionDirtyRef.current = true
        // Store prev snapshot for history — applied outside the updater
        // to avoid React strict mode double-invocation pushing duplicates
        pendingHistoryRef.current = prev
        return next
      })
    },
    []
  )

  // Apply history push outside setKeyframes updater to avoid strict mode duplication
  const pendingHistoryRef = useRef<CropKeyframe[] | null>(null)
  useEffect(() => {
    if (pendingHistoryRef.current !== null) {
      setHistory((h) => [...h.slice(-49), pendingHistoryRef.current!])
      setFuture([])
      pendingHistoryRef.current = null
    }
  }, [keyframes])

  const undo = useCallback(() => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    if (!prev) {
      setHistory((h) => h.slice(0, -1))
      return
    }
    setHistory((h) => h.slice(0, -1))
    setFuture((f) => [...f, keyframes])
    setKeyframes(prev)
    setSelectedIndex(null)
  }, [history, keyframes])

  const redo = useCallback(() => {
    if (future.length === 0) return
    const next = future[future.length - 1]
    setFuture((f) => f.slice(0, -1))
    setHistory((h) => [...h, keyframes])
    setKeyframes(next)
    setSelectedIndex(null)
  }, [future, keyframes])

  /* ───────── sync video element on view mode switch ───────── */
  useEffect(() => {
    const video = videoRef.current
    if (!video || !videoUrl) return
    const onCanPlay = () => {
      const end = trimEnd || duration
      const target = Math.max(trimStart, Math.min(end, currentTime))
      if (Math.abs(video.currentTime - target) > 0.1) {
        video.currentTime = target
      }
    }
    if (video.readyState >= 3) {
      onCanPlay()
    } else {
      video.addEventListener('canplay', onCanPlay, { once: true })
      return () => video.removeEventListener('canplay', onCanPlay)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewMode])

  /* ───────── playback sync ───────── */
  useEffect(() => {
    if (!isPlaying) return
    const end = trimEnd || duration
    let rafId: number
    const tick = () => {
      const v = videoRef.current
      if (v) {
        // Stop at trim end
        if (end > 0 && v.currentTime >= end) {
          v.pause()
          v.currentTime = end
          setCurrentTime(end)
          setIsPlaying(false)
          return
        }
        setCurrentTime(v.currentTime)
        if (v.ended) setIsPlaying(false)
      }
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [isPlaying, trimEnd, duration])

  // Capture first frame as poster: play an off-screen video, grab the first
  // decoded frame via canvas, then set as poster on the visible element.
  useEffect(() => {
    if (!videoUrl) return
    let revoke = ''
    let cancelled = false

    const offscreen = document.createElement('video')
    offscreen.muted = true
    offscreen.playsInline = true
    offscreen.preload = 'auto'
    offscreen.style.position = 'fixed'
    offscreen.style.top = '-9999px'
    offscreen.style.width = '1px'
    offscreen.style.height = '1px'
    document.body.appendChild(offscreen)
    offscreen.src = videoUrl

    // Wait for timeupdate — guarantees at least one frame has been decoded
    const onTimeUpdate = () => {
      if (cancelled) return
      offscreen.pause()
      offscreen.removeEventListener('timeupdate', onTimeUpdate)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = offscreen.videoWidth || 1920
        canvas.height = offscreen.videoHeight || 1080
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(offscreen, 0, 0)
          canvas.toBlob((blob) => {
            if (blob && !cancelled) {
              revoke = URL.createObjectURL(blob)
              setPosterUrl(revoke)
            }
          })
        }
      } catch {
        // ignore
      }
      offscreen.src = ''
      offscreen.remove()
    }

    offscreen.addEventListener('timeupdate', onTimeUpdate)
    // Must actually play to get a decoded frame with some codecs
    offscreen.addEventListener(
      'canplay',
      () => {
        if (!cancelled) offscreen.play().catch(() => {})
      },
      { once: true }
    )

    return () => {
      cancelled = true
      if (revoke) URL.revokeObjectURL(revoke)
      offscreen.removeEventListener('timeupdate', onTimeUpdate)
      offscreen.pause()
      offscreen.src = ''
      offscreen.remove()
    }
  }, [videoUrl])

  // Set duration from main video
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onMeta = () => setDuration(video.duration)
    if (video.readyState >= 1 && video.duration) {
      setDuration(video.duration)
    }
    video.addEventListener('loadedmetadata', onMeta)
    return () => video.removeEventListener('loadedmetadata', onMeta)
  }, [videoUrl])

  /* ───────── GPU processing ───────── */
  const processVideoFile = useCallback(async (file: File) => {
    setProcessing(true)
    setErrorMessage('')
    setProcessingStatus('Uploading to GPU...')
    try {
      setProcessingStatus('Detecting ball positions on GPU...')
      const res = await fetch('/api/editor/process', {
        method: 'POST',
        body: file,
      })

      if (res.status === 401) {
        throw new Error('Sign in required to use ball detection')
      }
      if (res.status === 413) {
        throw new Error('Video is too large (max 500MB)')
      }
      if (!res.ok) throw new Error('Processing failed')
      const detection = await res.json()

      const positions = detection.positions || []
      const sceneChangesData = detection.scene_changes || []
      // Capture metadata so save() can persist it alongside the keyframes.
      lastDetectionMetaRef.current = {
        codecFingerprint: detection.codec_fingerprint ?? null,
        modalInferenceMs: detection.modal_inference_ms ?? null,
        modalAppVersion: detection.modal_app_version ?? null,
      }
      const cropKfs = detectionsToCropKeyframes({
        positions,
        scene_changes: sceneChangesData,
        all_candidates: [],
      })
      const simplified = simplifyCropKeyframes(cropKfs, sceneChangesData)

      setKeyframes(simplified)
      // Snapshot the pristine AI output — kept for feedback.keyframes_before
      // across the whole session, even after saves.
      originallyDetectedRef.current = simplified
      sessionDirtyRef.current = false
      setSceneChanges(sceneChangesData)
      setHistory([])
      setFuture([])
      setProcessingStatus(
        `${simplified.length} keyframes from ${positions.length} detections`
      )
      setTimeout(() => setProcessingStatus(''), 5000)
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Processing failed — try importing keyframes manually'
      setErrorMessage(msg)
      setProcessingStatus('')
    } finally {
      setProcessing(false)
    }
  }, [])

  /* ───────── file handlers ───────── */
  const validateAndImportVideo = useCallback(
    (file: File) => {
      // Validate file size
      if (file.size > MAX_VIDEO_SIZE) {
        setErrorMessage(
          `Video is too large (${(file.size / 1024 / 1024).toFixed(0)}MB). Max 500MB.`
        )
        return
      }

      // Validate file type
      if (!file.type.startsWith('video/')) {
        setErrorMessage('Please select a video file')
        return
      }

      // Confirm if replacing existing work
      if (keyframes.length > 0) {
        const confirmed = window.confirm(
          'Loading a new video will discard your current keyframes. Continue?'
        )
        if (!confirmed) return
      }

      if (videoUrl) URL.revokeObjectURL(videoUrl)
      const url = URL.createObjectURL(file)
      setVideoUrl(url)
      videoUrlRef.current = url
      setPosterUrl(null)
      setTrimStart(0)
      setTrimEnd(0)
      setVideoFilename(file.name)
      setCurrentTime(0)
      setIsPlaying(false)
      setSelectedIndex(null)
      setKeyframes([])
      setSceneChanges([])
      setHistory([])
      setFuture([])
      setErrorMessage('')
      videoFileRef.current = file
    },
    [videoUrl, keyframes.length]
  )

  const handleDetectBall = useCallback(() => {
    if (!videoFileRef.current || processing) return

    // If re-detecting, confirm
    if (keyframes.length > 0) {
      const confirmed = window.confirm(
        'Re-detecting will replace your current keyframes. Continue?'
      )
      if (!confirmed) return
    }

    processVideoFile(videoFileRef.current)
  }, [processing, processVideoFile, keyframes.length])

  const handleImportKeyframes = useCallback((file: File) => {
    if (file.size > 50 * 1024 * 1024) {
      setErrorMessage('JSON file too large (max 50MB)')
      return
    }

    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const raw = JSON.parse(e.target?.result as string)
        const parsed = parseKeyframesJson(raw)
        const kfs = detectionsToCropKeyframes({
          positions: parsed.positions,
          scene_changes: parsed.scene_changes,
          all_candidates: [],
        })
        setKeyframes(kfs)
        setSceneChanges(parsed.scene_changes)
        setSelectedIndex(null)
        setHistory([])
        setFuture([])
        setErrorMessage('')
      } catch {
        setErrorMessage(
          'Invalid JSON. Expected: {positions: [...], scene_changes: [...]}'
        )
      }
    }
    reader.readAsText(file)
  }, [])

  const handleOutroFile = useCallback(
    (file: File) => {
      if (!file.type.startsWith('video/')) {
        setErrorMessage('Outro must be a video file')
        return
      }
      setOutroFile(file)
      // Capture thumbnail from outro
      const url = URL.createObjectURL(file)
      const v = document.createElement('video')
      v.muted = true
      v.playsInline = true
      v.preload = 'auto'
      v.src = url
      v.style.position = 'fixed'
      v.style.top = '-9999px'
      document.body.appendChild(v)
      const onTimeUpdate = () => {
        v.pause()
        v.removeEventListener('timeupdate', onTimeUpdate)
        const canvas = document.createElement('canvas')
        canvas.width = v.videoWidth || 1920
        canvas.height = v.videoHeight || 1080
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(v, 0, 0)
          canvas.toBlob((blob) => {
            if (blob) {
              if (outroThumb) URL.revokeObjectURL(outroThumb)
              setOutroThumb(URL.createObjectURL(blob))
            }
          })
        }
        URL.revokeObjectURL(url)
        v.src = ''
        v.remove()
      }
      v.addEventListener('timeupdate', onTimeUpdate)
      v.addEventListener('canplay', () => v.play().catch(() => {}), {
        once: true,
      })
    },
    [outroThumb]
  )

  const handleExport = useCallback(() => {
    // Only export keyframes within trim range
    const start = trimStart
    const end = trimEnd || duration
    const trimmedKeyframes =
      start > 0 || trimEnd > 0
        ? keyframes.filter((kf) => kf.time >= start && kf.time <= end)
        : keyframes
    const exportData = {
      keyframes: trimmedKeyframes,
      source_width: SOURCE_WIDTH,
      crop_width: CROP_WIDTH,
      video_filename: videoFilename,
      ...(start > 0 || trimEnd > 0 ? { trim_start: start, trim_end: end } : {}),
      ...(outroFile ? { outro_filename: outroFile.name } : {}),
      exported_at: new Date().toISOString(),
    }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = videoFilename.replace(/\.[^.]+$/, '_keyframes.json')
    a.click()
    URL.revokeObjectURL(url)
  }, [keyframes, videoFilename])

  /* ───────── Phase 3: save keyframes to Supabase via /api/editor/save ───────── */
  const canPersist = portraitCropEnabled === true && Boolean(recordingId)

  const handleSave = useCallback(async () => {
    if (!canPersist) return
    if (keyframes.length === 0) return
    setSaving(true)
    setSaveError(null)
    try {
      // Session-dirty bit is the authoritative signal — a user who reopened
      // a previously-edited job and hasn't touched it writes `accepted`; any
      // edit in this session writes `edited`.
      const hasEdits = sessionDirtyRef.current
      const pristine = originallyDetectedRef.current
      // Normalise keyframes to the DB schema shape expected by save_crop_job.
      const normalised = keyframes.map((kf) => ({
        time_seconds: kf.time,
        x_pixels: kf.x,
        source: kf.source,
        confidence: kf.confidence ?? 0.5,
        edited_by_user: kf.source === 'user' || hasEdits,
        edited_at:
          kf.source === 'user' || hasEdits ? new Date().toISOString() : null,
      }))

      const meta = lastDetectionMetaRef.current
      const payload = {
        recordingId,
        keyframes: normalised,
        sceneChanges,
        status: hasEdits ? 'edited' : 'detected',
        codecFingerprint: meta.codecFingerprint,
        modalInferenceMs: meta.modalInferenceMs,
        modalAppVersion: meta.modalAppVersion,
        feedback: hasEdits
          ? {
              action: 'edited' as const,
              note: null,
              keyframesBefore: pristine,
              keyframesAfter: keyframes,
            }
          : { action: 'accepted' as const, note: null },
      }

      const res = await fetch('/api/editor/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.status === 503) {
        throw new Error('Portrait crop editor is disabled')
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || 'Save failed')
      }
      const body = (await res.json()) as {
        jobId: string
        status: string
        updatedAt: string
      }
      setJobId(body.jobId)
      setLastSavedAt(new Date(body.updatedAt).getTime())
      // Clear session dirty — subsequent saves without further edits count
      // as `accepted` (confirming the AI's output) rather than repeat edits.
      sessionDirtyRef.current = false
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
    // Refs intentionally omitted — they carry session state that's read on
    // each invocation but shouldn't retrigger the memo.
  }, [canPersist, keyframes, recordingId, sceneChanges])

  // Relative-time label for the Save button tooltip / aria. Frozen between
  // saves — re-runs only when a new save completes. Label drifts slightly
  // stale until the next save, which is fine for this surface.
  const savedAgo = useMemo(() => {
    if (!lastSavedAt) return null
    const s = Math.round((Date.now() - lastSavedAt) / 1000)
    if (s < 10) return 'just now'
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.round(s / 60)}m ago`
    return `${Math.round(s / 3600)}h ago`
  }, [lastSavedAt])

  /* ───────── drag & drop ───────── */
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragOver(false)
      const file = e.dataTransfer.files[0]
      if (!file) return
      if (file.type.startsWith('video/')) {
        validateAndImportVideo(file)
      } else if (file.name.endsWith('.json')) {
        handleImportKeyframes(file)
      }
    },
    [validateAndImportVideo, handleImportKeyframes]
  )

  /* ───────── playback controls ───────── */
  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      // If at or past trim end, loop back to trim start
      const end = trimEnd || duration
      if (end > 0 && video.currentTime >= end - 0.05) {
        video.currentTime = trimStart
        setCurrentTime(trimStart)
      }
      video
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false))
    } else {
      video.pause()
      setIsPlaying(false)
    }
  }, [trimStart, trimEnd, duration])

  const seek = useCallback(
    (time: number) => {
      const video = videoRef.current
      if (!video) return
      const end = trimEnd || duration
      const clamped = Math.max(trimStart, Math.min(end, time))
      video.currentTime = clamped
      setCurrentTime(clamped)
    },
    [trimStart, trimEnd, duration]
  )

  const stepForward = useCallback(() => {
    const end = trimEnd || duration
    seek(Math.min(end, currentTime + 0.2))
  }, [currentTime, trimEnd, duration, seek])

  const stepBackward = useCallback(() => {
    seek(Math.max(trimStart, currentTime - 0.2))
  }, [currentTime, trimStart, seek])

  /* ───────── crop drag ───────── */
  const handleCropDrag = useCallback((x: number) => {
    setDragCropX(x)
    setIsDragging(true)
  }, [])

  const handleDragEnd = useCallback(() => {
    // Always clear drag state — stale closures in window listeners can cause
    // dragCropX to appear null even when it isn't, so we must always reset
    setDragCropX((prevDragX) => {
      if (prevDragX !== null) {
        const time = Math.round(currentTime * 1000) / 1000
        updateKeyframes((prev) => {
          const existingIdx = prev.findIndex(
            (kf) => kf.source === 'user' && Math.abs(kf.time - time) < 0.05
          )
          if (existingIdx >= 0) {
            const updated = [...prev]
            updated[existingIdx] = { ...updated[existingIdx], x: prevDragX }
            return updated
          }
          const newKf: CropKeyframe = {
            time,
            x: prevDragX,
            source: 'user',
            confidence: 1.0,
          }
          return [...prev, newKf].sort((a, b) => a.time - b.time)
        })
      }
      return null
    })
    setIsDragging(false)
  }, [currentTime, updateKeyframes])

  /* ───────── keyframe actions ───────── */
  const addKeyframe = useCallback(() => {
    const time = Math.round(currentTime * 1000) / 1000
    const x = interpolateCropX(keyframes, currentTime, sceneChanges)
    updateKeyframes((prev) => {
      const exists = prev.findIndex(
        (kf) => kf.source === 'user' && Math.abs(kf.time - time) < 0.05
      )
      if (exists >= 0) return prev
      const newKf: CropKeyframe = { time, x, source: 'user', confidence: 1.0 }
      return [...prev, newKf].sort((a, b) => a.time - b.time)
    })
  }, [currentTime, keyframes, updateKeyframes])

  const simplifyKeyframes = useCallback(() => {
    updateKeyframes((prev) => {
      const simplified = simplifyCropKeyframes(prev, sceneChanges)
      if (simplified.length === prev.length) return prev
      return simplified
    })
    setSelectedIndex(null)
  }, [updateKeyframes, sceneChanges])

  const deleteKeyframe = useCallback(
    (index: number) => {
      updateKeyframes((prev) => prev.filter((_, i) => i !== index))
      setSelectedIndex(null)
    },
    [updateKeyframes]
  )

  const resetKeyframe = useCallback(
    (index: number) => {
      updateKeyframes((prev) => {
        const kf = prev[index]
        if (kf.source !== 'user') return prev
        const aiKfs = prev.filter((k, i) => i !== index && k.source !== 'user')
        if (aiKfs.length === 0) return prev.filter((_, i) => i !== index)
        const nearest = aiKfs.reduce((a, b) =>
          Math.abs(a.time - kf.time) < Math.abs(b.time - kf.time) ? a : b
        )
        if (Math.abs(nearest.time - kf.time) < 0.15) {
          return prev.filter((_, i) => i !== index)
        }
        return prev
      })
      setSelectedIndex(null)
    },
    [updateKeyframes]
  )

  /* ───────── trim actions ───────── */
  const effectiveTrimEnd = trimEnd || duration

  const trimDeleteLeft = useCallback(() => {
    if (currentTime <= trimStart) return
    setTrimStart(currentTime)
    // Remove keyframes before the new start
    updateKeyframes((prev) => prev.filter((kf) => kf.time >= currentTime))
    setSceneChanges((prev) => prev.filter((t) => t >= currentTime))
  }, [currentTime, trimStart, updateKeyframes])

  const trimDeleteRight = useCallback(() => {
    if (currentTime >= effectiveTrimEnd) return
    setTrimEnd(currentTime)
    // Remove keyframes after the new end
    updateKeyframes((prev) => prev.filter((kf) => kf.time <= currentTime))
    setSceneChanges((prev) => prev.filter((t) => t <= currentTime))
  }, [currentTime, effectiveTrimEnd, updateKeyframes])

  const addSplitMarker = useCallback(() => {
    if (!duration) return
    // Avoid duplicate markers within 0.1s
    const exists = sceneChanges.some((t) => Math.abs(t - currentTime) < 0.1)
    if (exists) return
    setSceneChanges((prev) => [...prev, currentTime].sort((a, b) => a - b))
  }, [currentTime, duration, sceneChanges])

  const trimReset = useCallback(() => {
    setTrimStart(0)
    setTrimEnd(0)
  }, [])

  /* ───────── keyboard shortcuts ───────── */
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return

      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowRight':
          e.preventDefault()
          seek(Math.min(duration, currentTime + (e.shiftKey ? 1 : 0.2)))
          break
        case 'ArrowLeft':
          e.preventDefault()
          seek(Math.max(0, currentTime - (e.shiftKey ? 1 : 0.2)))
          break
        case 'KeyK':
          e.preventDefault()
          addKeyframe()
          break
        case 'Delete':
        case 'Backspace':
          if (selectedIndex !== null) {
            e.preventDefault()
            deleteKeyframe(selectedIndex)
          }
          break
        case 'KeyS':
          e.preventDefault()
          addSplitMarker()
          break
        case 'KeyP':
          e.preventDefault()
          setPreviewMode((m) => (m === 'split' ? 'portrait' : 'split'))
          break
        case 'Escape':
          setSelectedIndex(null)
          setShowShortcuts(false)
          break
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [
    togglePlay,
    seek,
    addKeyframe,
    addSplitMarker,
    deleteKeyframe,
    undo,
    redo,
    selectedIndex,
    keyframes,
    currentTime,
    duration,
  ])

  /* ───────── timeline touch helpers ───────── */
  const seekFromPointer = useCallback(
    (clientX: number) => {
      const rect = timelineRef.current?.getBoundingClientRect()
      if (!rect) return
      const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      seek(pct * duration)
    },
    [seek, duration]
  )

  /* ───────── derived values ───────── */
  const userKeyframeCount = keyframes.filter(
    (kf) => kf.source === 'user'
  ).length
  const aiKeyframeCount = keyframes.length - userKeyframeCount

  const selectedKeyframe =
    selectedIndex !== null ? keyframes[selectedIndex] : null

  // Nearest keyframes for navigation
  const nearestKeyframes = useMemo(() => {
    if (keyframes.length === 0) return { prev: null, next: null }
    const prevKf = [...keyframes]
      .reverse()
      .find((kf) => kf.time < currentTime - 0.05)
    const nextKf = keyframes.find((kf) => kf.time > currentTime + 0.05)
    return { prev: prevKf ?? null, next: nextKf ?? null }
  }, [keyframes, currentTime])

  /* ═══════════════════════════════════════════════════════════ */
  /*  RENDER — ALWAYS THE EDITOR (no separate empty state)      */
  /* ═══════════════════════════════════════════════════════════ */

  return (
    <div
      className="flex h-[100dvh] flex-col overflow-hidden select-none"
      style={{
        background: 'var(--editor-bg, #060b08)',
        touchAction: 'manipulation',
      }}
      onDragOver={(e) => {
        e.preventDefault()
        setIsDragOver(true)
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      {/* Hidden file inputs */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) validateAndImportVideo(f)
        }}
      />
      <input
        ref={jsonInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleImportKeyframes(f)
        }}
      />
      <input
        ref={outroInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) handleOutroFile(f)
        }}
      />

      {/* ── TOP BAR ── */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{
          background: 'var(--editor-bar, #0a100d)',
          borderBottom:
            '1px solid var(--editor-border, rgba(185,186,163,0.08))',
          fontSize: '12px',
        }}
      >
        <div className="flex items-center gap-3">
          {fromAcademy && (
            <button
              onClick={() => window.history.back()}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:text-[var(--timberwolf)] transition-colors"
              style={{ fontSize: '11px' }}
            >
              <ChevronLeft size={12} />
              Content
            </button>
          )}
          <span className="truncate max-w-[200px] opacity-40">
            {videoFilename || 'No video loaded'}
          </span>
          {/* Detect Ball button — always visible when video is loaded */}
          {videoUrl && !processing && (
            <button
              onClick={handleDetectBall}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 min-h-[36px] text-emerald-400 transition-colors hover:bg-emerald-400/10"
              style={{
                border: '1px solid rgba(16,185,129,0.2)',
                fontSize: '11px',
              }}
            >
              <Sparkles size={12} />
              {keyframes.length > 0 ? 'Re-detect' : 'Detect Ball'}
            </button>
          )}
          {processing && (
            <div
              className="flex items-center gap-1.5 text-emerald-400"
              style={{ fontSize: '11px' }}
            >
              <Loader2 size={12} className="animate-spin" />
              {processingStatus}
            </div>
          )}
          {keyframes.length > 0 && !processing && (
            <div className="flex items-center gap-2">
              <span
                className="rounded px-1.5 py-0.5 text-emerald-400"
                style={{
                  background: 'rgba(16,185,129,0.1)',
                  fontSize: '11px',
                }}
              >
                {aiKeyframeCount} AI
              </span>
              {userKeyframeCount > 0 && (
                <span
                  className="rounded px-1.5 py-0.5 text-amber-400"
                  style={{
                    background: 'rgba(245,158,11,0.1)',
                    fontSize: '11px',
                  }}
                >
                  {userKeyframeCount} manual
                </span>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* Undo/Redo */}
          <button
            onClick={undo}
            disabled={history.length === 0}
            className="rounded p-2 min-h-[36px] min-w-[36px] flex items-center justify-center transition-colors hover:bg-white/5 disabled:opacity-20"
            title="Undo (⌘Z)"
          >
            <Undo2 size={14} />
          </button>
          <button
            onClick={redo}
            disabled={future.length === 0}
            className="rounded p-2 min-h-[36px] min-w-[36px] flex items-center justify-center transition-colors hover:bg-white/5 disabled:opacity-20"
            title="Redo (⌘⇧Z)"
          >
            <Redo2 size={14} />
          </button>

          <div
            className="mx-1 h-4 w-px"
            style={{
              background: 'var(--editor-border, rgba(185,186,163,0.1))',
            }}
          />

          {/* Import */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="rounded p-2 min-h-[36px] min-w-[36px] flex items-center justify-center transition-colors hover:bg-white/5"
            title="Import video"
          >
            <Upload size={14} />
          </button>
          <button
            onClick={() => jsonInputRef.current?.click()}
            className="hidden sm:flex rounded p-2 min-h-[36px] min-w-[36px] items-center justify-center transition-colors hover:bg-white/5"
            title="Import keyframes JSON"
          >
            <FileJson size={14} />
          </button>

          <div
            className="mx-1 h-4 w-px hidden sm:block"
            style={{
              background: 'var(--editor-border, rgba(185,186,163,0.1))',
            }}
          />

          {/* Outro */}
          {outroFile ? (
            <div
              className="flex items-center gap-1.5 rounded px-1.5 py-1 min-h-[36px]"
              style={{ border: '1px solid rgba(185,186,163,0.1)' }}
            >
              {outroThumb && (
                <img
                  src={outroThumb}
                  alt=""
                  className="h-6 w-auto rounded"
                  style={{ aspectRatio: '16/9', objectFit: 'cover' }}
                />
              )}
              <span className="text-[10px] opacity-50 max-w-[60px] truncate hidden sm:inline">
                {outroFile.name}
              </span>
              <button
                onClick={() => {
                  setOutroFile(null)
                  if (outroThumb) {
                    URL.revokeObjectURL(outroThumb)
                    setOutroThumb(null)
                  }
                }}
                className="rounded p-0.5 hover:bg-white/10 transition-colors"
                title="Remove outro"
              >
                <X size={10} className="opacity-40" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => outroInputRef.current?.click()}
              className="hidden sm:flex items-center gap-1 rounded px-2 py-2 min-h-[36px] text-xs transition-colors hover:bg-white/5 opacity-40 hover:opacity-70"
              title="Add outro video"
            >
              <Plus size={11} />
              <span>Outro</span>
            </button>
          )}

          {/* Save (only when recording-linked and feature gate allows it) */}
          {canPersist && (
            <button
              onClick={handleSave}
              disabled={saving || keyframes.length === 0}
              aria-busy={saving}
              aria-label={
                saving
                  ? 'Saving keyframes'
                  : saveError
                    ? `Save failed: ${saveError}`
                    : lastSavedAt
                      ? `Saved ${savedAgo}`
                      : 'Save keyframes'
              }
              className="flex items-center gap-1.5 rounded px-2 py-2 min-h-[36px] transition-colors hover:bg-white/5 disabled:opacity-30"
              title={
                saveError
                  ? `Save failed: ${saveError}`
                  : lastSavedAt
                    ? `Saved ${savedAgo}`
                    : 'Save keyframes'
              }
            >
              {saving ? (
                <Loader2 size={13} className="animate-spin" />
              ) : saveError ? (
                <AlertTriangle size={13} className="text-red-400" />
              ) : lastSavedAt ? (
                <Check size={13} className="text-emerald-400" />
              ) : (
                <Save size={13} />
              )}
              <span className="hidden sm:inline">
                {saving
                  ? 'Saving…'
                  : lastSavedAt
                    ? 'Saved'
                    : 'Save'}
              </span>
            </button>
          )}

          {/* Export */}
          <button
            onClick={handleExport}
            disabled={keyframes.length === 0}
            className="flex items-center gap-1.5 rounded px-2 py-2 min-h-[36px] transition-colors hover:bg-white/5 disabled:opacity-30"
            title="Export keyframes"
          >
            <Download size={13} />
            <span className="hidden sm:inline">Export</span>
          </button>

          {/* Keyboard shortcuts — hidden on mobile */}
          <button
            onClick={() => setShowShortcuts(!showShortcuts)}
            className="hidden sm:flex rounded p-2 min-h-[36px] min-w-[36px] items-center justify-center transition-colors hover:bg-white/5"
            title="Keyboard shortcuts"
          >
            <Keyboard size={14} />
          </button>
        </div>
      </div>

      {/* ── PORTRAIT-CROP KILL SWITCH BANNER ── */}
      <AnimatePresence>
        {portraitCropEnabled === false && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex items-center gap-2 px-3 py-2 text-xs overflow-hidden border-l-2"
            style={{
              background: 'rgba(245,158,11,0.08)',
              color: '#f59e0b',
              borderLeftColor: 'rgba(245,158,11,0.6)',
              borderBottom:
                '1px solid var(--editor-border, rgba(185,186,163,0.08))',
            }}
          >
            <AlertTriangle size={12} className="flex-shrink-0" />
            <span>
              Assisted editor paused. Local edits won&apos;t sync — export to
              keep your work.
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── ERROR MESSAGE ── */}
      <AnimatePresence>
        {errorMessage && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex items-center justify-between px-3 py-2 text-xs text-red-400 overflow-hidden"
            style={{
              background: 'rgba(239,68,68,0.08)',
              borderBottom:
                '1px solid var(--editor-border, rgba(185,186,163,0.08))',
            }}
          >
            <span>{errorMessage}</span>
            <button
              onClick={() => setErrorMessage('')}
              className="p-1 hover:bg-white/5 rounded"
            >
              <X size={12} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── VIDEO PREVIEW AREA ── */}
      <div className="relative flex flex-1 items-center justify-center gap-3 overflow-hidden p-3">
        {/* Drag overlay */}
        <AnimatePresence>
          {isDragOver && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-30 flex items-center justify-center"
              style={{
                background: 'rgba(10,16,13,0.9)',
                border: '2px dashed rgba(16,185,129,0.4)',
                margin: '12px',
                borderRadius: '12px',
              }}
            >
              <div className="text-center">
                <Upload size={32} className="mx-auto mb-3 text-emerald-400" />
                <p className="text-sm opacity-60">
                  Drop video or keyframes JSON
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {!videoUrl ? (
          /* ── UPLOAD ZONE (integrated into editor) ── */
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col items-center text-center max-w-md"
          >
            <div
              className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl"
              style={{
                background:
                  'linear-gradient(135deg, rgba(16,185,129,0.12), rgba(16,185,129,0.06))',
              }}
            >
              <Upload size={24} className="text-emerald-400" />
            </div>

            <p className="mb-6 text-sm leading-relaxed opacity-40">
              Drop a panoramic recording here or click to upload.
              <br />
              AI will detect the ball and generate a portrait crop.
            </p>

            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.98 }}
              onClick={() => fileInputRef.current?.click()}
              className="group mb-3 flex items-center gap-3 rounded-xl px-7 py-3 text-sm font-medium transition-all"
              style={{
                background: 'linear-gradient(135deg, #10b981, #059669)',
                color: '#0a100d',
              }}
            >
              <Upload size={16} />
              Upload Video
            </motion.button>

            <button
              onClick={() => jsonInputRef.current?.click()}
              className="flex items-center gap-2 text-xs opacity-40 transition-opacity hover:opacity-60"
            >
              <FileJson size={14} />
              Import keyframes JSON
            </button>
          </motion.div>
        ) : (
          <>
            {/* View mode toggle */}
            <button
              onClick={() =>
                setPreviewMode((m) => (m === 'split' ? 'portrait' : 'split'))
              }
              className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-lg px-2.5 py-2 min-h-[36px] text-xs transition-colors hover:bg-white/10"
              style={{
                background: 'rgba(10,16,13,0.8)',
                border: '1px solid var(--editor-border, rgba(185,186,163,0.1))',
              }}
              title="Toggle view (P)"
            >
              {previewMode === 'split' ? (
                <Minimize2 size={12} />
              ) : (
                <Maximize2 size={12} />
              )}
              <span className="hidden sm:inline">
                {previewMode === 'split' ? 'Portrait only' : 'Split view'}
              </span>
            </button>

            {previewMode === 'split' ? (
              /* ── SPLIT VIEW: Source + Portrait ── */
              <div className="flex h-full w-full items-center justify-center gap-3">
                {/* Source video with crop overlay */}
                <div className="relative flex-1 flex items-center justify-center h-full">
                  <div
                    className="relative"
                    style={{
                      maxHeight: '100%',
                      aspectRatio: '16/9',
                    }}
                  >
                    <video
                      ref={videoRef}
                      src={videoUrl}
                      className="h-full w-full rounded-lg object-contain"
                      style={{ maxHeight: 'calc(100dvh - 220px)' }}
                      preload="auto"
                      playsInline
                      muted
                      onClick={togglePlay}
                    />
                    {/* First-frame overlay — hides once user plays */}
                    {posterUrl && !isPlaying && currentTime < 0.1 && (
                      <img
                        src={posterUrl}
                        alt=""
                        className="absolute inset-0 h-full w-full rounded-lg object-contain pointer-events-none"
                      />
                    )}
                    {/* Crop overlay — darkened areas outside crop */}
                    <div className="pointer-events-none absolute inset-0 rounded-lg overflow-hidden">
                      {/* Left dark */}
                      <div
                        className="absolute inset-y-0 left-0"
                        style={{
                          width: `${cropPercent * (1 - CROP_RATIO) * 100}%`,
                          background: 'rgba(0,0,0,0.6)',
                        }}
                      />
                      {/* Right dark */}
                      <div
                        className="absolute inset-y-0 right-0"
                        style={{
                          width: `${(1 - cropPercent) * (1 - CROP_RATIO) * 100}%`,
                          background: 'rgba(0,0,0,0.6)',
                        }}
                      />
                      {/* Crop border */}
                      <div
                        className="absolute inset-y-0"
                        style={{
                          left: `${cropPercent * (1 - CROP_RATIO) * 100}%`,
                          width: `${CROP_RATIO * 100}%`,
                          border: '1px solid rgba(16,185,129,0.4)',
                          boxShadow: '0 0 0 1px rgba(16,185,129,0.1)',
                        }}
                      >
                        {/* Drag affordance — grip indicators */}
                        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 hover:opacity-40 transition-opacity pointer-events-none">
                          <GripVertical
                            size={20}
                            className="text-emerald-400"
                          />
                        </div>
                      </div>
                    </div>
                    {/* Drag handle for crop position */}
                    <CropDragHandle
                      videoEl={videoRef.current}
                      cropX={effectiveCropX}
                      onDrag={handleCropDrag}
                      onDragEnd={handleDragEnd}
                    />
                  </div>
                </div>

                {/* Portrait preview — hidden on mobile (use portrait-only mode instead) */}
                <div
                  className="hidden md:flex items-center justify-center h-full"
                  style={{ width: '200px', flexShrink: 0 }}
                >
                  <PortraitPreview
                    videoUrl={videoUrl}
                    currentTime={currentTime}
                    cropX={effectiveCropX}
                    isPlaying={isPlaying}
                  />
                </div>
              </div>
            ) : (
              /* ── PORTRAIT ONLY VIEW ── */
              <div className="flex h-full items-center justify-center">
                <div
                  className="relative"
                  style={{
                    height: '100%',
                    maxHeight: 'calc(100dvh - 220px)',
                    aspectRatio: `${9}/${16}`,
                  }}
                >
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    className="h-full w-full rounded-lg"
                    style={{
                      objectFit: 'cover',
                      objectPosition: `${(effectiveCropX / (SOURCE_WIDTH - CROP_WIDTH)) * 100}% center`,
                    }}
                    preload="auto"
                    playsInline
                    muted
                    onClick={togglePlay}
                  />
                  {posterUrl && !isPlaying && currentTime < 0.1 && (
                    <img
                      src={posterUrl}
                      alt=""
                      className="absolute inset-0 h-full w-full rounded-lg pointer-events-none"
                      style={{
                        objectFit: 'cover',
                        objectPosition: `${(effectiveCropX / (SOURCE_WIDTH - CROP_WIDTH)) * 100}% center`,
                      }}
                    />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── TIMELINE + CONTROLS ── */}
      {duration > 0 && (
        <div
          style={{
            background: 'var(--editor-bar, #0a100d)',
            borderTop: '1px solid var(--editor-border, rgba(185,186,163,0.08))',
          }}
        >
          {/* Playback controls */}
          <div className="flex items-center justify-between px-3 py-2">
            {/* Left: time display */}
            <div
              className="flex items-center gap-2 tabular-nums"
              style={{
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: '13px',
              }}
            >
              <span className="text-emerald-400">
                {formatTime(currentTime)}
              </span>
              <span className="opacity-20">/</span>
              <span className="opacity-40">
                {trimStart > 0 || trimEnd > 0
                  ? formatTime((trimEnd || duration) - trimStart)
                  : formatTime(duration)}
              </span>
            </div>

            {/* Center: transport controls */}
            <div className="flex items-center gap-1">
              <button
                onClick={() =>
                  nearestKeyframes.prev && seek(nearestKeyframes.prev.time)
                }
                disabled={!nearestKeyframes.prev}
                className="rounded p-2 min-h-[40px] min-w-[40px] flex items-center justify-center transition-colors hover:bg-white/5 disabled:opacity-20"
                title="Previous keyframe"
              >
                <SkipBack size={14} />
              </button>
              <button
                onClick={stepBackward}
                className="rounded p-2 min-h-[40px] min-w-[40px] flex items-center justify-center transition-colors hover:bg-white/5"
                title="Step back (←)"
              >
                <ChevronLeft size={16} />
              </button>
              <button
                onClick={togglePlay}
                className="mx-1 flex h-10 w-10 items-center justify-center rounded-full transition-colors hover:bg-white/10"
                style={{ background: 'rgba(16,185,129,0.15)' }}
                title="Play/Pause (Space)"
              >
                {isPlaying ? (
                  <Pause size={14} className="text-emerald-400" />
                ) : (
                  <Play size={14} className="ml-0.5 text-emerald-400" />
                )}
              </button>
              <button
                onClick={stepForward}
                className="rounded p-2 min-h-[40px] min-w-[40px] flex items-center justify-center transition-colors hover:bg-white/5"
                title="Step forward (→)"
              >
                <ChevronRight size={16} />
              </button>
              <button
                onClick={() =>
                  nearestKeyframes.next && seek(nearestKeyframes.next.time)
                }
                disabled={!nearestKeyframes.next}
                className="rounded p-2 min-h-[40px] min-w-[40px] flex items-center justify-center transition-colors hover:bg-white/5 disabled:opacity-20"
                title="Next keyframe"
              >
                <SkipForward size={14} />
              </button>
            </div>

            {/* Right: trim + keyframe actions */}
            <div className="flex items-center gap-1 justify-end">
              {/* Trim controls */}
              {videoUrl && (
                <>
                  <button
                    onClick={trimDeleteLeft}
                    disabled={currentTime <= trimStart}
                    className="rounded p-2 min-h-[36px] min-w-[36px] flex items-center justify-center text-xs transition-colors hover:bg-white/5 disabled:opacity-20"
                    title="Delete left of playhead"
                  >
                    <span className="flex items-center gap-0.5">
                      <span className="text-[10px] opacity-60">◀</span>
                      <Scissors size={12} />
                    </span>
                  </button>
                  <button
                    onClick={addSplitMarker}
                    className="rounded p-2 min-h-[36px] min-w-[36px] flex items-center justify-center text-xs transition-colors hover:bg-white/5"
                    title="Split at playhead (S)"
                  >
                    <Scissors size={12} />
                  </button>
                  <button
                    onClick={trimDeleteRight}
                    disabled={currentTime >= (trimEnd || duration)}
                    className="rounded p-2 min-h-[36px] min-w-[36px] flex items-center justify-center text-xs transition-colors hover:bg-white/5 disabled:opacity-20"
                    title="Delete right of playhead"
                  >
                    <span className="flex items-center gap-0.5">
                      <Scissors size={12} />
                      <span className="text-[10px] opacity-60">▶</span>
                    </span>
                  </button>
                  {(trimStart > 0 || trimEnd > 0) && (
                    <button
                      onClick={trimReset}
                      className="rounded p-2 min-h-[36px] text-xs transition-colors hover:bg-white/5 opacity-40 hover:opacity-80"
                      title="Reset trim"
                    >
                      <RotateCcw size={10} />
                    </button>
                  )}
                  <div className="w-px h-4 bg-white/10 mx-0.5" />
                </>
              )}
              <button
                onClick={addKeyframe}
                className="flex items-center gap-1 rounded px-2 py-2 min-h-[36px] text-xs transition-colors hover:bg-white/5"
                title="Add keyframe (K)"
              >
                <Plus size={12} />
                <span className="hidden sm:inline">Keyframe</span>
              </button>
              {keyframes.length > 5 && (
                <button
                  onClick={simplifyKeyframes}
                  className="hidden sm:flex items-center gap-1 rounded px-2 py-2 min-h-[36px] text-xs transition-colors hover:bg-white/5"
                  title="Simplify keyframes"
                >
                  <Sparkles size={12} />
                  <span className="hidden sm:inline">Simplify</span>
                </button>
              )}
              {selectedIndex !== null && (
                <>
                  {selectedKeyframe?.source === 'user' && (
                    <button
                      onClick={() => resetKeyframe(selectedIndex)}
                      className="rounded p-2 min-h-[36px] min-w-[36px] flex items-center justify-center text-xs transition-colors hover:bg-white/5"
                      title="Reset to AI value"
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                  <button
                    onClick={() => deleteKeyframe(selectedIndex)}
                    className="rounded p-2 min-h-[36px] min-w-[36px] flex items-center justify-center text-xs text-red-400 transition-colors hover:bg-red-400/10"
                    title="Delete keyframe (⌫)"
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Timeline track */}
          <div
            ref={timelineRef}
            className="group relative mx-3 mb-3 h-14 cursor-crosshair rounded-lg select-none"
            style={{
              background: '#0d1410',
              touchAction: 'none',
            }}
            onMouseDown={(e) => seekFromPointer(e.clientX)}
            onMouseMove={(e) => {
              if (e.buttons !== 1) return
              seekFromPointer(e.clientX)
            }}
            onTouchStart={(e) => {
              e.preventDefault()
              seekFromPointer(e.touches[0].clientX)
            }}
            onTouchMove={(e) => {
              e.preventDefault()
              seekFromPointer(e.touches[0].clientX)
            }}
          >
            {/* Trim region overlays */}
            {trimStart > 0 && duration > 0 && (
              <div
                className="absolute inset-y-0 left-0 z-20 rounded-l-lg pointer-events-none"
                style={{
                  width: `${(trimStart / duration) * 100}%`,
                  background: 'rgba(0,0,0,0.7)',
                  borderRight: '2px solid rgba(239,68,68,0.5)',
                }}
              />
            )}
            {trimEnd > 0 && duration > 0 && (
              <div
                className="absolute inset-y-0 right-0 z-20 rounded-r-lg pointer-events-none"
                style={{
                  width: `${((duration - trimEnd) / duration) * 100}%`,
                  background: 'rgba(0,0,0,0.7)',
                  borderLeft: '2px solid rgba(239,68,68,0.5)',
                }}
              />
            )}

            {/* Crop position graph (mini waveform) */}
            <CropGraph
              keyframes={keyframes}
              duration={duration}
              splits={sceneChanges}
            />

            {/* Scene change markers */}
            {sceneChanges.map((sc, i) => (
              <div
                key={`sc-${i}`}
                className="absolute top-0 h-full"
                style={{
                  left: `${(sc / duration) * 100}%`,
                  width: '1px',
                  background: 'rgba(239,68,68,0.3)',
                }}
              />
            ))}

            {/* Keyframe dots — positioned on the graph line */}
            {keyframes.map((kf, i) => {
              const maxX = SOURCE_WIDTH - CROP_WIDTH
              const yPct = 100 - (kf.x / maxX) * 100
              return (
                <button
                  key={`kf-${i}`}
                  className="absolute z-10 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center"
                  style={{
                    left: `${(kf.time / duration) * 100}%`,
                    top: `${yPct}%`,
                    width: '28px',
                    height: '28px',
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setSelectedIndex(i)
                    seek(kf.time)
                  }}
                  title={`${kf.source} @ ${formatTime(kf.time)}`}
                >
                  <div
                    style={{
                      width: selectedIndex === i ? '10px' : '6px',
                      height: selectedIndex === i ? '10px' : '6px',
                      borderRadius: '50%',
                      background: KEYFRAME_COLORS[kf.source],
                      boxShadow:
                        selectedIndex === i
                          ? `0 0 8px ${KEYFRAME_COLORS[kf.source]}`
                          : 'none',
                      transition: 'all 0.15s ease',
                    }}
                  />
                </button>
              )
            })}

            {/* Playhead */}
            <div
              className="absolute top-0 z-20 h-full pointer-events-none"
              style={{
                left: `${(currentTime / duration) * 100}%`,
                transform: 'translateX(-50%)',
              }}
            >
              <div className="mx-auto h-full w-px bg-white/80" />
              <div
                className="absolute -top-1 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-sm"
                style={{ background: 'rgba(255,255,255,0.9)' }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ── KEYBOARD SHORTCUTS OVERLAY ── */}
      <AnimatePresence>
        {showShortcuts && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{
              background: 'rgba(0,0,0,0.7)',
              backdropFilter: 'blur(4px)',
            }}
            onClick={() => setShowShortcuts(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-sm rounded-xl p-6"
              style={{
                background: '#0d1410',
                border: '1px solid var(--editor-border, rgba(185,186,163,0.1))',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-sm font-medium">Keyboard Shortcuts</h3>
                <button
                  onClick={() => setShowShortcuts(false)}
                  className="opacity-40 hover:opacity-100 p-1"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="space-y-2 text-xs">
                {[
                  ['Space', 'Play / Pause'],
                  ['← / →', 'Step 0.2s'],
                  ['⇧← / ⇧→', 'Step 1s'],
                  ['K', 'Add keyframe'],
                  ['⌫', 'Delete selected keyframe'],
                  ['⌘Z / ⌘⇧Z', 'Undo / Redo'],
                  ['P', 'Toggle preview mode'],
                  ['Esc', 'Deselect'],
                ].map(([key, desc]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between py-1"
                  >
                    <span className="opacity-50">{desc}</span>
                    <kbd
                      className="rounded px-2 py-0.5"
                      style={{
                        background: 'rgba(185,186,163,0.08)',
                        fontSize: '11px',
                      }}
                    >
                      {key}
                    </kbd>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── SELECTED KEYFRAME INFO BAR ── */}
      <AnimatePresence>
        {selectedKeyframe && (
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 10, opacity: 0 }}
            className="absolute bottom-[150px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-lg px-3 py-2 text-xs"
            style={{
              background: 'rgba(10,16,13,0.9)',
              border: '1px solid var(--editor-border, rgba(185,186,163,0.1))',
              backdropFilter: 'blur(8px)',
            }}
          >
            <div
              className="h-2 w-2 rounded-full"
              style={{
                background: KEYFRAME_COLORS[selectedKeyframe.source],
              }}
            />
            <span className="opacity-60">
              {selectedKeyframe.source.replace('ai_', 'AI ')}
            </span>
            <span
              className="tabular-nums"
              style={{ fontFamily: 'var(--font-mono, monospace)' }}
            >
              {formatTime(selectedKeyframe.time)}
            </span>
            <span className="opacity-40">x: {selectedKeyframe.x}px</span>
            <span className="opacity-40">
              {Math.round(selectedKeyframe.confidence * 100)}%
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════ */
/*  SUB-COMPONENTS                                                */
/* ═══════════════════════════════════════════════════════════════ */

/** Draggable crop handle overlaid on the source video — supports mouse + touch */
function CropDragHandle({
  videoEl,
  cropX,
  onDrag,
  onDragEnd,
}: {
  videoEl: HTMLVideoElement | null
  cropX: number
  onDrag: (x: number) => void
  onDragEnd: () => void
}) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      if (!videoEl) return

      const videoRect = videoEl.getBoundingClientRect()
      const startClientX = e.clientX
      const startCropX = cropX

      const onMove = (me: MouseEvent) => {
        const deltaPx = me.clientX - startClientX
        const deltaCrop = (deltaPx / videoRect.width) * SOURCE_WIDTH
        const maxCropX = SOURCE_WIDTH - CROP_WIDTH
        onDrag(
          Math.round(Math.max(0, Math.min(maxCropX, startCropX + deltaCrop)))
        )
      }
      const onUp = () => {
        onDragEnd()
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [videoEl, cropX, onDrag, onDragEnd]
  )

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.preventDefault()
      if (!videoEl) return

      const videoRect = videoEl.getBoundingClientRect()
      const startClientX = e.touches[0].clientX
      const startCropX = cropX

      const onMove = (te: TouchEvent) => {
        te.preventDefault()
        const deltaPx = te.touches[0].clientX - startClientX
        const deltaCrop = (deltaPx / videoRect.width) * SOURCE_WIDTH
        const maxCropX = SOURCE_WIDTH - CROP_WIDTH
        onDrag(
          Math.round(Math.max(0, Math.min(maxCropX, startCropX + deltaCrop)))
        )
      }
      const onEnd = () => {
        onDragEnd()
        window.removeEventListener('touchmove', onMove)
        window.removeEventListener('touchend', onEnd)
      }

      window.addEventListener('touchmove', onMove, { passive: false })
      window.addEventListener('touchend', onEnd)
    },
    [videoEl, cropX, onDrag, onDragEnd]
  )

  if (!videoEl) return null

  const pct = cropX / (SOURCE_WIDTH - CROP_WIDTH)
  const leftPct = pct * (1 - CROP_RATIO) * 100
  const widthPct = CROP_RATIO * 100

  return (
    <div
      className="absolute top-0 bottom-0 cursor-ew-resize"
      style={{
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        touchAction: 'none',
      }}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
    />
  )
}

/**
 * Portrait preview — CSS-only crop of the source video.
 * Uses overflow:hidden + negative margin to show only the 9:16 slice.
 */
function PortraitPreview({
  videoUrl,
  currentTime,
  cropX,
  isPlaying,
}: {
  videoUrl: string
  currentTime: number
  cropX: number
  isPlaying: boolean
}) {
  const pvRef = useRef<HTMLVideoElement>(null)

  // Ensure preview video renders a frame once loaded
  useEffect(() => {
    const pv = pvRef.current
    if (!pv) return
    const onMeta = () => {
      pv.currentTime = currentTime || 0.001
    }
    pv.addEventListener('loadedmetadata', onMeta)
    return () => pv.removeEventListener('loadedmetadata', onMeta)
    // Only run on mount/src change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoUrl])

  // Keep preview video time in sync — tighter threshold when paused
  useEffect(() => {
    const pv = pvRef.current
    if (!pv) return
    const threshold = isPlaying ? 0.15 : 0.05
    if (Math.abs(pv.currentTime - currentTime) > threshold) {
      pv.currentTime = currentTime
    }
  }, [currentTime, isPlaying])

  // Play/pause sync
  useEffect(() => {
    const pv = pvRef.current
    if (!pv) return
    if (isPlaying && pv.paused) pv.play().catch(() => {})
    else if (!isPlaying && !pv.paused) pv.pause()
  }, [isPlaying])

  const maxCropX = SOURCE_WIDTH - CROP_WIDTH
  const cropPct = maxCropX > 0 ? (cropX / maxCropX) * 100 : 50

  return (
    <div
      className="relative overflow-hidden rounded-lg"
      style={{
        width: '100%',
        aspectRatio: `${9}/${16}`,
        background: '#000',
        border: '1px solid var(--editor-border, rgba(185,186,163,0.08))',
      }}
    >
      <video
        ref={pvRef}
        src={videoUrl}
        className="absolute inset-0 h-full w-full"
        style={{
          objectFit: 'cover',
          objectPosition: `${cropPct}% center`,
        }}
        preload="auto"
        playsInline
        muted
      />
      <div
        className="absolute bottom-2 left-2 z-10 rounded px-1.5 py-0.5"
        style={{ background: 'rgba(0,0,0,0.6)', fontSize: '11px' }}
      >
        9:16
      </div>
    </div>
  )
}

/** Mini crop position graph rendered as SVG in the timeline */
function CropGraph({
  keyframes,
  duration,
  splits,
}: {
  keyframes: CropKeyframe[]
  duration: number
  splits: number[]
}) {
  if (keyframes.length < 2) return null

  const maxX = SOURCE_WIDTH - CROP_WIDTH

  // Split keyframes into segments separated by split markers
  const segments: CropKeyframe[][] = []
  let current: CropKeyframe[] = []
  for (const kf of keyframes) {
    // Check if there's a split between the last keyframe in current and this one
    if (current.length > 0) {
      const prev = current[current.length - 1]
      const hasSplit = splits.some((s) => s > prev.time && s < kf.time)
      if (hasSplit) {
        segments.push(current)
        current = []
      }
    }
    current.push(kf)
  }
  if (current.length > 0) segments.push(current)

  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="cropGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(16,185,129,0.15)" />
          <stop offset="100%" stopColor="rgba(16,185,129,0)" />
        </linearGradient>
      </defs>
      {segments.map((seg, si) => {
        if (seg.length < 2) return null
        const pts = seg.map((kf) => {
          const x = (kf.time / duration) * 100
          const y = 100 - (kf.x / maxX) * 100
          return `${x},${y}`
        })
        const firstX = (seg[0].time / duration) * 100
        const lastX = (seg[seg.length - 1].time / duration) * 100
        return (
          <g key={si}>
            <polygon
              points={`${pts.join(' ')} ${lastX},100 ${firstX},100`}
              fill="url(#cropGrad)"
            />
            <polyline
              points={pts.join(' ')}
              fill="none"
              stroke="rgba(16,185,129,0.3)"
              strokeWidth="0.5"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )
      })}
    </svg>
  )
}
