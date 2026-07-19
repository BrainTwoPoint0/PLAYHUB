'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import Hls from 'hls.js'
import { refreshDelayMs, isExpiryError } from '@/lib/video/signed-url-refresh'

// The HTML5 <video> + hls.js transport, extracted verbatim from VideoPlayer so
// BOTH the flat marketplace player and the unified WatchPlayer drive one master
// <video> through identical logic. Owns: the video/hls/container refs, all state
// mirrored off native video events, the chrome state (showControls / openMenu /
// auto-hide), keyboard shortcuts, progress emit, and every playback command.
// Returns everything the presentational PlayerControlBar + player shell need.

interface UseVideoTransportOptions {
  src: string
  initialTimeSeconds?: number
  onProgressUpdate?: (currentSeconds: number, durationSeconds: number) => void
  onSeek?: (timestampSeconds: number) => void
  canEdit?: boolean
  onAddTag?: (
    timestampSeconds: number,
    videoEl: HTMLVideoElement | null
  ) => void
  // Signed-URL re-signing (opt-in). When `recordingId` is set, the hook fetches
  // a fresh signed URL before the current one expires (and reactively on an
  // expiry error) and swaps it in place, preserving playback position — so a
  // long session never 403-loops on a dead URL. `shareToken` is forwarded to
  // the re-sign endpoint for bearer (share-link) viewers. Omit both to disable.
  recordingId?: string
  shareToken?: string | null
}

