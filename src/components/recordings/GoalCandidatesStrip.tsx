'use client'

// Review strip for AI-detected goal candidates (Spiideo goal-detect pilot).
// Platform-admin-only surface: the GET route 403s everyone else and the
// strip renders nothing on any !ok response, so non-admins see no change
// (portrait-strip pattern). Chronological — the reviewer scrubs the match
// candidate by candidate; ~1 in 3 clips is a goal BY DESIGN (the frozen
// chain trades precision for recall; the review IS the filter).
// Approve writes a public `goal` event that appears immediately as a
// timeline marker (onApproved lets the page refresh its events list).

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Goal, Loader2, Plus, Undo2, X } from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'
import {
  EVENT_OFFSET_S,
  parseClockInput,
  subAnchorHints,
} from '@/lib/goal-review/multi-goal'

interface CandidateEvent {
  eventId: string
  stampSource: 'anchor_offset' | 'human_scrub'
  stampSeconds: number | null
}

interface GoalCandidate {
  id: string
  t0S: number
  t1S: number
  anchorS: number
  /** First kickoff peak per dead->live cycle ([0] = anchor); [] on
   *  pre-hybrid rows. Feeds subAnchorHints — review hints, never auto. */
  subAnchorsS: number[]
  pko: number | null
  deadctx: number | null
  status: 'draft' | 'approved' | 'rejected' | 'error'
  error: string | null
  clipUrl: string | null
  approvedEventId: string | null
  events: CandidateEvent[]
}

type ReviewBody =
  | { action: 'approve' | 'unapprove' | 'reject' | 'restore' }
  | { action: 'add_goal'; timestampSeconds: number; estimate?: true }
  | { action: 'remove_event'; eventId: string }

interface GoalCandidatesStripProps {
  recordingId: string
  /** Called after a successful approve so the page can refresh its events. */
  onApproved?: () => void
}

const STATUS_STYLES: Record<GoalCandidate['status'], string> = {
  draft: 'bg-amber-500/15 text-amber-300',
  approved: 'bg-emerald-500/15 text-emerald-300',
  rejected: 'bg-white/[0.06] text-muted-foreground/60',
  error: 'bg-red-500/15 text-red-300',
}

// Mirror of the batch job's clip window: clip starts at max(0, t0-90). The
// goal-estimate offset (EVENT_OFFSET_S) is imported from the lib so the
// cycle-hint chips and the card's own "goal ~m:ss" hint can never drift.
const CLIP_PRE_S = 90
const SEEK_LEAD_S = 10

function clipStartS(cand: { t0S: number }): number {
  return Math.max(0, cand.t0S - CLIP_PRE_S)
}

function goalOffsetS(cand: { t0S: number; anchorS: number }): number {
  return Math.max(0, cand.anchorS - EVENT_OFFSET_S - clipStartS(cand))
}

