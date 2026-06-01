// POST /api/admin/lyl/cleanup
//
// Fires the LYL sync Lambda's `cleanup` action asynchronously (Function URL
// with `X-Amz-Invocation-Type: Event`) and returns 202 immediately. The
// Lambda finds empty "entry-without-content" share-copies, deletes them in
// Veo, and re-arms their originals so the next cron re-shares once the source
// is ready. It emails a cleanup summary when done (the async invoke means the
// caller doesn't get the result inline).
//
// Veo mutations need Playwright/Chromium, which Netlify lacks — that's why
// this routes through the Lambda rather than running in-process, mirroring
// /api/admin/lyl/sync.
//
// Body: { apply?: boolean }. Default apply=false → dry-run (report only).

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { getAuthUserStrict } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { invokeLylSyncAsync } from '../_invoke'

export async function POST(request: NextRequest) {
  const { user } = await getAuthUserStrict()
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!(await isPlatformAdmin(user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Parse apply flag defensively — destructive when true, so default false.
  let apply = false
  try {
    const body = await request.json()
    apply = body?.apply === true
  } catch {
    // No/!JSON body → dry-run.
  }

  const requestId = randomUUID()
  const result = await invokeLylSyncAsync({
    action: 'cleanup',
    apply,
    trigger: 'manual',
    createdBy: user.id,
    requestId,
  })
  if (result.kind === 'not_configured') {
    return NextResponse.json(
      {
        error: 'sync_lambda_not_configured',
        message:
          'LYL_SYNC_LAMBDA_URL or LYL_SYNC_API_KEY env var missing — deploy the Lambda first',
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
      apply,
      request_id: requestId,
      message: apply
        ? 'Cleanup started (apply) — a summary email will follow.'
        : 'Cleanup dry-run started — a report email will follow.',
    },
    { status: 202, headers: { 'x-request-id': requestId } }
  )
}
