import { NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { listVideos } from '@/lib/tiktok/api'
import { tiktokErrorResponse } from '@/lib/tiktok/route-helpers'

export const dynamic = 'force-dynamic'

// Connected account's videos with per-video metrics (video.list).
export async function GET(request: Request) {
  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(request.url)
  const cursorParam = searchParams.get('cursor')
  const cursor = cursorParam ? Number(cursorParam) : undefined
  if (cursorParam && !Number.isFinite(cursor)) {
    return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 })
  }
  try {
    const page = await listVideos(user.id, cursor)
    return NextResponse.json(page)
  } catch (err) {
    return tiktokErrorResponse(err)
  }
}
