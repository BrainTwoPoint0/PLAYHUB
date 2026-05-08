import type { HealthResponse } from './types'

// Module-scope aggregate cache for the GET /api/health response. Keeps
// the route cheap under burst — a scraper at 100 rps lands on the
// cached body, so Stripe / Supabase service role / S3 only get hit at
// most once per TTL per Lambda instance.
//
// Status-aware TTL: a `healthy` body caches longer than `degraded` /
// `unhealthy`. The shorter TTL only kicks in *after* the first
// non-healthy result lands — i.e., this caps the lag between detecting
// an outage and being able to clear the alert, NOT the lag between an
// outage starting and being detected. The first detection still has up
// to `HEALTHY_TTL_MS` of stale-cache headroom, which is intentional —
// UptimeRobot at 60s cadence is the actual outage detector.
const HEALTHY_TTL_MS = 30_000
const UNHEALTHY_TTL_MS = 5_000

let cached: {
  body: HealthResponse
  httpStatus: number
  expiresAt: number
} | null = null

export const responseCache = {
  get() {
    if (cached && Date.now() < cached.expiresAt) return cached
    return null
  },
  set(body: HealthResponse, httpStatus: number) {
    const ttl = body.status === 'healthy' ? HEALTHY_TTL_MS : UNHEALTHY_TTL_MS
    cached = { body, httpStatus, expiresAt: Date.now() + ttl }
  },
}

// Test-only: clear the in-memory cache between cases.
export function _resetHealthResponseCache() {
  cached = null
}
