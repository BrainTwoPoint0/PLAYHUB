/**
 * Shared validation for the portrait-crop editor API routes.
 *
 * All user-supplied input flows through here before it hits the database or
 * any upstream service (Modal). Keeps SSRF, injection, and out-of-range bugs
 * out of the route handlers.
 */

import type { CropClient } from './db-types'

export const VIDEO_URL_ALLOWED_HOSTS = [
  'c.veocdn.com',
  'veo-content-ii.s3.amazonaws.com',
  'veo-content.s3.amazonaws.com',
]

export const SOURCE_WIDTH = 1920
export const CROP_WIDTH = 608
export const MAX_X = SOURCE_WIDTH - CROP_WIDTH // 1312
export const MAX_KEYFRAMES_PER_JOB = 500
export const MAX_SCENE_CHANGES_PER_JOB = 100
export const MAX_NOTE_LENGTH = 2000
// Feedback snapshots are user-supplied opaque JSON. Cap serialized size to
// prevent storage-growth DoS (500 keyframes × small object ≈ 40KB, so 64KB
// gives headroom for reasonable payloads without inviting abuse).
export const MAX_FEEDBACK_SNAPSHOT_BYTES = 64 * 1024
export const KEYFRAME_SOURCES = [
  'ai_ball',
  'ai_tracked',
  'ai_cluster',
  'user',
] as const
export const FEEDBACK_ACTIONS = [
  'accepted',
  'rejected',
  'edited',
  'exported',
] as const

export type KeyframeSource = (typeof KEYFRAME_SOURCES)[number]
export type FeedbackAction = (typeof FEEDBACK_ACTIONS)[number]

export interface ValidatedKeyframe {
  time_seconds: number
  x_pixels: number
  source: KeyframeSource
  confidence: number
  edited_by_user: boolean
  edited_at: string | null
}

export interface ValidatedSavePayload {
  recording_id: string | null
  video_url: string | null
  keyframes: ValidatedKeyframe[]
  scene_changes: number[]
  status: 'detected' | 'edited'
  codec_fingerprint: Record<string, unknown> | null
  modal_inference_ms: number | null
  modal_app_version: string | null
  feedback: {
    action: FeedbackAction
    note: string | null
    keyframes_before: unknown
    keyframes_after: unknown
  } | null
}

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly status: number = 400
  ) {
    super(message)
    this.name = 'ValidationError'
  }
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new ValidationError(`Missing or invalid ${field}`)
  }
  return v
}

function isUuid(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  )
}

/** SSRF guard: https only, standard port, allowlisted host. */
export function validateVideoUrl(raw: unknown): string {
  const s = requireString(raw, 'videoUrl')
  let parsed: URL
  try {
    parsed = new URL(s)
  } catch {
    throw new ValidationError('Invalid videoUrl')
  }
  if (parsed.protocol !== 'https:') {
    throw new ValidationError('videoUrl must be https', 403)
  }
  if (parsed.port && parsed.port !== '443') {
    throw new ValidationError('videoUrl cannot use non-standard ports', 403)
  }
  if (!VIDEO_URL_ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new ValidationError(
      `videoUrl host not allowed: ${parsed.hostname}`,
      403
    )
  }
  return parsed.toString()
}

function validateKeyframe(raw: unknown, i: number): ValidatedKeyframe {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError(`keyframes[${i}] must be an object`)
  }
  const r = raw as Record<string, unknown>
  const time =
    typeof r.time === 'number'
      ? r.time
      : typeof r.time_seconds === 'number'
        ? r.time_seconds
        : NaN
  const x =
    typeof r.x === 'number'
      ? r.x
      : typeof r.x_pixels === 'number'
        ? r.x_pixels
        : NaN
  const source = r.source
  const confidence =
    typeof r.confidence === 'number' ? r.confidence : 0.5
  const editedByUser =
    typeof r.editedByUser === 'boolean'
      ? r.editedByUser
      : typeof r.edited_by_user === 'boolean'
        ? r.edited_by_user
        : false
  const editedAtRaw = r.editedAt ?? r.edited_at ?? null

  if (!isFinite(time) || time < 0) {
    throw new ValidationError(`keyframes[${i}].time must be a non-negative number`)
  }
  if (!isFinite(x) || x < 0 || x > SOURCE_WIDTH) {
    throw new ValidationError(`keyframes[${i}].x out of range [0,${SOURCE_WIDTH}]`)
  }
  if (
    typeof source !== 'string' ||
    !(KEYFRAME_SOURCES as readonly string[]).includes(source)
  ) {
    throw new ValidationError(`keyframes[${i}].source invalid`)
  }
  if (confidence < 0 || confidence > 1) {
    throw new ValidationError(`keyframes[${i}].confidence out of range [0,1]`)
  }
  let editedAt: string | null = null
  if (editedAtRaw !== null && editedAtRaw !== undefined) {
    const s = String(editedAtRaw)
    if (isNaN(Date.parse(s))) {
      throw new ValidationError(`keyframes[${i}].editedAt invalid timestamp`)
    }
    editedAt = new Date(s).toISOString()
  }
  return {
    time_seconds: Number(time.toFixed(3)),
    x_pixels: Math.round(x),
    source: source as KeyframeSource,
    confidence: Number(confidence.toFixed(2)),
    edited_by_user: editedByUser,
    edited_at: editedAt,
  }
}

