// Shared helper for the two POST routes that fire the LYL sync Lambda
// (`/sync` and `/recordings/[slug]/retrigger`).
//
// Strategy: AWS Lambda Function URL accepts `X-Amz-Invocation-Type:
// Event` for async invocation. AWS returns 202 immediately (with empty
// body) after queueing — the Lambda runs to completion in the background.
// This avoids Netlify's ~26s function-timeout cap when the Lambda's
// orchestrator run can take 1-2 minutes.
//
// 5s outbound timeout via AbortSignal — gives AWS plenty of time to
// queue the event, but caps the route response time. If AWS doesn't
// respond within 5s, we treat the request as unreachable.

const INVOKE_TIMEOUT_MS = 5_000

export interface InvokeInput {
  trigger: 'manual' | 'api'
  createdBy: string
  /** Server-generated request id for cross-system debug. Logged + passed
   *  in X-Request-Id header so it shows up in Lambda CloudWatch logs. */
  requestId: string
  /** If set, scopes the run to a single recording. */
  onlyRecordingSlug?: string
}

export type InvokeResult =
  | { kind: 'accepted'; status: 202 }
  | { kind: 'not_configured' } // env vars missing
  | { kind: 'unreachable'; message: string } // fetch threw / timed out
  | { kind: 'rejected'; status: number; body: string } // AWS or handler responded non-2xx

export async function invokeLylSyncAsync(
  input: InvokeInput
): Promise<InvokeResult> {
  const lambdaUrl = process.env.LYL_SYNC_LAMBDA_URL
  const apiKey = process.env.LYL_SYNC_API_KEY
  if (!lambdaUrl || !apiKey) return { kind: 'not_configured' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), INVOKE_TIMEOUT_MS)

  let resp: Response
  try {
    resp = await fetch(lambdaUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        // AWS Lambda Function URL: this header forces async invocation.
        // AWS returns 202 immediately after queueing the event.
        'X-Amz-Invocation-Type': 'Event',
        'X-Request-Id': input.requestId,
      },
      body: JSON.stringify({
        trigger: input.trigger,
        createdBy: input.createdBy,
        onlyRecordingSlug: input.onlyRecordingSlug,
      }),
      signal: controller.signal,
    })
  } catch (err) {
    return {
      kind: 'unreachable',
      message: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timeout)
  }

  if (resp.status === 202) return { kind: 'accepted', status: 202 }
  // Anything else is unexpected — async invoke is supposed to return 202
  // unless the URL itself is misconfigured or auth fails.
  const body = await resp.text().catch(() => '')
  // Log server-side so ops can correlate via the request id; don't echo
  // the full Lambda body to the caller (may contain x-api-key feedback).
  console.error(
    `invokeLylSyncAsync rejected request_id=${input.requestId} status=${resp.status} body=${body.slice(0, 200)}`
  )
  return { kind: 'rejected', status: resp.status, body }
}
