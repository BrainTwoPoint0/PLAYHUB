'use client'

// Pitch-calibration page client: loads the scene's still + mesh, drives the
// marking state machine, and saves through PUT /pitch-calibration.
//
// Load sequence: GET ?propose=1 (auth-gated; also returns the newest still's
// presigned URL + the mesh source game) → fetch the public mesh artifacts +
// probe the still's real dimensions → ready. Seeds: the ACTIVE row's marks on
// recalibration, else the occupancy proposal (systematically inset — the
// admin drags corners OUT to the painted lines), else guided placement.

import { ArrowLeft, Check, Loader2, TriangleAlert, XCircle } from 'lucide-react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import { Link, useRouter } from '@/i18n/navigation'

import { Button, Input, Label } from '@braintwopoint0/playback-commons/ui'
import {
  calibrationReducer,
  canSave,
  dimsValid,
  hasFullMidline,
  initialCalibrationState,
  nextMark,
  solveErrorBand,
  type CalibrationState,
} from '@/components/calibration/calibration-state'
import { CalibrationSurface } from '@/components/calibration/CalibrationSurface'
import type { SceneProjection } from '@/components/video/VirtualPanoramaPlayer'
import { meshBaseUrl } from '@/lib/panorama/mesh'
import {
  CORNER_MARK_NAMES,
  MARK_NAMES,
  MIDLINE_MARK_NAMES,
  PITCH_LENGTH_BOUNDS,
  PITCH_WIDTH_BOUNDS,
  type MarkName,
  type PitchMark,
} from '@/lib/panorama/pitch-marks'
import { cn } from '@braintwopoint0/playback-commons/utils'

interface CalibrationGetResponse {
  active: {
    marks: PitchMark[]
    pitch_length_m: number
    pitch_width_m: number
    reprojection_error_px: number | null
  } | null
  proposal: { marks: PitchMark[]; note: string } | null
  proposalStatus?: 'ok' | 'no_mesh' | 'no_tracklets' | 'unavailable'
  frame: { s3Key: string; url: string } | null
  meshSourceGameId: string | null
}

interface LoadedAssets {
  sceneJson: { projections: SceneProjection[] }
  verticesBin: ArrayBuffer
  indicesBin: ArrayBuffer
  frame: { s3Key: string; url: string }
  frameWidth: number
  frameHeight: number
  data: CalibrationGetResponse
}

type LoadPhase =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'no_mesh' }
  | { kind: 'no_frame'; proposalStatus?: string }
  | { kind: 'load_error' }
  | { kind: 'ready'; assets: LoadedAssets }

/** Probe the still's natural dimensions (also validates the presigned URL). */
async function probeImage(
  url: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () =>
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('still failed to load'))
    img.src = url
  })
}

export interface PitchCalibrationClientProps {
  venueId: string
  sceneId: string
  sceneName?: string
}

