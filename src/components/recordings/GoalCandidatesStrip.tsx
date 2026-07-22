'use client'

// Review strip for AI-detected goal candidates (Spiideo goal-detect pilot).
// Platform-admin-only surface: the GET route 403s everyone else and the
// strip renders nothing on any !ok response, so non-admins see no change
// (portrait-strip pattern). Chronological — the reviewer scrubs the match
// candidate by candidate; ~1 in 3 clips is a goal BY DESIGN (the frozen
// chain trades precision for recall; the review IS the filter).
// Approve writes a public `goal` event that appears immediately as a
// timeline marker (onApproved lets the page refresh its events list).

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Check, Goal, Loader2, Undo2, X } from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'

interface GoalCandidate {
  id: string
  t0S: number
  t1S: number
  anchorS: number
  pko: number | null
  deadctx: number | null
  status: 'draft' | 'approved' | 'rejected' | 'error'
  error: string | null
  clipUrl: string | null
  approvedEventId: string | null
}

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

// Mirror of the batch job's clip window + the producer's goal estimate:
// clip starts at max(0, t0-90); the goal sits ~20s before the detected
// kickoff anchor (Veo-measured median goal->kickoff latency — landed 1s
// from the true goal on the pilot E2E).
const CLIP_PRE_S = 90
const EVENT_OFFSET_S = 20
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

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/recordings/${recordingId}/goal-candidates`,
          { signal }
        )
        if (!res.ok) return // silent — non-admins simply see nothing
        const json = (await res.json()) as { candidates?: GoalCandidate[] }
        if (!signal?.aborted) setCandidates(json.candidates ?? [])
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
    async (
      cand: GoalCandidate,
      action: 'approve' | 'unapprove' | 'reject' | 'restore'
    ) => {
      setBusyId(cand.id)
      setNotice(null)
      try {
        const res = await fetch(
          `/api/recordings/${recordingId}/goal-candidates/${cand.id}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action }),
          }
        )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string
            code?: string
          } | null
          // Localize the actionable codes; fall back to the server string
          // (English) only for unexpected ones.
          setNotice(
            body?.code === 'event_write_failed'
              ? t('approveRepairNotice')
              : body?.code === 'event_delete_failed'
                ? t('unapproveRepairNotice')
                : body?.code === 'invalid_state'
                  ? t('staleNotice')
                  : (body?.error ?? t('actionFailed'))
          )
          // event_write_failed leaves the repair state visible on refresh
          await refresh()
          return
        }
        if (action === 'approve') {
          setNotice(t('approvedNotice'))
          onApproved?.()
        } else if (action === 'unapprove') {
          setNotice(t('unapprovedNotice'))
          onApproved?.()   // refreshes the page's events — the marker is gone
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
          const repairing =
            cand.status === 'approved' && !cand.approvedEventId
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
                          onClick={() => act(cand, 'approve')}
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
                          onClick={() => act(cand, 'reject')}
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
                          onClick={() => act(cand, 'restore')}
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
                          onClick={() => act(cand, 'unapprove')}
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
            </div>
          )
        })}
      </div>
    </div>
  )
}
