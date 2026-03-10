import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 180 // 3 min timeout for GPU processing

const MODAL_URL = process.env.NEXT_PUBLIC_MODAL_CROP_URL || ''

export async function POST(request: NextRequest) {
  try {
    if (!MODAL_URL) {
      return NextResponse.json(
        { error: 'Processing endpoint not configured' },
        { status: 500 }
      )
    }

    const body = request.body
    if (!body) {
      return NextResponse.json({ error: 'Empty body' }, { status: 400 })
    }

    const contentLength = request.headers.get('content-length')

    const res = await fetch(MODAL_URL, {
      method: 'POST',
      body: body,
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(contentLength && { 'Content-Length': contentLength }),
      },
      // @ts-expect-error -- Node fetch supports duplex for streaming request bodies
      duplex: 'half',
    })

    if (!res.ok) {
      const text = await res.text()
      console.error('Modal error:', res.status, text.slice(0, 200))
      return NextResponse.json(
        { error: 'GPU processing failed' },
        { status: 502 }
      )
    }

    const detection = await res.json()
    return NextResponse.json(detection)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Processing failed'
    console.error('Portrait crop processing error:', message)
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 })
  }
}
