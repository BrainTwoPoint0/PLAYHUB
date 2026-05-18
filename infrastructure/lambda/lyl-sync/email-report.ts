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

const RESEND_ENDPOINT = 'https://api.resend.com/emails'
const FROM = 'PLAYHUB Alerts <admin@playbacksports.ai>'

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function statusBanner(status: RunSyncResult['status']): { color: string; emoji: string; label: string } {
  switch (status) {
    case 'succeeded': return { color: '#10b981', emoji: '✓',  label: 'Succeeded' }
    case 'partial':   return { color: '#f59e0b', emoji: '⚠️', label: 'Partial (some failures)' }
    case 'failed':    return { color: '#dc2626', emoji: '⛔', label: 'Failed' }
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
}

export async function sendRunReportEmail({ result, trigger, leagueClubSlug }: SendInput): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY
  const to = process.env.LYL_REPORT_EMAIL
  if (!apiKey || !to) {
    console.warn('[lyl-sync] RESEND_API_KEY or LYL_REPORT_EMAIL not set, skipping report email')
    return
  }

  const banner = statusBanner(result.status)
  const subjectPrefix = result.status === 'succeeded' ? 'OK' : result.status === 'partial' ? 'PARTIAL' : 'FAILED'
  const subject = `[LYL sync · ${subjectPrefix}] ${result.counts.shareAccepts} shared, ${result.counts.homeAssignments} placed, ${result.counts.failures} failures`

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
        ${result.errors.slice(0, 50).map((e) => `
          <tr style="border-top:1px solid #2a2f2d;">
            <td style="padding:8px; color:#d6d5c9;">${escapeHtml(e.recording_title)}<br><span style="color:#6b7280; font-family:monospace; font-size:11px;">${escapeHtml(e.recording_slug)}</span></td>
            <td style="padding:8px; color:#f59e0b; font-family:monospace; font-size:11px;">${escapeHtml(e.stage)}</td>
            <td style="padding:8px; color:#d6d5c9;">${escapeHtml(e.error.slice(0, 300))}</td>
          </tr>
        `).join('')}
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
          <tr><td style="padding:6px 8px; color:#b9baa3;">Failures</td><td style="padding:6px 8px; color:${result.counts.failures > 0 ? '#dc2626' : '#d6d5c9'}; text-align:right;">${fmtCount(result.counts.failures)}</td></tr>
        </table>

        <h3 style="color:#d6d5c9; font-size:14px; margin:24px 0 8px;">LLM usage</h3>
        <table style="width:100%; border-collapse:collapse; font-size:13px;">
          <tr><td style="padding:6px 8px; color:#b9baa3;">Input tokens</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${result.llm.inputTokens.toLocaleString()}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Output tokens</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">${result.llm.outputTokens.toLocaleString()}</td></tr>
          <tr><td style="padding:6px 8px; color:#b9baa3;">Cost</td><td style="padding:6px 8px; color:#d6d5c9; text-align:right;">$${result.llm.costUsd.toFixed(4)}</td></tr>
        </table>

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
    console.warn('[lyl-sync] RESEND_API_KEY or LYL_REPORT_EMAIL not set, skipping crash email')
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
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      console.error(`[lyl-sync] Resend API error: ${resp.status} ${text.slice(0, 500)}`)
    } else {
      console.log(`[lyl-sync] report email dispatched to ${body.to.join(',')}`)
    }
  } catch (err) {
    console.error('[lyl-sync] Failed to send report email:', err instanceof Error ? err.message : err)
  }
}
