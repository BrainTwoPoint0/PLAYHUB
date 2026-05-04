// Shared Stripe idempotency-key helper.
//
// Stripe rejects a reused idempotency key when the request body has changed,
// so a key based purely on (productId, userId) deadlocks buyer retries any
// time a venue admin edits the listing (price change, team rename, etc.).
// Hash the canonical request shape so any parameter change generates a fresh
// key while pure browser-retry of the identical request still dedupes.

import { createHash } from 'crypto'

// stableStringify sorts object keys recursively before serializing — the
// literal object passed today happens to have a stable insertion order, but
// a future refactor that constructs the payload via spread/merge could
// silently change the digest for the same logical request. Sorting keys
// removes that footgun.
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value))
    return '[' + value.map(stableStringify).join(',') + ']'
  const entries = Object.keys(value as object)
    .sort()
    .map((k) => JSON.stringify(k) + ':' + stableStringify((value as any)[k]))
  return '{' + entries.join(',') + '}'
}

export function buildIdempotencyKey(scope: string, payload: object): string {
  const digest = createHash('sha256')
    .update(stableStringify(payload))
    .digest('hex')
    .slice(0, 32)
  return `${scope}-${digest}`
}
