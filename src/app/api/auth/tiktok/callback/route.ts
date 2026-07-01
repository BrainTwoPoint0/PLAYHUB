import { NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { tiktok } from '@/lib/tiktok/client'
import { cookies } from 'next/headers'

// OAuth redirect target. Mirrors the PlayerData callback: validate CSRF state,
// exchange the code, persist tokens, and bounce back to the /tiktok dashboard.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')
  const state = searchParams.get('state')

  // Prefer the configured app URL so the Host header can't influence the redirect.
  const base = process.env.NEXT_PUBLIC_APP_URL || origin
  const fail = (msg: string) =>
    NextResponse.redirect(
      `${base}/tiktok?tiktok_error=${encodeURIComponent(msg)}`
    )

  // User denied, or TikTok returned an error.
  if (error) {
    const desc = searchParams.get('error_description') || error
    return fail(desc)
  }
  if (!code) return fail('missing_code')

  // Validate CSRF state — read then immediately clear the cookie.
  const cookieStore = await cookies()
  const storedState = cookieStore.get('tiktok_oauth_state')?.value
  cookieStore.delete('tiktok_oauth_state')
  if (!state || !storedState || state !== storedState) {
    return fail('Invalid state parameter. Please try connecting again.')
  }

  const { user } = await getAuthUser()
  if (!user) return fail('not_authenticated')

  try {
    await tiktok.handleCallback(code, user.id)
    return NextResponse.redirect(`${base}/tiktok?connected=true`)
  } catch (err) {
    // Never reflect the raw exception (token-exchange/config detail) into the
    // redirect URL — log it server-side and surface a generic code.
    console.error(
      '[tiktok] callback exchange failed:',
      err instanceof Error ? err.message : err
    )
    return fail('connection_failed')
  }
}
