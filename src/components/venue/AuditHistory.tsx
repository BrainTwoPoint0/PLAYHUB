'use client'

// Self-contained audit history panel for the venue management page.
// Lazy-fetches /api/venue/[venueId]/audit on mount and on "Load more".
// Uses the same frosted-card visual language as the share modal and the
// tag overlay so it feels native to the new watch surface.

import { useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
} from '@braintwopoint0/playback-commons/ui'
import {
  Loader2,
  ScrollText,
  ChevronDown,
  ChevronRight,
  Trash2,
  Pencil,
  UserPlus,
  UserMinus,
  ExternalLink,
} from 'lucide-react'

interface AuditActor {
  user_id: string
  username: string | null
}

interface AuditTargetRecording {
  id: string
  title: string
  home_team: string | null
  away_team: string | null
  match_date: string | null
}

interface AuditRow {
  id: string
  action: string
  target_type: string
  target_id: string | null
  target_recording_id: string | null
  was_admin_override: boolean
  metadata: Record<string, any> | null
  created_at: string
  actor: AuditActor | null
  target_recording: AuditTargetRecording | null
}

// Humanize the canonical action codes. Falls back to the raw code so
// future actions still render something sensible until we add a label.
// Maps action code → auditHistory.actions.* message key.
const ACTION_LABEL_KEY: Record<string, string> = {
  'recording_event.delete': 'deletedTag',
  'recording_event.update': 'editedTag',
  'recording_access.grant': 'grantedAccess',
  'recording_access.decline': 'declinedInvitation',
}

function actionMeta(action: string) {
  switch (action) {
    case 'recording_event.delete':
      return { Icon: Trash2, tint: 'text-red-300', tintBg: 'bg-red-400/10' }
    case 'recording_event.update':
      return {
        Icon: Pencil,
        tint: 'text-amber-300',
        tintBg: 'bg-amber-400/10',
      }
    case 'recording_access.grant':
      return {
        Icon: UserPlus,
        tint: 'text-emerald-300',
        tintBg: 'bg-emerald-400/10',
      }
    case 'recording_access.decline':
      return {
        Icon: UserMinus,
        tint: 'text-muted-foreground',
        tintBg: 'bg-white/[0.06]',
      }
    default:
      return {
        Icon: ScrollText,
        tint: 'text-muted-foreground',
        tintBg: 'bg-white/[0.06]',
      }
  }
}

interface AuditHistoryProps {
  venueId: string
}

