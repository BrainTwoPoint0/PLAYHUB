'use client'

// Clutch AI panel for padel recordings: match stats, player annotation
// (crop → name), and the per-rally highlight browser. Mounted only for
// Clutch recordings (WatchClient gates on recording.isClutch); a 404 from
// the API (e.g. recording republished without Clutch data) hides the panel,
// any other failure shows a retry card — a paying customer must never get
// a silent blank.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from '@braintwopoint0/playback-commons/ui'
import { cn } from '@braintwopoint0/playback-commons/utils'
import { Check, Pencil, Play, RefreshCw, X } from 'lucide-react'

// ── API payload types ───────────────────────────────────────────────

interface PlayerStats {
  distanceRunMeters: number | null
  nShots: number | null
  winnerShots: number | null
  errorShots: number | null
  rating: number | null
}

interface ClutchPlayer {
  playerId: string
  displayName: string | null
  isGroundTruth: boolean
  cropUrl: string | null
  pair: string | null
  stats: PlayerStats | null
}

interface ClipEntry {
  url: string
  thumbUrl: string | null
}

interface ClutchData {
  stats: {
    matchTimeMinutes: number | null
    matchTimeInPlayMinutes: number | null
    avgRallyShots: number | null
    avgRallySeconds: number | null
    longestRallyShots: number | null
    longestRallySeconds: number | null
  } | null
  players: ClutchPlayer[]
  clips: {
    full: Partial<
      Record<'matchWoBreaks' | 'clutchAutopan' | 'clutchLandscape', ClipEntry>
    >
    selectors: Record<string, Record<string, ClipEntry[]>>
  } | null
}

interface ClutchPanelProps {
  recordingId: string
  canLabel: boolean
}

// Translation keys under `watch.clutch.*` for the rally-selector pills and
// full-length clip buttons. Unknown API keys fall back to the raw key.
const SELECTOR_LABEL_KEYS: Record<string, string> = {
  longest_rally: 'longestRallies',
  rating_based: 'topPace',
  pose_based: 'playerPicks',
}

const FULL_LABEL_KEYS: Record<string, string> = {
  clutchLandscape: 'highlightReel',
  clutchAutopan: 'highlightReelVertical',
  matchWoBreaks: 'matchWithoutBreaks',
}

// Pause every other <video> on the page when a clip starts — prevents the
// rally clip and the main match player talking over each other.
function pauseOtherVideos(current: HTMLVideoElement) {
  document.querySelectorAll('video').forEach((v) => {
    if (v !== current && !v.paused) v.pause()
  })
}

