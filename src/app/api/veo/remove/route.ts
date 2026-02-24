import { NextResponse } from 'next/server'
import { removeMember } from '@/lib/veo/client'

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
    const { clubSlug, teamSlug, email } = await request.json()

    if (!clubSlug || !teamSlug || !email) {
      return NextResponse.json(
        { error: 'Missing required fields: clubSlug, teamSlug, email' },
        { status: 400 }
      )
    }

    const result = await removeMember(clubSlug, teamSlug, email)

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
