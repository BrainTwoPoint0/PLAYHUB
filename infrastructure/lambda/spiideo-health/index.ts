// Lambda: Spiideo scene/camera health poller + API-accessibility canary.
// Runs every 15 minutes via EventBridge. Signs into the INTERNAL Spiideo API
// (api.spiideo.com), validates the response contract, and upserts a health
// snapshot per scene into playhub_spiideo_scene_health.
//
// The API is reverse-engineered and undocumented, so the primary job of this
// Lambda is as much to detect when Spiideo CHANGES that API as to record
// health: any sign-in failure or shape drift trips the canary (email + the
// ApiReachable / ContractErrors / Lambda Errors alarms).
// See docs/decisions/2026-07-01-spiideo-scene-health.md.

import { createClient } from '@supabase/supabase-js'
import {
  signIn,
  getOverview,
  getScenesWithStatus,
  validateContract,
  mapSceneToRow,
  type SceneHealthRow,
  type SpiideoOverview,
} from './spiideo-health-client'

const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || ''
const RESEND_API_KEY = process.env.RESEND_API_KEY || ''
const ALERT_EMAIL = process.env.ALERT_EMAIL || ''

// Error prefixes so the catch block can tell "the reverse-engineered API
// changed" apart from "our own DB/config broke" and alert accordingly — a
// misattributed page sends the on-call chasing the wrong system.
const ERR_CONFIG = 'CONFIG:'
const ERR_DB = 'DB:'

// ── config ──────────────────────────────────────────────────────────

export interface PollConfig {
  email: string
  password: string
  accountId: string
  dryRun: boolean
}

// Read at call time (not module load) so a missing credential throws a clear,
// classified error instead of surfacing as a confusing sign-in failure that
// looks like API drift.
export function configFromEnv(): PollConfig {
  const email = process.env.SPIIDEO_PLAY_EMAIL || ''
  const password = process.env.SPIIDEO_PLAY_PASSWORD || ''
  const accountId = process.env.SPIIDEO_ACCOUNT_ID || ''
  const missing = [
    !email && 'SPIIDEO_PLAY_EMAIL',
    !password && 'SPIIDEO_PLAY_PASSWORD',
    !accountId && 'SPIIDEO_ACCOUNT_ID',
  ].filter(Boolean)
  if (missing.length) {
    throw new Error(`${ERR_CONFIG} missing env: ${missing.join(', ')}`)
  }
  return { email, password, accountId, dryRun: process.env.DRY_RUN === '1' }
}

// ── helpers ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

async function sendAlertEmail(subject: string, body: string): Promise<void> {
  if (!RESEND_API_KEY || !ALERT_EMAIL) return
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'PLAYHUB <admin@playbacksports.ai>',
        to: [ALERT_EMAIL],
        subject,
        html: `<pre style="font-family: monospace">${escapeHtml(body)}</pre>`,
      }),
    })
  } catch (err) {
    console.error('Failed to send alert email:', err)
  }
}

interface HealthMetrics {
  apiReachable: number // 1 = signed in + valid contract; 0 = unreachable OR drifted
  contractErrors: number // 1 = response parsed but lost fields we persist
  scenesUpserted: number
  scenesOnline: number
  scenesOffline: number
}

// EMF metrics — the ApiReachable/ContractErrors alarms read these. The handler
// also throws on failure so the AWS/Lambda Errors alarm fires too; the custom
// metrics distinguish "API gone" (ApiReachable=0) from "shape changed"
// (ContractErrors=1) in the alert. Note a reachable-but-drifted API reports
// apiReachable=0 AND contractErrors=1.
function emitMetrics(m: HealthMetrics): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'PLAYHUB/SpiideoHealth',
            Dimensions: [[]],
            Metrics: [
              { Name: 'ApiReachable', Unit: 'Count' },
              { Name: 'ContractErrors', Unit: 'Count' },
              { Name: 'ScenesUpserted', Unit: 'Count' },
              { Name: 'ScenesOnline', Unit: 'Count' },
              { Name: 'ScenesOffline', Unit: 'Count' },
            ],
          },
        ],
      },
      ApiReachable: m.apiReachable,
      ContractErrors: m.contractErrors,
      ScenesUpserted: m.scenesUpserted,
      ScenesOnline: m.scenesOnline,
      ScenesOffline: m.scenesOffline,
    })
  )
}

// Upsert the snapshot, backfilling organization_id from the venue mapping so a
// single write carries the org link (no second UPDATE pass). Throws DB-tagged
// errors so the caller classifies them as our-infra failures, not API drift.
async function upsertRows(rows: SceneHealthRow[]): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error(`${ERR_CONFIG} SUPABASE_URL / SUPABASE_SERVICE_KEY not set`)
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  const ids = rows.map((r) => r.scene_id)
  const { data: maps, error: mapErr } = await supabase
    .from('playhub_scene_venue_mapping')
    .select('scene_id, organization_id')
    .in('scene_id', ids)
  if (mapErr) {
    // Throw rather than continue: proceeding would upsert organization_id=null
    // for every row and wipe previously-good org links. A mapping-read failure
    // is a real DB fault worth surfacing.
    throw new Error(`${ERR_DB} venue-mapping lookup failed: ${mapErr.message}`)
  }
  const orgByScene = new Map<string, string | null>(
    (maps ?? []).map(
      (m: { scene_id: string; organization_id: string | null }) => [
        m.scene_id,
        m.organization_id,
      ]
    )
  )
  for (const r of rows) {
    r.organization_id = orgByScene.get(r.scene_id) ?? null
  }

  const { error } = await supabase
    .from('playhub_spiideo_scene_health')
    .upsert(rows as unknown as Record<string, unknown>[], {
      onConflict: 'scene_id',
    })
  if (error) {
    throw new Error(`${ERR_DB} upsert failed: ${error.message}`)
  }
}

