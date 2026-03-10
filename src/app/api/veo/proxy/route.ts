// GET /api/veo/proxy?url=https://c.veocdn.com/...
// Server-side proxy for Veo CDN URLs (CORS blocked in browser)
// Streams video/image content through our API

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'

const ALLOWED_HOSTS = [
  'c.veocdn.com',
  'veo-content-ii.s3.amazonaws.com',
  'veo-content.s3.amazonaws.com',
]

export async function GET(request: NextRequest) {
  // Auth check
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Validate URL
  const targetUrl = request.nextUrl.searchParams.get('url')
  if (!targetUrl) {
    return NextResponse.json(
      { error: 'Missing url parameter' },
      { status: 400 }
    )
  }

  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 })
  }

  if (parsed.protocol !== 'https:') {
    return NextResponse.json(
      { error: 'Only HTTPS URLs allowed' },
      { status: 403 }
    )
  }

  if (parsed.port && parsed.port !== '443') {
    return NextResponse.json(
      { error: 'Non-standard ports not allowed' },
      { status: 403 }
    )
  }

  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return NextResponse.json({ error: 'URL host not allowed' }, { status: 403 })
  }

  try {
    // Forward Range header for video seeking support
    const upstreamHeaders: Record<string, string> = {
      'User-Agent': 'PLAYHUB/1.0',
    }
    const rangeHeader = request.headers.get('range')
    if (rangeHeader) {
      upstreamHeaders['Range'] = rangeHeader
    }

    const upstream = await fetch(targetUrl, {
      headers: upstreamHeaders,
    })

    if (!upstream.ok && upstream.status !== 206) {
      return new NextResponse(`Upstream error: ${upstream.status}`, {
        status: upstream.status,
      })
    }

    // Stream the response through, preserving range response headers
    const headers = new Headers()
    const contentType = upstream.headers.get('content-type')
    if (contentType) headers.set('Content-Type', contentType)
    const contentLength = upstream.headers.get('content-length')
    if (contentLength) headers.set('Content-Length', contentLength)
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) headers.set('Content-Range', contentRange)
    const acceptRanges = upstream.headers.get('accept-ranges')
    if (acceptRanges) headers.set('Accept-Ranges', acceptRanges)
    headers.set('Cache-Control', 'public, max-age=86400')

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('CDN proxy error:', message)
    return NextResponse.json({ error: 'Proxy request failed' }, { status: 502 })
  }
}
