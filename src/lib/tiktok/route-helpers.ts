import { NextResponse } from 'next/server'
import { TikTokAuthError, TikTokUploadError } from './errors'

/**
 * Same-origin guard for state-changing routes (CSRF defence). Rejects only when
 * an Origin/Referer header is present AND its host differs from the app host —
 * cross-site forms/fetches carry a foreign Origin, while same-origin requests
 * either match or (for some same-origin GETs) omit it.
 */
export function isSameOrigin(request: Request): boolean {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) return true // no configured host to compare against
  const appHost = new URL(appUrl).host
  const source = request.headers.get('origin') || request.headers.get('referer')
  if (!source) return true
  try {
    return new URL(source).host === appHost
  } catch {
    return false
  }
}

/**
 * Map a caught error to the project's `{ error, code? }` shape with an honest
 * status code. Auth errors → 409 (UI reconnect), upload validation → 413/422,
 * everything else → 502 with a generic message (never leak config/token detail).
 */
export function tiktokErrorResponse(err: unknown): NextResponse {
  if (err instanceof TikTokAuthError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: 409 }
    )
  }
  if (err instanceof TikTokUploadError) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.code === 'too_large' ? 413 : 422 }
    )
  }
  // Unknown/upstream failure: log the detail, return a generic message.
  console.error(
    '[tiktok] route error:',
    err instanceof Error ? err.message : err
  )
  return NextResponse.json(
    { error: 'Something went wrong talking to TikTok', code: 'tiktok_error' },
    { status: 502 }
  )
}
