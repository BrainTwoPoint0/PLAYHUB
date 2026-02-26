// POST /api/academy/[clubSlug]/veo/cache-sync
// Triggers Veo ClubHouse sync via AWS Lambda (async invocation).
// Lambda scrapes Veo and writes directly to Supabase in the background.
// Auth: platform admin session (manual Sync Now button)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { getClubBySlug } from '@/lib/academy/config'
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda'

const VEO_SYNC_LAMBDA_NAME =
  process.env.VEO_SYNC_LAMBDA_NAME || 'playhub-veo-sync'

type RouteContext = { params: Promise<{ clubSlug: string }> }

export async function POST(request: NextRequest, { params }: RouteContext) {
  // Auth: platform admin only
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { clubSlug } = await params
  const club = await getClubBySlug(clubSlug)
  if (!club || !club.veoClubSlug) {
    return NextResponse.json({ error: 'Club not found' }, { status: 404 })
  }

  try {
    const lambda = new LambdaClient({
      region: process.env.PLAYHUB_AWS_REGION || 'eu-west-2',
      credentials: {
        accessKeyId: process.env.PLAYHUB_AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY!,
      },
    })
    await lambda.send(
      new InvokeCommand({
        FunctionName: VEO_SYNC_LAMBDA_NAME,
        InvocationType: 'Event', // Async — Lambda runs in background
        Payload: Buffer.from(
          JSON.stringify({ action: 'cache-sync', clubSlug })
        ),
      })
    )

    return NextResponse.json({
      success: true,
      clubSlug,
      message: 'Sync started — data will update shortly',
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Sync failed'
    console.error(`Cache sync error (${clubSlug}):`, error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
