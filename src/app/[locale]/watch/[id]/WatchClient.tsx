'use client'

import { Link } from '@/i18n/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { useCallback, useEffect, useRef, useState } from 'react'
import { refreshDelayMs } from '@/lib/video/signed-url-refresh'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  Loader2,
  Plus,
  Lock,
  Share2,
  Sparkles,
  Tag as TagIcon,
  Trash2,
  X,
} from 'lucide-react'
import { ShareRecordingModal } from '@/components/ShareRecordingModal'
import ClutchPanel from './ClutchPanel'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
} from '@braintwopoint0/playback-commons/ui'
import {
  type MediaPack,
  type GraphicPackageOverlay,
} from '@/components/video/VideoPlayer'
import { FlatZoomPlayer } from '@/components/video/FlatZoomPlayer'
import { WatchPlayer } from '@/components/video/WatchPlayer'
import {
  EVENT_TYPE_COLORS,
  formatTimestamp,
  type EventType,
  type RecordingEvent,
} from '@/lib/recordings/event-types'
import { useEventTypeLabels } from '@/lib/recordings/use-event-labels'

// Frequency-weighted order for the quick-tag grid. Coaches reach for Goal /
// Shot / Save / Foul most; admin-only events (Kick Off / Half Time) sit
// further back. Stable order is what makes the digit-key shortcuts feel
// like muscle memory — re-ordering would invalidate everyone's reflexes.
const TAG_GRID_ORDER: EventType[] = [
  'goal',
  'shot',
  'save',
  'foul',
  'corner',
  'free_kick',
  'penalty',
  'yellow_card',
  'red_card',
  'kick_off',
  'half_time',
  'full_time',
  'substitution',
  'other',
]

// Keyboard shortcuts mapped to grid position (4 cols × 4 rows). Row 1 is the
// number row, rows 2-4 are home-row letters so a coach can stay on the
// keyboard without thinking about modifiers.
const TAG_SHORTCUT_KEYS: string[] = [
  '1',
  '2',
  '3',
  '4',
  'q',
  'w',
  'e',
  'r',
  'a',
  's',
  'd',
  'f',
  'z',
  'x',
]
const KEY_TO_TYPE: Record<string, EventType> = TAG_SHORTCUT_KEYS.reduce(
  (acc, key, idx) => {
    if (TAG_GRID_ORDER[idx]) acc[key] = TAG_GRID_ORDER[idx]
    return acc
  },
  {} as Record<string, EventType>
)

interface Recording {
  id: string
  title: string
  description: string | null
  matchDate: string
  homeTeam: string
  awayTeam: string
  venue: string | null
  pitchName: string | null
  competition: string | null
  durationSeconds: number | null
  shareToken: string | null
  thumbnailUrl: string | null
  isClutch?: boolean
  // Panorama recordings render in the pannable/zoomable PanoramaPlayer instead
  // of the standard VideoPlayer. Set when content_type === 'panorama'.
  isPanorama?: boolean
}

interface WatchClientProps {
  recording: Recording
  videoUrl: string | null
  events: RecordingEvent[]
  graphicPackage: GraphicPackageOverlay | null
  mediaPack: MediaPack | null
  from: string | null
  token: string | null
  canSave: boolean
  canSignInToSave: boolean
  canTag: boolean
  canPublish: boolean
  isAdmin: boolean
  currentUserId: string | null
  resumeSeconds: number
  // Public de-warp mesh base URL for panorama recordings (null otherwise). The
  // "Explore the pitch" flow confirms mesh + raw VP availability before mounting
  // the pannable VirtualPanoramaPlayer; otherwise the Auto production plays.
  meshBaseUrl?: string | null
  // Half-pitch focus pan window (radians), derived server-side from the
  // scene's active calibration. Narrows the de-warp pan limits only.
  panWindow?: { minRad: number; maxRad: number } | null
}

// Map fine-grained event types to coarse rail filters. Lets a coach narrow
// "what happened" without mentally translating yellow/red/foul into one
// filter pill — we do it for them.
type FilterGroup = 'all' | 'scoring' | 'cards' | 'phase' | 'other'
const FILTER_GROUP_FOR: Record<EventType, FilterGroup> = {
  goal: 'scoring',
  shot: 'scoring',
  save: 'scoring',
  penalty: 'scoring',
  corner: 'other',
  free_kick: 'other',
  foul: 'other',
  yellow_card: 'cards',
  red_card: 'cards',
  substitution: 'cards',
  kick_off: 'phase',
  half_time: 'phase',
  full_time: 'phase',
  other: 'other',
}
// Filter pill labels are translated at render via `watch.filters.<id>`.
const FILTER_GROUPS: FilterGroup[] = [
  'all',
  'scoring',
  'cards',
  'phase',
  'other',
]

// labelKey === null → the PLAYHUB brand name (not translated).
function backLink(from: string | null): {
  href: string
  labelKey: 'matches' | 'myRecordings' | 'venue' | null
} {
  if (from === 'matches') return { href: '/matches', labelKey: 'matches' }
  if (from === 'recordings')
    return { href: '/recordings', labelKey: 'myRecordings' }
  if (from?.startsWith('venue:'))
    return { href: `/venue/${from.slice(6)}`, labelKey: 'venue' }
  return { href: '/', labelKey: null }
}

