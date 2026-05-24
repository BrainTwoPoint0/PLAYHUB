'use client'

// Admin client component for managing LYL Veo recording assignments.
// All free-text fields are rendered as plain text only — never use
// dangerouslySetInnerHTML, never feed parse_reasoning to a markdown
// renderer (security review explicitly flagged the prompt-injection
// echo concern; reasoning is capped at 4KB server-side but we still
// treat it as untrusted display content).

import { useEffect, useMemo, useState } from 'react'

// ---------------------------------------------------------------------------
// Types — mirror the row shapes the API routes return
// ---------------------------------------------------------------------------

interface AssignmentRow {
  id: string
  recording_slug: string
  recording_title: string
  recording_uuid: string | null
  match_date: string | null
  duration_seconds: number | null
  parsed_home_subclub_slug: string | null
  parsed_away_subclub_slug: string | null
  parsed_home_age_group: string | null
  parsed_away_age_group: string | null
  parse_method: 'rules' | 'llm' | 'manual' | null
  parse_confidence: number | null
  parse_reasoning: string | null
  home_team_slug: string | null
  away_team_slug: string | null
  status:
    | 'pending'
    | 'parsed'
    | 'home_assigned'
    | 'fully_assigned'
    | 'operator_locked'
    | 'unparseable'
    | 'too_long'
    | 'intra_team'
    | 'failed'
  failure_stage: string | null
  last_error: string | null
  last_processed_at: string | null
  updated_at: string
}

interface SubclubOption {
  subclub_slug: string
  display_name: string
}

interface SyncRunRow {
  id: string
  trigger_source: 'cron' | 'manual' | 'api'
  started_at: string
  completed_at: string | null
  status: 'running' | 'succeeded' | 'partial' | 'failed'
  veo_recordings_seen: number | null
  rules_parsed: number | null
  llm_parsed: number | null
  unparseable: number | null
  home_assignments: number | null
  share_accepts: number | null
  auto_corrections: number | null
  failures: number | null
  llm_cost_usd: number | null
}

const STATUS_FILTERS: AssignmentRow['status'][] = [
  'pending',
  'parsed',
  'home_assigned',
  'fully_assigned',
  'operator_locked',
  'unparseable',
  'too_long',
  'intra_team',
  'failed',
]
const AGE_GROUPS = [
  'u5',
  'u6',
  'u7',
  'u8',
  'u9',
  'u10',
  'u11',
  'u12',
  'u13',
  'u14',
  'u15',
  'u16',
  'u17',
  'u18',
]

const STATUS_LABELS: Record<
  AssignmentRow['status'],
  { label: string; tone: 'green' | 'amber' | 'red' | 'grey' | 'blue' }
