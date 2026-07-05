'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Card,
  CardContent,
  Badge,
  Button,
  Skeleton,
  EmptyState,
} from '@braintwopoint0/playback-commons/ui'
import { cn } from '@braintwopoint0/playback-commons/utils'
import {
  Activity,
  Gauge,
  Video,
  Camera,
  RefreshCw,
  Wifi,
  WifiOff,
  AlertTriangle,
  Loader2,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────

interface SceneHealth {
  sceneId: string
  sceneName: string | null
  organizationId: string | null
  venueName: string | null
  online: boolean | null
  alertState: string | null
  cameraCount: number | null
  onlineCameras: number | null
  outages: number | null
  lastOnlineChange: string | null
  lastCheckedAt: string | null
  lastSnapshotAt: string | null
  lastSnapshotStatus: string | null
  snapshotUrl: string | null
}
interface Summary {
  total: number
  online: number
  attention: number
}
interface SpeedTest {
  state: string
  connectionQuality: string | null
  meanUploadSpeedMbps: number | null
}
type Which = 'speed' | 'recording' | 'snapshot'
type ActionState =
  | { kind: 'idle' }
  | { kind: 'running'; which: Which }
  | { kind: 'speed'; result: SpeedTest }
  | { kind: 'recording' }
  | { kind: 'snapshot'; url: string }
  | { kind: 'error'; message: string }

// ── Helpers ────────────────────────────────────────────────────────

function relativeTime(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

const humanize = (s: string) => s.replace(/_/g, ' ')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function postCommand(sceneId: string, action: string) {
  const res = await fetch('/api/admin/scene-health', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, sceneId }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`)
  return body
}

// ── Component ──────────────────────────────────────────────────────

export function SceneHealthClient() {
  const [scenes, setScenes] = useState<SceneHealth[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actions, setActions] = useState<Record<string, ActionState>>({})

  const mounted = useRef(true)
  const inFlight = useRef<Set<string>>(new Set())
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const setAction = (id: string, s: ActionState) => {
    if (mounted.current) setActions((prev) => ({ ...prev, [id]: s }))
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setActions({}) // clear stale per-scene results on refresh
    try {
      const res = await fetch('/api/admin/scene-health')
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || 'Failed to load')
      setScenes(body.scenes)
      setSummary(body.summary)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function runSpeedTest(sceneId: string) {
    if (inFlight.current.has(sceneId)) return
    inFlight.current.add(sceneId)
    setAction(sceneId, { kind: 'running', which: 'speed' })
    try {
      const { testId } = await postCommand(sceneId, 'speed-test')
      for (let i = 0; i < 12; i++) {
        await sleep(3000)
        if (!mounted.current) return
        const res = await fetch(
          `/api/admin/scene-health?speedTest=${encodeURIComponent(sceneId)}&testId=${encodeURIComponent(testId)}`
        )
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || 'Status check failed')
        const result: SpeedTest | null = body.result
        if (result?.state === 'finished')
          return setAction(sceneId, { kind: 'speed', result })
        if (result?.state === 'error')
          return setAction(sceneId, {
            kind: 'error',
            message: 'Speed test failed on the camera',
          })
      }
      setAction(sceneId, { kind: 'error', message: 'Speed test timed out' })
    } catch (e) {
      setAction(sceneId, {
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed',
      })
    } finally {
      inFlight.current.delete(sceneId)
    }
  }

  async function runTestRecording(sceneId: string) {
    if (inFlight.current.has(sceneId)) return
    inFlight.current.add(sceneId)
    setAction(sceneId, { kind: 'running', which: 'recording' })
    try {
      await postCommand(sceneId, 'test-recording')
      setAction(sceneId, { kind: 'recording' })
    } catch (e) {
      setAction(sceneId, {
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed',
      })
    } finally {
      inFlight.current.delete(sceneId)
    }
  }

  async function runSnapshot(sceneId: string) {
    if (inFlight.current.has(sceneId)) return
    inFlight.current.add(sceneId)
    // Remember the previous snapshot time so we can tell a NEW capture apart
    // from a stale one when polling.
    const prevAt =
      scenes.find((s) => s.sceneId === sceneId)?.lastSnapshotAt ?? null
    setAction(sceneId, { kind: 'running', which: 'snapshot' })
    try {
      await postCommand(sceneId, 'snapshot') // 202 — Lambda runs ~40-60s
      // Poll longer than the Lambda's worst-case runtime so a slow-but-ok
      // capture doesn't show a false timeout (40 × 3s = 120s).
      for (let i = 0; i < 40; i++) {
        await sleep(3000)
        if (!mounted.current) return
        const res = await fetch('/api/admin/scene-health')
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || 'Status check failed')
        const s = (body.scenes as SceneHealth[]).find(
          (x) => x.sceneId === sceneId
        )
        if (
          s?.lastSnapshotStatus === 'ready' &&
          s.lastSnapshotAt &&
          s.lastSnapshotAt !== prevAt &&
          s.snapshotUrl
        ) {
          setAction(sceneId, {
            kind: 'snapshot',
            url: `${s.snapshotUrl}?t=${encodeURIComponent(s.lastSnapshotAt)}`,
          })
          return
        }
        if (s?.lastSnapshotStatus === 'error') {
          setAction(sceneId, {
            kind: 'error',
            message: 'Snapshot capture failed on the camera',
          })
          return
        }
      }
      setAction(sceneId, { kind: 'error', message: 'Snapshot timed out' })
    } catch (e) {
      setAction(sceneId, {
        kind: 'error',
        message: e instanceof Error ? e.message : 'Failed',
      })
    } finally {
      inFlight.current.delete(sceneId)
    }
  }

  const isInitialLoad = loading && scenes.length === 0

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-[var(--timberwolf)]">
          Scene Health
        </h1>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw
            className={cn('h-4 w-4 mr-2', loading && 'animate-spin')}
          />
          Refresh
        </Button>
      </div>

      {summary && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard
            icon={Video}
            label="Scenes"
            value={summary.total}
            tone="neutral"
          />
          <StatCard
            icon={Wifi}
            label="Online"
            value={summary.online}
            tone="good"
          />
          <StatCard
            icon={AlertTriangle}
            label="Need attention"
            value={summary.attention}
            tone="warn"
          />
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
          {error}
        </div>
      )}

      {isInitialLoad ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : scenes.length === 0 ? (
        <EmptyState
          icon={<Activity className="h-10 w-10" />}
          title="No scenes"
          description="No Spiideo scene health recorded yet."
        />
      ) : (
        <div className="space-y-2">
          {scenes.map((s) => (
            <SceneRow
              key={s.sceneId}
              scene={s}
              action={actions[s.sceneId] ?? { kind: 'idle' }}
              onSpeedTest={() => runSpeedTest(s.sceneId)}
              onTestRecording={() => runTestRecording(s.sceneId)}
              onSnapshot={() => runSnapshot(s.sceneId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Video
  label: string
  value: number
  tone: 'neutral' | 'good' | 'warn'
}) {
  const toneCls = {
    neutral:
      'border-[var(--timberwolf)]/20 bg-[var(--timberwolf)]/5 text-[var(--timberwolf)]',
    good: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-400',
  }[tone]
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border px-4 py-3',
        toneCls
      )}
    >
      <Icon className="h-5 w-5 shrink-0 opacity-80" />
      <div>
        <div className="text-2xl font-semibold leading-none">{value}</div>
        <div className="mt-1 text-xs opacity-80">{label}</div>
      </div>
    </div>
  )
}

function SceneRow({
  scene,
  action,
  onSpeedTest,
  onTestRecording,
  onSnapshot,
}: {
  scene: SceneHealth
  action: ActionState
  onSpeedTest: () => void
  onTestRecording: () => void
  onSnapshot: () => void
}) {
  const online = scene.online === true
  const running = action.kind === 'running'
  const speedRunning = running && action.which === 'speed'
  const recRunning = running && action.which === 'recording'
  const snapRunning = running && action.which === 'snapshot'
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {online ? (
              <Wifi className="h-4 w-4 shrink-0 text-emerald-400" />
            ) : (
              <WifiOff className="h-4 w-4 shrink-0 text-[var(--ash-grey)]" />
            )}
            <span className="truncate font-medium text-[var(--timberwolf)]">
              {scene.sceneName ?? scene.sceneId}
            </span>
            <StatusBadge online={online} alertState={scene.alertState} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[var(--ash-grey)]">
            {scene.venueName && <span>{scene.venueName}</span>}
            <span>
              {scene.onlineCameras ?? '?'}/{scene.cameraCount ?? '?'} cameras
            </span>
            <span>{scene.outages ?? 0} outages</span>
            <span>changed {relativeTime(scene.lastOnlineChange)}</span>
            <span>checked {relativeTime(scene.lastCheckedAt)}</span>
          </div>
          {action.kind === 'speed' && (
            <div className="mt-2 text-xs text-emerald-400">
              Upload {action.result.meanUploadSpeedMbps ?? '?'} Mbps ·{' '}
              {action.result.connectionQuality ?? 'unknown'}
            </div>
          )}
          {action.kind === 'recording' && (
            <div className="mt-2 text-xs text-emerald-400">
              Test recording started (~60s).
            </div>
          )}
          {snapRunning && (
            <div className="mt-2 text-xs text-[var(--ash-grey)]">
              Capturing snapshot… (~45s)
            </div>
          )}
          {action.kind === 'snapshot' && (
            <div className="mt-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={action.url}
                alt={`${scene.sceneName ?? 'Scene'} snapshot`}
                className="max-h-72 w-full rounded-md border border-[var(--timberwolf)]/10 object-contain"
              />
            </div>
          )}
          {action.kind === 'error' && (
            <div className="mt-2 flex items-center gap-1 text-xs text-red-400">
              <AlertTriangle className="h-3 w-3" /> {action.message}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onSpeedTest}
            disabled={!online || running}
            title={online ? undefined : 'Scene offline'}
          >
            {speedRunning ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Gauge className="h-4 w-4 mr-2" />
            )}
            {speedRunning ? 'Testing… (~20s)' : 'Speed Test'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onSnapshot}
            disabled={!online || running}
            title={online ? undefined : 'Scene offline'}
          >
            {snapRunning ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Camera className="h-4 w-4 mr-2" />
            )}
            {snapRunning ? 'Capturing…' : 'Snapshot'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onTestRecording}
            disabled={!online || running}
            title={online ? undefined : 'Scene offline'}
          >
            {recRunning ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Video className="h-4 w-4 mr-2" />
            )}
            Test Recording
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusBadge({
  online,
  alertState,
}: {
  online: boolean
  alertState: string | null
}) {
  if (online && (!alertState || alertState === 'none')) {
    return (
      <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
        Online
      </Badge>
    )
  }
  if (online) {
    return (
      <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">
        {humanize(alertState!)}
      </Badge>
    )
  }
  return (
    <Badge className="bg-red-500/20 text-red-400 border-red-500/30">
      Offline
    </Badge>
  )
}
