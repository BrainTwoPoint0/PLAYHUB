// Post-run summary email for the LYL Veo sync.
//
// Mirrors the pattern used in infrastructure/lambda/sync-recordings/index.ts:
// direct fetch against the Resend HTTP API, gated on RESEND_API_KEY +
// LYL_REPORT_EMAIL, never throws (the email is a courtesy — failing to
// send it must not poison the Lambda run).
//
// Two flavours:
//   - sendRunReportEmail(result) — normal post-run summary (any status)
//   - sendRunCrashEmail(error)   — orchestrator threw, no RunSyncResult
//
// Both produce a dark-themed HTML email matching PLAYHUB's other admin
// alerts (#0a100d / #d6d5c9). HTML strings escape user-controlled text
// (recording titles, error messages) via escapeHtml() — Veo titles are
// operator-controlled but parse_reasoning + Veo API errors can echo
// arbitrary content, so we treat everything as untrusted.

import type { RunSyncResult } from '../../../src/lib/lyl-sync/orchestrator'
import type { AuditResult } from '../../../src/lib/lyl-sync/audit'
import type { CleanupResult } from '../../../src/lib/lyl-sync/cleanup'
import type { SupabaseClient } from '@supabase/supabase-js'

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const FROM = 'PLAYHUB Alerts <admin@playbacksports.ai>'

/** Per-recording row rendered in the email's actions table. Sourced from
 *  playhub_recording_assignments filtered by the current run's run id, so
 *  we always show the canonical post-run state (including auto-corrections
 *  + intra-team matches + failed rows). */
interface RecordingActionRow {
  recording_slug: string
  recording_title: string | null
  status: string // 'fully_assigned' | 'intra_team' | 'unparseable' | 'too_long' | 'failed'
  home_team_slug: string | null
  away_team_slug: string | null
  away_accepted_recording_uuid: string | null
  failure_stage: string | null
  last_error: string | null
}

/** Pull every assignment row touched by this run (last_sync_run_id match).
 *  Returns [] on error — the per-recording table is a courtesy section,
 *  it must never block the email itself from sending. Wrapped in a 5s
 *  Promise.race deadline (supabase-js doesn't accept AbortSignal on
 *  query builders): a hung PostgREST response would otherwise eat the
 *  remaining Lambda budget and the crash-email path would never fire
 *  because we're already inside the success path. */
const QUERY_DEADLINE_MS = 5000
async function loadRunActions(
  supabase: SupabaseClient,
  runId: string
): Promise<RecordingActionRow[]> {
  try {
    const queryPromise = supabase
      .from('playhub_recording_assignments')
      .select(
        'recording_slug, recording_title, status, home_team_slug, away_team_slug, away_accepted_recording_uuid, failure_stage, last_error'
      )
      .eq('last_sync_run_id', runId)
      .order('status', { ascending: true })
      .order('recording_title', { ascending: true })
    const deadlinePromise = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `loadRunActions deadline (${QUERY_DEADLINE_MS}ms) exceeded`
            )
          ),
        QUERY_DEADLINE_MS
      )
    )
    const { data, error } = (await Promise.race([
      queryPromise,
      deadlinePromise,
    ])) as Awaited<typeof queryPromise>
    if (error) {
      console.warn('[lyl-sync] loadRunActions failed:', error.message)
      return []
    }
    return (data ?? []) as RecordingActionRow[]
  } catch (e) {
    console.warn(
      '[lyl-sync] loadRunActions threw:',
      e instanceof Error ? e.message : e
    )
    return []
  }
}

function statusBadgeColor(status: string): string {
  switch (status) {
    case 'fully_assigned':
      return '#10b981' // green
    case 'intra_team':
      return '#3b82f6' // blue
    case 'too_long':
      return '#6b7280' // grey
    case 'unparseable':
      return '#f59e0b' // amber
    case 'failed':
      return '#dc2626' // red
    default:
      return '#b9baa3'
  }
}

/** Human-readable summary of what happened to this recording. Reads the
 *  assignment row's columns and synthesises a one-line description. */
