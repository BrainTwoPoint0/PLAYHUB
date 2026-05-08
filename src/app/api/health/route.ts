import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { spiideoHealthCache } from './spiideo-cache'
import { responseCache } from './response-cache'
import { testConnection } from '@/lib/spiideo/client'
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createServiceClient } from '@/lib/supabase/server'
import Stripe from 'stripe'
import type {
  HealthErrorCode,
  HealthResponse,
  ServiceStatus,
} from './types'

// ─── Config ─────────────────────────────────────────────────────

const CHECK_TIMEOUT = 5000

// ─── Helpers ────────────────────────────────────────────────────

// Map raw errors to a fixed enum so we never echo SDK messages back to
// an unauthenticated caller — AWS errors leak bucket / region / ARN,
// Stripe leaks request IDs and key-prefix, Supabase leaks schema hints.
function classifyError(err: unknown): HealthErrorCode {
  if (!err) return 'unknown'
  const name = err instanceof Error ? err.name.toLowerCase() : ''
  const msg =
    err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase()
  // Search across both fields so AWS-style PascalCase error names
  // (`AccessDenied`, `Forbidden`) classify the same as their human
  // message counterparts (`Access Denied`, `Forbidden`).
  const haystack = `${name} ${msg}`
  if (
    haystack.includes('timeout') ||
    haystack.includes('aborted') ||
    name.includes('aborterror') ||
    name.includes('timeouterror')
  ) {
    return 'timeout'
  }
  if (
    haystack.includes('access denied') ||
    haystack.includes('accessdenied') ||
    haystack.includes('forbidden') ||
    haystack.includes('unauthorized') ||
    haystack.includes('invalid api key') ||
    haystack.includes('invalid auth') ||
    haystack.includes('401') ||
    haystack.includes('403')
  ) {
    return 'auth_failed'
  }
  if (
    haystack.includes('econnrefused') ||
    haystack.includes('enotfound') ||
    haystack.includes('econnreset') ||
    haystack.includes('network')
  ) {
    return 'connection_failed'
  }
  return 'unknown'
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
  )
  return Promise.race([promise, timeout])
}

// ─── Individual Health Checks ───────────────────────────────────

// Spiideo health is cached for 5 minutes (see ./spiideo-cache) to avoid
// hitting their rate limit on every probe.
async function checkSpiideo(): Promise<ServiceStatus> {
  const cached = spiideoHealthCache.get()
  if (cached) return { ...cached, latencyMs: 0 }

  const start = Date.now()
  try {
    const result = await withTimeout(testConnection(), CHECK_TIMEOUT)
    if (!result.success) throw new Error(result.error || 'Connection failed')
    const status: ServiceStatus = {
      name: 'spiideo',
      status: 'healthy',
      latencyMs: Date.now() - start,
      critical: false,
    }
    spiideoHealthCache.set(status, 5 * 60 * 1000)
    return status
  } catch (err) {
    const status: ServiceStatus = {
      name: 'spiideo',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: classifyError(err),
      critical: false,
    }
    spiideoHealthCache.set(status, 5 * 60 * 1000)
    return status
  }
}

async function checkS3(): Promise<ServiceStatus> {
  const start = Date.now()
  try {
    const client = new S3Client({
      region: process.env.PLAYHUB_AWS_REGION || 'eu-west-2',
      credentials: {
        accessKeyId: process.env.PLAYHUB_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY!,
      },
    })
    try {
      await client.send(
        new HeadObjectCommand({
          Bucket: process.env.S3_RECORDINGS_BUCKET!,
          Key: 'recordings/_health',
        }),
        { abortSignal: AbortSignal.timeout(CHECK_TIMEOUT) }
      )
    } catch (e: any) {
      // 404 NotFound = bucket is accessible, key just doesn't exist → healthy.
      // 403 AccessDenied = bad credentials → falls through to outer catch.
      if (e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404) {
        return {
          name: 's3',
          status: 'healthy',
          latencyMs: Date.now() - start,
          critical: true,
        }
      }
      throw e
    }
    return {
      name: 's3',
      status: 'healthy',
      latencyMs: Date.now() - start,
      critical: true,
    }
  } catch (err) {
    return {
      name: 's3',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: classifyError(err),
      critical: true,
    }
  }
}

