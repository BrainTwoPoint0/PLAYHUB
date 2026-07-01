// TikTok Content Posting — upload a highlight to the creator's inbox as a draft
// (scope: video.upload). This is the "finish in the TikTok app" flow: the video
// lands in the creator's inbox and they tap to complete the post. It does NOT use
// Direct Post (video.publish), which requires the heavier content audit.
//
// FILE_UPLOAD is used (not PULL_FROM_URL) so we don't need to verify a URL-prefix
// domain — the Supabase signed-URL host can't be verified. Portrait highlight
// clips are small, so we upload the whole file as a single chunk.
//
// Endpoints + fields verified against:
//   https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
//   https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status

import { tiktok } from './client'
import { TikTokUploadError } from './errors'

const INBOX_INIT_URL =
  'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/'
const STATUS_FETCH_URL =
  'https://open.tiktokapis.com/v2/post/publish/status/fetch/'

// TikTok's single-chunk ceiling. Larger files must be split into 5–64MB chunks;
// our portrait renders are well under this, so we keep the path single-chunk.
const MAX_SINGLE_CHUNK_BYTES = 64 * 1024 * 1024

interface TikTokError {
  code?: string
  message?: string
  log_id?: string
}

function assertOk(error: TikTokError | undefined, httpStatus: number): void {
  if (httpStatus < 200 || httpStatus >= 300) {
    throw new Error(
      `TikTok publish HTTP ${httpStatus}${error?.message ? `: ${error.message}` : ''}`
    )
  }
  if (error && error.code && error.code !== 'ok') {
    throw new Error(`TikTok publish error (${error.code}): ${error.message ?? ''}`)
  }
}

export interface PublishResult {
  publishId: string
  status: string
}

/**
 * Upload an MP4 to the connected account's TikTok inbox as a draft.
 * Returns the publish_id and the initial status (typically PROCESSING_UPLOAD;
 * poll {@link getPublishStatus} for SEND_TO_USER_INBOX).
 */
export async function uploadVideoToInbox(
  userId: string,
  video: Uint8Array
): Promise<PublishResult> {
  const videoSize = video.byteLength
  if (videoSize === 0) {
    throw new TikTokUploadError('empty', 'Empty video buffer')
  }
  if (videoSize > MAX_SINGLE_CHUNK_BYTES) {
    throw new TikTokUploadError(
      'too_large',
      `Video is ${(videoSize / 1024 / 1024).toFixed(1)}MB — exceeds the ${
        MAX_SINGLE_CHUNK_BYTES / 1024 / 1024
      }MB single-chunk limit`
    )
  }

  const accessToken = await tiktok.getAccessToken(userId)

  // 1. Initialise the upload — single chunk covering the whole file.
  const initRes = await fetch(INBOX_INIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: videoSize,
        total_chunk_count: 1,
      },
    }),
  })
  const initJson = (await initRes.json()) as {
    data?: { publish_id?: string; upload_url?: string }
    error?: TikTokError
  }
  assertOk(initJson.error, initRes.status)
  const publishId = initJson.data?.publish_id
  const uploadUrl = initJson.data?.upload_url
  if (!publishId || !uploadUrl) {
    throw new Error('TikTok init returned no publish_id/upload_url')
  }

  // 2. PUT the bytes to the returned upload_url (single chunk = whole file).
  // Uint8Array is a valid runtime BodyInit; the cast sidesteps the TS typed-array
  // generic mismatch (Uint8Array<ArrayBufferLike> vs BodyInit's ArrayBuffer view).
  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(videoSize),
      'Content-Range': `bytes 0-${videoSize - 1}/${videoSize}`,
    },
    body: video as unknown as BodyInit,
  })
  if (!putRes.ok) {
    const detail = await putRes.text().catch(() => '')
    throw new Error(
      `TikTok chunk upload failed (${putRes.status}): ${detail.slice(0, 200)}`
    )
  }

  // 3. Report the initial status (caller can poll for SEND_TO_USER_INBOX).
  // Best-effort: the bytes are already committed, so a failed status read must
  // NOT turn a successful upload into a thrown error. Fall back to the known
  // in-progress state and let the caller poll getPublishStatus if it wants more.
  try {
    const status = await getPublishStatus(userId, publishId)
    return { publishId, status: status.status }
  } catch {
    return { publishId, status: 'PROCESSING_UPLOAD' }
  }
}

export interface PublishStatus {
  status: string
  failReason?: string
  uploadedBytes?: number
}

/** Fetch the current status of a publish attempt. */
export async function getPublishStatus(
  userId: string,
  publishId: string
): Promise<PublishStatus> {
  const accessToken = await tiktok.getAccessToken(userId)
  const res = await fetch(STATUS_FETCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ publish_id: publishId }),
  })
  const json = (await res.json()) as {
    data?: { status?: string; fail_reason?: string; uploaded_bytes?: number }
    error?: TikTokError
  }
  assertOk(json.error, res.status)
  return {
    status: json.data?.status ?? 'UNKNOWN',
    failReason: json.data?.fail_reason,
    uploadedBytes: json.data?.uploaded_bytes,
  }
}
