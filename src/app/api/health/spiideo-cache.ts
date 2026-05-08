import type { ServiceStatus } from './types'

let cached: { result: ServiceStatus; expiresAt: number } | null = null

export const spiideoHealthCache = {
  get(): ServiceStatus | null {
    if (cached && Date.now() < cached.expiresAt) return cached.result
    return null
  },
  set(result: ServiceStatus, ttlMs: number) {
    cached = { result, expiresAt: Date.now() + ttlMs }
  },
  reset() {
    cached = null
  },
}
