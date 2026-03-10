import { NextResponse } from 'next/server'
import { getMatchDetails, probeMatchVideos, probeMatchBrowser } from '@/lib/veo/client'

const SYNC_API_KEY = process.env.SYNC_API_KEY

function verifyApiKey(request: Request): boolean {
  const apiKey = request.headers.get('x-api-key')
  return apiKey === SYNC_API_KEY && !!SYNC_API_KEY
}

/**
 * Probe endpoint: fetch full match details from Veo to inspect CDN/video URLs.
 * GET /api/veo/match-probe?slug=match-slug-here
 */
export async function GET(request: Request) {
  if (!verifyApiKey(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const slug = searchParams.get('slug')

    if (!slug) {
      return NextResponse.json(
        { error: 'Missing required query param: slug' },
        { status: 400 }
      )
    }

    const mode = searchParams.get('mode') || 'details'

    const result = mode === 'videos'
      ? await probeMatchVideos(slug)
      : mode === 'browser'
        ? await probeMatchBrowser(slug)
        : await getMatchDetails(slug)

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
