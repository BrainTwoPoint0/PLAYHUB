import { NextResponse } from 'next/server'
import { listRecordings } from '@/lib/veo/client'
import { timingSafeEqual } from 'crypto'

const SYNC_API_KEY = process.env.SYNC_API_KEY

function verifyApiKey(request: Request): boolean {
  const apiKey = request.headers.get('x-api-key')
  if (!apiKey || !SYNC_API_KEY) return false
  if (apiKey.length !== SYNC_API_KEY.length) return false
  return timingSafeEqual(Buffer.from(apiKey), Buffer.from(SYNC_API_KEY))
}

export async function GET(request: Request) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const club = searchParams.get('club')

    if (!club) {
      return NextResponse.json(
        { error: 'Missing required query param: club' },
        { status: 400 }
      )
    }

    const result = await listRecordings(club)

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
