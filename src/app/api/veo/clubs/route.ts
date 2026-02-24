import { NextResponse } from 'next/server'
import { listClubsAndTeams } from '@/lib/veo/client'

const SYNC_API_KEY = process.env.SYNC_API_KEY

function verifyApiKey(request: Request): boolean {
  const apiKey = request.headers.get('x-api-key')
  return apiKey === SYNC_API_KEY && !!SYNC_API_KEY
}

export async function GET(request: Request) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await listClubsAndTeams()

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
