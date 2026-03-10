import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

export async function POST() {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL || 'https://playhub.playbacksports.ai'
  const supabase = await createClient()

  await supabase.auth.signOut()

  return NextResponse.redirect(`${baseUrl}/`, { status: 303 })
}

// Keep GET for backwards compatibility but redirect to login
export async function GET() {
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL || 'https://playhub.playbacksports.ai'
  const supabase = await createClient()

  await supabase.auth.signOut()

  return NextResponse.redirect(`${baseUrl}/`)
}
