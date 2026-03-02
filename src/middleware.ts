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

  // This will refresh session if expired - required for Server Components
  const { error } = await supabase.auth.getUser()

  // If token refresh failed (invalid/expired/rate-limited), clear auth cookies
  // to prevent an infinite refresh loop that causes 429 rate limiting
  if (error) {
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

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
