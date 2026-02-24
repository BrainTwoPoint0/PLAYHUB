// GET/POST/DELETE /api/academy/[clubSlug]/veo/exceptions
// Manage Veo cleanup exceptions — users exempt from automated removal

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { getClubBySlug } from '@/lib/academy/config'

type RouteContext = { params: Promise<{ clubSlug: string }> }

async function requireAdmin() {
  const supabase = await createClient()
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser()

  if (error || !user) return null
  const isAdmin = await isPlatformAdmin(user.id)
  return isAdmin ? user : null
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const user = await requireAdmin()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { clubSlug } = await params
  const club = getClubBySlug(clubSlug)
  if (!club) {
    return NextResponse.json({ error: 'Club not found' }, { status: 404 })
  }

  const supabase = createServiceClient() as any

  const { data, error } = await supabase
    .from('playhub_veo_exceptions')
    .select('id, club_slug, email, reason, added_by, created_at')
    .eq('club_slug', clubSlug)
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ exceptions: data })
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const user = await requireAdmin()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { clubSlug } = await params
  const club = getClubBySlug(clubSlug)
  if (!club) {
    return NextResponse.json({ error: 'Club not found' }, { status: 404 })
  }

  const body = await request.json()
  const email = body.email?.trim()?.toLowerCase()
  const reason = body.reason?.trim() || null

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  const supabase = createServiceClient() as any

  const { data, error } = await supabase
    .from('playhub_veo_exceptions')
    .upsert(
      { club_slug: clubSlug, email, reason, added_by: user.id },
      { onConflict: 'club_slug,email' }
    )
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ exception: data }, { status: 201 })
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const user = await requireAdmin()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { clubSlug } = await params
  const club = getClubBySlug(clubSlug)
  if (!club) {
    return NextResponse.json({ error: 'Club not found' }, { status: 404 })
  }

  const body = await request.json()
  const email = body.email?.trim()?.toLowerCase()

  if (!email) {
    return NextResponse.json({ error: 'Email is required' }, { status: 400 })
  }

  const supabase = createServiceClient() as any

  const { error } = await supabase
    .from('playhub_veo_exceptions')
    .delete()
    .eq('club_slug', clubSlug)
    .eq('email', email)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