// ── poll (testable core) ────────────────────────────────────────────

export interface PollDeps {
  config?: PollConfig
  fetchImpl?: typeof fetch
  writeRows?: (rows: SceneHealthRow[]) => Promise<void>
  sendAlert?: (subject: string, body: string) => Promise<void>
}

export interface PollResult {
  statusCode: number
  body: string
  metrics: HealthMetrics
}

// The whole poll, with every side-effect injectable so branch behaviour (happy
// / contract-drift / network-fail / DB-fail / config-missing) is unit-testable.
export async function runPoll(deps: PollDeps = {}): Promise<PollResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sendAlert = deps.sendAlert ?? sendAlertEmail

  const metrics: HealthMetrics = {
    apiReachable: 0,
    contractErrors: 0,
    scenesUpserted: 0,
    scenesOnline: 0,
    scenesOffline: 0,
  }

  try {
    const config = deps.config ?? configFromEnv()
    const writeRows =
      deps.writeRows ??
      (config.dryRun
        ? async (rows: SceneHealthRow[]) => {
            console.log(`DRY_RUN: would upsert ${rows.length} scenes`)
          }
        : upsertRows)

    console.log(`Starting Spiideo health poll (dryRun=${config.dryRun})`)

    const { status, jwt } = await signIn(
      config.email,
      config.password,
      fetchImpl
    )
    const scenes = jwt
      ? await getScenesWithStatus(jwt, config.accountId, fetchImpl)
      : undefined

    const contract = validateContract({ signInStatus: status, jwt, scenes })
    if (!contract.ok) {
      metrics.contractErrors = 1
      throw new Error(
        `Spiideo API contract failed: ${contract.failures.join('; ')}`
      )
    }

    // contract.ok guarantees scenes.content is an array
    metrics.apiReachable = 1

    // Overview is best-effort: we don't persist it, so a change to that summary
    // endpoint must not block writing scene health. Log and move on.
    let overview: SpiideoOverview | undefined
    try {
      overview = await getOverview(jwt!, config.accountId, fetchImpl)
    } catch (err) {
      console.warn(
        'overview fetch failed (non-blocking):',
        err instanceof Error ? err.message : String(err)
      )
    }

    const checkedAt = new Date().toISOString()
    const rows = scenes!.content.map((s) =>
      mapSceneToRow(s, config.accountId, checkedAt)
    )
    metrics.scenesOnline = rows.filter((r) => r.online === true).length
    metrics.scenesOffline = rows.length - metrics.scenesOnline

    if (config.dryRun) {
      for (const r of rows) {
        console.log(
          `  ${r.scene_name} online=${r.online} alert=${r.alert_state} cams=${r.online_cameras}/${r.camera_count} outages=${r.outages}`
        )
      }
    }
    await writeRows(rows)
    metrics.scenesUpserted = rows.length

    emitMetrics(metrics)
    console.log(
      `Spiideo health poll OK — upserted ${metrics.scenesUpserted} scenes (${metrics.scenesOnline} online, ${metrics.scenesOffline} offline)`
    )
    return {
      statusCode: 200,
      body: JSON.stringify({
        scenesUpserted: metrics.scenesUpserted,
        scenesOnline: metrics.scenesOnline,
        scenesOffline: metrics.scenesOffline,
        overview,
      }),
      metrics,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('Spiideo health poll FAILED:', message)
    emitMetrics(metrics)

    // Classify so the alert points at the right system.
    let subject: string
    let preamble: string
    if (message.startsWith(ERR_CONFIG)) {
      subject = '⚙️ Spiideo health FAILED — configuration'
      preamble = 'The spiideo-health Lambda is misconfigured (missing env).'
    } else if (message.startsWith(ERR_DB)) {
      subject = '🗄️ Spiideo health FAILED — database write'
      preamble =
        'The spiideo-health Lambda read the Spiideo API fine but could not write to Supabase.'
    } else {
      subject =
        '🚨 Spiideo health canary FAILED — internal API may have changed'
      preamble =
        `The spiideo-health Lambda could not read scene health from api.spiideo.com. ` +
        `This is a reverse-engineered private API; if it persists, re-run the recon ` +
        `(veo-automations/spiideo-cloudcontrol-recon.mjs) to find the new shape.`
    }
    await sendAlert(subject, `${preamble}\n\nReason: ${message}`)

    // Re-throw so the AWS/Lambda Errors alarm also fires.
    throw err
  }
}

// ── handler ─────────────────────────────────────────────────────────

export const handler = async (): Promise<{
  statusCode: number
  body: string
}> => {
  const { statusCode, body } = await runPoll()
  return { statusCode, body }
}
