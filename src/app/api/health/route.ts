import { NextResponse } from 'next/server'

// ─── Types ──────────────────────────────────────────────────────

interface ServiceStatus {
  name: string
  status: 'healthy' | 'unhealthy'
  latencyMs: number
  error?: string
  critical: boolean
}

interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  timestamp: string
  uptime: number
  services: ServiceStatus[]
}

// ─── Individual Health Checks ───────────────────────────────────

const CHECK_TIMEOUT = 5000

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
  )
  return Promise.race([promise, timeout])
}

async function checkSpiideo(): Promise<ServiceStatus> {
  const start = Date.now()
  try {
    const { testConnection } = await import('@/lib/spiideo/client')
    const result = await withTimeout(testConnection('kuwait'), CHECK_TIMEOUT)
    if (!result.success) throw new Error(result.error || 'Connection failed')
    return {
      name: 'spiideo',
      status: 'healthy',
      latencyMs: Date.now() - start,
      critical: true,
    }
  } catch (err) {
    return {
      name: 'spiideo',
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : 'Unknown error',
      critical: true,
    }
  }
}

async function checkS3(): Promise<ServiceStatus> {
  const start = Date.now()
  try {
    const { HeadObjectCommand, S3Client } = await import('@aws-sdk/client-s3')
    const client = new S3Client({
      region: process.env.PLAYHUB_AWS_REGION || 'eu-west-2',
      credentials: {
        accessKeyId: process.env.PLAYHUB_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY!,
      },
    })
    try {
      await withTimeout(
        client.send(
          new HeadObjectCommand({
            Bucket: process.env.S3_RECORDINGS_BUCKET!,
            Key: '_health',
          })
        ),
        CHECK_TIMEOUT
      )
    } catch (e: any) {
      // 404 NotFound = bucket is accessible, key just doesn't exist → healthy
      // 403 AccessDenied = bad credentials → unhealthy
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
      error: err instanceof Error ? err.message : 'Unknown error',
      critical: true,
    }
  }
}

async function checkSupabase(): Promise<ServiceStatus> {
  const start = Date.now()
  try {
    const { createServiceClient } = await import('@/lib/supabase/server')
    const supabase = createServiceClient()
    const query = supabase
      .from('profiles')
      .select('id', { head: true, count: 'exact' })
      .limit(0)
    const { error } = await withTimeout(Promise.resolve(query), CHECK_TIMEOUT)
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
      error: err instanceof Error ? err.message : 'Unknown error',
      critical: true,
    }
  }
}

async function checkStripe(): Promise<ServiceStatus> {
  const start = Date.now()
  try {
    const Stripe = (await import('stripe')).default
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
    await withTimeout(stripe.balance.retrieve(), CHECK_TIMEOUT)
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
      error: err instanceof Error ? err.message : 'Unknown error',
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
    error: hasKey ? undefined : 'RESEND_API_KEY not set',
    critical: false,
  }
}

// ─── Route Handler ──────────────────────────────────────────────

const startTime = Date.now()

export async function GET() {
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
          error: r.reason?.message || 'Check failed',
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
    uptime: Math.floor((Date.now() - startTime) / 1000),
    services,
  }

  return NextResponse.json(body, {
    status: overallStatus === 'unhealthy' ? 503 : 200,
  })
}
