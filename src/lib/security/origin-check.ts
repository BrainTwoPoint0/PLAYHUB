// Cookie-authed mutating endpoints in App Router are vulnerable to CSRF unless
// they verify the request's Origin/Referer matches the app's own host. This
// helper is the canonical gate — call at the top of every POST/PUT/DELETE
// handler that depends on the Supabase auth cookie. Returns null on pass,
// or a NextResponse 403 on fail. Allowlist defaults to APP_URL but accepts
// extra trusted hosts (e.g. preview deploys).

import { NextRequest, NextResponse } from 'next/server'

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? ''

function hostFromUrl(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

export function rejectCrossOrigin(
  request: NextRequest,
  extraAllowedHosts: string[] = []
): NextResponse | null {
  const allowed = new Set<string>(
    [APP_URL, ...extraAllowedHosts]
      .map(hostFromUrl)
      .filter((h): h is string => h !== null)
  )
  // Always allow same-host requests (request.url's host matches the deployed host).
  const selfHost = hostFromUrl(request.url)
  if (selfHost) allowed.add(selfHost)

  const originHost =
    hostFromUrl(request.headers.get('origin')) ??
    hostFromUrl(request.headers.get('referer'))

  // Browsers omit Origin on same-origin GET/HEAD but include it on POST/PUT/DELETE
  // when triggered by JS. A missing Origin AND missing Referer on a mutating
  // request is suspicious — block it.
  if (!originHost) {
    return NextResponse.json(
      { error: 'Missing Origin header on mutating request' },
      { status: 403 }
    )
  }

  if (!allowed.has(originHost)) {
    return NextResponse.json(
      { error: 'Cross-origin request not allowed' },
      { status: 403 }
    )
  }

  return null
}
