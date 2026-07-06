import { createServerClient } from '@supabase/ssr'
import createIntlMiddleware from 'next-intl/middleware'
import { NextResponse, type NextRequest } from 'next/server'
import { routing } from '@/i18n/routing'

const handleI18nRouting = createIntlMiddleware(routing)

// Paths that must bypass locale routing entirely. /auth/callback and
// /auth/confirm are route handlers wired into Supabase dashboard redirect
// URLs — a locale rewrite/redirect there would break the PKCE exchange.
function isIntlPath(pathname: string) {
  return (
    !pathname.startsWith('/api') &&
    !pathname.startsWith('/auth/callback') &&
    !pathname.startsWith('/auth/confirm') &&
    !pathname.includes('.') // files (images, manifests, …)
  )
}

type PendingCookie = {
  name: string
  value: string
  options?: Record<string, unknown>
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  const cookieDomain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN

  // ── Phase A: Supabase session refresh ──────────────────────────────────
  // Cookie writes mutate request.cookies (so the locale rewrite below
  // forwards refreshed tokens to server code) and are buffered so Phase C
  // can replay them as Set-Cookie headers onto whatever response
  // next-intl produces.
  const pendingCookies: PendingCookie[] = []

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(cookieDomain && {
        cookieOptions: { domain: cookieDomain },
      }),
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(
          cookiesToSet: {
            name: string
            value: string
            options?: Record<string, unknown>
          }[]
        ) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          pendingCookies.push(...cookiesToSet)
        },
      },
    }
  )

  // Use getSession() instead of getUser() to refresh the token.
  // getSession() only makes a network call when the JWT is expired and
  // needs refreshing (~once per hour). getUser() calls Supabase Auth on
  // EVERY request, which quickly burns through the ~30 req/min rate limit.
  const isPageOrApi = pathname.startsWith('/api/') || !pathname.includes('.') // pages don't have file extensions

  if (isPageOrApi) {
    const { error } = await supabase.auth.getSession()

    // If token refresh failed with an auth error (invalid/expired refresh
    // token), clear cookies. Do NOT clear on rate limit (429) or if
    // there's simply no session (user never logged in).
    if (error && error.status !== 429) {
      // Clear stale session cookies but preserve in-flight auth flow state:
      // the `code-verifier` cookie is part of the PKCE password-reset /
      // magic-link flow and wiping it breaks exchangeCodeForSession.
      const staleCookies = request.cookies
        .getAll()
        .filter(
          (c) => c.name.startsWith('sb-') && !c.name.includes('code-verifier')
        )
      for (const cookie of staleCookies) {
        request.cookies.delete(cookie.name)
        pendingCookies.push({
          name: cookie.name,
          value: '',
          options: {
            maxAge: 0,
            path: '/',
            ...(cookieDomain && { domain: cookieDomain }),
          },
        })
      }
    }
  }

  // ── Phase B: locale routing ────────────────────────────────────────────
  // Rewrites /venue → /[locale]/venue internally (or 307-redirects for
  // locale prefix normalization). Sees the already-refreshed request cookies.
  const response = isIntlPath(pathname)
    ? handleI18nRouting(request)
    : NextResponse.next({ request })

  // ── Phase C: replay Supabase cookie mutations onto the final response ──
  // Set-Cookie is honored by browsers on 307 redirects too, so deletions
  // and refreshes survive next-intl's locale redirects.
  for (const { name, value, options } of pendingCookies) {
    response.cookies.set(name, value, options as never)
  }

  // Security headers
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')

  return response
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