export function useVideoTransport({
  src,
  initialTimeSeconds,
  onProgressUpdate,
  onSeek,
  canEdit = false,
  onAddTag,
  recordingId,
  shareToken,
}: UseVideoTransportOptions) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // The URL the <video> is actually loading. Starts at the server-signed `src`
  // and is replaced in place by re-signing (which must NOT go through the `src`
  // prop, or the resume-seek would fire against the OLD position). A prop change
  // to `src` (a genuinely new video) resyncs it below.
  const [currentSrc, setCurrentSrc] = useState(src)
  // Set just before a re-sign swap; the loadedmetadata handler restores from it
  // (live position/paused/rate) instead of the first-load resume seek.
  const resumeAfterSwapRef = useRef<{
    time: number
    wasPaused: boolean
    rate: number
  } | null>(null)
  const resigningRef = useRef(false)
  const lastResignAtRef = useRef(0)
  // Declared here (before the HLS setup effect) so that effect's error handler
  // can invoke the latest resign. Populated by the sync effect below; a no-op
  // until then (errors can't fire before the video loads, post-commit).
  const resignRef = useRef<() => void>(() => {})
  // Held in a ref so the keyboard handler doesn't re-attach every render
  // when toggleFullscreen's identity changes.
  const toggleFullscreenRef = useRef<(() => void) | null>(null)

  const [isPlaying, setIsPlaying] = useState(false)
  const [hasPlayedOnce, setHasPlayedOnce] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(1)
  const [isMuted, setIsMuted] = useState(false)
  const [showControls, setShowControls] = useState(true)
  const [isLoading, setIsLoading] = useState(true)
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

  // A genuinely new video (prop change) resets the internal src; re-signing
  // updates currentSrc directly and never touches the prop. Drop any pending
  // swap-restore — a new video must never resume the OLD video's position.
  useEffect(() => {
    resumeAfterSwapRef.current = null
    setCurrentSrc(src)
  }, [src])

  // HLS setup — keyed on currentSrc so a re-sign swap re-runs it cleanly.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !currentSrc) return

    if (hlsRef.current) {
      hlsRef.current.destroy()
      hlsRef.current = null
    }

    // Clear stale quality state — the new manifest will repopulate via
    // MANIFEST_PARSED. Without this the menu shows the old levels until
    // the new parse completes.
    setQualityLevels([])
    setCurrentLevel(-1)

    const isHls = currentSrc.includes('.m3u8')

    if (isHls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: true })
      hls.loadSource(currentSrc)
      hls.attachMedia(video)
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            // An expired signed URL 403s here and never bubbles to
            // `video.error`, so hls.js would retry the DEAD url forever. On a
            // 403 with re-signing enabled, re-sign + swap instead of startLoad.
            const status = (data.response as { code?: number } | undefined)
              ?.code
            if (status === 403 && recordingId) resignRef.current()
            else hls.startLoad()
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR)
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
      video.src = currentSrc
    } else {
      video.src = currentSrc
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy()
        hlsRef.current = null
      }
    }
    // recordingId is a stable page-level prop (only gates the HLS 403 re-sign);
    // included to satisfy exhaustive-deps — it never changes mid-session, so it
    // never forces a spurious reload.
  }, [currentSrc, recordingId])

  // Re-sign the playback URL and swap it in place, preserving the live
  // position/paused/rate. No-op unless `recordingId` is set. Rate-limited and
  // concurrency-guarded so a persistently-failing URL can't tight-loop.
  const resignAndSwap = useCallback(async () => {
    const video = videoRef.current
    if (!video || !recordingId || resigningRef.current) return
    const now = Date.now()
    if (now - lastResignAtRef.current < 10_000) return
    resigningRef.current = true
    lastResignAtRef.current = now
    try {
      // Token in a header (not the query) so this repeatedly-polled endpoint
      // doesn't leak a non-expiring token into access logs.
      const res = await fetch(
        `/api/recordings/${recordingId}/playback-url`,
        {
          cache: 'no-store',
          headers: shareToken ? { 'x-share-token': shareToken } : undefined,
        }
      )
      if (!res.ok) throw new Error(`resign HTTP ${res.status}`)
      const { url } = (await res.json()) as { url?: string }
      if (!url) throw new Error('resign: no url')
      // Restore the live position on the next loadedmetadata (see below).
      resumeAfterSwapRef.current = {
        time: video.currentTime,
        wasPaused: video.paused,
        rate: video.playbackRate,
      }
      setCurrentSrc(url) // re-runs the setup effect → reloads → restores
    } catch (err) {
      // Leave any existing error state; the proactive timer fired once and the
      // reactive path is rate-limited, so this fails safe (no loop).
      console.error('[useVideoTransport] re-sign failed:', err)
    } finally {
      resigningRef.current = false
    }
  }, [recordingId, shareToken])

  // Keep the ref (declared above the setup effect) pointed at the latest
  // resign, so the mount-once listener effect + the HLS handler always call it.
  useEffect(() => {
    resignRef.current = resignAndSwap
  }, [resignAndSwap])

  // Proactive refresh: re-arm whenever the loaded URL changes (initial + after
  // each swap). Fires at ~80% of the URL's remaining TTL. Disabled without a
  // recordingId or when the URL carries no parseable expiry (reactive covers it).
  useEffect(() => {
    if (!recordingId) return
    const delay = refreshDelayMs(currentSrc, Date.now())
    if (delay === null) return
    const id = setTimeout(() => {
      resignRef.current()
    }, delay)
    return () => clearTimeout(id)
  }, [currentSrc, recordingId])

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
      // Re-sign swap: restore the LIVE position/rate and resume if it was
      // playing. Takes precedence over the first-load resume seek so a mid-watch
      // URL refresh is invisible.
      const swap = resumeAfterSwapRef.current
      if (swap) {
        resumeAfterSwapRef.current = null
        video.currentTime = Math.min(
          swap.time,
          Math.max(0, video.duration - 0.1)
        )
        video.playbackRate = swap.rate
        if (!swap.wasPaused) video.play().catch(() => {})
        return
      }
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
    // A dead signed URL surfaces as a network/src MediaError. Re-sign + swap
    // (no-op without a recordingId). Not an expiry error → left unhandled.
    const onError = () => {
      if (isExpiryError(video.error)) resignRef.current()
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
    video.addEventListener('error', onError)
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
      video.removeEventListener('error', onError)
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
          t.isContentEditable ||
          // The de-warp canvas host (role="application") owns arrow/zoom/0 keys
          // for panning while it's focused — don't double-fire master seek/volume.
          t.closest?.('[role="application"]'))
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

  return {
    videoRef,
    hlsRef,
    containerRef,
    state: {
      isPlaying,
      hasPlayedOnce,
      currentTime,
      duration,
      volume,
      isMuted,
      showControls,
      isLoading,
      playbackRate,
      bufferedEnd,
      isPiP,
      pipSupported,
      qualityLevels,
      currentLevel,
      openMenu,
      progress,
    },
    setOpenMenu,
    setShowControls,
    handleMouseMove,
    commands: {
      togglePlayPause,
      seekTo,
      handleProgressClick,
      toggleMute,
      handleVolumeChange,
      skip,
      setRate,
      setQuality,
      togglePiP,
      stepFrame,
      toggleFullscreen,
    },
  }
}
