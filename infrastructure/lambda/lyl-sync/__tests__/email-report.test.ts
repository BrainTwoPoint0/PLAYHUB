// Unit tests for the LYL Lambda's email-report helper.
//
// Covers:
//   - Subject prefix discriminates succeeded/partial/failed correctly.
//   - HTML escapes recording titles / error messages (XSS / formatting).
//   - Truncates >50 errors with a "n more" footer.
//   - Gracefully no-ops when RESEND_API_KEY or LYL_REPORT_EMAIL missing.
//   - Doesn't throw when fetch rejects (courtesy email — non-fatal).
//   - Crash email uses dedicated subject prefix even with multi-line errors.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendRunReportEmail, sendRunCrashEmail } from '../email-report'
import type { RunSyncResult } from '../../../../src/lib/lyl-sync/orchestrator'

function makeResult(overrides: Partial<RunSyncResult> = {}): RunSyncResult {
  return {
    runId: 'run-abc',
    status: 'succeeded',
    counts: {
      veoRecordingsSeen: 17,
      newRecordings: 3,
      rulesParsed: 16,
      llmParsed: 1,
      unparseable: 0,
      homeAssignments: 3,
      shareAccepts: 3,
      autoCorrections: 0,
      deferredAwaitingContent: 0,
      failures: 0,
    },
    audit: { emptyShareCopies: [], awayPending: [], emptyOriginals: [] },
    llm: { inputTokens: 1234, outputTokens: 567, costUsd: 0.0084 },
    errors: [],
    ...overrides,
  }
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, text: async () => '' })
  vi.stubGlobal('fetch', fetchMock)
  process.env.RESEND_API_KEY = 'test_re_key'
  process.env.LYL_REPORT_EMAIL = 'admin@example.com'
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.RESEND_API_KEY
  delete process.env.LYL_REPORT_EMAIL
})

describe('sendRunReportEmail', () => {
  it('uses OK subject prefix for succeeded runs', async () => {
    await sendRunReportEmail({
      result: makeResult(),
      trigger: 'cron',
      leagueClubSlug: 'lyl',
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.subject).toContain('[LYL sync · OK]')
  })

  it('uses PARTIAL prefix when status=partial', async () => {
    await sendRunReportEmail({
      result: makeResult({
        status: 'partial',
        counts: { ...makeResult().counts, failures: 2 },
      }),
      trigger: 'cron',
      leagueClubSlug: 'lyl',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.subject).toContain('[LYL sync · PARTIAL]')
    expect(body.subject).toContain('2 failures')
  })

  it('uses FAILED prefix when status=failed', async () => {
    await sendRunReportEmail({
      result: makeResult({ status: 'failed' }),
      trigger: 'manual',
      leagueClubSlug: 'lyl',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.subject).toContain('[LYL sync · FAILED]')
  })

  it('escapes HTML in recording titles and error messages', async () => {
    await sendRunReportEmail({
      result: makeResult({
        status: 'partial',
        errors: [
          {
            recording_slug: 'rec-1',
            recording_title: '<script>alert(1)</script>',
            stage: 'home_assign',
            error: 'Veo said "<not found>"',
          },
        ],
      }),
      trigger: 'cron',
      leagueClubSlug: 'lyl',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.html).not.toContain('<script>alert(1)</script>')
    expect(body.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body.html).toContain('&quot;&lt;not found&gt;&quot;')
  })

  it('truncates errors past 50 with a "n more" footer', async () => {
    const errors = Array.from({ length: 73 }, (_, i) => ({
      recording_slug: `rec-${i}`,
      recording_title: `Match ${i}`,
      stage: 'home_assign' as const,
      error: 'boom',
    }))
    await sendRunReportEmail({
      result: makeResult({ status: 'partial', errors }),
      trigger: 'cron',
      leagueClubSlug: 'lyl',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.html).toContain('Match 0')
    expect(body.html).toContain('Match 49')
    expect(body.html).not.toContain('Match 50') // truncated
    expect(body.html).toContain('23 more')
  })

  it('no-ops when RESEND_API_KEY is missing', async () => {
    delete process.env.RESEND_API_KEY
    await sendRunReportEmail({
      result: makeResult(),
      trigger: 'cron',
      leagueClubSlug: 'lyl',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('no-ops when LYL_REPORT_EMAIL is missing', async () => {
    delete process.env.LYL_REPORT_EMAIL
    await sendRunReportEmail({
      result: makeResult(),
      trigger: 'cron',
      leagueClubSlug: 'lyl',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not throw when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    await expect(
      sendRunReportEmail({
        result: makeResult(),
        trigger: 'cron',
        leagueClubSlug: 'lyl',
      })
    ).resolves.toBeUndefined()
  })

  it('does not throw on non-200 Resend response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'bad key',
    })
    await expect(
      sendRunReportEmail({
        result: makeResult(),
        trigger: 'cron',
        leagueClubSlug: 'lyl',
      })
    ).resolves.toBeUndefined()
  })
})

describe('sendRunCrashEmail', () => {
  it('uses CRASHED subject prefix and truncates long messages to 80 chars', async () => {
    const longMessage = 'crashed because '.repeat(20) // ~320 chars
    await sendRunCrashEmail(new Error(longMessage), {
      trigger: 'cron',
      leagueClubSlug: 'lyl',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.subject.startsWith('[LYL sync · CRASHED] ')).toBe(true)
    // Subject body (after prefix) is the message truncated to 80 chars
    const subjectBody = body.subject.replace('[LYL sync · CRASHED] ', '')
    expect(subjectBody.length).toBeLessThanOrEqual(80)
  })

  it('handles non-Error throwables', async () => {
    await sendRunCrashEmail('a string was thrown', {
      trigger: 'manual',
      leagueClubSlug: 'lyl',
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.subject).toContain('a string was thrown')
  })

  it('no-ops when env vars missing', async () => {
    delete process.env.RESEND_API_KEY
    await sendRunCrashEmail(new Error('x'), {
      trigger: 'cron',
      leagueClubSlug: 'lyl',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