export function validateSavePayload(raw: unknown): ValidatedSavePayload {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('Request body must be an object')
  }
  const r = raw as Record<string, unknown>

  const recordingIdProvided = r.recordingId !== null && r.recordingId !== undefined
  const videoUrlProvided = r.videoUrl !== null && r.videoUrl !== undefined
  if (recordingIdProvided === videoUrlProvided) {
    throw new ValidationError('Provide exactly one of recordingId or videoUrl')
  }
  const recordingId = recordingIdProvided
    ? (isUuid(r.recordingId)
        ? (r.recordingId as string)
        : (() => {
            throw new ValidationError('recordingId must be a UUID')
          })())
    : null
  const videoUrl = videoUrlProvided ? validateVideoUrl(r.videoUrl) : null

  if (!Array.isArray(r.keyframes)) {
    throw new ValidationError('keyframes must be an array')
  }
  if (r.keyframes.length > MAX_KEYFRAMES_PER_JOB) {
    throw new ValidationError(
      `Too many keyframes (${r.keyframes.length} > ${MAX_KEYFRAMES_PER_JOB})`
    )
  }
  const keyframes = r.keyframes.map((kf, i) => validateKeyframe(kf, i))
  // Enforce time-ascending order — downstream interpolation assumes it.
  for (let i = 1; i < keyframes.length; i++) {
    if (keyframes[i].time_seconds < keyframes[i - 1].time_seconds) {
      throw new ValidationError('keyframes must be sorted by time ascending')
    }
  }

  const sceneChangesRaw = r.sceneChanges ?? r.scene_changes ?? []
  if (!Array.isArray(sceneChangesRaw)) {
    throw new ValidationError('sceneChanges must be an array')
  }
  if (sceneChangesRaw.length > MAX_SCENE_CHANGES_PER_JOB) {
    throw new ValidationError('Too many scene changes')
  }
  const sceneChanges = sceneChangesRaw.map((v, i) => {
    if (typeof v !== 'number' || !isFinite(v) || v < 0) {
      throw new ValidationError(`sceneChanges[${i}] must be a non-negative number`)
    }
    return Number(v.toFixed(3))
  })

  const status = r.status
  if (status !== 'detected' && status !== 'edited') {
    throw new ValidationError('status must be "detected" or "edited"')
  }

  const codec = r.codecFingerprint ?? r.codec_fingerprint ?? null
  const codecFingerprint =
    codec === null || (typeof codec === 'object' && !Array.isArray(codec))
      ? (codec as Record<string, unknown> | null)
      : (() => {
          throw new ValidationError('codecFingerprint must be an object or null')
        })()

  const msRaw = r.modalInferenceMs ?? r.modal_inference_ms ?? null
  const modalInferenceMs =
    msRaw === null
      ? null
      : typeof msRaw === 'number' && isFinite(msRaw) && msRaw >= 0
        ? Math.round(msRaw)
        : (() => {
            throw new ValidationError('modalInferenceMs must be a non-negative number')
          })()

  const verRaw = r.modalAppVersion ?? r.modal_app_version ?? null
  const modalAppVersion =
    verRaw === null
      ? null
      : typeof verRaw === 'string' && verRaw.length <= 100
        ? verRaw
        : (() => {
            throw new ValidationError('modalAppVersion must be a string ≤100 chars')
          })()

  let feedback: ValidatedSavePayload['feedback'] = null
  if (r.feedback) {
    if (typeof r.feedback !== 'object') {
      throw new ValidationError('feedback must be an object')
    }
    const fb = r.feedback as Record<string, unknown>
    if (
      typeof fb.action !== 'string' ||
      !(FEEDBACK_ACTIONS as readonly string[]).includes(fb.action)
    ) {
      throw new ValidationError('feedback.action invalid')
    }
    const note = fb.note
    if (note !== null && note !== undefined && typeof note !== 'string') {
      throw new ValidationError('feedback.note must be a string or null')
    }
    if (typeof note === 'string' && note.length > MAX_NOTE_LENGTH) {
      throw new ValidationError('feedback.note too long')
    }
    const before = fb.keyframesBefore ?? fb.keyframes_before ?? null
    const after = fb.keyframesAfter ?? fb.keyframes_after ?? null
    const guardSize = (value: unknown, field: string) => {
      if (value === null || value === undefined) return
      const serialized = JSON.stringify(value)
      if (serialized.length > MAX_FEEDBACK_SNAPSHOT_BYTES) {
        throw new ValidationError(
          `feedback.${field} exceeds ${MAX_FEEDBACK_SNAPSHOT_BYTES} bytes`,
          413
        )
      }
    }
    guardSize(before, 'keyframesBefore')
    guardSize(after, 'keyframesAfter')
    feedback = {
      action: fb.action as FeedbackAction,
      note: (note as string | null) ?? null,
      keyframes_before: before,
      keyframes_after: after,
    }
  }

  return {
    recording_id: recordingId,
    video_url: videoUrl,
    keyframes,
    scene_changes: sceneChanges,
    status,
    codec_fingerprint: codecFingerprint,
    modal_inference_ms: modalInferenceMs,
    modal_app_version: modalAppVersion,
    feedback,
  }
}

/**
 * Hard gate — refuse the request if the global kill switch is off.
 * Called at the top of every portrait-crop route that touches the editor.
 */
export async function requirePortraitCropEnabled(
  supabase: unknown
): Promise<void> {
  const sb = supabase as CropClient
  const { data, error } = await sb
    .from('playhub_feature_flags')
    .select('enabled')
    .eq('key', 'portrait_crop_enabled')
    .maybeSingle()
  if (error) {
    // RLS or connectivity failure — fail closed.
    throw new ValidationError('Feature flag check failed', 503)
  }
  if (!data || !data.enabled) {
    throw new ValidationError('Portrait crop editor is currently disabled', 503)
  }
}
