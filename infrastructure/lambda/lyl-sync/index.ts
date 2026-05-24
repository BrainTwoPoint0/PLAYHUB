// Lambda handler for the weekly LYL Veo recording-assignment sync.
//
// Two entry points:
//   - EventBridge cron (weekly, Mon 06:00 UTC) — trigger='cron', no auth.
//   - Lambda Function URL POST (admin UI manual trigger) — trigger='manual',
//     x-api-key required (LYL_SYNC_API_KEY).
//
// Wraps the orchestrator (src/lib/lyl-sync/orchestrator.ts) — all real
// logic lives there. This file is the thin Lambda contract: parse event
// → invoke orchestrator → tear down Veo session → return JSON summary.

import { createClient } from '@supabase/supabase-js'
import { runSync } from '../../../src/lib/lyl-sync/orchestrator'
import { buildDefaultDeps as buildParserDeps } from '../../../src/lib/lyl-sync/parser'
import { veoAdapter, shutdownVeo } from './veo-adapter'
import { sendRunReportEmail, sendRunCrashEmail } from './email-report'

const LEAGUE_CLUB_SLUG = process.env.LEAGUE_CLUB_SLUG || 'lyl'
const SHARE_RECIPIENT_EMAIL =
  process.env.LYL_SHARE_RECIPIENT_EMAIL || process.env.VEO_EMAIL!
const LAMBDA_API_KEY = process.env.LYL_SYNC_API_KEY || ''

// EventBridge event shape (cron). The `source: aws.events` discriminator
// is what we key on.
interface EventBridgeEvent {
  source?: string
  'detail-type'?: string
  detail?: Record<string, unknown>
}

// Lambda Function URL invocation shape (manual / API trigger).
interface FunctionUrlEvent {
  requestContext?: { http?: { method?: string } }
  headers?: Record<string, string>
  body?: string
  isBase64Encoded?: boolean
}

type LambdaEvent = EventBridgeEvent & FunctionUrlEvent

interface ManualBody {
  trigger?: 'manual' | 'api'
  /** Caller's auth user id; required for non-cron triggers per DB CHECK. */
  createdBy?: string
  /** Limit run to a single recording (re-trigger from admin UI). */
  onlyRecordingSlug?: string
}

export async function handler(event: LambdaEvent) {
  // Server-only Lambda: prefer SUPABASE_URL but fall back to
  // NEXT_PUBLIC_SUPABASE_URL when invoking from a local-dev shell that
  // still uses the Next-prefixed convention. Either resolves the same
  // Supabase project.
  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!supabaseUrl)
    throw new Error('SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) must be set')
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY must be set')
  }
  const supabase = createClient(
    supabaseUrl,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  )

  // Discriminate EventBridge (cron) vs Function URL (manual API call).
  // EventBridge events carry `source: "aws.events"`; URL invocations
  // carry `requestContext.http`.
  const isFunctionUrl = !!event.requestContext?.http
  let trigger: 'cron' | 'manual' | 'api' = 'cron'
  let createdBy: string | undefined
  let onlyRecordingSlug: string | undefined

  if (isFunctionUrl) {
    // Auth: x-api-key header. Anything wrong → 401.
    const provided =
      event.headers?.['x-api-key'] || event.headers?.['X-Api-Key']
    if (!LAMBDA_API_KEY || provided !== LAMBDA_API_KEY) {
      return jsonResponse(401, { error: 'unauthorized' })
    }
    const body: ManualBody = event.body
      ? JSON.parse(
          event.isBase64Encoded
            ? Buffer.from(event.body, 'base64').toString()
            : event.body
        )
      : {}
    trigger = body.trigger ?? 'manual'
    createdBy = body.createdBy
    onlyRecordingSlug = body.onlyRecordingSlug
    if (trigger !== 'cron' && !createdBy) {
      return jsonResponse(400, {
        error:
          'createdBy required for manual/api triggers (DB CHECK chk_created_by_when_human_trigger)',
      })
    }
  }

  try {
    const result = await runSync(
      {
        leagueClubSlug: LEAGUE_CLUB_SLUG,
        // Veo's club slug differs from our DB slug — orchestrator uses
        // this for share-accepted-copy detection (Veo prefixes share-
        // copy slugs with the recipient's Veo club slug).
        veoClubSlug: process.env.VEO_CLUB_SLUG || LEAGUE_CLUB_SLUG,
        trigger,
        createdBy,
        onlyRecordingSlug,
        shareRecipientEmail: SHARE_RECIPIENT_EMAIL,
      },
      {
        supabase,
        veo: veoAdapter,
        parserFactory: () => buildParserDeps(),
      }
    )

    // Fire-and-log report email. Wrapped so a Resend outage can't
    // poison the Lambda response — sendRunReportEmail already swallows
    // its own errors but we belt-and-brace here too. Pass the supabase
    // client so the email can render the per-recording actions table
    // (queried by last_sync_run_id from playhub_recording_assignments).
    await sendRunReportEmail({
      result,
      trigger,
      leagueClubSlug: LEAGUE_CLUB_SLUG,
      supabase,
    }).catch((emailErr) => {
      console.error('lyl-sync: report email dispatch failed', emailErr)
    })

    // Compact response — full per-recording detail is in
    // playhub_recording_sync_runs.errors_jsonb for the email + admin UI.
    return isFunctionUrl
      ? jsonResponse(200, result)
      : { statusCode: 200, body: JSON.stringify(result) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('lyl-sync: unhandled error', message)
    // Crash path — no RunSyncResult row was written, so the admin UI
    // wouldn't show this failure. Email is the only out-of-band signal.
    await sendRunCrashEmail(err, {
      trigger,
      leagueClubSlug: LEAGUE_CLUB_SLUG,
    }).catch(() => {})
    return isFunctionUrl
      ? jsonResponse(500, { error: 'internal_error', message })
      : {
          statusCode: 500,
          body: JSON.stringify({ error: 'internal_error', message }),
        }
  } finally {
    // Always close the browser session — even after a thrown error.
    // Without this, the Lambda container's warm pool keeps a live
    // Chromium process around forever.
    await shutdownVeo().catch(() => {})
  }
}

function jsonResponse(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}
