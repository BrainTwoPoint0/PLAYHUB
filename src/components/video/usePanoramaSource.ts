'use client'

// Raw-VP source resolution for the de-warp ("Explore the pitch") surface.
//
// The de-warp needs the RAW VirtualPanorama, which lives behind
// POST /api/recordings/[id]/panorama-source. That route is idempotent: it
// serves a short-TTL signed URL when the panorama is already banked, else it
// triggers a multi-GB Batch capture and answers { status: 'pending' }. So this
// hook owns two things:
//
//   1. the capture POLL — a bounded, backing-off poll that stops before the
//      server's 10-min stuck-window would re-trigger a DUPLICATE capture, and
//   2. the proactive RE-SIGN — the signed URL expires like the master's, but
//      the poll stops at 'ready' and would never refresh it. We re-call the
//      route (it re-signs on every hit) at ~80% of the URL's TTL.
//
// Extracted from WatchClient so /watch/[id] and /recordings/[id] share one
// implementation of the expiry/poll state machine rather than two that drift.

import { useCallback, useEffect, useRef, useState } from 'react'
import { refreshDelayMs } from '@/lib/video/signed-url-refresh'

export type ExploreState =
  'idle' | 'loading' | 'pending' | 'unavailable' | 'timeout' | 'error'

export interface PanoramaSource {
  /** Signed raw-VP URL once ready, else null. */
  panoramaSrc: string | null
  /** Poll/capture state for the surface toggle's chrome. */
  exploreState: ExploreState
  /**
   * Ask for the raw VP (triggering a capture if needed) and start polling.
   * `auto` marks a request the USER did not make (a page opening straight on
   * the de-warp): those must not be able to reach the terminal 'unavailable'
   * state, which permanently hides the Explore toggle for the session.
   */
  onExplore: (opts?: { auto?: boolean }) => void
}

/** How long we keep polling a pending capture before surfacing a retry. */
const POLL_DEADLINE_MS = 5 * 60_000

