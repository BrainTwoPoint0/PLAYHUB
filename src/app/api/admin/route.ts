// GET /api/admin - Get admin dashboard data
// POST /api/admin - Admin actions

import { createClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  isPlatformAdmin,
  getAdminStats,
  getAllVenues,
  getAllUsers,
  getAllRecordings,
  togglePlatformAdmin,
  deleteUser,
} from '@/lib/admin/auth'

export async function GET(request: NextRequest) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check if user is platform admin
  const isAdmin = await isPlatformAdmin(user.id)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const section = searchParams.get('section') || 'stats'

  switch (section) {
    case 'stats':
      const stats = await getAdminStats()
      return NextResponse.json(stats)

    case 'venues':
      const venues = await getAllVenues()
      return NextResponse.json({ venues })

    case 'users':
      const users = await getAllUsers()
      return NextResponse.json({ users })

    case 'recordings':
      const recordings = await getAllRecordings()
      return NextResponse.json({ recordings })

    default:
      return NextResponse.json({ error: 'Invalid section' }, { status: 400 })
  }
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Check if user is platform admin
  const isAdmin = await isPlatformAdmin(user.id)
  if (!isAdmin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = await request.json()
  const { action } = body

  switch (action) {
    case 'toggleAdmin': {
      const { profileId, isAdmin: makeAdmin } = body
      if (!profileId) {
        return NextResponse.json(
          { error: 'profileId required' },
          { status: 400 }
        )
      }
      const result = await togglePlatformAdmin(profileId, makeAdmin)
      return NextResponse.json(result)
    }

    case 'deleteUser': {
      const { profileId } = body
      if (!profileId) {
        return NextResponse.json(
          { error: 'profileId required' },
          { status: 400 }
        )
      }
      const result = await deleteUser(profileId, user.id)
      if (!result.success) {
        return NextResponse.json({ error: result.error }, { status: 400 })
      }
      return NextResponse.json(result)
    }

    default:
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
  }
}
