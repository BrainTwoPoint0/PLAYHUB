import { NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { tiktok } from '@/lib/tiktok/client'
import { isSameOrigin } from '@/lib/tiktok/route-helpers'
import { cookies } from 'next/headers'

// Read-only actions: connect (returns the OAuth URL) | status. Neither mutates
// server state, so GET is safe. Disconnect is a POST (see below).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action')

  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  switch (action) {
    case 'connect': {
      // CSRF state, stored httpOnly for validation on callback.
      const state = crypto.randomUUID()
      const url = tiktok.getConnectUrl(state)
      const cookieStore = await cookies()
      cookieStore.set('tiktok_oauth_state', state, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 600, // 10 minutes
        path: '/',
      })
      return NextResponse.json({ url })
    }

    case 'status': {
      const connection = await tiktok.getConnection(user.id)
      return NextResponse.json({
        connected: !!connection?.isActive,
        needsReconnect: !!connection && !connection.isActive,
      })
    }

    default:
      return NextResponse.json(
        { error: 'Invalid action. Use: connect, status (disconnect is POST)' },
        { status: 400 }
      )
  }
}

// Disconnect mutates state → POST + same-origin guard (never a credentialed GET,
// which is CSRF-triggerable via a lured navigation/img).
export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await tiktok.disconnect(user.id)
  return NextResponse.json({ success: true })
}
