'use client'

// Venue-page "Pitch cameras" card: per-scene calibration status + the entry
// point into the marking surface. Fetches one status per Spiideo scene in
// parallel (venues have a handful at most) and reports them up so the
// schedule form can gate the pitch-focus picker on midline availability.

import { Ruler } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'

import { Button } from '@braintwopoint0/playback-commons/ui'
import { cn } from '@braintwopoint0/playback-commons/utils'
import { Link } from '@/i18n/navigation'
import { solveErrorBand } from '@/components/calibration/calibration-state'
import { hasMidline, type PitchMark } from '@/lib/panorama/pitch-marks'

export interface SceneCalibrationStatus {
  hasActive: boolean
  hasMidline: boolean
  reprojectionErrorPx: number | null
  /** Relative verdict band (same law as the result screen), null when unknown. */
  band: 'good' | 'ok' | 'bad' | null
  createdAt: string | null
}

interface SceneRef {
  id: string
  name: string
  provider?: 'spiideo' | 'clutch'
}

export interface PitchCamerasCardProps {
  venueId: string
  scenes: SceneRef[]
  onStatuses?: (statuses: Record<string, SceneCalibrationStatus>) => void
}

export function PitchCamerasCard({
  venueId,
  scenes,
  onStatuses,
}: PitchCamerasCardProps) {
  const t = useTranslations('venue.cameras')
  const format = useFormatter()
  const [statuses, setStatuses] = useState<Record<
    string,
    SceneCalibrationStatus
  > | null>(null)
  const [failed, setFailed] = useState(false)
  // Non-admins can see the venue page but the calibration API 403s — hide
  // the card for them rather than showing a permanent error.
  const [forbidden, setForbidden] = useState(false)

  const spiideoScenes = scenes.filter(
    (s) => (s.provider ?? 'spiideo') === 'spiideo'
  )

  useEffect(() => {
    if (spiideoScenes.length === 0) return
    let cancelled = false
    ;(async () => {
      // allSettled: one scene's transient failure must neither blank the
      // other scenes' statuses nor mislabel calibrated scenes as
      // "not calibrated" (rows with no entry render as unknown)
      const results = await Promise.allSettled(
        spiideoScenes.map(async (scene) => {
          const res = await fetch(
            `/api/venue/${venueId}/pitch-calibration?sceneId=${encodeURIComponent(scene.id)}`
          )
          if (res.status === 401 || res.status === 403) {
            if (!cancelled) setForbidden(true)
            throw new Error('forbidden')
          }
          if (!res.ok) throw new Error(`status ${res.status}`)
          const data = await res.json()
          const marks: PitchMark[] = data.active?.marks ?? []
          const status: SceneCalibrationStatus = {
            hasActive: !!data.active,
            hasMidline: !!data.active && hasMidline(marks),
            reprojectionErrorPx:
              data.active?.reprojection_error_px != null
                ? Number(data.active.reprojection_error_px)
                : null,
            band:
              data.active?.reprojection_error_px != null
                ? solveErrorBand(
                    Number(data.active.reprojection_error_px),
                    marks
                  )
                : null,
            createdAt: data.active?.created_at ?? null,
          }
          return [scene.id, status] as const
        })
      )
      if (cancelled) return
      const map: Record<string, SceneCalibrationStatus> = {}
      let anyFailed = false
      for (const r of results) {
        if (r.status === 'fulfilled') map[r.value[0]] = r.value[1]
        else anyFailed = true
      }
      if (anyFailed) {
        console.error(
          'Calibration statuses failed for some scenes:',
          results.filter((r) => r.status === 'rejected')
        )
        setFailed(true)
      }
      setStatuses(map)
      onStatuses?.(map)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venueId, scenes.map((s) => s.id).join(',')])

  if (spiideoScenes.length === 0 || forbidden) return null

  return (
    <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] p-6 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
      <div className="mb-1 flex items-center gap-2">
        <Ruler className="h-4 w-4 text-[var(--ash-grey)]" />
        <h2 className="text-lg font-semibold tracking-tight text-[var(--timberwolf)]">
          {t('title')}
        </h2>
      </div>
      <p className="mb-4 text-xs text-[var(--ash-grey)]">{t('subtitle')}</p>
      {failed && (
        <p className="mb-2 text-xs text-amber-400">{t('loadError')}</p>
      )}
      <ul className="divide-y divide-white/[0.05]">
        {spiideoScenes.map((scene) => {
          const status = statuses?.[scene.id]
          return (
            <li
              key={scene.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-[var(--timberwolf)]">
                  {scene.name}
                </p>
                {!statuses ? (
                  <div
                    aria-busy="true"
                    className="mt-1 h-3 w-40 animate-pulse rounded bg-white/[0.06]"
                  />
                ) : !status ? (
                  <p className="text-xs text-[var(--ash-grey)]">
                    {t('statusUnknown')}
                  </p>
                ) : status.hasActive ? (
                  <p
                    className={cn(
                      'text-xs',
                      // same relative band as the result screen — the venue
                      // card must not contradict the verdict the admin saw
                      status.band === 'ok'
                        ? 'text-amber-400'
                        : status.band === 'bad'
                          ? 'text-red-400'
                          : 'text-emerald-400'
                    )}
                  >
                    {[
                      status.reprojectionErrorPx != null
                        ? t('statusCalibrated', {
                            err: status.reprojectionErrorPx.toFixed(0),
                            date: status.createdAt
                              ? format.dateTime(new Date(status.createdAt), {
                                  dateStyle: 'medium',
                                })
                              : '—',
                          })
                        : t('statusCalibratedNoErr', {
                            date: status.createdAt
                              ? format.dateTime(new Date(status.createdAt), {
                                  dateStyle: 'medium',
                                })
                              : '—',
                          }),
                      status.hasMidline ? t('statusMidline') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                ) : (
                  <p className="text-xs text-[var(--ash-grey)]">
                    {t('statusNone')}
                  </p>
                )}
              </div>
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={`/venue/${venueId}/calibration/${scene.id}?name=${encodeURIComponent(scene.name)}`}
                >
                  {status?.hasActive ? t('recalibrate') : t('calibrate')}
                </Link>
              </Button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
