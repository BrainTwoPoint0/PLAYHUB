import { NextResponse } from 'next/server'
import { invitePlayer } from '@/lib/veo/client'
import { verifyApiKey } from '@braintwopoint0/playback-commons/security'

const SYNC_API_KEY = process.env.SYNC_API_KEY || ''

export async function POST(request: Request) {
  if (!verifyApiKey(request, SYNC_API_KEY)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { clubSlug, teamSlug, email } = await request.json()

    if (!clubSlug || !teamSlug || !email) {
      return NextResponse.json(
        { error: 'Missing required fields: clubSlug, teamSlug, email' },
        { status: 400 }
      )
    }

    const result = await invitePlayer(clubSlug, teamSlug, email)

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
