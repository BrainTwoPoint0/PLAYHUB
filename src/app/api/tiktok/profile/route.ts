import { NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/supabase/server'
import { getUserInfo } from '@/lib/tiktok/api'
import { tiktokErrorResponse } from '@/lib/tiktok/route-helpers'

export const dynamic = 'force-dynamic'

// Connected account's profile + aggregate stats (user.info.profile / user.info.stats).
export async function GET() {
  const { user } = await getAuthUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const profile = await getUserInfo(user.id)
    return NextResponse.json({ profile })
  } catch (err) {
    // TikTokAuthError → 409 { code } so the UI can prompt connect vs reconnect.
    return tiktokErrorResponse(err)
  }
}