export default function WatchClient({
  recording,
  videoUrl,
  events: initialEvents,
  graphicPackage,
  mediaPack,
  from,
  token,
  canSave,
  canSignInToSave,
  canTag,
  canPublish,
  isAdmin,
  currentUserId,
  resumeSeconds,
  meshBaseUrl,
  panWindow,
}: WatchClientProps) {
  const t = useTranslations('watch')
  const eventLabels = useEventTypeLabels()
  const tc = useTranslations('common')
  const format = useFormatter()
  const back = backLink(from)
  // Panorama player: on when the recording is flagged panorama, or when
  // ?view=panorama is present (a test override for footage not yet flagged).
  // Read from window (not useSearchParams) to avoid a Suspense boundary.
  const [forcePanorama, setForcePanorama] = useState(false)
  useEffect(() => {
    setForcePanorama(
      new URLSearchParams(window.location.search).get('view') === 'panorama'
    )
  }, [])
  const showPanorama = Boolean(recording.isPanorama) || forcePanorama
  const [events, setEvents] = useState<RecordingEvent[]>(initialEvents)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Crosslink state: hover a tag in the rail → that marker on the video
  // timeline pulses, and vice versa. Single source of truth, two surfaces.
  const [hoveredTagId, setHoveredTagId] = useState<string | null>(null)

  // Filter pills above the rail — narrows by event-type group.
  const [filterGroup, setFilterGroup] = useState<FilterGroup>('all')

  // Share modal toggle.
  const [shareOpen, setShareOpen] = useState(false)

  // De-warp free-look ("Explore the pitch"): the default surface is the Auto
  // production (FlatZoomPlayer on videoUrl). Clicking Explore asks the server for
  // the raw VP (POST /panorama-source — access-gated, may trigger a capture and
  // return pending); once ready we lazy-mount the pannable VirtualPanoramaPlayer
  // with the Auto production as its autoSrc. Available only when a mesh exists.
  const [panoramaSrc, setPanoramaSrc] = useState<string | null>(null)
  const [exploreState, setExploreState] = useState<
    'idle' | 'loading' | 'pending' | 'unavailable' | 'timeout' | 'error'
  >('idle')
  const explorePollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exploreDeadlineRef = useRef<number>(0)
  const explorePollsRef = useRef<number>(0)
  // One-shot retry timer for a failed raw-VP proactive re-sign; `used` bounds it
  // to a single retry per proactive cycle.
  const panoramaResignRetryRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null
    used: boolean
  }>({ timer: null, used: false })
  useEffect(
    () => () => {
      if (explorePollRef.current) clearTimeout(explorePollRef.current)
      if (panoramaResignRetryRef.current.timer)
        clearTimeout(panoramaResignRetryRef.current.timer)
    },
    []
  )

  // Stop polling before the server's 10-min stuck-window would re-trigger a
  // DUPLICATE multi-GB capture; surface a retryable 'timeout' instead.
  const scheduleExplorePoll = () => {
    if (Date.now() > exploreDeadlineRef.current) {
      setExploreState('timeout')
      return
    }
    explorePollsRef.current += 1
    const delay = explorePollsRef.current < 10 ? 6000 : 10000 // gentle backoff after ~1 min
    explorePollRef.current = setTimeout(requestPanorama, delay)
  }

  const requestPanorama = async (): Promise<void> => {
    if (Date.now() > exploreDeadlineRef.current) {
      setExploreState('timeout')
      return
    }
    let data: { status?: string; url?: string } = {}
    try {
      const res = await fetch(
        `/api/recordings/${recording.id}/panorama-source${token ? `?token=${encodeURIComponent(token)}` : ''}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }
      )
      // fetch doesn't throw on 4xx/5xx. 5xx is transient → retry; 4xx (403/404) →
      // not available to this viewer → stop (keeps the Auto production).
      if (!res.ok) {
        if (res.status >= 500) return scheduleExplorePoll()
        setExploreState('unavailable')
        return
      }
      data = await res.json().catch(() => ({}))
    } catch {
      // network blip → retry within the deadline
      return scheduleExplorePoll()
    }
    if (data.status === 'ready' && data.url) {
      // WatchPlayer flips to the de-warp surface once panoramaSrc is set (if the
      // user asked for it). We just publish the ready URL + clear the poll state.
      setPanoramaSrc(data.url)
      setExploreState('idle')
    } else if (data.status === 'pending') {
      setExploreState('pending')
      scheduleExplorePoll()
    } else {
      // 'unavailable' — not a panorama / no game / anonymous-can't-trigger.
      setExploreState('unavailable')
    }
  }

  const onExplore = () => {
    if (exploreState === 'loading' || exploreState === 'pending') return
    exploreDeadlineRef.current = Date.now() + 5 * 60_000
    explorePollsRef.current = 0
    setExploreState('loading')
    void requestPanorama()
  }

  // Raw-VP re-sign: the de-warp's signed URL expires like the master's, but the
  // capture poll stops at 'ready' and never refreshes it. Re-call panorama-source
  // (which re-signs on every hit) and publish the fresh URL — VirtualPanoramaPlayer
  // rebuilds its texture and the slave re-seeks to the master. Quiet on failure;
  // no deadline/state churn (unlike requestPanorama, which drives the capture).
  const resignPanorama = useCallback(async () => {
    let ok = false
    try {
      const res = await fetch(
        `/api/recordings/${recording.id}/panorama-source${token ? `?token=${encodeURIComponent(token)}` : ''}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          cache: 'no-store',
        }
      )
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          status?: string
          url?: string
        }
        if (data.status === 'ready' && data.url) {
          panoramaResignRetryRef.current.used = false // success → fresh budget
          setPanoramaSrc(data.url) // re-arms the proactive effect
          ok = true
        }
      }
    } catch {
      // fall through to the bounded retry below
    }
    // One bounded retry per cycle — a single blip shouldn't leave the de-warp to
    // 403 at expiry. After that the player's own error path is the fallback.
    if (!ok && !panoramaResignRetryRef.current.used) {
      panoramaResignRetryRef.current.used = true
      panoramaResignRetryRef.current.timer = setTimeout(() => {
        void resignPanorama()
      }, 30_000)
    }
  }, [recording.id, token])

  // Proactive: re-arm at ~80% of the current panorama URL's TTL. Re-runs each
  // time panoramaSrc changes (initial ready + each resign).
  useEffect(() => {
    if (!panoramaSrc) return
    const delay = refreshDelayMs(panoramaSrc, Date.now())
    if (delay === null) return
    const id = setTimeout(() => {
      void resignPanorama()
    }, delay)
    return () => clearTimeout(id)
  }, [panoramaSrc, resignPanorama])

  // View-progress persistence: skip duplicate writes when the user is
  // paused (player still pings every 5s). Use sendBeacon when the page is
  // hiding so the final flush survives navigation; otherwise plain fetch
  // with keepalive so the request still completes after a click-through.
  const lastReportedPositionRef = useRef<number>(-1)
  const persistProgress = (currentSeconds: number, durationSeconds: number) => {
    if (Math.abs(currentSeconds - lastReportedPositionRef.current) < 1) return
    lastReportedPositionRef.current = currentSeconds
    const url = `/api/recordings/${recording.id}/view-progress`
    const body = JSON.stringify({
      position_seconds: Math.floor(currentSeconds),
      total_seconds: Math.floor(durationSeconds),
    })
    // sendBeacon is the spec'd primitive for fire-and-forget on unload.
    // Use it when the document is in the process of going away — falls
    // back to fetch keepalive otherwise (better error visibility).
    if (
      typeof navigator !== 'undefined' &&
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden' &&
      typeof navigator.sendBeacon === 'function'
    ) {
      try {
        navigator.sendBeacon(
          url,
          new Blob([body], { type: 'application/json' })
        )
        return
      } catch {
        // fall through to fetch
      }
    }
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {})
  }

  // Quick-tag overlay state. Lives at the page level so it can be triggered
  // from the player chrome (VideoPlayer.onAddTag) AND the rail header.
  const [tagOverlay, setTagOverlay] = useState<{
    timestamp: number
    visibility: 'public' | 'private'
    posting: boolean
    pendingType: EventType | null
    error: string | null
  } | null>(null)
  const [tagSavedFlash, setTagSavedFlash] = useState<{
    eventType: EventType
    timestamp: number
  } | null>(null)
  const [keepOpenAfterSave, setKeepOpenAfterSave] = useState(false)

  // Refs that survive overlay close → reopen so the user's preferences
  // (last visibility choice, the originating "+" button to return focus to,
  // and the underlying <video> element used by "Keep open after saving" to
  // advance the pinned timestamp to the current playhead) persist.
  const lastVisibilityRef = useRef<'public' | 'private' | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const videoElRef = useRef<HTMLVideoElement | null>(null)
  const reduceMotion = useReducedMotion()

  // Track fullscreen target so the overlay portals INTO the fullscreen
  // element (rather than the page root). Without this, pressing the +
  // button in fullscreen renders the overlay outside the painted region
  // and the user has to exit fullscreen to see it.
  const [fullscreenEl, setFullscreenEl] = useState<Element | null>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
    const sync = () => {
      const doc = document as any
      setFullscreenEl(
        doc.fullscreenElement || doc.webkitFullscreenElement || null
      )
    }
    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])

  // Esc to close the overlay (works whether focus is in the modal or not).
  useEffect(() => {
    if (!tagOverlay) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeTagOverlay()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [tagOverlay])

  function openTagOverlay(
    timestamp: number,
    videoEl?: HTMLVideoElement | null
  ) {
    // Stash the underlying video element so "Keep open after saving" can
    // advance the pinned timestamp. We do NOT pause playback — the user can
    // pause via the player's own controls if they want.
    if (videoEl !== undefined) videoElRef.current = videoEl ?? null
    triggerRef.current = (document.activeElement as HTMLElement) || null
    setTagOverlay({
      timestamp,
      visibility:
        lastVisibilityRef.current ?? (canPublish ? 'public' : 'private'),
      posting: false,
      pendingType: null,
      error: null,
    })
  }

  function closeTagOverlay() {
    setTagOverlay(null)
    // Return focus to whatever opened the modal (the + button, usually).
    triggerRef.current?.focus?.()
  }

  async function postTag(eventType: EventType) {
    if (!tagOverlay || tagOverlay.posting) return
    // Remember the chosen visibility for the next session.
    lastVisibilityRef.current = tagOverlay.visibility
    setTagOverlay({
      ...tagOverlay,
      posting: true,
      pendingType: eventType,
      error: null,
    })
    try {
      const res = await fetch(`/api/recordings/${recording.id}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: eventType,
          timestamp_seconds: Math.floor(tagOverlay.timestamp),
          visibility: tagOverlay.visibility,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setTagOverlay({
          ...tagOverlay,
          posting: false,
          pendingType: null,
          error: data.error || t('tags.addFailed'),
        })
        return
      }
      setEvents((prev) =>
        [...prev, data.event].sort(
          (a, b) => a.timestamp_seconds - b.timestamp_seconds
        )
      )
      // "Save & continue" mode: keep the modal open, advance the pinned
      // timestamp to wherever the video is now, ready for the next tag.
      // Otherwise, close + flash the toast.
      if (keepOpenAfterSave) {
        const nextTs = videoElRef.current?.currentTime ?? tagOverlay.timestamp
        setTagOverlay({
          timestamp: nextTs,
          visibility: tagOverlay.visibility,
          posting: false,
          pendingType: null,
          error: null,
        })
      } else {
        setTagOverlay(null)
      }
      setTagSavedFlash({
        eventType,
        timestamp: Math.floor(tagOverlay.timestamp),
      })
      setTimeout(() => setTagSavedFlash(null), 1600)
      if (!keepOpenAfterSave) triggerRef.current?.focus?.()
    } catch {
      setTagOverlay({
        ...tagOverlay,
        posting: false,
        pendingType: null,
        error: t('tags.networkError'),
      })
    }
  }

  // Tag deletion uses a two-click confirm: first click stages the row in
  // "Delete?" mode for 3s, second click commits. Avoids a heavy modal for
  // a low-stakes destructive action while still preventing thumb-graze
  // deletes. ESC, blur, or timeout all dismiss the staged state.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const confirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function cancelDeleteConfirm() {
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current)
    setConfirmDeleteId(null)
  }

  function stageOrConfirmDelete(eventId: string) {
    if (confirmDeleteId === eventId) {
      cancelDeleteConfirm()
      void deleteTag(eventId)
      return
    }
    if (confirmTimeoutRef.current) clearTimeout(confirmTimeoutRef.current)
    setConfirmDeleteId(eventId)
    confirmTimeoutRef.current = setTimeout(() => {
      setConfirmDeleteId(null)
    }, 3000)
  }

  async function deleteTag(eventId: string) {
    const prev = events
    // Optimistic remove — rollback on failure.
    setEvents(prev.filter((e) => e.id !== eventId))
    try {
      const res = await fetch(
        `/api/recordings/${recording.id}/events/${eventId}`,
        { method: 'DELETE' }
      )
      if (!res.ok) setEvents(prev)
    } catch {
      setEvents(prev)
    }
  }

  // Keyboard shortcuts: 1-4 / qwer / asdf / zx fire the corresponding tile.
  // Active only while the modal is open and not posting.
  useEffect(() => {
    if (!tagOverlay) return
    const onKey = (e: KeyboardEvent) => {
      // Ignore when the user is typing in a real input
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const k = e.key.toLowerCase()
      const type = KEY_TO_TYPE[k]
      if (type && !tagOverlay.posting) {
        e.preventDefault()
        postTag(type)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [tagOverlay, keepOpenAfterSave])

  async function handleSave() {
    if (!token) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/recordings/${recording.id}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      if (res.ok) {
        setSaved(true)
      } else {
        const data = await res.json().catch(() => ({}))
        setSaveError(data.error || t('save.failed'))
      }
    } catch {
      setSaveError(t('save.failed'))
    } finally {
      setSaving(false)
    }
  }

  const signInUrl = `/auth/login?redirect=${encodeURIComponent(
    `/watch/${recording.id}${token ? `?token=${token}` : ''}`
  )}`

  // Format a duration in mm:ss / h:mm:ss for the match info card. Reuses the
  // event-types helper for visual consistency with the timeline timestamps.
  const durationLabel = recording.durationSeconds
    ? formatTimestamp(recording.durationSeconds)
    : null

  // Resume pill — only show on first render and only if we actually have a
  // resume position. Buyers who watched to the end last time get nothing.
  const resumeLabel = resumeSeconds > 0 ? formatTimestamp(resumeSeconds) : null

  // Filter the events for the rail. The TIMELINE shows all markers always —
  // filters are a UX affordance, not a data restriction.
  const visibleEvents =
    filterGroup === 'all'
      ? events
      : events.filter((e) => FILTER_GROUP_FOR[e.event_type] === filterGroup)

  // Per-group counts for the filter pill badges.
  const groupCounts = events.reduce<Record<FilterGroup, number>>(
    (acc, e) => {
      const g = FILTER_GROUP_FOR[e.event_type]
      acc[g] = (acc[g] || 0) + 1
      acc.all = (acc.all || 0) + 1
      return acc
    },
    { all: 0, scoring: 0, cards: 0, phase: 0, other: 0 }
  )

  return (
    <div className="mx-auto max-w-screen-xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Top bar: back link + share. Share lives here so it's discoverable
          on every watch surface (was previously buried in /recordings). */}
      <div className="mb-6 flex items-center justify-between gap-3">
        <Link
          href={back.href}
          className="text-muted-foreground hover:text-[var(--timberwolf)] inline-flex items-center text-sm transition-colors duration-300 gap-2"
        >
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
          {back.labelKey ? t(`back.${back.labelKey}`) : 'PLAYHUB'}
        </Link>
        {/* Only signed-in viewers with a real grant get a share affordance —
            anonymous bearer-link viewers don't have a share-token endpoint
            available to them. */}
        {currentUserId && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShareOpen(true)}
            className="h-8 px-3 text-xs border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/[0.16]"
          >
            <Share2 className="h-3.5 w-3.5 me-1.5" />
            {tc('share')}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Player + match info — span 2 columns on desktop. Player is sticky
            so it stays pinned as the user scrolls match info / description. */}
        <div className="lg:col-span-2 space-y-6">
          <div className="rounded-xl overflow-hidden border border-border bg-muted lg:sticky lg:top-6">
            {videoUrl ? (
              showPanorama ? (
                // Panorama-flagged footage: the raw panorama IS the default view
                // (no separate flat production), so keep the FlatZoom path.
                <FlatZoomPlayer
                  src={videoUrl}
                  posterUrl={recording.thumbnailUrl}
                  className="rounded-xl"
                />
              ) : (
                // Unified player: the flat production is the master clock + chrome;
                // the in-bar "Explore" toggle swaps to the WebGL de-warp SURFACE
                // without ever hiding the transport controls (never locked out).
                <WatchPlayer
                  src={videoUrl}
                  recordingId={recording.id}
                  shareToken={token}
                  events={events}
                  canEdit={canTag}
                  onAddTag={openTagOverlay}
                  mediaPack={mediaPack || undefined}
                  graphicPackage={graphicPackage || undefined}
                  posterUrl={recording.thumbnailUrl}
                  highlightedEventId={hoveredTagId}
                  onMarkerHover={setHoveredTagId}
                  initialTimeSeconds={resumeSeconds}
                  onProgressUpdate={currentUserId ? persistProgress : undefined}
                  className="rounded-xl"
                  meshBaseUrl={meshBaseUrl}
                  panWindow={panWindow}
                  panoramaSrc={panoramaSrc}
                  exploreState={exploreState}
                  onExplore={onExplore}
                />
              )
            ) : (
              <div className="aspect-video flex items-center justify-center text-muted-foreground text-sm">
                {t('videoUnavailable')}
              </div>
            )}
          </div>

          {/* Clutch AI extras (padel): stats, player labeling, rally clips.
              Renders nothing for non-clutch recordings. */}
          {recording.isClutch && (
            <ClutchPanel recordingId={recording.id} canLabel={canTag} />
          )}

          {/* Match info card — denser than before. Date / pitch / duration /
              competition all surfaced; description below. */}
          <Card className="bg-card border-border">
            <CardContent className="p-6 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h1 className="text-xl md:text-2xl font-semibold text-[var(--timberwolf)]">
                  {recording.homeTeam}{' '}
                  <span className="text-muted-foreground">{t('vs')}</span>{' '}
                  {recording.awayTeam}
                </h1>
                {resumeLabel && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-400/20">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                    {t('resumedAt', { time: resumeLabel })}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <div className="p-3 bg-muted rounded-lg">
                  <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                    {t('info.date')}
                  </p>
                  <p className="text-[var(--timberwolf)] font-medium">
                    {format.dateTime(new Date(recording.matchDate), 'short')}
                  </p>
                </div>
                {recording.competition && (
                  <div className="p-3 bg-muted rounded-lg">
                    <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                      {t('info.competition')}
                    </p>
                    <p className="text-[var(--timberwolf)] font-medium truncate">
                      {recording.competition}
                    </p>
                  </div>
                )}
                {recording.pitchName && (
                  <div className="p-3 bg-muted rounded-lg">
                    <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                      {t('info.pitch')}
                    </p>
                    <p className="text-[var(--timberwolf)] font-medium truncate">
                      {recording.pitchName}
                    </p>
                  </div>
                )}
                {durationLabel && (
                  <div className="p-3 bg-muted rounded-lg">
                    <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                      {t('info.duration')}
                    </p>
                    <p
                      dir="ltr"
                      className="text-[var(--timberwolf)] font-medium font-mono tabular-nums"
                    >
                      {durationLabel}
                    </p>
                  </div>
                )}
                {recording.venue && !recording.pitchName && (
                  <div className="p-3 bg-muted rounded-lg">
                    <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                      {t('info.venue')}
                    </p>
                    <p className="text-[var(--timberwolf)] font-medium truncate">
                      {recording.venue}
                    </p>
                  </div>
                )}
              </div>
              {recording.description && (
                <div className="pt-3 border-t border-border">
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {recording.description}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right rail — save CTA + tags. Stacks below on mobile. */}
        <div className="space-y-4 lg:sticky lg:top-8 lg:self-start">
          {(canSave || canSignInToSave) && (
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-base text-[var(--timberwolf)]">
                  {t('save.title')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  {t('save.description')}
                </p>
                {canSave && !saved && (
                  <Button
                    onClick={handleSave}
                    disabled={saving}
                    className="w-full bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="h-4 w-4 me-2 animate-spin" />
                        {t('save.saving')}
                      </>
                    ) : (
                      <>
                        <Bookmark className="h-4 w-4 me-2" />
                        {t('save.cta')}
                      </>
                    )}
                  </Button>
                )}
                {canSave && saved && (
                  <div className="flex items-center gap-2 text-sm text-emerald-400 border border-emerald-400/30 rounded-md bg-emerald-400/[0.06] px-3 py-2">
                    <BookmarkCheck className="h-4 w-4" />
                    {t('save.saved')}
                  </div>
                )}
                {canSignInToSave && (
                  <Button
                    asChild
                    className="w-full bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]"
                  >
                    <Link href={signInUrl}>
                      <Bookmark className="h-4 w-4 me-2" />
                      {t('save.signIn')}
                    </Link>
                  </Button>
                )}
                {saveError && (
                  <p dir="auto" className="text-xs text-red-400">
                    {saveError}
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="relative h-fit overflow-hidden border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 space-y-0">
              <div className="flex items-center gap-2.5">
                <CardTitle className="text-base text-[var(--timberwolf)]">
                  {t('tags.title')}
                </CardTitle>
                <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-white/[0.06] px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                  {events.length}
                </span>
                {/* Soft hint that auto-detection is on the roadmap so coaches
                    don't feel like manual tagging is permanent. */}
                <span
                  title={t('tags.aiSoonTitle')}
                  className="hidden sm:inline-flex items-center gap-1 rounded-full bg-emerald-400/[0.06] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.1em] text-emerald-300/70 ring-1 ring-emerald-400/15"
                >
                  <Sparkles className="h-2.5 w-2.5" />
                  {t('tags.aiSoon')}
                </span>
              </div>
              {canTag && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const v = document.querySelector('video')
                    openTagOverlay(v ? v.currentTime : 0)
                  }}
                  className="h-8 px-3 text-xs border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/[0.16]"
                >
                  <Plus className="h-3.5 w-3.5 me-1" />
                  {t('tags.add')}
                </Button>
              )}
            </CardHeader>
            <CardContent className="pt-0">
              {/* Filter pills — only render when there's something to filter
                  beyond a single group. Five pills for two tags is noise. */}
              {events.length >= 4 && (
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {FILTER_GROUPS.map((g) => {
                    const count = groupCounts[g] || 0
                    if (g !== 'all' && count === 0) return null
                    const active = filterGroup === g
                    return (
                      <button
                        key={g}
                        onClick={() => setFilterGroup(g)}
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
                          active
                            ? 'bg-[var(--timberwolf)] text-[var(--night)]'
                            : 'bg-white/[0.04] text-muted-foreground hover:bg-white/[0.08] hover:text-[var(--timberwolf)]'
                        }`}
                      >
                        {t(`filters.${g}`)}
                        <span
                          className={`tabular-nums ${
                            active ? 'opacity-70' : 'opacity-50'
                          }`}
                        >
                          {count}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {events.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/[0.06] bg-white/[0.01] py-8 text-center">
                  <TagIcon className="h-5 w-5 text-muted-foreground/50" />
                  <p className="text-xs text-muted-foreground max-w-[220px]">
                    {canTag ? t('tags.emptyCanTag') : t('tags.emptyReadOnly')}
                  </p>
                </div>
              ) : visibleEvents.length === 0 ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  {t('tags.emptyFilter')}
                </p>
              ) : (
                <ul className="-mx-2 space-y-0.5">
                  {visibleEvents.map((event) => {
                    const isMine = event.created_by === currentUserId
                    const isPrivate = event.visibility === 'private'
                    const color = EVENT_TYPE_COLORS[event.event_type]
                    const isConfirming = confirmDeleteId === event.id
                    const isHovered = hoveredTagId === event.id
                    // Admins can delete any tag on their venue's recordings
                    // (including AI-detected and other staff's tags).
                    const canDelete = isMine || isAdmin
                    const seek = () => {
                      const v = document.querySelector('video')
                      if (v) {
                        v.currentTime = Math.max(0, event.timestamp_seconds - 5)
                        v.play().catch(() => {})
                      }
                    }
                    return (
                      <li
                        key={event.id}
                        onMouseEnter={() => setHoveredTagId(event.id)}
                        onMouseLeave={() => setHoveredTagId(null)}
                        style={
                          isHovered && !isConfirming
                            ? {
                                backgroundColor: `${color}14`,
                                boxShadow: `inset 2px 0 0 0 ${color}`,
                              }
                            : undefined
                        }
                        className={`group relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors ${
                          isConfirming
                            ? 'bg-red-500/[0.08] ring-1 ring-inset ring-red-500/30'
                            : isHovered
                              ? ''
                              : 'hover:bg-white/[0.04]'
                        }`}
                      >
                        {/* Click area for seek — covers most of the row */}
                        <button
                          onClick={seek}
                          className="absolute inset-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
                          aria-label={t('tags.seekTo', {
                            time: formatTimestamp(event.timestamp_seconds),
                            label: eventLabels[event.event_type],
                          })}
                        />
                        {/* Colored dot with halo */}
                        <span
                          className="relative h-2 w-2 flex-shrink-0 rounded-full"
                          style={{
                            backgroundColor: color,
                            boxShadow: `0 0 0 3px ${color}1f`,
                          }}
                        />
                        {/* Timestamp — right-aligned in a fixed column for a
                            clean ladder of times across mixed mm:ss / h:mm:ss. */}
                        <span
                          dir="ltr"
                          className="relative z-[1] w-16 flex-shrink-0 text-end font-mono text-xs tabular-nums text-[var(--timberwolf)]"
                        >
                          {formatTimestamp(event.timestamp_seconds)}
                        </span>
                        {/* Type pill */}
                        <span
                          className="relative z-[1] rounded-md px-1.5 py-0.5 text-[10px] font-medium tracking-wide flex-shrink-0"
                          style={{
                            backgroundColor: `${color}1a`,
                            color,
                          }}
                        >
                          {eventLabels[event.event_type]}
                        </span>
                        {/* Optional label */}
                        {event.label && (
                          <span className="relative z-[1] truncate text-xs text-muted-foreground">
                            {event.label}
                          </span>
                        )}
                        {/* Right-side: lock + delete (mine only) */}
                        <span className="ms-auto flex flex-shrink-0 items-center gap-1">
                          {isPrivate && !isConfirming && (
                            <Lock
                              className="h-3 w-3 text-muted-foreground/60"
                              aria-label={
                                isMine
                                  ? t('tags.privateMine')
                                  : t('tags.private')
                              }
                            />
                          )}
                          {canDelete && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                stageOrConfirmDelete(event.id)
                              }}
                              onBlur={() => {
                                if (isConfirming) cancelDeleteConfirm()
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape' && isConfirming) {
                                  e.preventDefault()
                                  cancelDeleteConfirm()
                                }
                              }}
                              aria-label={
                                isConfirming
                                  ? t('tags.confirmDelete')
                                  : t('tags.delete')
                              }
                              className={`relative z-[2] grid place-items-center rounded-md transition-all ${
                                isConfirming
                                  ? 'h-6 px-2 bg-red-500/15 text-red-300 hover:bg-red-500/25'
                                  : 'h-6 w-6 text-muted-foreground/60 opacity-0 group-hover:opacity-100 hover:bg-white/[0.06] hover:text-red-300 focus:opacity-100'
                              }`}
                            >
                              {isConfirming ? (
                                <span className="text-[10px] font-medium">
                                  {t('tags.deletePrompt')}
                                </span>
                              ) : (
                                <Trash2 className="h-3 w-3" />
                              )}
                            </button>
                          )}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Share modal — uses the existing component which knows how to mint
          a share token + copy a URL + email-grant. Only signed-in viewers
          see this surface. */}
      {currentUserId && (
        <ShareRecordingModal
          open={shareOpen}
          onOpenChange={setShareOpen}
          recordingId={recording.id}
          recordingTitle={recording.title}
        />
      )}

      {/* Quick-tag overlay — portals INTO the fullscreen element when active
          so it stays visible without exiting fullscreen. Falls back to body. */}
      {mounted &&
        createPortal(
          <AnimatePresence>
            {tagOverlay && (
              <TagOverlayInner
                key="tag-overlay"
                tagOverlay={tagOverlay}
                canPublish={canPublish}
                keepOpenAfterSave={keepOpenAfterSave}
                setKeepOpenAfterSave={setKeepOpenAfterSave}
                setTagOverlay={setTagOverlay}
                postTag={postTag}
                closeTagOverlay={closeTagOverlay}
                reduceMotion={!!reduceMotion}
              />
            )}
          </AnimatePresence>,
          fullscreenEl || document.body
        )}

      {/* Saved-tag flash — same portal target so it shows in fullscreen too. */}
      {mounted &&
        createPortal(
          <AnimatePresence>
            {tagSavedFlash && (
              <motion.div
                key="tag-saved-flash"
                initial={{ y: 14, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 8, opacity: 0 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.22,
                  ease: [0.32, 0.72, 0, 1],
                }}
                role="status"
                aria-live="polite"
                className="pointer-events-none fixed bottom-8 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2.5 rounded-full border border-emerald-400/30 bg-[rgba(15,21,18,0.85)] px-4 py-2 text-sm font-medium text-emerald-300 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)] backdrop-blur-xl"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{
                    backgroundColor: EVENT_TYPE_COLORS[tagSavedFlash.eventType],
                    boxShadow: `0 0 10px ${EVENT_TYPE_COLORS[tagSavedFlash.eventType]}`,
                  }}
                />
                {t.rich('tags.savedFlash', {
                  label: eventLabels[tagSavedFlash.eventType],
                  time: formatTimestamp(tagSavedFlash.timestamp),
                  timeWrap: (chunks) => (
                    <span dir="ltr" className="font-mono tabular-nums">
                      {chunks}
                    </span>
                  ),
                })}
              </motion.div>
            )}
          </AnimatePresence>,
          fullscreenEl || document.body
        )}
    </div>
  )
}