export function PitchCalibrationClient({
  venueId,
  sceneId,
  sceneName,
}: PitchCalibrationClientProps) {
  const t = useTranslations('venue.calibration')
  const router = useRouter()
  const [load, setLoad] = useState<LoadPhase>({ kind: 'loading' })
  const [state, dispatch] = useReducer(calibrationReducer, undefined, () =>
    initialCalibrationState()
  )
  const seededRef = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state

  const apiUrl = `/api/venue/${venueId}/pitch-calibration`
  const stillErrorOnce = useRef(false)

  const loadAll = useCallback(async () => {
    setLoad({ kind: 'loading' })
    try {
      const res = await fetch(
        `${apiUrl}?sceneId=${encodeURIComponent(sceneId)}&propose=1`
      )
      if (res.status === 401 || res.status === 403) {
        setLoad({ kind: 'forbidden' })
        return
      }
      if (!res.ok) throw new Error(`GET ${res.status}`)
      const data: CalibrationGetResponse = await res.json()
      if (!data.meshSourceGameId) {
        setLoad({ kind: 'no_mesh' })
        return
      }
      if (!data.frame) {
        setLoad({ kind: 'no_frame', proposalStatus: data.proposalStatus })
        return
      }
      const base = meshBaseUrl(data.meshSourceGameId)
      const [sceneRes, vertsRes, idxRes, dims] = await Promise.all([
        fetch(`${base}/scene.json`),
        fetch(`${base}/vertices.bin`),
        fetch(`${base}/indices.bin`),
        probeImage(data.frame.url),
      ])
      if (!sceneRes.ok || !vertsRes.ok || !idxRes.ok)
        throw new Error('mesh fetch failed')
      const assets: LoadedAssets = {
        sceneJson: await sceneRes.json(),
        verticesBin: await vertsRes.arrayBuffer(),
        indicesBin: await idxRes.arrayBuffer(),
        frame: data.frame,
        frameWidth: dims.width,
        frameHeight: dims.height,
        data,
      }
      // an expiry-refetch may return a NEWER still; if its resolution
      // differs, raw-frame-px marks must be rescaled or they save at the
      // wrong scale against the new frameWidth/Height
      setLoad((prev) => {
        if (
          prev.kind === 'ready' &&
          (prev.assets.frameWidth !== assets.frameWidth ||
            prev.assets.frameHeight !== assets.frameHeight)
        ) {
          const fx = assets.frameWidth / prev.assets.frameWidth
          const fy = assets.frameHeight / prev.assets.frameHeight
          dispatch({
            type: 'SEED',
            marks: stateRef.current.marks.map((m) => ({
              name: m.name,
              uv: [m.uv[0] * fx, m.uv[1] * fy] as [number, number],
            })),
          })
        }
        return { kind: 'ready', assets }
      })
      stillErrorOnce.current = false // a later expiry gets one more refetch
    } catch (err) {
      console.error('Calibration load failed:', err)
      setLoad({ kind: 'load_error' })
    }
  }, [apiUrl, sceneId])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  // Seed once per successful load: active row wins (recalibration), else the
  // occupancy proposal, else guided placement from scratch.
  useEffect(() => {
    if (load.kind !== 'ready' || seededRef.current) return
    seededRef.current = true
    const { data } = load.assets
    if (data.active) {
      dispatch({ type: 'SEED', marks: data.active.marks })
      dispatch({
        type: 'SET_DIMS',
        lengthM: Number(data.active.pitch_length_m),
        widthM: Number(data.active.pitch_width_m),
      })
    } else if (data.proposal) {
      dispatch({ type: 'SEED', marks: data.proposal.marks })
    }
  }, [load])

  // Presigned still expired mid-session: refetch for a fresh URL. The marks
  // and reducer state survive — only the assets reload. The latch resets on
  // every successful load, so each expiry gets exactly one refetch (a
  // genuinely broken still errors once per load, never in a loop).
  const onStillError = useCallback(() => {
    if (stillErrorOnce.current) return
    stillErrorOnce.current = true
    loadAll()
  }, [loadAll])

  const save = useCallback(async () => {
    if (load.kind !== 'ready' || !canSave(state)) return
    dispatch({ type: 'SAVE' })
    try {
      const res = await fetch(apiUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // a hung PUT must not leave "Solving…" spinning forever
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          sceneId,
          frameS3Key: load.assets.frame.s3Key,
          frameWidth: load.assets.frameWidth,
          frameHeight: load.assets.frameHeight,
          pitchLengthM: state.lengthM,
          pitchWidthM: state.widthM,
          marks: state.marks,
        }),
      })
      const body = await res.json().catch(() => null)
      if (
        res.ok &&
        body?.solve &&
        Number.isFinite(body.solve.reprojectionErrorPx)
      ) {
        dispatch({
          type: 'SOLVE_OK',
          solve: { ...body.solve, activated: body.activated !== false },
        })
        return
      }
      const code: string = body?.code ?? 'internal'
      const markName: MarkName | undefined =
        code === 'mark_unprojectable' &&
        (MARK_NAMES as readonly string[]).includes(body?.markName)
          ? (body.markName as MarkName)
          : undefined
      dispatch({ type: 'SOLVE_ERR', code, markName })
    } catch {
      dispatch({ type: 'SOLVE_ERR', code: 'network' })
    }
  }, [apiUrl, load, sceneId, state])

  const venueHref = `/venue/${venueId}`
  const hasUnsavedWork = state.marks.length > 0 && state.phase.kind !== 'result'
  useEffect(() => {
    if (!hasUnsavedWork) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [hasUnsavedWork])
  const leave = useCallback(() => {
    if (hasUnsavedWork && !window.confirm(t('leaveConfirm'))) return
    router.push(venueHref)
  }, [hasUnsavedWork, router, t, venueHref])

  // ---- non-ready screens ----
  if (load.kind !== 'ready') {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        {load.kind === 'loading' ? (
          <>
            <Loader2 className="h-6 w-6 animate-spin text-[var(--ash-grey)]" />
            <p className="text-sm text-[var(--ash-grey)]">{t('loading')}</p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold leading-none tracking-tight text-[var(--timberwolf)]">
              {t(
                load.kind === 'forbidden'
                  ? 'forbiddenTitle'
                  : load.kind === 'no_mesh'
                    ? 'noMeshTitle'
                    : load.kind === 'no_frame'
                      ? 'noFrameTitle'
                      : 'loadErrorTitle'
              )}
            </h1>
            <p className="max-w-md text-sm text-[var(--ash-grey)]">
              {t(
                load.kind === 'forbidden'
                  ? 'forbiddenBody'
                  : load.kind === 'no_mesh'
                    ? 'noMeshBody'
                    : load.kind === 'no_frame'
                      ? 'noFrameBody'
                      : 'loadErrorBody'
              )}
            </p>
            <div className="flex gap-2">
              {load.kind === 'load_error' && (
                <Button variant="outline" size="sm" onClick={loadAll}>
                  {t('retry')}
                </Button>
              )}
              <Button variant="ghost" size="sm" asChild>
                <Link href={venueHref}>
                  <ArrowLeft className="me-1 h-4 w-4 rtl:rotate-180" />
                  {t('back')}
                </Link>
              </Button>
            </div>
          </>
        )}
      </div>
    )
  }

  const { assets } = load
  const placing = nextMark(state)
  const proposal = assets.data.proposal
  const showProposalBanner = !!proposal && !assets.data.active

  return (
    <div className="flex h-[calc(100dvh-4rem)] flex-col gap-3 p-3 lg:flex-row lg:p-4">
      {/* marking surface */}
      <div className="min-h-[50vh] flex-1">
        <CalibrationSurface
          sceneJson={assets.sceneJson}
          verticesBin={assets.verticesBin}
          indicesBin={assets.indicesBin}
          stillUrl={assets.frame.url}
          frameWidth={assets.frameWidth}
          frameHeight={assets.frameHeight}
          marks={state.marks}
          selected={state.selected}
          errorMark={state.errorMark}
          placing={placing}
          onPlace={(uv) => dispatch({ type: 'PLACE', uv })}
          onDragMark={(name, uv) => dispatch({ type: 'DRAG', name, uv })}
          onSelectMark={(name) => dispatch({ type: 'SELECT', name })}
          onStillError={onStillError}
          labels={{
            zoomIn: t('zoomIn'),
            zoomOut: t('zoomOut'),
            resetView: t('resetView'),
            surface: t('surfaceLabel'),
          }}
        />
      </div>

      {/* side panel */}
      <aside className="flex w-full flex-col gap-4 overflow-y-auto rounded-xl border border-zinc-800 bg-[var(--night)] p-4 lg:w-[340px]">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-semibold leading-tight tracking-tight text-[var(--timberwolf)]">
              {t('title')}
            </h1>
            <p className="text-xs text-[var(--ash-grey)]">
              {sceneName || sceneId}
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={leave}
            aria-label={t('back')}
          >
            <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
          </Button>
        </div>

        {state.phase.kind === 'result' && state.solve ? (
          <ResultPanel
            state={state}
            onRedo={() => dispatch({ type: 'REDO' })}
            venueHref={venueHref}
          />
        ) : (
          <>
            {showProposalBanner && (
              <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-3 text-xs text-[var(--timberwolf)]">
                {t('proposalBanner')}
              </div>
            )}
            {assets.data.proposalStatus === 'no_tracklets' &&
              !assets.data.active && (
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-[var(--ash-grey)]">
                  {t('proposalNoTracklets')}
                </div>
              )}
            {assets.data.proposalStatus === 'unavailable' && (
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-xs text-[var(--ash-grey)]">
                {t('proposalUnavailable')}
              </div>
            )}

            {state.phase.kind === 'placing' && (
              <p className="text-xs text-[var(--ash-grey)]">
                {t('placingHint')}
              </p>
            )}

            <StepList state={state} placing={placing} />

            {state.phase.kind === 'midline_offer' && (
              <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
                <p className="text-sm font-medium text-[var(--timberwolf)]">
                  {t('midlineOfferTitle')}
                </p>
                <p className="text-xs text-[var(--ash-grey)]">
                  {t('midlineOfferBody')}
                </p>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => dispatch({ type: 'ADD_MIDLINE' })}
                  >
                    {t('addMidline')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => dispatch({ type: 'SKIP_MIDLINE' })}
                  >
                    {t('skipMidline')}
                  </Button>
                </div>
              </div>
            )}

            {state.phase.kind === 'adjusting' && (
              <div className="space-y-2">
                {!hasFullMidline(state.marks) ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => dispatch({ type: 'ADD_MIDLINE' })}
                  >
                    {t('addMidline')}
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => dispatch({ type: 'DELETE_MIDLINE' })}
                  >
                    {t('deleteMidline')}
                  </Button>
                )}
                {state.selected && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      dispatch({ type: 'REPLACE_MARK', name: state.selected! })
                    }
                  >
                    {t('replaceMark', { mark: t(`marks.${state.selected}`) })}
                  </Button>
                )}
                <p className="text-xs text-[var(--ash-grey)]">
                  {t('nudgeHint')}
                </p>
              </div>
            )}

            <DimsInputs state={state} dispatch={dispatch} />

            {state.errorMark && (
              <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-300">
                {t('errUnprojectable', { mark: t(`marks.${state.errorMark}`) })}
              </div>
            )}
            {state.errorCode && !state.errorMark && (
              <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-xs text-red-300">
                {t(
                  state.errorCode === 'mesh_unavailable' ||
                    state.errorCode === 'no_mesh'
                    ? 'errMeshUnavailable'
                    : 'errSaveFailed'
                )}
              </div>
            )}

            <Button
              className="mt-auto"
              disabled={!canSave(state) || state.phase.kind === 'solving'}
              onClick={save}
            >
              {state.phase.kind === 'solving' && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t(state.phase.kind === 'solving' ? 'saving' : 'save')}
            </Button>
          </>
        )}
      </aside>
    </div>
  )
}

