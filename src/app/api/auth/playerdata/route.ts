import { NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { playerdata } from '@/lib/playerdata/client'
import { cookies } from 'next/headers'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action')

  const { user } = await getAuthUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  switch (action) {
    case 'connect': {
      // Generate a state param to prevent CSRF, store in cookie for validation
      const state = crypto.randomUUID()
      const url = playerdata.getConnectUrl(state)
      const cookieStore = await cookies()
      cookieStore.set('playerdata_oauth_state', state, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 600, // 10 minutes
        path: '/',
      })
      return NextResponse.json({ url })
    }

    case 'disconnect': {
      await playerdata.disconnect(user.id)
      return NextResponse.json({ success: true })
    }

    case 'status': {
      const connected = await playerdata.isConnected(user.id)
      return NextResponse.json({ connected })
    }

    default:
      return NextResponse.json(
        { error: 'Invalid action. Use: connect, disconnect, status' },
        { status: 400 }
      )
  }
}
