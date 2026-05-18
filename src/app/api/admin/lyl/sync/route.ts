// POST /api/admin/lyl/sync
//
// Fires the LYL sync Lambda asynchronously (Function URL with
// `X-Amz-Invocation-Type: Event`) and returns 202 immediately. The
// Lambda's full run (1-2 min) outlives Netlify's ~26s function timeout,
// so a synchronous wait would always 504.
//
// The UI polls GET /api/admin/lyl/runs to watch for the new row (the
// orchestrator inserts status='running' as its first action; the row
// surfaces within ~10s of acceptance).

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { getAuthUserStrict } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { invokeLylSyncAsync } from '../_invoke'

export async function POST(_request: NextRequest) {
  const { user } = await getAuthUserStrict()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const requestId = randomUUID()
  const result = await invokeLylSyncAsync({
    trigger: 'manual',
    createdBy: user.id,
    requestId,
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
    { accepted: true, request_id: requestId, message: 'Sync run started — poll /runs for status.' },
    { status: 202, headers: { 'x-request-id': requestId } }
  )
}
