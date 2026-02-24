import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { playerdata } from '@/lib/playerdata/client'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const action = searchParams.get('action')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  switch (action) {
    case 'connect': {
      // Generate a state param to prevent CSRF
      const state = crypto.randomUUID()
      const url = playerdata.getConnectUrl(state)
      return NextResponse.json({ url, state })
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