export function AuditHistory({ venueId }: AuditHistoryProps) {
  const t = useTranslations('auditHistory')
  const format = useFormatter()
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Relative time (just-now / 3m ago / 2h ago / 5d ago / locale date).
  const relativeTime = (iso: string): string => {
    const d = new Date(iso)
    const diff = Date.now() - d.getTime()
    const sec = Math.floor(diff / 1000)
    if (sec < 60) return t('justNow')
    const min = Math.floor(sec / 60)
    if (min < 60) return t('minutesAgo', { count: min })
    const hr = Math.floor(min / 60)
    if (hr < 24) return t('hoursAgo', { count: hr })
    const day = Math.floor(hr / 24)
    if (day < 7) return t('daysAgo', { count: day })
    return format.dateTime(d, 'short')
  }

  const fetchPage = async (cursor: string | null) => {
    const url = new URL(`/api/venue/${venueId}/audit`, window.location.origin)
    if (cursor) url.searchParams.set('cursor', cursor)
    const res = await fetch(url.toString())
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data.error || t('loadFailed'))
    }
    return (await res.json()) as {
      rows: AuditRow[]
      next_cursor: string | null
    }
  }

  useEffect(() => {
    let mounted = true
    setLoading(true)
    setError(null)
    fetchPage(null)
      .then((data) => {
        if (!mounted) return
        setRows(data.rows)
        setNextCursor(data.next_cursor)
      })
      .catch((err) => {
        if (!mounted) return
        setError(err.message || t('loadFailedShort'))
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [venueId])

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const data = await fetchPage(nextCursor)
      setRows((prev) => [...prev, ...data.rows])
      setNextCursor(data.next_cursor)
    } catch (err: any) {
      setError(err.message || t('loadMoreFailed'))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <Card className="relative h-fit overflow-hidden border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2.5">
          <ScrollText className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base text-[var(--timberwolf)]">
            {t('title')}
          </CardTitle>
          {!loading && (
            <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-white/[0.06] px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
              {rows.length}
              {nextCursor ? '+' : ''}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {loading ? (
          <div className="flex items-center justify-center py-10 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin me-2" />
            {t('loading')}
          </div>
        ) : error ? (
          <div className="flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300">
            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
            {/* dir=auto: server errors arrive in English and must not render right-aligned in RTL */}
            <span dir="auto">{error}</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-white/[0.06] bg-white/[0.01] py-8 text-center">
            <ScrollText className="h-5 w-5 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground max-w-[260px]">
              {t('empty')}
            </p>
          </div>
        ) : (
          <ul className="-mx-2 space-y-0.5">
            {rows.map((row) => {
              const isExpanded = expandedId === row.id
              const meta = actionMeta(row.action)
              const Icon = meta.Icon
              const labelKey = ACTION_LABEL_KEY[row.action]
              const label = labelKey ? t(`actions.${labelKey}`) : row.action
              const actorName = row.actor?.username || t('unknownUser')
              return (
                <li
                  key={row.id}
                  className="group rounded-lg transition-colors hover:bg-white/[0.04]"
                >
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : row.id)}
                    className="flex w-full items-center gap-2.5 px-2 py-2 text-start"
                    aria-expanded={isExpanded}
                  >
                    {/* Action icon chip */}
                    <span
                      className={`grid h-7 w-7 flex-shrink-0 place-items-center rounded-md ${meta.tintBg} ${meta.tint}`}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </span>

                    {/* Action + actor */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-[var(--timberwolf)]">
                        <span className="font-medium">{actorName}</span>{' '}
                        <span className="text-muted-foreground">
                          {label.toLowerCase()}
                        </span>
                        {row.target_recording && (
                          <>
                            <span className="text-muted-foreground">
                              {' '}
                              {t('on')}{' '}
                            </span>
                            <span className="font-medium">
                              {row.target_recording.title}
                            </span>
                          </>
                        )}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground/70 tabular-nums">
                        {relativeTime(row.created_at)}
                        {row.was_admin_override && (
                          <span className="ms-2 rounded bg-amber-400/10 px-1 py-0.5 text-[9px] uppercase tracking-[0.1em] text-amber-300/80">
                            {t('adminOverride')}
                          </span>
                        )}
                      </p>
                    </div>

                    <span className="text-muted-foreground/60 flex-shrink-0">
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 rtl:rotate-180" />
                      )}
                    </span>
                  </button>

                  {/* Expanded details — pretty-print metadata + a link to
                      the recording so the admin can navigate to context. */}
                  {isExpanded && (
                    <div className="mx-2 mb-2 rounded-md border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                      <dl className="space-y-1.5 text-[11px]">
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">{t('when')}</dt>
                          <dd className="text-[var(--timberwolf)] font-mono tabular-nums">
                            {format.dateTime(new Date(row.created_at), 'full')}
                          </dd>
                        </div>
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">
                            {t('action')}
                          </dt>
                          <dd className="text-[var(--timberwolf)] font-mono">
                            {row.action}
                          </dd>
                        </div>
                        {row.actor?.user_id && (
                          <div className="flex justify-between gap-3">
                            <dt className="text-muted-foreground">
                              {t('actor')}
                            </dt>
                            <dd className="text-[var(--timberwolf)] font-mono truncate max-w-[200px]">
                              {row.actor.user_id}
                            </dd>
                          </div>
                        )}
                        {row.target_id && (
                          <div className="flex justify-between gap-3">
                            <dt className="text-muted-foreground">
                              {t('targetId')}
                            </dt>
                            <dd className="text-[var(--timberwolf)] font-mono truncate max-w-[200px]">
                              {row.target_id}
                            </dd>
                          </div>
                        )}
                        {row.target_recording && (
                          <div className="flex justify-between gap-3">
                            <dt className="text-muted-foreground">
                              {t('recording')}
                            </dt>
                            <dd>
                              <Link
                                href={`/watch/${row.target_recording.id}`}
                                className="inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200"
                              >
                                {t('open')}
                                <ExternalLink className="h-2.5 w-2.5" />
                              </Link>
                            </dd>
                          </div>
                        )}
                      </dl>
                      {row.metadata && Object.keys(row.metadata).length > 0 && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[10px] uppercase tracking-[0.14em] text-muted-foreground/70 hover:text-muted-foreground">
                            {t('rawMetadata')}
                          </summary>
                          <pre
                            dir="ltr"
                            className="mt-1.5 max-h-48 overflow-auto rounded bg-black/30 p-2 text-[10px] font-mono text-muted-foreground/80"
                          >
                            {JSON.stringify(row.metadata, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {nextCursor && !loading && (
          <div className="mt-3 flex justify-center">
            <Button
              size="sm"
              variant="outline"
              onClick={loadMore}
              disabled={loadingMore}
              className="h-8 px-3 text-xs border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.06] hover:border-white/[0.16]"
            >
              {loadingMore ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 me-1.5 animate-spin" />
                  {t('loadingMore')}
                </>
              ) : (
                t('loadMore')
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