export function usePanoramaSource(
  recordingId: string,
  token: string | null
): PanoramaSource {
  const [panoramaSrc, setPanoramaSrc] = useState<string | null>(null)
  const [exploreState, setExploreState] = useState<ExploreState>('idle')

  const explorePollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exploreDeadlineRef = useRef<number>(0)
  const explorePollsRef = useRef<number>(0)
  // Whether the in-flight request was automatic (page opened on the de-warp)
  // rather than user-initiated. Gates the terminal 'unavailable' state.
  const autoRef = useRef(false)
  // One-shot retry timer for a failed re-sign; `used` bounds it to a single
  // retry per proactive cycle.
  const resignRetryRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null
    used: boolean
  }>({ timer: null, used: false })

  useEffect(
    () => () => {
      if (explorePollRef.current) clearTimeout(explorePollRef.current)
      if (resignRetryRef.current.timer)
        clearTimeout(resignRetryRef.current.timer)
    },
    []
  )

  // encodeURIComponent on the id too: on /recordings it comes from useParams(),
  // which Next hands back DECODED, so a crafted path segment would otherwise
  // let the browser normalise this POST onto a different same-origin route.
  const sourceUrl = `/api/recordings/${encodeURIComponent(recordingId)}/panorama-source${
    token ? `?token=${encodeURIComponent(token)}` : ''
  }`

  // requestPanorama and scheduleExplorePoll are mutually recursive; the ref
  // breaks the cycle without re-creating the timer chain on every render.
  const requestRef = useRef<() => Promise<void>>(async () => {})

  // Stop polling before the server's 10-min stuck-window would re-trigger a
  // DUPLICATE multi-GB capture; surface a retryable 'timeout' instead.
  const scheduleExplorePoll = useCallback(() => {
    if (Date.now() > exploreDeadlineRef.current) {
      setExploreState('timeout')
      return
    }
    explorePollsRef.current += 1
    const delay = explorePollsRef.current < 10 ? 6000 : 10000 // gentle backoff after ~1 min
    explorePollRef.current = setTimeout(() => {
      void requestRef.current()
    }, delay)
  }, [])

  const requestPanorama = useCallback(async (): Promise<void> => {
    if (Date.now() > exploreDeadlineRef.current) {
      setExploreState('timeout')
      return
    }
    // 'unavailable' is TERMINAL — it hides the Explore toggle for the rest of
    // the session. Only a request the user actually made may land there; an
    // automatic one falls back to 'idle' so the affordance survives and a
    // click can find out for real.
    const giveUp = () =>
      setExploreState(autoRef.current ? 'idle' : 'unavailable')
    let data: { status?: string; url?: string } = {}
    try {
      const res = await fetch(sourceUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      // fetch doesn't throw on 4xx/5xx. 5xx is transient → retry; 4xx (403/404) →
      // not available to this viewer → stop (keeps the Auto production).
      if (!res.ok) {
        if (res.status >= 500) return scheduleExplorePoll()
        giveUp()
        return
      }
      data = await res.json().catch(() => ({}))
    } catch {
      // network blip → retry within the deadline
      return scheduleExplorePoll()
    }
    if (data.status === 'ready' && data.url) {
      // The consumer flips to the de-warp surface once panoramaSrc is set (if
      // the user asked for it). We just publish the ready URL + clear the poll.
      setPanoramaSrc(data.url)
      setExploreState('idle')
    } else if (data.status === 'pending') {
      setExploreState('pending')
      scheduleExplorePoll()
    } else {
      // 'unavailable' — not a panorama / no game / anonymous-can't-trigger.
      giveUp()
    }
  }, [sourceUrl, scheduleExplorePoll])

  useEffect(() => {
    requestRef.current = requestPanorama
  }, [requestPanorama])

  // Identity change (a different recording, or a token swap) invalidates
  // EVERYTHING here. Without this the previous recording's signed raw-VP URL
  // stays published, and a consumer that survives the change — the App Router
  // preserves component state across dynamic-param navigations within the same
  // route — would render recording A's footage under recording B's mesh,
  // clock and title. Not an access break (the viewer holds both grants), but a
  // wrong-match render of minors' footage. Skips the initial mount: the state
  // is already fresh there, and clearing it would fight the auto-open.
  const prevSourceRef = useRef(sourceUrl)
  useEffect(() => {
    if (prevSourceRef.current === sourceUrl) return
    prevSourceRef.current = sourceUrl
    if (explorePollRef.current) clearTimeout(explorePollRef.current)
    if (resignRetryRef.current.timer) clearTimeout(resignRetryRef.current.timer)
    resignRetryRef.current = { timer: null, used: false }
    explorePollsRef.current = 0
    exploreDeadlineRef.current = 0
    autoRef.current = false
    setPanoramaSrc(null)
    setExploreState('idle')
  }, [sourceUrl])

  const onExplore = useCallback(
    (opts?: { auto?: boolean }) => {
      if (exploreState === 'loading' || exploreState === 'pending') return
      autoRef.current = !!opts?.auto
      exploreDeadlineRef.current = Date.now() + POLL_DEADLINE_MS
      explorePollsRef.current = 0
      setExploreState('loading')
      void requestPanorama()
    },
    [exploreState, requestPanorama]
  )

  // Re-sign: quiet on failure; no deadline/state churn (unlike requestPanorama,
  // which drives the capture). VirtualPanoramaPlayer rebuilds its texture on a
  // new src and the slave re-seeks to the master.
  const resignPanorama = useCallback(async () => {
    let ok = false
    try {
      const res = await fetch(sourceUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          status?: string
          url?: string
        }
        if (data.status === 'ready' && data.url) {
          resignRetryRef.current.used = false // success → fresh budget
          setPanoramaSrc(data.url) // re-arms the proactive effect
          ok = true
        }
      }
    } catch {
      // fall through to the bounded retry below
    }
    // One bounded retry per cycle — a single blip shouldn't leave the de-warp to
    // 403 at expiry. After that the player's own error path is the fallback.
    if (!ok && !resignRetryRef.current.used) {
      resignRetryRef.current.used = true
      resignRetryRef.current.timer = setTimeout(() => {
        void resignPanorama()
      }, 30_000)
    }
  }, [sourceUrl])

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

  return { panoramaSrc, exploreState, onExplore }
}
