import { NextResponse } from 'next/server'
import { setMatchPrivacy } from '@/lib/veo/client'

const SYNC_API_KEY = process.env.SYNC_API_KEY

function verifyApiKey(request: Request): boolean {
  const apiKey = request.headers.get('x-api-key')
  return apiKey === SYNC_API_KEY && !!SYNC_API_KEY
}

export async function POST(request: Request) {
  if (!verifyApiKey(request)) {
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
