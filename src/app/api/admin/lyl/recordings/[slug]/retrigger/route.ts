// POST /api/admin/lyl/recordings/[slug]/retrigger
//
// Fires the LYL sync Lambda asynchronously, scoped to a single recording
// via `onlyRecordingSlug`. Returns 202 immediately — the UI polls
// /api/admin/lyl/runs to see the new sync_runs row appear. See
// ../../_invoke.ts for the async-invocation contract.

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { getAuthUserStrict } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { invokeLylSyncAsync } from '../../../_invoke'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { user } = await getAuthUserStrict()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { slug } = await params
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(slug)) {
    return NextResponse.json({ error: 'invalid_slug' }, { status: 400 })
  }

  const requestId = randomUUID()
  const result = await invokeLylSyncAsync({
    trigger: 'manual',
    createdBy: user.id,
    requestId,
    onlyRecordingSlug: slug,
  })
  if (result.kind === 'not_configured') {
    return NextResponse.json(
      {
        error: 'sync_lambda_not_configured',
        message: 'LYL_SYNC_LAMBDA_URL or LYL_SYNC_API_KEY env var missing — deploy the Lambda first',
      },
      { status: 503, headers: { 'x-request-id': requestId } }
    )
  }
  if (result.kind === 'unreachable') {
    return NextResponse.json(
      { error: 'lambda_unreachable' },
      { status: 502, headers: { 'x-request-id': requestId } }
    )
  }
  if (result.kind === 'rejected') {
    return NextResponse.json(
      { error: 'lambda_rejected', status: result.status },
      { status: 502, headers: { 'x-request-id': requestId } }
    )
  }
  return NextResponse.json(
    {
      accepted: true,
      request_id: requestId,
      recording_slug: slug,
      message: 'Re-trigger queued — poll /runs for status.',
    },
    { status: 202, headers: { 'x-request-id': requestId } }
  )
}
