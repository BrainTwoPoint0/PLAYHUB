// Signed-URL refresh helpers — decide WHEN to re-sign a playback URL and WHETHER
// a media error is an expiry (403). Pure + framework-free so the player hook and
// WatchClient share one implementation and it's unit-tested in isolation.
//
// CloudFront signed URLs carry `?Expires=<unix-seconds>`; S3 presigned URLs
// (local dev) carry `?X-Amz-Date=<iso>` + `?X-Amz-Expires=<seconds>`. We parse
// both so dev and prod behave the same.

/**
 * Absolute expiry of a signed URL in epoch-ms, or null if it can't be
 * determined (then callers fall back to reactive-only refresh).
 */
export function expiresAtMs(signedUrl: string): number | null {
  let params: URLSearchParams
  try {
    params = new URL(signedUrl).searchParams
  } catch {
    return null
  }

  // CloudFront canned policy: ?Expires=<unix seconds>
  const cf = params.get('Expires')
  if (cf !== null) {
    const secs = Number(cf)
    return Number.isFinite(secs) && secs > 0 ? secs * 1000 : null
  }

  // S3 presigned (SigV4): ?X-Amz-Date=<YYYYMMDDTHHMMSSZ> + ?X-Amz-Expires=<secs>
  const date = params.get('X-Amz-Date')
  const ttl = params.get('X-Amz-Expires')
  if (date && ttl) {
    const secs = Number(ttl)
    const startMs = parseAmzDate(date)
    if (startMs !== null && Number.isFinite(secs) && secs > 0)
      return startMs + secs * 1000
  }

  return null
}

// `20260719T184625Z` → epoch ms. Returns null on any malformation.
function parseAmzDate(d: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(d)
  if (!m) return null
  const [, y, mo, da, h, mi, s] = m
  const ms = Date.UTC(+y, +mo - 1, +da, +h, +mi, +s)
  return Number.isNaN(ms) ? null : ms
}

/**
 * Delay (ms from `now`) at which to PROACTIVELY re-sign: `fraction` of the
 * remaining lifetime, floored at `minMs` so a URL already near (or past) expiry
 * refreshes promptly rather than never. Returns null when expiry is unknown
 * (caller relies on the reactive path instead). Never negative.
 */
export function refreshDelayMs(
  signedUrl: string,
  now: number,
  fraction = 0.8,
  minMs = 30_000
): number | null {
  const exp = expiresAtMs(signedUrl)
  if (exp === null) return null
  const remaining = exp - now
  // Already expired / about to: refresh now-ish (0), not a negative timer.
  if (remaining <= minMs) return 0
  return Math.max(minMs, remaining * fraction)
}

// HTMLMediaElement.error codes (MediaError). A signed-URL 403 surfaces as a
// network failure (2) or, when the browser gives up on the source, unsupported
// (4). We only auto-resign on these — a decode error (3) is not an expiry.
const MEDIA_ERR_NETWORK = 2
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

/**
 * Whether a MediaError looks like a signed-URL expiry we should recover from by
 * re-signing (vs a genuine decode/abort we must not loop on). Accepts the raw
 * `HTMLMediaElement.error` (or null).
 */
export function isExpiryError(err: MediaError | null | undefined): boolean {
  if (!err) return false
  return (
    err.code === MEDIA_ERR_NETWORK || err.code === MEDIA_ERR_SRC_NOT_SUPPORTED
  )
}