function mmss(s: number): string {
  const m = Math.floor(s / 60)
  const r = Math.floor(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}

export function GoalCandidatesStrip({
  recordingId,
  onApproved,
}: GoalCandidatesStripProps) {
  const t = useTranslations('recordingDetail.goalCandidates')
  const [candidates, setCandidates] = useState<GoalCandidate[] | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Only one clip plays at a time; the ref tracks its <video> so "Add goal
  // at this moment" can read the playhead.
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // Mirror of playingId for use inside refresh() without rebinding it.
  const playingIdRef = useRef<string | null>(null)
  useEffect(() => {
    playingIdRef.current = playingId
  }, [playingId])

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/recordings/${recordingId}/goal-candidates`,
          { signal }
        )
        if (!res.ok) return // silent — non-admins simply see nothing
        const json = (await res.json()) as { candidates?: GoalCandidate[] }
        // Review order = MATCH ORDER (Karim, 2026-07-22, superseding his
        // earlier span-desc ranking): the workflow is a complete pass over
        // every card, so chronological scanning beats goal-rich-first.
        // (Span remains the measured ranking signal — P@4 0.49 vs base
        // 0.32 on the freeze record — and stays the input for any future
        // auto-approve posture, which is PARKED pending a precision curve.)
        const sorted = (json.candidates ?? [])
          .map((c) => ({
            ...c,
            events: c.events ?? [],
            subAnchorsS: c.subAnchorsS ?? [],
          }))
          .sort((a, b) => a.anchorS - b.anchorS)
        if (!signal?.aborted) {
          // Keep the PLAYING card's clip URL: every refresh mints fresh
          // signed URLs, and swapping src reloads the video + resets the
          // playhead — killing the scrub position mid multi-goal review
          // (senior review H3). The old signed URL stays valid for an hour.
          setCandidates((prev) => {
            const pid = playingIdRef.current
            const prevUrl = pid
              ? (prev?.find((c) => c.id === pid)?.clipUrl ?? null)
              : null
            if (!pid || !prevUrl) return sorted
            return sorted.map((c) =>
              c.id === pid ? { ...c, clipUrl: prevUrl } : c
            )
          })
        }
      } catch {
        // aborted or network hiccup — leave the current state
      }
    },
    [recordingId]
  )

  useEffect(() => {
    const controller = new AbortController()
    setCandidates(null)
    setPlayingId(null)
    refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const act = useCallback(
    async (cand: GoalCandidate, body: ReviewBody) => {
      setBusyId(cand.id)
      setNotice(null)
      try {
        const res = await fetch(
          `/api/recordings/${recordingId}/goal-candidates/${cand.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        )
        if (!res.ok) {
          const resBody = (await res.json().catch(() => null)) as {
            error?: string
            code?: string
          } | null
          // Localize the actionable codes; fall back to the server string
          // (English) only for unexpected ones.
          setNotice(
            resBody?.code === 'event_write_failed'
              ? t('approveRepairNotice')
              : resBody?.code === 'event_delete_failed'
                ? t('unapproveRepairNotice')
                : resBody?.code === 'goal_add_failed'
                  ? t('addFailedNotice')
                  : resBody?.code === 'invalid_state'
                    ? t('staleNotice')
                    : (resBody?.error ?? t('actionFailed'))
          )
          // event_write_failed leaves the repair state visible on refresh
          await refresh()
          return
        }
        // Every marker mutation changes the /watch timeline — let the page
        // refresh its events list.
        if (body.action === 'approve' || body.action === 'add_goal') {
          setNotice(
            t(
              body.action === 'approve' ? 'approvedNotice' : 'markerAddedNotice'
            )
          )
          onApproved?.()
        } else if (body.action === 'unapprove') {
          setNotice(t('unapprovedNotice'))
          onApproved?.()
        } else if (body.action === 'remove_event') {
          setNotice(t('markerRemovedNotice'))
          onApproved?.()
        }
        await refresh()
      } catch {
        setNotice(t('actionFailed'))
      } finally {
        setBusyId(null)
      }
    },
    [recordingId, refresh, onApproved, t]
  )

  // Stamp the goal at the playhead of the playing clip (produced-video
  // clock = clip start + playhead). From draft the server treats it as the
  // approve path; while approved it appends another marker.
  const addAtMoment = useCallback(
    (cand: GoalCandidate) => {
      const video = videoRef.current
      if (!video || playingId !== cand.id) return
      const ts = clipStartS(cand) + video.currentTime
      void act(cand, {
        action: 'add_goal',
        timestampSeconds: Math.round(ts * 10) / 10,
      })
    },
    [act, playingId]
  )

  // Typed match-clock stamp ("22:33" off /watch): the review clip is capped
  // at 5 minutes, so goals deep in a long merged episode sit past the clip's
  // end and can't be reached by the playhead button.
  const [timeInputs, setTimeInputs] = useState<Record<string, string>>({})
  const addAtTime = useCallback(
    (cand: GoalCandidate) => {
      const raw = timeInputs[cand.id] ?? ''
      const ts = parseClockInput(raw)
      if (ts === null) {
        setNotice(t('badTimeNotice'))
        return
      }
      setTimeInputs((prev) => ({ ...prev, [cand.id]: '' }))
      void act(cand, { action: 'add_goal', timestampSeconds: ts })
    },
    [act, timeInputs, t]
  )

  if (!candidates || candidates.length === 0) return null

  const nGoals = candidates.filter((c) => c.status === 'approved').length
  const nOpen = candidates.filter((c) => c.status === 'draft').length

  return (
    <div className="mt-6 rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <Goal className="h-3.5 w-3.5 text-muted-foreground/40" />
        <span className="text-[11px] text-muted-foreground/50 uppercase tracking-wider">
          {t('title')}
        </span>
        <span className="text-[11px] text-muted-foreground/40">
          {t('counts', { open: nOpen, approved: nGoals })}
        </span>
        {notice && (
          <span className="text-[11px] text-muted-foreground/60">{notice}</span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground/40 mb-3">{t('hint')}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {candidates.map((cand) => {
          const busy = busyId === cand.id
          const playable = cand.clipUrl && cand.status !== 'error'
          const repairing = cand.status === 'approved' && !cand.approvedEventId
          // Per-cycle stamp offers (episode-split hybrid). Empty on
          // single-cycle cards — the median card renders exactly as before.
          const cycleHints =
            cand.status === 'draft' || cand.status === 'approved'
              ? subAnchorHints(cand.subAnchorsS, cand.events)
              : []
          return (
            <div
              key={cand.id}
              className={cn(
                'group relative rounded-lg overflow-hidden bg-white/[0.02] border border-white/[0.04]',
                cand.status === 'rejected' && 'opacity-50'
              )}
            >
              <div className="relative aspect-video bg-black/30">
                {playable && playingId === cand.id ? (
                  <video
                    ref={videoRef}
                    src={cand.clipUrl as string}
                    controls
                    autoPlay
                    playsInline
                    // Land the reviewer just before the estimated goal
                    // moment instead of the top of a multi-minute clip —
                    // the E2E's false "not a goal" was a goal sitting 71s
                    // into an unhinted clip.
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget
                      const seek = Math.max(0, goalOffsetS(cand) - SEEK_LEAD_S)
                      if (Number.isFinite(v.duration) && seek < v.duration) {
                        v.currentTime = seek
                      }
                    }}
                    className="w-full h-full object-contain bg-black"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => playable && setPlayingId(cand.id)}
                    disabled={!playable}
                    aria-label={t('preview')}
                    className="w-full h-full flex items-center justify-center text-muted-foreground/30 disabled:cursor-default"
                  >
                    {cand.status === 'error' ? (
                      <span className="px-2 text-[11px] text-red-300/70">
                        {cand.error ?? t('errorBadge')}
                      </span>
                    ) : (
                      <Goal className="h-6 w-6" />
                    )}
                  </button>
                )}
                <span
                  className={cn(
                    'absolute top-1.5 left-1.5 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                    STATUS_STYLES[cand.status]
                  )}
                >
                  {repairing ? t('repair') : t(cand.status)}
                </span>
              </div>
              {playingId === cand.id &&
                playable &&
                cand.status !== 'rejected' && (
                  <button
                    type="button"
                    onClick={() => addAtMoment(cand)}
                    disabled={busy}
                    className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] text-emerald-300/80 hover:text-emerald-300 hover:bg-emerald-500/10 border-b border-white/[0.04] disabled:opacity-50"
                  >
                    <Plus className="h-3 w-3" />
                    {t('addGoalAtMoment')}
                  </button>
                )}
              <div className="flex items-center justify-between gap-1 p-2">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-sm font-medium text-[var(--timberwolf)] tabular-nums">
                    {mmss(cand.anchorS)}
                  </span>
                  {cand.status !== 'error' && (
                    <span
                      className="text-[10px] text-emerald-300/60 tabular-nums"
                      title={t('goalHintTitle')}
                    >
                      {t('goalHint', { mmss: mmss(goalOffsetS(cand)) })}
                    </span>
                  )}
                  {cand.pko !== null && (
                    <span
                      className="text-[10px] text-muted-foreground/50 tabular-nums"
                      title={t('confidenceTitle')}
                    >
                      {t('confidence', {
                        pko: Math.round(cand.pko * 100),
                        dead:
                          cand.deadctx === null
                            ? 0
                            : Math.round(cand.deadctx * 100),
                      })}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
                  ) : (
                    <>
                      {(cand.status === 'draft' || repairing) && (
                        <button
                          type="button"
                          onClick={() => act(cand, { action: 'approve' })}
                          title={repairing ? t('approveRepair') : t('approve')}
                          aria-label={
                            repairing ? t('approveRepair') : t('approve')
                          }
                          className="p-1.5 rounded text-muted-foreground/60 hover:text-emerald-300 hover:bg-white/[0.06]"
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {cand.status === 'draft' && (
                        <button
                          type="button"
                          onClick={() => act(cand, { action: 'reject' })}
                          title={t('reject')}
                          aria-label={t('reject')}
                          className="p-1.5 rounded text-muted-foreground/60 hover:text-red-300 hover:bg-white/[0.06]"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {cand.status === 'rejected' && (
                        <button
                          type="button"
                          onClick={() => act(cand, { action: 'restore' })}
                          title={t('restore')}
                          aria-label={t('restore')}
                          className="p-1.5 rounded text-muted-foreground/60 hover:text-[var(--timberwolf)] hover:bg-white/[0.06]"
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {cand.status === 'approved' && (
                        <button
                          type="button"
                          onClick={() => act(cand, { action: 'unapprove' })}
                          title={t('unapprove')}
                          aria-label={t('unapprove')}
                          className="p-1.5 rounded text-muted-foreground/60 hover:text-amber-300 hover:bg-white/[0.06]"
                        >
                          <Undo2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {cand.status === 'approved' && cand.events.length > 0 && (
                <div className="flex flex-wrap gap-1 px-2 pb-2">
                  {cand.events.map((ev) => (
                    <span
                      key={ev.eventId}
                      className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 pl-2 pr-1 py-0.5 text-[10px] text-emerald-300 tabular-nums"
                      title={
                        ev.stampSource === 'human_scrub'
                          ? t('stampHuman')
                          : t('stampEstimate')
                      }
                    >
                      <Goal className="h-2.5 w-2.5" />
                      {mmss(
                        ev.stampSeconds ??
                          Math.max(0, cand.anchorS - EVENT_OFFSET_S)
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          act(cand, {
                            action: 'remove_event',
                            eventId: ev.eventId,
                          })
                        }
                        disabled={busy}
                        title={t('removeMarker')}
                        aria-label={t('removeMarker')}
                        className="p-0.5 rounded-full text-emerald-300/60 hover:text-red-300 hover:bg-white/[0.06] disabled:opacity-50"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {cycleHints.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
                  <span className="text-[10px] text-muted-foreground/40">
                    {t('cycleHintsLabel')}
                  </span>
                  {cycleHints.map((est) => (
                    <button
                      key={est}
                      type="button"
                      onClick={() =>
                        act(cand, {
                          action: 'add_goal',
                          timestampSeconds: est,
                          // machine-derived stamp: records as an estimate
                          // ('anchor_offset'), keeping human_scrub an honest
                          // human-precise label a later scrub can supersede
                          estimate: true,
                        })
                      }
                      disabled={busy}
                      title={t('cycleHintTitle', { mmss: mmss(est) })}
                      aria-label={t('cycleHintTitle', { mmss: mmss(est) })}
                      className="inline-flex items-center gap-1 rounded-full border border-dashed border-amber-500/30 bg-amber-500/5 px-2 py-0.5 text-[10px] text-amber-300/80 tabular-nums hover:bg-amber-500/15 hover:text-amber-300 disabled:opacity-50"
                    >
                      <Plus className="h-2.5 w-2.5" />
                      {t('cycleHintChip', { mmss: mmss(est) })}
                    </button>
                  ))}
                </div>
              )}
              {(cand.status === 'draft' || cand.status === 'approved') && (
                <div className="flex items-center gap-1 px-2 pb-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    value={timeInputs[cand.id] ?? ''}
                    onChange={(e) =>
                      setTimeInputs((prev) => ({
                        ...prev,
                        [cand.id]: e.target.value,
                      }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') addAtTime(cand)
                    }}
                    placeholder={t('addAtTimePlaceholder')}
                    aria-label={t('addAtTime')}
                    disabled={busy}
                    className="w-16 rounded bg-white/[0.04] border border-white/[0.06] px-1.5 py-0.5 text-[11px] text-[var(--timberwolf)] placeholder:text-muted-foreground/40 tabular-nums focus:outline-none focus:border-emerald-500/40 disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => addAtTime(cand)}
                    disabled={busy || !(timeInputs[cand.id] ?? '').trim()}
                    title={t('addAtTime')}
                    aria-label={t('addAtTime')}
                    className="p-1 rounded text-muted-foreground/60 hover:text-emerald-300 hover:bg-white/[0.06] disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                  <span className="text-[10px] text-muted-foreground/40">
                    {t('addAtTimeHint')}
                  </span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
