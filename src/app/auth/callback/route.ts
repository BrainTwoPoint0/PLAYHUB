import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://playhub.playbacksports.ai'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      return NextResponse.redirect(`${APP_URL}${next}`)
    }
  }

  // Return to login with error
  return NextResponse.redirect(
    `${APP_URL}/auth/login?error=Could not verify email`
  )
}
