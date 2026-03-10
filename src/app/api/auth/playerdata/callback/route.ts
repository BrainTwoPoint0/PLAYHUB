import { NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { playerdata } from '@/lib/playerdata/client'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')

  // Handle OAuth errors (user denied, etc.)
  if (error) {
    const desc = searchParams.get('error_description') || error
    return NextResponse.redirect(
      `${origin}/settings?playerdata_error=${encodeURIComponent(desc)}`
    )
  }

  if (!code) {
    return NextResponse.redirect(
      `${origin}/settings?playerdata_error=missing_code`
    )
  }

  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.redirect(
      `${origin}/settings?playerdata_error=not_authenticated`
    )
  }

  try {
    await playerdata.handleCallback(code, user.id)
    return NextResponse.redirect(`${origin}/settings?playerdata_connected=true`)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.redirect(
      `${origin}/settings?playerdata_error=${encodeURIComponent(message)}`
    )
  }
}
