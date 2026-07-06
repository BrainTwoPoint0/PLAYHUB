'use client'

// Venue-level padel analytics card (Clutch venues only). Self-fetching and
// self-hiding: renders nothing while loading, on error, and for venues with
// zero Clutch recordings — Spiideo-only venues never see it.

import { useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@braintwopoint0/playback-commons/ui'
import type { ChartConfig } from '@braintwopoint0/playback-commons/ui'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid } from 'recharts'

interface ClutchSummary {
  totalRecordings: number
  withStats: number
  totalInPlayMinutes: number
  avgRallyShots: number | null
  avgRallySeconds: number | null
  longestRally: {
    shots: number
    seconds: number | null
    recordingId: string
    title: string
    matchDate: string
  } | null
  namedPlayers: number
  courts: string[]
  days: Array<{ date: string; total: number; byCourt: Record<string, number> }>
}

const COURT_COLORS = [
  'hsl(160, 70%, 45%)',
  'hsl(217, 91%, 60%)',
  'hsl(47, 96%, 53%)',
  'hsl(280, 65%, 60%)',
  'hsl(15, 90%, 55%)',
]

export function ClutchVenueStats({ venueId }: { venueId: string }) {
  const t = useTranslations('venueStats')
  const format = useFormatter()
  const [summary, setSummary] = useState<ClutchSummary | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/venue/${venueId}/clutch/summary`, {
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setSummary(data))
      .catch(() => {})
    return () => controller.abort()
  }, [venueId])

  // Guard the shape, not just presence — a 200 with an unexpected body
  // (e.g. an error payload) must not white-screen the whole venue page.
  if (
    !summary ||
    !Array.isArray(summary.days) ||
    !Array.isArray(summary.courts) ||
    summary.totalRecordings === 0
  )
    return null

  // Chart rows: one series per court
  const chartData = summary.days.map((d) => ({
    date: d.date,
    ...Object.fromEntries(
      summary.courts.map((court) => [court, d.byCourt[court] || 0])
    ),
  }))
  const chartConfig = Object.fromEntries(
    summary.courts.map((court, i) => [
      court,
      { label: court, color: COURT_COLORS[i % COURT_COLORS.length] },
    ])
  ) as ChartConfig

  const inPlayHours = summary.totalInPlayMinutes / 60

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] p-6 mb-6">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
          {t('title')}
        </h2>
        <span className="inline-flex items-center rounded-full bg-emerald-400/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-400/20">
          {t('recordingsBadge', { count: summary.totalRecordings })}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div className="p-3 bg-muted rounded-lg">
          <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
            {t('timeInPlay')}
          </p>
          <p className="text-[var(--timberwolf)] font-medium">
            {inPlayHours >= 1
              ? t('hours', { hours: inPlayHours.toFixed(1) })
              : t('minutes', {
                  minutes: Math.round(summary.totalInPlayMinutes),
                })}
          </p>
        </div>
        <div className="p-3 bg-muted rounded-lg">
          <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
            {t('avgRally')}
          </p>
          <p className="text-[var(--timberwolf)] font-medium">
            {summary.avgRallyShots != null
              ? t('shots', { count: summary.avgRallyShots })
              : '—'}
            {summary.avgRallySeconds != null && (
              <span className="text-muted-foreground">
                {' '}
                ·{' '}
                {t('seconds', { seconds: Math.round(summary.avgRallySeconds) })}
              </span>
            )}
          </p>
        </div>
        <div className="p-3 bg-muted rounded-lg">
          <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
            {t('longestRally')}
          </p>
          {summary.longestRally ? (
            <Link
              href={`/watch/${summary.longestRally.recordingId}?from=venue:${venueId}`}
              className="text-emerald-300 font-medium underline decoration-emerald-400/30 underline-offset-2 hover:decoration-emerald-300 transition-colors"
              title={summary.longestRally.title}
            >
              {t('shots', { count: summary.longestRally.shots })}
              {summary.longestRally.seconds != null && (
                <span className="text-muted-foreground">
                  {' '}
                  ·{' '}
                  {t('seconds', {
                    seconds: Math.round(summary.longestRally.seconds),
                  })}
                </span>
              )}{' '}
              {t('openArrow')}
            </Link>
          ) : (
            <p className="text-[var(--timberwolf)] font-medium">—</p>
          )}
        </div>
        <div
          className="p-3 bg-muted rounded-lg"
          title={t('playersIdentifiedTitle')}
        >
          <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
            {t('playersIdentified')}
          </p>
          <p className="text-[var(--timberwolf)] font-medium">
            {summary.namedPlayers}
          </p>
        </div>
      </div>

      {summary.courts.length > 0 && (
        <div className="mt-5">
          <p className="text-sm text-muted-foreground mb-2">
            {t('perCourtLast30')}
          </p>
          <p className="sr-only">
            {summary.courts
              .map((court) =>
                t('courtSummary', {
                  court,
                  count: summary.days.reduce(
                    (n, d) => n + (d.byCourt[court] || 0),
                    0
                  ),
                })
              )
              .join('; ')}
          </p>
          <div dir="ltr">
            <ChartContainer config={chartConfig} className="h-[200px] w-full">
              <AreaChart data={chartData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="hsl(var(--border))"
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => {
                    const day = parseInt(d.split('-')[2], 10)
                    if (day === 1) {
                      return format.dateTime(new Date(d + 'T00:00:00'), {
                        numberingSystem: 'latn',
                        day: 'numeric',
                        month: 'short',
                      })
                    }
                    return day % 5 === 1 ? String(day) : ''
                  }}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  allowDecimals={false}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(label: string) => {
                        const d = new Date(label + 'T00:00:00')
                        return format.dateTime(d, {
                          numberingSystem: 'latn',
                          day: 'numeric',
                          month: 'short',
                        })
                      }}
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                {summary.courts.map((court, i) => (
                  <Area
                    key={court}
                    type="monotone"
                    dataKey={court}
                    stackId="1"
                    fill={COURT_COLORS[i % COURT_COLORS.length]}
                    fillOpacity={0.4}
                    stroke={COURT_COLORS[i % COURT_COLORS.length]}
                    strokeWidth={1.5}
                  />
                ))}
              </AreaChart>
            </ChartContainer>
          </div>
        </div>
      )}
    </div>
  )
}
