// Admin Spiideo scene-health API.
//
// GET  → the latest health snapshot per scene (from playhub_spiideo_scene_health).
// GET  ?speedTest={sceneId}&testId={id} → poll a running speed test's result.
// POST → issue a CloudControl device command against the internal Spiideo API:
//        speed-test (202, returns testId to poll) | test-recording (201).
//
// Platform-admin only (device commands mutate real cameras). Every command
// validates that sceneId is a scene we actually track before forwarding it to
// Spiideo — the sceneId is the only caller-controlled value that reaches the
// upstream API, so this closes the arbitrary-sceneId / SSRF-ish vector.
// Error details are logged server-side, never returned to the client.

import { NextRequest, NextResponse } from 'next/server'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'
import { getAuthUserStrict, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import {
  startSceneSpeedTest,
  getSpeedTestById,
  startTestRecording,
  SpiideoNotConfiguredError,
} from '@/lib/spiideo/internal-client'

const HEALTH_TABLE = 'playhub_spiideo_scene_health'
const SNAPSHOT_BUCKET = 'scene-snapshots'
const SNAPSHOT_URL_TTL_SECONDS = 300
const COMMAND_ACTIONS = ['speed-test', 'test-recording', 'snapshot'] as const
type CommandAction = (typeof COMMAND_ACTIONS)[number]

// Per-scene cooldown — a snapshot spins up a real live camera session, so guard
// against double-click / spam the same way test-recording does. Per warm
// instance (best-effort), same as lastTestRecording.
const SNAPSHOT_COOLDOWN_MS = 90_000
const lastSnapshot = new Map<string, number>()

// Best-effort per-scene cooldown so a double-click / runaway client can't spam
// real camera recordings. Module-scoped → per warm serverless instance only
// (not a hard guarantee), but catches the common case cheaply.
const TEST_RECORDING_COOLDOWN_MS = 90_000
const lastTestRecording = new Map<string, number>()

// Shared gate — returns null on success, or a NextResponse to short-circuit.
async function requireAdmin(): Promise<{ userId: string } | NextResponse> {
  const { user } = await getAuthUserStrict()
  if (!user)
    return NextResponse.json(
      { error: 'Unauthorized', code: 'unauthorized' },
      { status: 401 }
    )
  if (!(await isPlatformAdmin(user.id)))
    return NextResponse.json(
      { error: 'Forbidden', code: 'forbidden' },
      { status: 403 }
    )
  return { userId: user.id }
}

// Reject cross-site POSTs to an endpoint that physically actuates cameras.
function sameOriginOk(request: NextRequest): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return true // same-origin navigations may omit Origin
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

// Map a thrown internal-client error to a safe client response (logs the real
// message server-side; never leaks internal paths / env-var names to the client).
function spiideoErrorResponse(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : String(err)
  console.error('[scene-health] Spiideo command failed:', message)
  if (err instanceof SpiideoNotConfiguredError) {
    return NextResponse.json(
      {
        error: 'Spiideo integration is not configured',
        code: 'not_configured',
      },
      { status: 503 }
    )
  }
  return NextResponse.json(
    { error: 'Spiideo command failed', code: 'spiideo_error' },
    { status: 502 }
  )
}

export async function GET(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate instanceof NextResponse) return gate

  const { searchParams } = new URL(request.url)
  const speedTestScene = searchParams.get('speedTest')
  const testId = searchParams.get('testId')

  // Speed-test status poll.
  if (speedTestScene) {
    if (!testId) {
      return NextResponse.json(
        { error: 'testId required', code: 'bad_request' },
        { status: 400 }
      )
    }
    try {
      const result = await getSpeedTestById(speedTestScene, testId)
      return NextResponse.json({ result })
    } catch (err) {
      return spiideoErrorResponse(err)
    }
  }

  // Full health list.
  const supabase = createServiceClient() as any
  const { data, error } = await supabase
    .from(HEALTH_TABLE)
    .select(
      'scene_id, scene_name, online, alert_state, camera_count, online_cameras, outages, last_online_change, last_checked_at, organization_id, organizations(name), last_snapshot_at, last_snapshot_status, last_snapshot_error'
    )
    .order('online', { ascending: false })
    .order('alert_state', { ascending: true })
    .order('scene_name', { ascending: true })

  if (error) {
    console.error('[scene-health] list query failed:', error.message)
    return NextResponse.json(
      { error: 'Failed to load scene health', code: 'db_error' },
      { status: 500 }
    )
  }

  const scenes = (data ?? []).map((r: any) => ({
    sceneId: r.scene_id,
    sceneName: r.scene_name,
    organizationId: r.organization_id,
    venueName: r.organizations?.name ?? null,
    online: r.online,
    alertState: r.alert_state,
    cameraCount: r.camera_count,
    onlineCameras: r.online_cameras,
    outages: r.outages,
    lastOnlineChange: r.last_online_change,
    lastCheckedAt: r.last_checked_at,
    lastSnapshotAt: r.last_snapshot_at,
    lastSnapshotStatus: r.last_snapshot_status,
    snapshotUrl: null as string | null, // filled with a signed URL below
  }))

  // scene-snapshots is a PRIVATE bucket (frames can contain minors) — mint
  // short-TTL signed URLs for scenes that have a snapshot, rather than exposing
  // a public object URL.
  const snapScenes = scenes.filter((s: any) => s.lastSnapshotAt)
  if (snapScenes.length > 0) {
    const { data: signed } = await supabase.storage
      .from(SNAPSHOT_BUCKET)
      .createSignedUrls(
        snapScenes.map((s: any) => `${s.sceneId}.jpg`),
        SNAPSHOT_URL_TTL_SECONDS
      )
    const byPath = new Map(
      (signed ?? []).map((x: any) => [x.path, x.signedUrl])
    )
    for (const s of scenes) {
      if (s.lastSnapshotAt)
        s.snapshotUrl = byPath.get(`${s.sceneId}.jpg`) ?? null
    }
  }

  const summary = {
    total: scenes.length,
    online: scenes.filter((s: any) => s.online === true).length,
    attention: scenes.filter(
      (s: any) => s.alertState && s.alertState !== 'none'
    ).length,
  }

  return NextResponse.json({ summary, scenes })
}

