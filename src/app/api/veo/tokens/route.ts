// POST /api/veo/tokens — Store Veo auth tokens (platform admin only)
// GET  /api/veo/tokens — Check token status
//
// To get tokens: open app.veo.co in your browser, open DevTools → Network tab,
// find any API request, and copy the Authorization header (Bearer ...) and
// X-CSRFToken header.

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { storeTokens, getStoredTokens } from '@/lib/veo/direct-client'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || !(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const tokens = await getStoredTokens()
  if (!tokens) {
    return NextResponse.json({
      valid: false,
      message: 'No valid tokens stored',
    })
  }

  return NextResponse.json({
    valid: true,
    expiresAt: tokens.expiresAt,
    bearerPreview: `${tokens.bearer.substring(0, 20)}...`,
  })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || !(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { bearer, csrf } = body

  if (!bearer || !csrf) {
    return NextResponse.json(
      { error: 'Missing bearer or csrf token' },
      { status: 400 }
    )
  }

  await storeTokens(bearer, csrf, 'manual')

  return NextResponse.json({
    success: true,
    message: 'Tokens stored. Valid for ~55 minutes.',
  })
}