export default function ClutchPanel({
  recordingId,
  canLabel,
}: ClutchPanelProps) {
  const t = useTranslations('watch.clutch')
  const tc = useTranslations('common')
  const formatMinutes = (min: number | null): string =>
    min == null ? '—' : t('minutes', { minutes: Math.round(min) })
  const [data, setData] = useState<ClutchData | null>(null)
  const [loadState, setLoadState] = useState<
    'loading' | 'ready' | 'hidden' | 'error'
  >('loading')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [activeClip, setActiveClip] = useState<ClipEntry | null>(null)
  const [activeSelector, setActiveSelector] = useState<string>('longest_rally')
  const [clipError, setClipError] = useState(false)
  const clipPlayerRef = useRef<HTMLVideoElement | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/recordings/${recordingId}/clutch`)
      if (res.status === 404) {
        // Genuinely no Clutch data — hide quietly.
        setLoadState('hidden')
        return
      }
      if (!res.ok) throw new Error(`${res.status}`)
      setData(await res.json())
      setLoadState('ready')
      // Fresh signed URLs invalidate the previously selected clip.
      setActiveClip(null)
      setClipError(false)
    } catch {
      // Keep any data we already have; only show the error card when we
      // have nothing at all.
      setLoadState((s) => (s === 'ready' ? 'ready' : 'error'))
    }
  }, [recordingId])

  useEffect(() => {
    load()
  }, [load])

  // Bring the inline player into view when a clip is picked from the grid.
  useEffect(() => {
    if (activeClip && clipPlayerRef.current) {
      clipPlayerRef.current.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      })
    }
  }, [activeClip])

  if (loadState === 'loading' || loadState === 'hidden') return null

  if (loadState === 'error' && !data) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-6 flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5 me-1.5" />
            {tc('retry')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!data) return null
  const { stats, players, clips } = data

  // Per-match ordinal fallbacks ("Player 1"), not raw tracker ids
  // ("player-187" reads like a glitch). Stable: ordered by playerId.
  const ordinals = new Map<string, string>(
    [...players]
      .sort((a, b) => a.playerId.localeCompare(b.playerId))
      .map((p, i) => [p.playerId, t('playerOrdinal', { num: i + 1 })])
  )
  const nameFor = (p: ClutchPlayer) =>
    p.displayName ?? ordinals.get(p.playerId) ?? p.playerId

  const selectorClips = clips?.selectors?.autopan ?? {}
  const availableSelectors = Object.entries(selectorClips)
    .filter(([, entries]) => entries.length > 0)
    .map(([selector]) => selector)
  const currentSelector = availableSelectors.includes(activeSelector)
    ? activeSelector
    : availableSelectors[0]
  const hasClips =
    clips !== null &&
    (Object.keys(clips.full).length > 0 || availableSelectors.length > 0)

  const hasAnything = stats || players.length > 0 || hasClips
  if (!hasAnything) return null

  const unlabeledCount = players.filter((p) => !p.displayName).length

  // ── labeling ──────────────────────────────────────────────────────

  const startEdit = (player: ClutchPlayer) => {
    if (!canLabel) return
    setSaveError(null)
    setEditingId(player.playerId)
    setEditValue(player.displayName ?? '')
  }

  const saveLabel = async (playerId: string, displayName: string | null) => {
    if (!data) return
    const prevName =
      data.players.find((p) => p.playerId === playerId)?.displayName ?? null
    // Optimistic update; rollback is scoped to THIS player so a concurrent
    // successful save of another player is never clobbered.
    setData((d) =>
      d
        ? {
            ...d,
            players: d.players.map((p) =>
              p.playerId === playerId ? { ...p, displayName } : p
            ),
          }
        : d
    )
    setEditingId(null)
    setSaveError(null)
    setSaving(true)
    try {
      const res = await fetch(`/api/recordings/${recordingId}/clutch`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels: [{ playerId, displayName }] }),
      })
      if (!res.ok) throw new Error()
    } catch {
      setData((d) =>
        d
          ? {
              ...d,
              players: d.players.map((p) =>
                p.playerId === playerId ? { ...p, displayName: prevName } : p
              ),
            }
          : d
      )
      // Reopen the editor with the attempted value so the work isn't lost.
      setEditingId(playerId)
      setEditValue(displayName ?? '')
      setSaveError(t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Match stats ─────────────────────────────────────────── */}
      {stats && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-[var(--timberwolf)]">
              {t('matchStats')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                  {t('matchTime')}
                </p>
                <p className="text-[var(--timberwolf)] font-medium">
                  {formatMinutes(stats.matchTimeMinutes)}
                </p>
              </div>
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                  {t('inPlay')}
                </p>
                <p className="text-[var(--timberwolf)] font-medium">
                  {formatMinutes(stats.matchTimeInPlayMinutes)}
                </p>
              </div>
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                  {t('avgRally')}
                </p>
                <p className="text-[var(--timberwolf)] font-medium">
                  {t('shotsValue', { value: stats.avgRallyShots ?? '—' })}
                  {stats.avgRallySeconds != null && (
                    <span className="text-muted-foreground">
                      {' '}
                      ·{' '}
                      {t('secondsShort', {
                        seconds: Math.round(stats.avgRallySeconds),
                      })}
                    </span>
                  )}
                </p>
              </div>
              <div className="p-3 bg-muted rounded-lg">
                <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                  {t('longestRally')}
                </p>
                <p className="text-[var(--timberwolf)] font-medium">
                  {t('shotsValue', { value: stats.longestRallyShots ?? '—' })}
                  {stats.longestRallySeconds != null && (
                    <span className="text-muted-foreground">
                      {' '}
                      ·{' '}
                      {t('secondsShort', {
                        seconds: Math.round(stats.longestRallySeconds),
                      })}
                    </span>
                  )}
                </p>
              </div>
            </div>

            {/* Per-player table. Distance hides on mobile so the headline
                Rating column stays on-screen (global CSS hides scrollbars,
                so off-screen columns would be undiscoverable). */}
            {players.some((p) => p.stats) && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-start text-muted-foreground text-[10px] uppercase tracking-[0.14em]">
                      <th scope="col" className="pb-2 pe-3 font-medium">
                        {t('player')}
                      </th>
                      <th
                        scope="col"
                        className="pb-2 pe-3 font-medium text-end"
                      >
                        {t('shots')}
                      </th>
                      <th
                        scope="col"
                        className="pb-2 pe-3 font-medium text-end"
                      >
                        {t('winners')}
                      </th>
                      <th
                        scope="col"
                        className="pb-2 pe-3 font-medium text-end"
                      >
                        {t('errors')}
                      </th>
                      <th
                        scope="col"
                        className="pb-2 pe-3 font-medium text-end hidden sm:table-cell"
                      >
                        {t('distance')}
                      </th>
                      <th scope="col" className="pb-2 font-medium text-end">
                        {t('rating')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {players
                      .filter((p) => p.stats)
                      .map((p) => (
                        <tr
                          key={p.playerId}
                          className="border-t border-border/60"
                        >
                          <th
                            scope="row"
                            className="py-2 pe-3 text-start text-[var(--timberwolf)] font-medium"
                          >
                            {nameFor(p)}
                          </th>
                          <td className="py-2 pe-3 text-end text-[var(--timberwolf)]">
                            {p.stats!.nShots ?? '—'}
                          </td>
                          <td className="py-2 pe-3 text-end text-emerald-300">
                            {p.stats!.winnerShots ?? '—'}
                          </td>
                          <td className="py-2 pe-3 text-end text-red-300/80">
                            {p.stats!.errorShots ?? '—'}
                          </td>
                          <td className="py-2 pe-3 text-end text-[var(--timberwolf)] hidden sm:table-cell">
                            {p.stats!.distanceRunMeters != null
                              ? t('km', {
                                  km: (
                                    p.stats!.distanceRunMeters / 1000
                                  ).toFixed(1),
                                })
                              : '—'}
                          </td>
                          <td className="py-2 text-end">
                            {p.stats!.rating != null ? (
                              <span className="inline-flex items-center rounded-full bg-emerald-400/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-400/20">
                                {p.stats!.rating.toFixed(1)}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {t('ratingScale')}
                  {canLabel && unlabeledCount > 0 && (
                    <span> · {t('identifyPrompt')}</span>
                  )}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Players (crops + labeling) ─────────────────────────────── */}
      {players.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-[var(--timberwolf)]">
              {t('playersTitle')}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              {canLabel ? t('labelHint') : t('labelHintReadOnly')}
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            {saveError && (
              <p className="text-xs text-red-300" role="alert">
                {saveError}
              </p>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {players.map((player) => (
                <div
                  key={player.playerId}
                  className="rounded-lg bg-muted p-2 space-y-2"
                >
                  <div className="aspect-[3/4] rounded-md overflow-hidden bg-black/30 flex items-center justify-center">
                    {player.cropUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- signed expiring URL; next/image can't optimize it
                      <img
                        src={player.cropUrl}
                        alt={nameFor(player)}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="text-[10px] text-muted-foreground px-2 text-center">
                        {t('noPhoto')}
                      </span>
                    )}
                  </div>

                  {editingId === player.playerId ? (
                    <div className="space-y-1.5">
                      <Input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        maxLength={60}
                        autoFocus
                        placeholder={t('namePlaceholder')}
                        aria-label={t('nameFor', { name: nameFor(player) })}
                        className="h-8 text-xs bg-zinc-800 text-white"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && editValue.trim() && !saving)
                            saveLabel(player.playerId, editValue.trim())
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                      />
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 flex-1 text-xs"
                          disabled={!editValue.trim() || saving}
                          aria-label={t('saveName')}
                          onClick={() =>
                            saveLabel(player.playerId, editValue.trim())
                          }
                        >
                          <Check className="h-3.5 w-3.5 me-1" />
                          {tc('save')}
                        </Button>
                        {player.displayName && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 text-xs text-muted-foreground"
                            disabled={saving}
                            aria-label={t('removeName')}
                            onClick={() => saveLabel(player.playerId, null)}
                          >
                            {t('clearName')}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          aria-label={tc('cancel')}
                          onClick={() => setEditingId(null)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : canLabel ? (
                    // Whole row is the tap target — "tap a name" must mean
                    // exactly that, and 24px icon-only targets miss on touch.
                    <button
                      type="button"
                      onClick={() => startEdit(player)}
                      aria-label={t('editNameFor', { name: nameFor(player) })}
                      className="flex w-full items-center justify-between gap-1 min-h-9 rounded px-1 -mx-1 hover:bg-white/5 transition-colors"
                    >
                      <span
                        className={cn(
                          'text-xs font-medium truncate',
                          player.displayName
                            ? 'text-[var(--timberwolf)]'
                            : 'text-muted-foreground italic'
                        )}
                      >
                        {nameFor(player)}
                      </span>
                      <Pencil className="h-3 w-3 shrink-0 text-muted-foreground" />
                    </button>
                  ) : (
                    <p
                      className={cn(
                        'text-xs font-medium truncate min-h-9 flex items-center px-1',
                        player.displayName
                          ? 'text-[var(--timberwolf)]'
                          : 'text-muted-foreground italic'
                      )}
                    >
                      {nameFor(player)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Highlights ─────────────────────────────────────────────── */}
      {hasClips && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base text-[var(--timberwolf)]">
              {t('highlights')}
            </CardTitle>
            {clipError && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={load}
              >
                <RefreshCw className="h-3 w-3 me-1.5" />
                {t('refreshClips')}
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Inline player for the selected clip (separate from the main
                match player, which carries event/progress state) */}
            {activeClip && (
              <video
                key={activeClip.url}
                ref={clipPlayerRef}
                controls
                autoPlay
                poster={activeClip.thumbUrl ?? undefined}
                src={activeClip.url}
                className="w-full rounded-lg bg-black"
                onPlay={(e) => pauseOtherVideos(e.currentTarget)}
                onError={() => setClipError(true)}
              />
            )}

            {/* Full-length variants */}
            <div className="flex flex-wrap gap-2">
              {Object.entries(clips!.full).map(([key, entry]) =>
                entry ? (
                  <Button
                    key={key}
                    variant="outline"
                    size="sm"
                    aria-pressed={activeClip?.url === entry.url}
                    className={cn(
                      'text-xs',
                      activeClip?.url === entry.url &&
                        'border-emerald-400/40 text-emerald-300'
                    )}
                    onClick={() => setActiveClip(entry)}
                  >
                    <Play className="h-3 w-3 me-1.5" />
                    {FULL_LABEL_KEYS[key] ? t(FULL_LABEL_KEYS[key]) : key}
                  </Button>
                ) : null
              )}
            </div>

            {/* Per-rally clips by selector */}
            {availableSelectors.length > 0 && (
              <div className="space-y-3">
                <div
                  className="flex flex-wrap gap-1.5"
                  role="group"
                  aria-label={t('highlightCategories')}
                >
                  {availableSelectors.map((selector) => (
                    <button
                      key={selector}
                      onClick={() => setActiveSelector(selector)}
                      aria-pressed={selector === currentSelector}
                      className={cn(
                        'rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors',
                        selector === currentSelector
                          ? 'bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/20'
                          : 'bg-muted text-muted-foreground hover:text-[var(--timberwolf)]'
                      )}
                    >
                      {selector === currentSelector && (
                        <Check className="inline h-3 w-3 me-1 -mt-px" />
                      )}
                      {SELECTOR_LABEL_KEYS[selector]
                        ? t(SELECTOR_LABEL_KEYS[selector])
                        : selector}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {(selectorClips[currentSelector] ?? []).map((entry, i) => (
                    <button
                      key={entry.url}
                      onClick={() => setActiveClip(entry)}
                      aria-label={t('playRally', { num: i + 1 })}
                      className={cn(
                        'group relative aspect-video rounded-lg overflow-hidden bg-muted text-left',
                        activeClip?.url === entry.url &&
                          'ring-2 ring-emerald-400/40'
                      )}
                    >
                      {entry.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- signed expiring URL
                        <img
                          src={entry.thumbUrl}
                          alt=""
                          className="h-full w-full object-cover transition-transform group-hover:scale-105"
                          onError={(e) => {
                            // Expired/broken thumb → hide, the tile fallback
                            // text below stays usable.
                            e.currentTarget.style.display = 'none'
                          }}
                        />
                      ) : null}
                      <div className="absolute inset-0 flex items-center justify-center bg-black/10 group-hover:bg-black/30 transition-colors">
                        <Play className="h-6 w-6 text-white/80 group-hover:text-white transition-colors drop-shadow" />
                      </div>
                      <span className="absolute bottom-1.5 start-2 text-[10px] font-medium text-white drop-shadow">
                        {t('rally', { num: i + 1 })}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