> = {
  pending: { label: 'Pending', tone: 'grey' },
  parsed: { label: 'Parsed', tone: 'blue' },
  home_assigned: { label: 'Home assigned', tone: 'amber' },
  fully_assigned: { label: 'Fully assigned', tone: 'green' },
  operator_locked: { label: 'Operator locked', tone: 'blue' },
  unparseable: { label: 'Unparseable', tone: 'red' },
  too_long: { label: 'Too long', tone: 'grey' },
  intra_team: { label: 'Intra-team', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
}

const TONE_COLORS: Record<'green' | 'amber' | 'red' | 'grey' | 'blue', string> =
  {
    green: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    red: 'bg-red-500/15 text-red-300 border-red-500/30',
    grey: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
    blue: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  }

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function LylRecordingsClient() {
  const [recordings, setRecordings] = useState<AssignmentRow[]>([])
  const [subclubs, setSubclubs] = useState<SubclubOption[]>([])
  const [runs, setRuns] = useState<SyncRunRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<
    AssignmentRow['status'] | 'all'
  >('all')
  const [search, setSearch] = useState('')
  const [overrideTarget, setOverrideTarget] = useState<AssignmentRow | null>(
    null
  )
  const [triggerBusy, setTriggerBusy] = useState(false)
  const [perRowBusy, setPerRowBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<{
    kind: 'ok' | 'error'
    text: string
  } | null>(null)

  async function loadAll() {
    setLoadError(null)
    try {
      const [recRes, runsRes] = await Promise.all([
        fetch('/api/admin/lyl/recordings').then((r) => r.json()),
        fetch('/api/admin/lyl/runs?limit=25').then((r) => r.json()),
      ])
      if (recRes.error) throw new Error(`recordings: ${recRes.error}`)
      if (runsRes.error) throw new Error(`runs: ${runsRes.error}`)
      setRecordings(recRes.recordings ?? [])
      setSubclubs(recRes.subclubs ?? [])
      setRuns(runsRes.runs ?? [])
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAll()
  }, [])

  // After a manual trigger, poll for ~90s so the new sync_runs row
  // surfaces without the user needing to refresh.
  useEffect(() => {
    if (!triggerBusy) return
    const start = Date.now()
    const interval = setInterval(async () => {
      await loadAll()
      if (Date.now() - start > 90_000) {
        clearInterval(interval)
        setTriggerBusy(false)
      }
    }, 6_000)
    return () => clearInterval(interval)
  }, [triggerBusy])

  // Auto-dismiss toast after 4s.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4_000)
    return () => clearTimeout(t)
  }, [toast])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return recordings.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (!q) return true
      return (
        r.recording_title.toLowerCase().includes(q) ||
        r.recording_slug.toLowerCase().includes(q) ||
        (r.parsed_home_subclub_slug ?? '').includes(q) ||
        (r.parsed_away_subclub_slug ?? '').includes(q)
      )
    })
  }, [recordings, statusFilter, search])

  async function triggerFullSync() {
    setTriggerBusy(true)
    try {
      const resp = await fetch('/api/admin/lyl/sync', { method: 'POST' })
      const body = await resp.json()
      if (resp.status === 202) {
        setToast({ kind: 'ok', text: 'Sync queued. Watching for the run row…' })
      } else if (resp.status === 503) {
        setToast({
          kind: 'error',
          text: body.message ?? 'Lambda not configured',
        })
        setTriggerBusy(false)
      } else {
        setToast({
          kind: 'error',
          text: body.error ?? `Trigger failed (${resp.status})`,
        })
        setTriggerBusy(false)
      }
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'network_error',
      })
      setTriggerBusy(false)
    }
  }

  async function triggerOne(slug: string) {
    setPerRowBusy(slug)
    try {
      const resp = await fetch(
        `/api/admin/lyl/recordings/${encodeURIComponent(slug)}/retrigger`,
        {
          method: 'POST',
        }
      )
      const body = await resp.json()
      if (resp.status === 202) {
        setToast({
          kind: 'ok',
          text: `Re-trigger queued for ${slug.slice(0, 32)}…`,
        })
      } else {
        setToast({
          kind: 'error',
          text: body.error ?? `Failed (${resp.status})`,
        })
      }
    } catch (err) {
      setToast({
        kind: 'error',
        text: err instanceof Error ? err.message : 'network_error',
      })
    } finally {
      setPerRowBusy(null)
      // No polling on per-row — just refetch once after a short delay.
      setTimeout(loadAll, 5000)
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <Header
          onRunSync={triggerFullSync}
          runningSync={triggerBusy}
          totalRecordings={recordings.length}
        />

        <RunsPanel runs={runs} />

        <div className="flex flex-wrap items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as AssignmentRow['status'] | 'all')
            }
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm"
          >
            <option value="all">All statuses ({recordings.length})</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s].label} (
                {recordings.filter((r) => r.status === s).length})
              </option>
            ))}
          </select>
          <input
            type="search"
            placeholder="Search title or slug…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm flex-1 min-w-[240px]"
          />
        </div>

        {loadError ? (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            Failed to load: {loadError}
            <button onClick={loadAll} className="ml-3 underline">
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="text-zinc-400 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="text-zinc-400 text-sm">No recordings match.</div>
        ) : (
          <RecordingsTable
            rows={filtered}
            subclubs={subclubs}
            perRowBusy={perRowBusy}
            onOverride={setOverrideTarget}
            onRetrigger={triggerOne}
          />
        )}
      </div>

      {overrideTarget && (
        <OverrideModal
          row={overrideTarget}
          subclubs={subclubs}
          onClose={() => setOverrideTarget(null)}
          onSaved={() => {
            setOverrideTarget(null)
            setToast({ kind: 'ok', text: 'Override saved' })
            loadAll()
          }}
        />
      )}

      {toast && (
        <div
          className={`fixed bottom-6 right-6 z-50 px-4 py-3 rounded-md shadow-lg text-sm border ${
            toast.kind === 'ok'
              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
              : 'bg-red-500/15 border-red-500/40 text-red-200'
          }`}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function Header({
  onRunSync,
  runningSync,
  totalRecordings,
}: {
  onRunSync: () => void
  runningSync: boolean
  totalRecordings: number
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 border-b border-zinc-800 pb-4">
      <div>
        <p className="text-xs uppercase tracking-[0.28em] text-zinc-500">
          PLAYHUB Admin · LYL
        </p>
        <h1 className="text-2xl font-semibold mt-1">Recording assignments</h1>
        <p className="text-sm text-zinc-400 mt-1">
          {totalRecordings} recordings tracked. Cron runs weekly Monday 06:00
          UTC.
        </p>
      </div>
      <button
        type="button"
        onClick={onRunSync}
        disabled={runningSync}
        className="bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-200 px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {runningSync ? 'Sync queued… (watching)' : 'Run sync now'}
      </button>
    </div>
  )
}

function RunsPanel({ runs }: { runs: SyncRunRow[] }) {
  if (runs.length === 0) {
    return (
      <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
        No sync runs yet. Click{' '}
        <strong className="text-zinc-200">Run sync now</strong> to start the
        first one.
      </div>
    )
  }
  const latest = runs[0]
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">
          Recent sync runs
        </h2>
        <p className="text-xs text-zinc-500">
          Latest: {fmtRel(latest.started_at)}
        </p>
      </div>
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {runs.slice(0, 6).map((r) => (
          <div
            key={r.id}
            className="border border-zinc-800 rounded-md p-3 text-xs"
          >
            <div className="flex items-center justify-between">
              <span
                className={`px-2 py-0.5 rounded text-[10px] uppercase tracking-wider ${runStatusColor(r.status)}`}
              >
                {r.status}
              </span>
              <span className="text-zinc-500">{r.trigger_source}</span>
            </div>
            <p className="text-zinc-400 mt-2">{fmtAbs(r.started_at)}</p>
            <dl className="grid grid-cols-2 gap-1 mt-2 text-zinc-300">
              <dt className="text-zinc-500">Seen</dt>
              <dd>{r.veo_recordings_seen ?? '—'}</dd>
              <dt className="text-zinc-500">Rules</dt>
              <dd>{r.rules_parsed ?? '—'}</dd>
              <dt className="text-zinc-500">LLM</dt>
              <dd>{r.llm_parsed ?? '—'}</dd>
              <dt className="text-zinc-500">Unparseable</dt>
              <dd>{r.unparseable ?? '—'}</dd>
              <dt className="text-zinc-500">Home patched</dt>
              <dd>{r.home_assignments ?? '—'}</dd>
              <dt className="text-zinc-500">Shares</dt>
              <dd>{r.share_accepts ?? '—'}</dd>
              <dt className="text-zinc-500">Auto-fixes</dt>
              <dd>{r.auto_corrections ?? '—'}</dd>
              <dt className="text-zinc-500">Failures</dt>
              <dd>{r.failures ?? '—'}</dd>
              {r.llm_cost_usd != null && (
                <>
                  <dt className="text-zinc-500">LLM cost</dt>
                  <dd>${r.llm_cost_usd.toFixed(4)}</dd>
                </>
              )}
            </dl>
          </div>
        ))}
      </div>
    </div>
  )
}

function RecordingsTable({
  rows,
  subclubs: _subclubs,
  perRowBusy,
  onOverride,
  onRetrigger,
}: {
  rows: AssignmentRow[]
  subclubs: SubclubOption[]
  perRowBusy: string | null
  onOverride: (row: AssignmentRow) => void
  onRetrigger: (slug: string) => void
}) {
  return (
    <div className="overflow-x-auto rounded-md border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-400">
          <tr>
            <th className="px-3 py-2 text-left">Match</th>
            <th className="px-3 py-2 text-left">Parsed (home → away)</th>
            <th className="px-3 py-2 text-left">Status</th>
            <th className="px-3 py-2 text-left">Method</th>
            <th className="px-3 py-2 text-left">Last processed</th>
            <th className="px-3 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map((row) => {
            const tone = STATUS_LABELS[row.status]
            return (
              <tr key={row.id} className="hover:bg-zinc-900/50">
                <td className="px-3 py-3 align-top">
                  <div className="text-zinc-100">{row.recording_title}</div>
                  <div className="text-xs text-zinc-500 mt-1">
                    {row.recording_slug}
                  </div>
                  {row.match_date && (
                    <div className="text-xs text-zinc-500 mt-0.5">
                      {fmtAbs(row.match_date)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-3 align-top">
                  {row.parsed_home_subclub_slug &&
                  row.parsed_away_subclub_slug ? (
                    <div className="text-xs">
                      <code className="text-zinc-200">
                        {row.parsed_home_subclub_slug}-
                        {row.parsed_home_age_group}
                      </code>
                      <span className="text-zinc-500 mx-1">vs</span>
                      <code className="text-zinc-200">
                        {row.parsed_away_subclub_slug}-
                        {row.parsed_away_age_group}
                      </code>
                    </div>
                  ) : (
                    <span className="text-xs text-zinc-500">—</span>
                  )}
                  {row.last_error && (
                    <div className="text-xs text-red-300 mt-1 break-all">
                      {row.last_error.slice(0, 200)}
                    </div>
                  )}
                </td>
                <td className="px-3 py-3 align-top">
                  <span
                    className={`inline-block text-xs px-2 py-1 rounded border ${TONE_COLORS[tone.tone]}`}
                  >
                    {tone.label}
                  </span>
                  {row.failure_stage && (
                    <div className="text-xs text-zinc-500 mt-1">
                      stage: {row.failure_stage}
                    </div>
                  )}
                </td>
                <td className="px-3 py-3 align-top text-xs text-zinc-300">
                  {row.parse_method ?? '—'}
                  {row.parse_confidence != null && (
                    <div className="text-zinc-500">
                      {Math.round(row.parse_confidence * 100)}%
                    </div>
                  )}
                </td>
                <td className="px-3 py-3 align-top text-xs text-zinc-400">
                  {row.last_processed_at ? fmtRel(row.last_processed_at) : '—'}
                </td>
                <td className="px-3 py-3 align-top text-right whitespace-nowrap">
                  <button
                    onClick={() => onOverride(row)}
                    className="text-xs text-zinc-300 hover:text-zinc-100 px-2 py-1 border border-zinc-700 rounded hover:border-zinc-500"
                  >
                    Override
                  </button>
                  <button
                    onClick={() => onRetrigger(row.recording_slug)}
                    disabled={perRowBusy === row.recording_slug}
                    className="ml-2 text-xs text-zinc-300 hover:text-zinc-100 px-2 py-1 border border-zinc-700 rounded hover:border-zinc-500 disabled:opacity-50"
                  >
                    {perRowBusy === row.recording_slug ? '…' : 'Re-trigger'}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function OverrideModal({
  row,
  subclubs,
  onClose,
  onSaved,
}: {
  row: AssignmentRow
  subclubs: SubclubOption[]
  onClose: () => void
  onSaved: () => void
}) {
  const [homeSub, setHomeSub] = useState(row.parsed_home_subclub_slug ?? '')
  const [homeAge, setHomeAge] = useState(row.parsed_home_age_group ?? '')
  const [awaySub, setAwaySub] = useState(row.parsed_away_subclub_slug ?? '')
  const [awayAge, setAwayAge] = useState(row.parsed_away_age_group ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const resp = await fetch(
        `/api/admin/lyl/recordings/${encodeURIComponent(row.recording_slug)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            home_subclub_slug: homeSub,
            home_age_group: homeAge,
            away_subclub_slug: awaySub,
            away_age_group: awayAge,
          }),
        }
      )
      const body = await resp.json()
      if (!resp.ok) throw new Error(body.error ?? `Failed (${resp.status})`)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  async function clearOverride() {
    setSaving(true)
    setError(null)
    try {
      const resp = await fetch(
        `/api/admin/lyl/recordings/${encodeURIComponent(row.recording_slug)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clear_override: true }),
        }
      )
      const body = await resp.json()
      if (!resp.ok) throw new Error(body.error ?? `Failed (${resp.status})`)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 bg-black/70 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-lg max-w-2xl w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold text-zinc-100">
          Override assignment
        </h2>
        <p className="text-xs text-zinc-500 mt-1 break-all">
          {row.recording_title}
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <SubclubAgePicker
            label="Home team"
            subclubs={subclubs}
            subclub={homeSub}
            setSubclub={setHomeSub}
            age={homeAge}
            setAge={setHomeAge}
          />
          <SubclubAgePicker
            label="Away team"
            subclubs={subclubs}
            subclub={awaySub}
            setSubclub={setAwaySub}
            age={awayAge}
            setAge={setAwayAge}
          />
        </div>
        <p className="text-xs text-zinc-500 mt-3">
          Saving sets <code>parse_method=manual</code> and{' '}
          <code>status=operator_locked</code>. The cron will skip this recording
          on future runs until you clear the override.
        </p>
        {error && (
          <div className="text-xs text-red-300 mt-3 border border-red-500/40 bg-red-500/10 p-2 rounded">
            {error}
          </div>
        )}
        <div className="flex items-center justify-between mt-5">
          <button
            onClick={clearOverride}
            disabled={saving || row.status !== 'operator_locked'}
            className="text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-30"
          >
            Clear override (cron resumes control)
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1.5"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving || !homeSub || !awaySub || !homeAge || !awayAge}
              className="bg-zinc-100 text-zinc-900 px-3 py-1.5 rounded text-xs font-medium disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save override'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SubclubAgePicker({
  label,
  subclubs,
  subclub,
  setSubclub,
  age,
  setAge,
}: {
  label: string
  subclubs: SubclubOption[]
  subclub: string
  setSubclub: (s: string) => void
  age: string
  setAge: (s: string) => void
}) {
  return (
    <div>
      <label className="text-xs uppercase tracking-wider text-zinc-500">
        {label}
      </label>
      <select
        value={subclub}
        onChange={(e) => setSubclub(e.target.value)}
        className="w-full mt-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm"
      >
        <option value="">— select subclub —</option>
        {subclubs.map((s) => (
          <option key={s.subclub_slug} value={s.subclub_slug}>
            {s.display_name} ({s.subclub_slug})
          </option>
        ))}
      </select>
      <select
        value={age}
        onChange={(e) => setAge(e.target.value)}
        className="w-full mt-2 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm"
      >
        <option value="">— age group —</option>
        {AGE_GROUPS.map((a) => (
          <option key={a} value={a}>
            {a.toUpperCase()}
          </option>
        ))}
      </select>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtAbs(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function fmtRel(iso: string): string {
  const t = new Date(iso).getTime()
  if (isNaN(t)) return iso
  const diff = Date.now() - t
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function runStatusColor(s: SyncRunRow['status']): string {
  switch (s) {
    case 'succeeded':
      return 'bg-emerald-500/20 text-emerald-200 border border-emerald-500/30'
    case 'partial':
      return 'bg-amber-500/20 text-amber-200 border border-amber-500/30'
    case 'failed':
      return 'bg-red-500/20 text-red-200 border border-red-500/30'
    case 'running':
      return 'bg-sky-500/20 text-sky-200 border border-sky-500/30'
  }
}
