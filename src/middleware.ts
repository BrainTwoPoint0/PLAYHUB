import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  })

  const cookieDomain = process.env.NEXT_PUBLIC_COOKIE_DOMAIN

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
          supabaseResponse = NextResponse.next({
            request,
          })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // Use getSession() instead of getUser() to refresh the token.
  // getSession() only makes a network call when the JWT is expired and
  // needs refreshing (~once per hour). getUser() calls Supabase Auth on
  // EVERY request, which quickly burns through the ~30 req/min rate limit.
  const pathname = request.nextUrl.pathname
  const isPageOrApi = pathname.startsWith('/api/') || !pathname.includes('.') // pages don't have file extensions

  if (isPageOrApi) {
    const {
      data: { session },
      error,
    } = await supabase.auth.getSession()

    // If token refresh failed with an auth error (invalid/expired refresh
    // token), clear cookies. Do NOT clear on rate limit (429) or if
    // there's simply no session (user never logged in).
    if (error && error.status !== 429) {
      const allCookies = request.cookies.getAll()
      const authCookies = allCookies.filter((c) => c.name.startsWith('sb-'))
      if (authCookies.length > 0) {
        supabaseResponse = NextResponse.next({ request })
        for (const cookie of authCookies) {
          supabaseResponse.cookies.set(cookie.name, '', {
            maxAge: 0,
            path: '/',
            ...(cookieDomain && { domain: cookieDomain }),
          })
        }
      }
    }
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