function StepList({
  state,
  placing,
}: {
  state: CalibrationState
  placing: MarkName | null
}) {
  const t = useTranslations('venue.calibration')
  const placed = new Set(state.marks.map((m) => m.name))
  const steps: MarkName[] = [
    ...CORNER_MARK_NAMES,
    ...(placed.has('midline_n') ||
    placed.has('midline_s') ||
    (state.phase.kind === 'placing' &&
      state.phase.queue.some((n) =>
        (MIDLINE_MARK_NAMES as readonly string[]).includes(n)
      ))
      ? MIDLINE_MARK_NAMES
      : []),
  ]
  return (
    <ol className="space-y-1.5">
      {steps.map((name) => {
        const isDone = placed.has(name)
        const isNext = placing === name
        return (
          <li
            key={name}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
              isNext
                ? 'bg-emerald-950/40 text-[var(--timberwolf)]'
                : isDone
                  ? 'text-[var(--timberwolf)]'
                  : 'text-[var(--ash-grey)]'
            )}
          >
            <span
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border text-[10px]',
                isDone
                  ? 'border-emerald-500 bg-emerald-500/15 text-emerald-400'
                  : isNext
                    ? 'border-emerald-400 text-emerald-400'
                    : 'border-zinc-700'
              )}
            >
              {isDone ? <Check className="h-3 w-3" /> : null}
            </span>
            <span className="flex-1">{t(`marks.${name}`)}</span>
            {isNext && (
              <span className="text-[10px] uppercase tracking-wide text-emerald-400">
                {t('clickToPlace')}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function DimsInputs({
  state,
  dispatch,
}: {
  state: CalibrationState
  dispatch: React.Dispatch<Parameters<typeof calibrationReducer>[1]>
}) {
  const t = useTranslations('venue.calibration')
  const lengthBad =
    Number.isFinite(state.lengthM) &&
    (state.lengthM < PITCH_LENGTH_BOUNDS[0] ||
      state.lengthM > PITCH_LENGTH_BOUNDS[1])
  const widthBad =
    Number.isFinite(state.widthM) &&
    (state.widthM < PITCH_WIDTH_BOUNDS[0] ||
      state.widthM > PITCH_WIDTH_BOUNDS[1])
  return (
    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <p className="text-sm font-medium text-[var(--timberwolf)]">
        {t('dimsTitle')}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor="pitch-length" className="text-xs">
            {t('lengthLabel')}
          </Label>
          <Input
            id="pitch-length"
            type="number"
            min={PITCH_LENGTH_BOUNDS[0]}
            max={PITCH_LENGTH_BOUNDS[1]}
            aria-invalid={lengthBad}
            value={Number.isFinite(state.lengthM) ? state.lengthM : ''}
            onChange={(e) =>
              dispatch({
                type: 'SET_DIMS',
                lengthM: e.target.valueAsNumber,
                widthM: state.widthM,
              })
            }
            className={cn('bg-zinc-800', lengthBad && 'border-amber-500/60')}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pitch-width" className="text-xs">
            {t('widthLabel')}
          </Label>
          <Input
            id="pitch-width"
            type="number"
            min={PITCH_WIDTH_BOUNDS[0]}
            max={PITCH_WIDTH_BOUNDS[1]}
            aria-invalid={widthBad}
            value={Number.isFinite(state.widthM) ? state.widthM : ''}
            onChange={(e) =>
              dispatch({
                type: 'SET_DIMS',
                lengthM: state.lengthM,
                widthM: e.target.valueAsNumber,
              })
            }
            className={cn('bg-zinc-800', widthBad && 'border-amber-500/60')}
          />
        </div>
      </div>
      <p
        className={cn(
          'text-xs',
          dimsValid(state) ? 'text-[var(--ash-grey)]' : 'text-amber-400'
        )}
      >
        {t('dimsHint', {
          minL: PITCH_LENGTH_BOUNDS[0],
          maxL: PITCH_LENGTH_BOUNDS[1],
          minW: PITCH_WIDTH_BOUNDS[0],
          maxW: PITCH_WIDTH_BOUNDS[1],
        })}
      </p>
    </div>
  )
}

function ResultPanel({
  state,
  onRedo,
  venueHref,
}: {
  state: CalibrationState
  onRedo: () => void
  venueHref: string
}) {
  const t = useTranslations('venue.calibration')
  const solve = state.solve!
  const err = solve.reprojectionErrorPx
  // relative to the pitch's on-screen span — absolute px thresholds misread
  // venue-fit distortion as bad marking. The server's verdict wins when
  // present (it decided activation); recompute only for old responses.
  const band = solve.band ?? solveErrorBand(err, state.marks)
  const BandIcon =
    band === 'good' ? Check : band === 'ok' ? TriangleAlert : XCircle
  const perMark = Object.entries(solve.perMarkErrorRad).sort(
    ([, a], [, b]) => b - a
  )
  const worst = perMark[0]?.[0]
  return (
    <div className="space-y-3">
      <div
        className={cn(
          'rounded-lg border p-4',
          band === 'good' && 'border-emerald-900/60 bg-emerald-950/30',
          band === 'ok' && 'border-amber-900/60 bg-amber-950/30',
          band === 'bad' && 'border-red-900/60 bg-red-950/30'
        )}
      >
        <p className="flex items-center gap-1.5 text-sm font-medium text-[var(--timberwolf)]">
          <BandIcon
            className={cn(
              'h-4 w-4',
              band === 'good' && 'text-emerald-400',
              band === 'ok' && 'text-amber-400',
              band === 'bad' && 'text-red-400'
            )}
          />
          {t(
            band === 'good'
              ? 'resultGood'
              : band === 'ok'
                ? 'resultOk'
                : 'resultBad'
          )}
        </p>
        <p
          className={cn(
            'mt-1 text-3xl font-semibold leading-none tracking-tight tabular-nums',
            band === 'good' && 'text-emerald-400',
            band === 'ok' && 'text-amber-400',
            band === 'bad' && 'text-red-400'
          )}
        >
          {t('reprojectionError', { px: err.toFixed(1) })}
        </p>
        <p className="mt-2 text-xs text-[var(--ash-grey)]">
          {t(
            band === 'good'
              ? 'resultGoodHint'
              : band === 'ok'
                ? 'resultOkHint'
                : 'resultBadHint',
            {
              mark: worst
                ? (MARK_NAMES as readonly string[]).includes(worst)
                  ? t(`marks.${worst}`)
                  : worst
                : '',
            }
          )}
        </p>
      </div>
      <div className="space-y-1">
        {perMark.map(([name, rad]) => (
          <div
            key={name}
            className="flex items-center justify-between text-xs text-[var(--ash-grey)]"
          >
            <span>
              {(MARK_NAMES as readonly string[]).includes(name)
                ? t(`marks.${name}`)
                : name}
            </span>
            <span className="tabular-nums">
              {solve.perMarkErrorPx?.[name] != null
                ? t('reprojectionError', {
                    px: solve.perMarkErrorPx[name].toFixed(0),
                  })
                : `${((rad * 180) / Math.PI).toFixed(2)}°`}
            </span>
          </div>
        ))}
      </div>
      <p className="text-xs text-[var(--ash-grey)]">
        {solve.activated === false ? t('redoNoteInactive') : t('redoNote')}
      </p>
      <div className="flex gap-2">
        {band === 'bad' ? (
          <>
            <Button onClick={onRedo}>{t('redo')}</Button>
            <Button variant="outline" asChild>
              <Link href={venueHref}>{t('accept')}</Link>
            </Button>
          </>
        ) : (
          <>
            <Button asChild>
              <Link href={venueHref}>{t('accept')}</Link>
            </Button>
            <Button variant="outline" onClick={onRedo}>
              {t('redo')}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
