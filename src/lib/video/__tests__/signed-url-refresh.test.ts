import { describe, it, expect } from 'vitest'
import {
  expiresAtMs,
  refreshDelayMs,
  isExpiryError,
} from '../signed-url-refresh'

const CF = (expUnix: number) =>
  `https://d1.cloudfront.net/recordings/x.mp4?Expires=${expUnix}&Key-Pair-Id=K1&Signature=abc`

describe('expiresAtMs', () => {
  it('parses a CloudFront Expires (seconds → ms)', () => {
    expect(expiresAtMs(CF(1784486785))).toBe(1784486785 * 1000)
  })

  it('parses an S3 presigned X-Amz-Date + X-Amz-Expires', () => {
    // 2026-07-19T18:46:25Z + 3600s
    const url =
      'https://b.s3.amazonaws.com/x.mp4?X-Amz-Date=20260719T184625Z&X-Amz-Expires=3600&X-Amz-Signature=z'
    expect(expiresAtMs(url)).toBe(Date.UTC(2026, 6, 19, 18, 46, 25) + 3600_000)
  })

  it('returns null for a non-URL, an unsigned URL, or a malformed Expires', () => {
    expect(expiresAtMs('not a url')).toBeNull()
    expect(expiresAtMs('https://x/y.mp4')).toBeNull()
    expect(expiresAtMs('https://x/y.mp4?Expires=abc')).toBeNull()
    expect(expiresAtMs('https://x/y.mp4?Expires=0')).toBeNull()
    expect(
      expiresAtMs('https://x/y.mp4?X-Amz-Date=nope&X-Amz-Expires=3600')
    ).toBeNull()
  })
})

describe('refreshDelayMs', () => {
  const now = 1_000_000_000_000
  it('returns 80% of remaining lifetime by default', () => {
    const exp = now + 4 * 3600_000 // 4h out
    expect(refreshDelayMs(CF(exp / 1000), now)).toBe(4 * 3600_000 * 0.8)
  })

  it('floors at minMs so a URL near expiry still refreshes', () => {
    const exp = now + 20_000 // 20s out, below the 30s floor
    expect(refreshDelayMs(CF(exp / 1000), now)).toBe(0) // remaining <= minMs → refresh now
    const exp2 = now + 40_000 // 40s out; 80% = 32s but floor keeps >= 30s
    expect(refreshDelayMs(CF(exp2 / 1000), now)).toBe(32_000)
  })

  it('returns 0 (not negative) for an already-expired URL', () => {
    expect(refreshDelayMs(CF((now - 10_000) / 1000), now)).toBe(0)
  })

  it('returns null when expiry is unknown (reactive-only)', () => {
    expect(refreshDelayMs('https://x/y.mp4', now)).toBeNull()
  })
})

describe('isExpiryError', () => {
  it('is true for NETWORK(2) and SRC_NOT_SUPPORTED(4)', () => {
    expect(isExpiryError({ code: 2 } as MediaError)).toBe(true)
    expect(isExpiryError({ code: 4 } as MediaError)).toBe(true)
  })
  it('is false for ABORTED(1), DECODE(3), and null', () => {
    expect(isExpiryError({ code: 1 } as MediaError)).toBe(false)
    expect(isExpiryError({ code: 3 } as MediaError)).toBe(false)
    expect(isExpiryError(null)).toBe(false)
    expect(isExpiryError(undefined)).toBe(false)
  })
})