function describeAction(row: RecordingActionRow): string {
  switch (row.status) {
    case 'fully_assigned':
      return `placed in <strong>${escapeHtml(row.home_team_slug ?? '?')}</strong> · shared to <strong>${escapeHtml(row.away_team_slug ?? '?')}</strong>`
    case 'intra_team':
      return `placed in <strong>${escapeHtml(row.home_team_slug ?? '?')}</strong> (intra-team scrimmage — no opponent share)`
    case 'too_long':
      return `skipped — recording exceeds the duration cap`
    case 'unparseable':
      return `couldn't parse title — operator review needed${row.last_error ? `: <em>${escapeHtml(row.last_error.slice(0, 200))}</em>` : ''}`
    case 'failed':
      return `<span style="color:#dc2626;">failed at <code>${escapeHtml(row.failure_stage ?? '?')}</code></span>${row.last_error ? ` — <em>${escapeHtml(row.last_error.slice(0, 200))}</em>` : ''}`
    default:
      return escapeHtml(row.status)
  }
}

function renderActionsTable(rows: RecordingActionRow[]): string {
  if (rows.length === 0) {
    return `<p style="color:#6b7280; font-size:13px; font-style:italic;">No recording-level rows touched by this run.</p>`
  }
  const limit = 100
  const trimmed = rows.slice(0, limit)
  return `
    <table style="width:100%; border-collapse:collapse; font-size:12px; background:#1a1f1d; border-radius:6px; overflow:hidden;">
      <thead><tr style="background:#0a100d;">
        <th style="text-align:left; padding:8px; color:#b9baa3;">Status</th>
        <th style="text-align:left; padding:8px; color:#b9baa3;">Recording</th>
        <th style="text-align:left; padding:8px; color:#b9baa3;">Action</th>
      </tr></thead>
      <tbody>
      ${trimmed
        .map(
          (row) => `
        <tr style="border-top:1px solid #2a2f2d; vertical-align:top;">
          <td style="padding:8px;">
            <span style="display:inline-block; padding:2px 8px; border-radius:10px; font-size:10px; font-family:monospace; background:${statusBadgeColor(row.status)}33; color:${statusBadgeColor(row.status)};">
              ${escapeHtml(row.status)}
            </span>
          </td>
          <td style="padding:8px; color:#d6d5c9;">
            ${escapeHtml(row.recording_title ?? '(no title)')}
            <br><span style="color:#6b7280; font-family:monospace; font-size:11px;">${escapeHtml(row.recording_slug)}</span>
          </td>
          <td style="padding:8px; color:#d6d5c9;">${describeAction(row)}</td>
        </tr>
      `
        )
        .join('')}
      ${rows.length > limit ? `<tr><td colspan="3" style="padding:8px; color:#6b7280; font-style:italic;">… ${rows.length - limit} more (see admin UI)</td></tr>` : ''}
      </tbody>
    </table>
  `
}

/** "Needs attention" section: empty share-copies (broken — entry without
 *  content), deferred originals (waiting on Veo processing), and stuck
 *  originals (source ready but away never landed). Rendered in both the
 *  sync-run email and the cleanup-run email. */
