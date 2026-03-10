import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://playhub.playbacksports.ai'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const rawNext = searchParams.get('next') ?? '/'
  // Validate redirect is a safe relative path (prevent open redirect)
  const next =
    rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.includes('@') && !rawNext.includes('\\')
      ? rawNext
      : '/'

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