async function checkSupabase(): Promise<ServiceStatus> {
  const start = Date.now()
  try {
    const supabase = createServiceClient()
    // `head: true` + `limit(0)` returns no row data — only the count
    // header. Service-role bypasses RLS, but the empty projection means
    // no row content is exposed.
    const { error } = await supabase
      .from('profiles')
      .select('id', { head: true, count: 'exact' })
      .limit(0)
      .abortSignal(AbortSignal.timeout(CHECK_TIMEOUT))
    if (error) throw error
    return {
      name: 'supabase',
      status: 'healthy',
      latencyMs: Date.now() - start,
      critical: true,
    }
  } catch (err) {
    return {
      name: 'supabase',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: classifyError(err),
      critical: true,
    }
  }
}

async function checkStripe(): Promise<ServiceStatus> {
  const start = Date.now()
  try {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      timeout: CHECK_TIMEOUT,
    })
    await stripe.balance.retrieve()
    return {
      name: 'stripe',
      status: 'healthy',
      latencyMs: Date.now() - start,
      critical: false,
    }
  } catch (err) {
    return {
      name: 'stripe',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: classifyError(err),
      critical: false,
    }
  }
}

async function checkResend(): Promise<ServiceStatus> {
  const start = Date.now()
  const hasKey = !!process.env.RESEND_API_KEY
  return {
    name: 'resend',
    status: hasKey ? 'healthy' : 'unhealthy',
    latencyMs: Date.now() - start,
    error: hasKey ? undefined : 'misconfigured',
    critical: false,
  }
}

// ─── Auth ───────────────────────────────────────────────────────

// Optional shared-secret header. When `HEALTH_CHECK_TOKEN` is unset the
// route stays open (current behaviour, keeps UptimeRobot working until
// the token is provisioned). When set, callers must send
// `x-health-token: <value>` — UptimeRobot supports custom headers per
// monitor.
function isAuthorized(req: Request): boolean {
  const required = process.env.HEALTH_CHECK_TOKEN
  if (!required) return true
  const provided = req.headers.get('x-health-token') ?? ''
  // Constant-time comparison. Length mismatch is treated as failure
  // without leaking the expected length via early-return.
  const a = Buffer.from(provided)
  const b = Buffer.from(required)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const instanceStartTime = Date.now()

// ─── Route Handler ──────────────────────────────────────────────

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return new NextResponse(null, {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const hit = responseCache.get()
  if (hit) {
    return NextResponse.json(hit.body, {
      status: hit.httpStatus,
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const results = await Promise.allSettled([
    checkSpiideo(),
    checkS3(),
    checkSupabase(),
    checkStripe(),
    checkResend(),
  ])

  const services: ServiceStatus[] = results.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : {
          name: 'unknown',
          status: 'unhealthy' as const,
          latencyMs: 0,
          error: classifyError(r.reason),
          critical: true,
        }
  )

  const criticalDown = services.some(
    (s) => s.critical && s.status === 'unhealthy'
  )
  const anyDown = services.some((s) => s.status === 'unhealthy')

  const overallStatus: HealthResponse['status'] = criticalDown
    ? 'unhealthy'
    : anyDown
      ? 'degraded'
      : 'healthy'

  const body: HealthResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    // Lambda-instance uptime, not service uptime — resets on cold start.
    // Named explicitly so dashboards don't misread it as availability.
    instanceUptime: Math.floor((Date.now() - instanceStartTime) / 1000),
    services,
  }
  const httpStatus = overallStatus === 'unhealthy' ? 503 : 200

  responseCache.set(body, httpStatus)

  return NextResponse.json(body, {
    status: httpStatus,
    headers: { 'Cache-Control': 'no-store' },
  })
}