function renderAuditSection(audit?: AuditResult): string {
  // Defensive: a partial/legacy result may lack the audit field — the email
  // is a courtesy and must never throw.
  if (!audit) return ''
  const { emptyShareCopies, awayPending } = audit
  const total = emptyShareCopies.length + awayPending.length
  if (total === 0) {
    return `<h3 style="color:#d6d5c9; font-size:14px; margin:24px 0 8px;">Content audit</h3>
      <p style="color:#10b981; font-size:14px;">No empty copies, nothing pending. ✅</p>`
  }
  const list = (
    label: string,
    color: string,
    items: Array<{ title: string; slug: string }>
  ) =>
    items.length
      ? `<p style="color:${color}; font-size:13px; margin:12px 0 4px;"><strong>${escapeHtml(label)} (${items.length})</strong></p>
         <ul style="margin:0; padding-left:18px; color:#d6d5c9; font-size:12px;">
           ${items
             .slice(0, 50)
             .map(
               (i) =>
                 `<li>${escapeHtml(i.title || '(no title)')} <span style="color:#6b7280; font-family:monospace;">${escapeHtml(i.slug)}</span></li>`
             )
             .join('')}
           ${items.length > 50 ? `<li style="color:#6b7280; font-style:italic;">… ${items.length - 50} more</li>` : ''}
         </ul>`
      : ''
  return `
    <h3 style="color:#d6d5c9; font-size:14px; margin:24px 0 8px;">Content audit — needs attention</h3>
    <div style="padding:12px 16px; background:#1a1f1d; border-radius:6px;">
      ${list(
        'Empty share-copies (broken — verified no footage)',
        '#dc2626',
        emptyShareCopies.map((c) => ({ title: c.title, slug: c.copySlug }))
      )}
      ${list(
        'Away-share pending (home filed, away not yet completed)',
        '#f59e0b',
        awayPending.map((a) => ({ title: a.title, slug: a.recordingSlug }))
      )}
    </div>
  `
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function statusBanner(status: RunSyncResult['status']): {
  color: string
  emoji: string
  label: string
} {
  switch (status) {
    case 'succeeded':
      return { color: '#10b981', emoji: '✓', label: 'Succeeded' }
    case 'partial':
      return { color: '#f59e0b', emoji: '⚠️', label: 'Partial (some failures)' }
    case 'failed':
      return { color: '#dc2626', emoji: '⛔', label: 'Failed' }
  }
}

function fmtCount(n: number | null | undefined): string {
  if (n == null) return '—'
  return String(n)
}

interface SendInput {
  result: RunSyncResult
  trigger: 'cron' | 'manual' | 'api'
  leagueClubSlug: string
  /** Optional — when provided, the email includes the per-recording actions
   *  table (queried from playhub_recording_assignments by last_sync_run_id).
   *  Omit to render the legacy counts+failures-only email. */
  supabase?: SupabaseClient
}

export async function sendRunReportEmail({
  result,
  trigger,
  leagueClubSlug,
  supabase,
}: SendInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  const to = process.env.LYL_REPORT_EMAIL
  if (!apiKey || !to) {
    console.warn(
      '[lyl-sync] RESEND_API_KEY or LYL_REPORT_EMAIL not set, skipping report email'
    )
    return
  }

  const banner = statusBanner(result.status)
  const subjectPrefix =
    result.status === 'succeeded'
      ? 'OK'
      : result.status === 'partial'
        ? 'PARTIAL'
        : 'FAILED'
  const subject = `[LYL sync · ${subjectPrefix}] ${result.counts.shareAccepts} shared, ${result.counts.homeAssignments} placed, ${result.counts.failures} failures`

  // Per-recording actions table (post-run state from the assignment table).
  // Best-effort — if the supabase client wasn't passed, or the query fails,
  // we omit this section silently rather than blocking the whole email.
  const actionRows = supabase
    ? await loadRunActions(supabase, result.runId)
    : []
  const actionsSection = supabase
    ? `
      <h3 style="color:#d6d5c9; font-size:14px; margin:24px 0 8px;">Per-recording actions</h3>
      ${renderActionsTable(actionRows)}
    `
    : ''

  const errorsTable = result.errors.length
    ? `
      <h3 style="color:#d6d5c9; font-size:14px; margin:24px 0 8px;">Per-recording failures</h3>
      <table style="width:100%; border-collapse:collapse; font-size:12px; background:#1a1f1d; border-radius:6px; overflow:hidden;">
        <thead><tr style="background:#0a100d;">
          <th style="text-align:left; padding:8px; color:#b9baa3;">Recording</th>
          <th style="text-align:left; padding:8px; color:#b9baa3;">Stage</th>
          <th style="text-align:left; padding:8px; color:#b9baa3;">Error</th>
        </tr></thead>
        <tbody>
        ${result.errors
          .slice(0, 50)
          .map(
            (e) => `
          <tr style="border-top:1px solid #2a2f2d;">
            <td style="padding:8px; color:#d6d5c9;">${escapeHtml(e.recording_title)}<br><span style="color:#6b7280; font-family:monospace; font-size:11px;">${escapeHtml(e.recording_slug)}</span></td>
            <td style="padding:8px; color:#f59e0b; font-family:monospace; font-size:11px;">${escapeHtml(e.stage)}</td>
            <td style="padding:8px; color:#d6d5c9;">${escapeHtml(e.error.slice(0, 300))}</td>
          </tr>
        `
          )
          .join('')}
        ${result.errors.length > 50 ? `<tr><td colspan="3" style="padding:8px; color:#6b7280; font-style:italic;">… ${result.errors.length - 50} more (see admin UI)</td></tr>` : ''}
        </tbody>
      </table>
    `
    : '<p style="color:#10b981; font-size:14px;">No per-recording failures. 🎉</p>'

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a100d; color:#d6d5c9; padding:32px 16px;">
      <div style="max-width:640px; margin:0 auto;">
        <h1 style="font-size:20px; color:#d6d5c9; margin:0 0 8px;">LYL Veo sync</h1>
        <p style="font-size:12px; color:#b9baa3; margin:0 0 24px;">League: <code>${escapeHtml(leagueClubSlug)}</code> · Trigger: <code>${escapeHtml(trigger)}</code> · Run: <code>${escapeHtml(result.runId)}</code></p>

        <div style="padding:12px 16px; background:${banner.color}22; border-left:3px solid ${banner.color}; border-radius:4px; margin-bottom:24px;">
          <strong style="color:${banner.color}; font-size:16px;">${banner.emoji} ${banner.label}</strong>
        </div>

        <h3 style="color:#d6d5c9; font-size:14px; margin:24px 0 8px;">Counts</h3>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <tr><td style="padding:6px 8px; color:#b9baa3;">Veo recordings seen</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${fmtCount(result.counts.veoRecordingsSeen)}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">New (this run)</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${fmtCount(result.counts.newRecordings)}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Parsed (rules)</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${fmtCount(result.counts.rulesParsed)}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Parsed (LLM)</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${fmtCount(result.counts.llmParsed)}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Unparseable</td><td style="padding:6px 8px; color:${result.counts.unparseable > 0 ? '#f59e0b' : '#d6d5c9'}; text-align:right;">${fmtCount(result.counts.unparseable)}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Home placements</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${fmtCount(result.counts.homeAssignments)}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Share-with-opponent accepts</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${fmtCount(result.counts.shareAccepts)}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Auto-corrections</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${fmtCount(result.counts.autoCorrections)}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Away-share deferred (awaiting Veo processing)</td><td style="padding:6px 8px; color:${result.counts.deferredAwaitingContent > 0 ? '#f59e0b' : '#d6d5c9'}; text-align:right;">${fmtCount(result.counts.deferredAwaitingContent)}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Failures</td><td style="padding:6px 8px; color:${result.counts.failures > 0 ? '#dc2626' : '#d6d5c9'}; text-align:right;">${fmtCount(result.counts.failures)}</td></tr>
        </table>

        ${renderAuditSection(result.audit)}

        <h3 style="color:#d6d5c9; font-size:14px; margin:24px 0 8px;">LLM usage</h3>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <tr><td style="padding:6px 8px; color:#b9baa3;">Input tokens</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${result.llm.inputTokens.toLocaleString()}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Output tokens</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${result.llm.outputTokens.toLocaleString()}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Cost</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">$${result.llm.costUsd.toFixed(4)}</td></tr>
        </table>

        ${actionsSection}

        ${errorsTable}

        <p style="margin-top:32px; padding-top:16px; border-top:1px solid #2a2f2d; font-size:12px; color:#6b7280;">
          PLAYHUB admin · LYL recording sync · ${new Date().toISOString()}
        </p>
      </div>
    </div>
  `

  await postToResend(apiKey, { from: FROM, to: [to], subject, html })
}

export async function sendRunCrashEmail(
  error: unknown,
  ctx: { trigger: 'cron' | 'manual' | 'api'; leagueClubSlug: string }
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  const to = process.env.LYL_REPORT_EMAIL
  if (!apiKey || !to) {
    console.warn(
      '[lyl-sync] RESEND_API_KEY or LYL_REPORT_EMAIL not set, skipping crash email'
    )
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  const stack = error instanceof Error && error.stack ? error.stack : ''
  const subject = `[LYL sync · CRASHED] ${message.slice(0, 80)}`
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a100d; color:#d6d5c9; padding:32px 16px;">
      <div style="max-width:640px; margin:0 auto;">
        <h1 style="font-size:20px; color:#dc2626; margin:0 0 8px;">⛔ LYL Veo sync crashed</h1>
        <p style="font-size:12px; color:#b9baa3; margin:0 0 24px;">League: <code>${escapeHtml(ctx.leagueClubSlug)}</code> · Trigger: <code>${escapeHtml(ctx.trigger)}</code></p>
        <div style="padding:12px 16px; background:#dc262622; border-left:3px solid #dc2626; border-radius:4px; margin-bottom:16px;">
          <pre style="margin:0; color:#d6d5c9; font-size:12px; white-space:pre-wrap; word-break:break-word;">${escapeHtml(message)}</pre>
        </div>
        ${stack ? `<details><summary style="color:#b9baa3; cursor:pointer; font-size:12px;">Stack trace</summary><pre style="background:#1a1f1d; padding:12px; border-radius:4px; color:#b9baa3; font-size:11px; overflow-x:auto;">${escapeHtml(stack)}</pre></details>` : ''}
        <p style="margin-top:32px; padding-top:16px; border-top:1px solid #2a2f2d; font-size:12px; color:#6b7280;">
          The orchestrator threw before completing — no run summary row was written.
          Check CloudWatch logs for full context.
        </p>
      </div>
    </div>
  `
  await postToResend(apiKey, { from: FROM, to: [to], subject, html })
}

/** Cleanup-run summary email. Fired after the Lambda 'cleanup' action so the
 *  admin (who triggered an async invoke and got a 202) learns the outcome. */
export async function sendCleanupReportEmail({
  result,
  trigger,
  leagueClubSlug,
}: {
  result: CleanupResult
  trigger: 'cron' | 'manual' | 'api'
  leagueClubSlug: string
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  const to = process.env.LYL_REPORT_EMAIL
  if (!apiKey || !to) {
    console.warn(
      '[lyl-sync] RESEND_API_KEY or LYL_REPORT_EMAIL not set, skipping cleanup email'
    )
    return
  }
  const subject = `[LYL cleanup · ${result.applied ? 'APPLIED' : 'DRY-RUN'}] ${result.cleaned.length} removed, ${result.failed.length} failed, ${result.audit.emptyShareCopies.length} empty found`
  const failedTable = result.failed.length
    ? `<h3 style="color:#d6d5c9; font-size:14px; margin:24px 0 8px;">Delete failures</h3>
       <ul style="margin:0; padding-left:18px; color:#d6d5c9; font-size:12px;">
         ${result.failed
           .slice(0, 50)
           .map(
             (f) =>
               `<li><span style="font-family:monospace;">${escapeHtml(f.copySlug)}</span> — <em style="color:#dc2626;">${escapeHtml(f.error.slice(0, 200))}</em></li>`
           )
           .join('')}
       </ul>`
    : ''
  const skippedNote = result.skippedDueToDeadline.length
    ? `<p style="color:#f59e0b; font-size:13px;">⏱ ${result.skippedDueToDeadline.length} empty copies skipped (sweep hit the wall-clock deadline) — re-run cleanup to finish.</p>`
    : ''
  const abortNote = result.abortedTooMany
    ? `<p style="color:#dc2626; font-size:14px; font-weight:600;">⛔ Aborted — the audit flagged more empty copies than the safety cap allows. Nothing was deleted. Investigate before re-running (possible Veo outage / audit misfire).</p>`
    : ''
  const ineligibleNote = result.skippedNotEligible.length
    ? `<p style="color:#b9baa3; font-size:13px;">${result.skippedNotEligible.length} empty copies not eligible for delete (within grace window or orphaned) — left in place.</p>`
    : ''
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0a100d; color:#d6d5c9; padding:32px 16px;">
      <div style="max-width:640px; margin:0 auto;">
        <h1 style="font-size:20px; color:#d6d5c9; margin:0 0 8px;">LYL content cleanup</h1>
        <p style="font-size:12px; color:#b9baa3; margin:0 0 24px;">League: <code>${escapeHtml(leagueClubSlug)}</code> · Trigger: <code>${escapeHtml(trigger)}</code> · Mode: <code>${result.applied ? 'apply' : 'dry-run'}</code></p>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <tr><td style="padding:6px 8px; color:#b9baa3;">Empty copies found</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${result.audit.emptyShareCopies.length}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Deleted + re-armed</td><td style="padding:6px 8px; color:#10b981; text-align:right;">${result.cleaned.length}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Delete failures</td><td style="padding:6px 8px; color:${result.failed.length ? '#dc2626' : '#d6d5c9'}; text-align:right;">${result.failed.length}</td></tr>
        </table>
        ${abortNote}
        ${ineligibleNote}
        ${skippedNote}
        ${renderAuditSection(result.audit)}
        ${failedTable}
        <p style="margin-top:32px; padding-top:16px; border-top:1px solid #2a2f2d; font-size:12px; color:#6b7280;">
          PLAYHUB admin · LYL content cleanup · ${new Date().toISOString()}
        </p>
      </div>
    </div>
  `
  await postToResend(apiKey, { from: FROM, to: [to], subject, html })
}

async function postToResend(
  apiKey: string,
  body: { from: string; to: string[]; subject: string; html: string }
): Promise<void> {
  try {
    // 10s hard cap — Resend p99 is ~2-3s; a hung connection would
    // otherwise eat the Lambda's full 600s timeout, breaking the
    // duration alarm's signal ("alarm fired" ≠ "real run took too long").
    // Per cloud-infra review.
    const resp = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      console.error(
        `[lyl-sync] Resend API error: ${resp.status} ${text.slice(0, 500)}`
      )
    } else {
      console.log(`[lyl-sync] report email dispatched to ${body.to.join(',')}`)
    }
  } catch (err) {
    console.error(
      '[lyl-sync] Failed to send report email:',
      err instanceof Error ? err.message : err
    )
  }
}