export async function POST(request: NextRequest) {
  const gate = await requireAdmin()
  if (gate instanceof NextResponse) return gate
  if (!sameOriginOk(request)) {
    return NextResponse.json(
      { error: 'Cross-origin request rejected', code: 'forbidden' },
      { status: 403 }
    )
  }

  let body: { action?: string; sceneId?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON body', code: 'bad_request' },
      { status: 400 }
    )
  }

  const action = body.action as CommandAction
  const sceneId = body.sceneId
  if (!action || !COMMAND_ACTIONS.includes(action)) {
    return NextResponse.json(
      {
        error: `action must be one of: ${COMMAND_ACTIONS.join(', ')}`,
        code: 'bad_request',
      },
      { status: 400 }
    )
  }
  if (!sceneId || typeof sceneId !== 'string') {
    return NextResponse.json(
      { error: 'sceneId required', code: 'bad_request' },
      { status: 400 }
    )
  }

  // Only ever forward a sceneId we actually track. Prevents a caller from
  // pointing our authenticated Spiideo session at an arbitrary scene id.
  const supabase = createServiceClient() as any
  const { data: scene, error: lookupErr } = await supabase
    .from(HEALTH_TABLE)
    .select('scene_id, scene_name, online')
    .eq('scene_id', sceneId)
    .maybeSingle()
  if (lookupErr) {
    console.error('[scene-health] scene lookup failed:', lookupErr.message)
    return NextResponse.json(
      { error: 'Scene lookup failed', code: 'db_error' },
      { status: 500 }
    )
  }
  if (!scene) {
    return NextResponse.json(
      { error: 'Unknown sceneId', code: 'not_found' },
      { status: 404 }
    )
  }

  try {
    if (action === 'speed-test') {
      const { id } = await startSceneSpeedTest(sceneId)
      return NextResponse.json({ started: true, testId: id }, { status: 202 })
    }

    // test-recording and snapshot both actuate a live camera — require online.
    if (scene.online !== true) {
      return NextResponse.json(
        {
          error: 'Scene is offline — the camera must be online',
          code: 'scene_offline',
        },
        { status: 409 }
      )
    }

    if (action === 'test-recording') {
      const now = Date.now()
      const last = lastTestRecording.get(sceneId) ?? 0
      if (now - last < TEST_RECORDING_COOLDOWN_MS) {
        return NextResponse.json(
          {
            error:
              'A test recording was just started for this scene — please wait',
            code: 'cooldown',
          },
          { status: 429 }
        )
      }
      lastTestRecording.set(sceneId, now)
      const recording = await startTestRecording(
        sceneId,
        scene.scene_name ?? sceneId
      )
      return NextResponse.json({ started: true, recording }, { status: 201 })
    }

    // action === 'snapshot' — hand off to the ffmpeg Lambda asynchronously.
    const lambdaName = process.env.SPIIDEO_SNAPSHOT_LAMBDA_NAME
    const apiKey = process.env.SNAPSHOT_API_KEY
    const awsKeyId = process.env.SNAPSHOT_INVOKE_AWS_ACCESS_KEY_ID
    const awsSecret = process.env.SNAPSHOT_INVOKE_AWS_SECRET_ACCESS_KEY
    if (!lambdaName || !apiKey || !awsKeyId || !awsSecret) {
      return NextResponse.json(
        { error: 'Snapshot Lambda not configured', code: 'not_configured' },
        { status: 503 }
      )
    }
    const snapNow = Date.now()
    if (snapNow - (lastSnapshot.get(sceneId) ?? 0) < SNAPSHOT_COOLDOWN_MS) {
      return NextResponse.json(
        {
          error: 'A snapshot was just requested for this scene — please wait',
          code: 'cooldown',
        },
        { status: 429 }
      )
    }
    // Direct async invoke (InvocationType: Event → 202) as the scoped
    // snapshot-invoker IAM user. (This account's guardrail blocks Function URL
    // invokes, so we invoke the function directly rather than via a URL.) The
    // Lambda owns the status lifecycle (it writes 'pending' first, then
    // 'ready'/'error'), so a failed invoke here never strands the row. The
    // ~40-60s capture outlives Netlify's timeout; the client polls the row. The
    // payload is the Function-URL event shape the handler already parses.
    const lambda = new LambdaClient({
      region: process.env.SNAPSHOT_INVOKE_AWS_REGION || 'eu-west-2',
      credentials: { accessKeyId: awsKeyId, secretAccessKey: awsSecret },
      maxAttempts: 1, // don't retry a device-command invoke
    })
    let httpStatus: number | undefined
    try {
      const out = await lambda.send(
        new InvokeCommand({
          FunctionName: lambdaName,
          InvocationType: 'Event',
          Payload: JSON.stringify({
            headers: { 'x-api-key': apiKey },
            body: JSON.stringify({ sceneId }),
          }),
        })
      )
      httpStatus = out.$metadata.httpStatusCode
    } catch (err) {
      console.error(
        `[scene-health] snapshot invoke error:`,
        err instanceof Error ? err.message : String(err)
      )
    }
    if (httpStatus !== 202) {
      console.error(
        `[scene-health] snapshot invoke rejected httpStatus=${httpStatus}`
      )
      return NextResponse.json(
        { error: 'Snapshot could not be started', code: 'invoke_failed' },
        { status: 502 }
      )
    }
    lastSnapshot.set(sceneId, snapNow)
    return NextResponse.json({ started: true }, { status: 202 })
  } catch (err) {
    return spiideoErrorResponse(err)
  }
}
