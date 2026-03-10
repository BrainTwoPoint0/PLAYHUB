// Shareable recording link - redirects to the public watch page
import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const { origin } = new URL(request.url)

  // Look up the recording's share token
  const supabase = createServiceClient() as any
  const { data: recording } = await supabase
    .from('playhub_match_recordings')
    .select('share_token')
    .eq('id', id)
    .eq('status', 'published')
    .maybeSingle()

  if (recording?.share_token) {
    return NextResponse.redirect(`${origin}/watch/${recording.share_token}`)
  }

  // No share token — redirect to the authenticated recordings page
  return NextResponse.redirect(`${origin}/recordings/${id}`)
}
