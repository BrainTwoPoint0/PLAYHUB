import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://playhub.playbacksports.ai'

// Allowlist the OTP types this route is wired to serve. Without this,
// an attacker holding a victim's `signup` / `invite` token could craft
// `?type=signup&next=/auth/reset-password` and land on the reset page
// with a valid session — a one-click password takeover.
const ALLOWED_TYPES: ReadonlySet<EmailOtpType> = new Set(['recovery'])

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const rawType = searchParams.get('type') as EmailOtpType | null
  const type = rawType && ALLOWED_TYPES.has(rawType) ? rawType : null
  const rawNext = searchParams.get('next') ?? '/'

  // Prevent open-redirect via the `next` param — same check as /auth/callback.
  const next =
    rawNext.startsWith('/') &&
    !rawNext.startsWith('//') &&
    !rawNext.includes('@') &&
    !rawNext.includes('\\')
      ? rawNext
      : '/'

  if (tokenHash && type) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    })
    if (!error) {
      return NextResponse.redirect(`${APP_URL}${next}`)
    }
  }

  return NextResponse.redirect(
    `${APP_URL}/auth/login?error=Could not verify reset link`
  )
}
