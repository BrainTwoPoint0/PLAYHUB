import { NextResponse } from 'next/server'
import { setMatchPrivacy } from '@/lib/veo/client'
import { verifyApiKey } from '@braintwopoint0/playback-commons/security'

const SYNC_API_KEY = process.env.SYNC_API_KEY || ''

export async function POST(request: Request) {
  if (!verifyApiKey(request, SYNC_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { matchSlug, privacy } = await request.json()

    if (!matchSlug || !privacy) {
      return NextResponse.json(
        { error: 'Missing required fields: matchSlug, privacy' },
        { status: 400 }
      )
    }

    if (privacy !== 'public' && privacy !== 'private') {
      return NextResponse.json(
        { error: 'privacy must be "public" or "private"' },
        { status: 400 }
      )
    }

    const result = await setMatchPrivacy(matchSlug, privacy)

    return NextResponse.json(result, {
      status: result.success ? 200 : 500,
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
