// Shared helpers for interpreting Veo's `processing_status` field.
//
// Veo reports a recording's upload/processing state in `processing_status`,
// which is either a plain string ('done') or a JSON blob like
// {"status":"uploading","label":"Uploading"}. An empty/absent value and
// '{}' both mean "nothing pending" (i.e. done).
//
// Two consumers rely on this:
//   - the academy content page, which shows a "still processing" badge, and
//   - the LYL recording-sync, which must NOT share a recording into the away
//     team's folder until the source has finished processing (otherwise the
//     share-copy points at content that doesn't exist yet — an empty
//     "NOT SET" entry with no video).

/** Inputs needed to decide whether a recording has playable content yet. */
export interface ContentReadinessInput {
  // Veo returns processing_status as a JSON OBJECT (e.g. {} when done, or
  // {status,label} while in progress) in list/detail responses — NOT a string.
  // Accept both forms: the list/detail path passes the object; some legacy
  // call sites / tests pass the stringified form.
  processing_status?: unknown
  thumbnail?: string | null
}

/**
 * Parse `processing_status` into a human-readable "still processing" label,
 * or `null` when the recording is done.
 *
 * Veo's list + detail endpoints return this field as a JSON object:
 *   - `{}`                      → done (nothing pending)
 *   - `{status:'done'}`         → done
 *   - `{status:'uploading', label:'Uploading'}` → in progress
 * Older/other call sites may pass the stringified form ('done' / '{}' / JSON).
 * Returns the label for in-progress states (so the UI can surface it), or
 * `null` when done.
 */
export function parseProcessingStatus(raw?: unknown): string | null {
  if (raw == null) return null
  // Object form (the real shape from Veo's API).
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    if (Object.keys(obj).length === 0) return null // {} = done
    if (obj.status === 'done') return null
    return (
      (typeof obj.label === 'string' && obj.label) ||
      (typeof obj.status === 'string' && obj.status) ||
      null
    )
  }
  // String form (legacy / stringified).
  if (typeof raw !== 'string' || raw === '' || raw === 'done' || raw === '{}')
    return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed.status === 'done') return null
    return parsed.label || parsed.status || null
  } catch {
    return raw === 'done' ? null : raw
  }
}

/**
 * True when Veo has finished processing the recording (no pending state).
 * Inverse of "there's a processing label to show".
 */
export function isProcessingDone(raw?: unknown): boolean {
  return parseProcessingStatus(raw) === null
}

/**
 * True when a recording has playable content: processing is done AND a
 * thumbnail has been rendered. An empty thumbnail with "done" status is the
 * tell-tale of an entry-without-content (e.g. a share-copy created before the
 * source finished uploading) — treat it as not ready.
 */
export function isContentReady(rec: ContentReadinessInput): boolean {
  if (!isProcessingDone(rec.processing_status)) return false
  return typeof rec.thumbnail === 'string' && rec.thumbnail.trim().length > 0
}