// Quick-tag picker. Rendered via createPortal — when the player is fullscreen,
// the portal target is the fullscreen element, otherwise document.body. Keeping
// it as a standalone component lets us swap portal targets without remounting
// state inside the modal.
type TagOverlayState = {
  timestamp: number
  visibility: 'public' | 'private'
  posting: boolean
  pendingType: EventType | null
  error: string | null
}

function TagOverlayInner({
  tagOverlay,
  canPublish,
  keepOpenAfterSave,
  setKeepOpenAfterSave,
  setTagOverlay,
  postTag,
  closeTagOverlay,
  reduceMotion,
}: {
  tagOverlay: TagOverlayState
  canPublish: boolean
  keepOpenAfterSave: boolean
  setKeepOpenAfterSave: (v: boolean) => void
  setTagOverlay: (s: TagOverlayState) => void
  postTag: (t: EventType) => void
  closeTagOverlay: () => void
  reduceMotion: boolean
}) {
  const t = useTranslations('watch')
  const eventLabels = useEventTypeLabels()
  const tc = useTranslations('common')
  // Focus first tile on mount so keyboard users can fire shortcuts or arrow
  // through the grid immediately. We also expose the dialog's id chain for
  // SR (aria-labelledby points at the timestamp heading).
  const firstTileRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      firstTileRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(id)
  }, [])

  const fadeDur = reduceMotion ? 0 : 0.18
  const cardDur = reduceMotion ? 0 : 0.22

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: fadeDur, ease: [0.32, 0.72, 0, 1] }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 backdrop-blur-md p-4"
      onClick={closeTagOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tag-overlay-heading"
    >
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 6, scale: 0.99 }}
        transition={{ duration: cardDur, ease: [0.32, 0.72, 0, 1] }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-[460px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[rgba(15,21,18,0.95)] shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7),inset_0_0_0_1px_rgba(255,255,255,0.04)] backdrop-blur-2xl backdrop-saturate-150"
      >
        {/* Hairline top highlight — premium card signature */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
        {/* Soft emerald glow from the cursor accent */}
        <div className="pointer-events-none absolute -top-24 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-emerald-400/[0.07] blur-3xl" />

        <div className="relative p-5 sm:p-6">
          {/* Header — promoted timestamp + live cursor dot */}
          <div className="flex items-start justify-between mb-5">
            <div className="flex items-center gap-2.5">
              <span className="relative flex h-2 w-2">
                {!reduceMotion && (
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                )}
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
              </span>
              <div>
                <p
                  id="tag-overlay-heading"
                  className="font-mono text-[22px] leading-none tracking-tight text-[var(--timberwolf)] tabular-nums"
                >
                  {formatTimestamp(Math.floor(tagOverlay.timestamp))}
                </p>
                <p className="mt-1.5 text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  {t('tagOverlay.newTag')}
                </p>
              </div>
            </div>
            <button
              onClick={closeTagOverlay}
              aria-label={tc('close')}
              className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-all hover:bg-white/[0.06] hover:text-[var(--timberwolf)] active:scale-95"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Visibility — segmented control */}
          {canPublish && (
            <div className="mb-5">
              <div className="relative grid grid-cols-2 rounded-lg bg-white/[0.04] p-1 ring-1 ring-inset ring-white/[0.06]">
                <motion.div
                  layout
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 500, damping: 38 }
                  }
                  className="absolute inset-y-1 w-[calc(50%-4px)] rounded-md bg-[var(--timberwolf)] shadow-[0_2px_8px_rgba(0,0,0,0.25)]"
                  style={{
                    // Logical property so the indicator tracks the correct
                    // segment in RTL as well as LTR.
                    insetInlineStart:
                      tagOverlay.visibility === 'public' ? 4 : 'calc(50%)',
                  }}
                />
                {(['public', 'private'] as const).map((v) => {
                  const active = tagOverlay.visibility === v
                  return (
                    <button
                      key={v}
                      onClick={() =>
                        setTagOverlay({ ...tagOverlay, visibility: v })
                      }
                      className={`relative z-10 flex h-8 items-center justify-center gap-1.5 text-xs font-medium transition-colors ${
                        active
                          ? 'text-[var(--night)]'
                          : 'text-muted-foreground hover:text-[var(--timberwolf)]'
                      }`}
                    >
                      {v === 'private' && <Lock className="h-3 w-3" />}
                      {v === 'public'
                        ? t('tagOverlay.public')
                        : t('tagOverlay.private')}
                    </button>
                  )
                })}
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground/80">
                {tagOverlay.visibility === 'public'
                  ? t('tagOverlay.publicHint')
                  : t('tagOverlay.privateHint')}
              </p>
            </div>
          )}
          {!canPublish && (
            <div className="mb-5 flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-muted-foreground">
              <Lock className="h-3 w-3 flex-shrink-0" />
              <span>{t('tagOverlay.privateOnly')}</span>
            </div>
          )}

          {/* Event tile grid — frequency-ordered, gradient-wash, per-tile pending */}
          <div className="grid grid-cols-4 gap-1.5">
            {TAG_GRID_ORDER.map((type, idx) => {
              const color = EVENT_TYPE_COLORS[type]
              const isPending = tagOverlay.pendingType === type
              const isOtherPending =
                tagOverlay.posting && tagOverlay.pendingType !== type
              const shortcut = TAG_SHORTCUT_KEYS[idx]
              return (
                <button
                  key={type}
                  ref={idx === 0 ? firstTileRef : undefined}
                  onClick={() => postTag(type)}
                  disabled={tagOverlay.posting}
                  style={{ ['--tile' as any]: color }}
                  className={`group relative flex min-h-[68px] flex-col items-center justify-center gap-1.5 overflow-hidden rounded-xl border px-2 py-2.5 text-[11px] font-medium text-[var(--timberwolf)] transition-all duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--timberwolf)]/60 focus-visible:ring-offset-0 ${
                    isPending
                      ? 'border-[var(--tile)]/60 bg-[var(--tile)]/10 shadow-[inset_0_0_0_1px_var(--tile)]'
                      : 'border-white/[0.06] bg-white/[0.02] hover:-translate-y-px hover:border-white/[0.14] hover:bg-white/[0.05] hover:shadow-[0_4px_14px_-4px_rgba(0,0,0,0.5)] active:translate-y-0 active:scale-[0.97]'
                  } ${isOtherPending ? 'pointer-events-none opacity-30' : ''} disabled:cursor-not-allowed motion-reduce:transition-none motion-reduce:hover:translate-y-0`}
                >
                  {/* Gradient wash from event color, hover only */}
                  <span
                    aria-hidden
                    className={`pointer-events-none absolute inset-0 bg-gradient-to-b from-[var(--tile)]/15 to-transparent transition-opacity duration-200 ${
                      isPending
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100'
                    }`}
                  />
                  {/* Dot or spinner */}
                  {isPending ? (
                    <Loader2
                      className="relative h-3 w-3 animate-spin"
                      style={{ color }}
                    />
                  ) : (
                    <span
                      className="relative h-2 w-2 rounded-full transition-transform duration-200 ease-out group-hover:scale-125 motion-reduce:group-hover:scale-100"
                      style={{
                        backgroundColor: color,
                        boxShadow: `0 0 0 3px ${color}1f`,
                      }}
                    />
                  )}
                  <span className="relative">{eventLabels[type]}</span>
                  {/* Keyboard shortcut chip */}
                  {shortcut && (
                    <span
                      aria-hidden
                      className="absolute end-1.5 top-1.5 hidden rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[9px] text-muted-foreground/80 sm:block"
                    >
                      {shortcut}
                    </span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Inline error */}
          <AnimatePresence>
            {tagOverlay.error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.16 }}
                dir="auto"
                className="mt-4 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300"
                role="alert"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                {tagOverlay.error}
              </motion.p>
            )}
          </AnimatePresence>

          {/* Footer: rapid-fire tagging toggle + shortcut hint */}
          <div className="mt-5 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-3">
            <label className="flex cursor-pointer select-none items-center gap-2 text-[11px] text-muted-foreground hover:text-[var(--timberwolf)]">
              <input
                type="checkbox"
                checked={keepOpenAfterSave}
                onChange={(e) => setKeepOpenAfterSave(e.target.checked)}
                className="h-3 w-3 cursor-pointer accent-emerald-400"
              />
              {t('tagOverlay.keepOpen')}
            </label>
            <span className="hidden text-[10px] text-muted-foreground/70 sm:block">
              {t.rich('tagOverlay.escHint', {
                kbd: (chunks) => (
                  <kbd className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[9px]">
                    {chunks}
                  </kbd>
                ),
              })}
            </span>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
