// S3 Client for PLAYHUB Match Recordings
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Upload } from '@aws-sdk/lib-storage'
import { Readable } from 'stream'

// ============================================================================
// Configuration
// ============================================================================

const S3_BUCKET = process.env.S3_RECORDINGS_BUCKET!
const AWS_REGION = process.env.PLAYHUB_AWS_REGION || 'eu-west-2'

const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.PLAYHUB_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY!,
  },
})

// ============================================================================
// Types
// ============================================================================

export interface UploadResult {
  s3Key: string
  bucket: string
  size: number
  etag?: string
}

export interface TransferProgress {
  loaded: number
  total: number
  percentage: number
}

// ============================================================================
// Upload Functions
// ============================================================================

/**
 * Upload a file from a URL to S3 (streaming, handles large files)
 */
export async function uploadFromUrl(
  sourceUrl: string,
  s3Key: string,
  options?: {
    contentType?: string
    onProgress?: (progress: TransferProgress) => void
  }
): Promise<UploadResult> {
  // Fetch the source file
  const response = await fetch(sourceUrl)
  if (!response.ok) {
    throw new Error(`Failed to fetch source: ${response.status}`)
  }

  const contentLength = parseInt(response.headers.get('content-length') || '0')
  const contentType =
    options?.contentType || response.headers.get('content-type') || 'video/mp4'

  if (!response.body) {
    throw new Error('No response body')
  }

  // Convert web ReadableStream to Node.js Readable
  const nodeStream = Readable.fromWeb(
    response.body as import('stream/web').ReadableStream
  )

  // Use multipart upload for large files
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: S3_BUCKET,
      Key: s3Key,
      Body: nodeStream,
      ContentType: contentType,
    },
    queueSize: 4, // Concurrent parts
    partSize: 10 * 1024 * 1024, // 10MB parts
    leavePartsOnError: false,
  })

  // Track progress
  let loaded = 0
  upload.on('httpUploadProgress', (progress) => {
    loaded = progress.loaded || 0
    if (options?.onProgress && contentLength > 0) {
      options.onProgress({
        loaded,
        total: contentLength,
        percentage: Math.round((loaded / contentLength) * 100),
      })
    }
  })

  const result = await upload.done()

  return {
    s3Key,
    bucket: S3_BUCKET,
    size: contentLength,
    etag: result.ETag,
  }
}

/**
 * Check if a file exists in S3
 */
export async function fileExists(s3Key: string): Promise<boolean> {
  try {
    await s3Client.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
      })
    )
    return true
  } catch {
    return false
  }
}

/**
 * Get file metadata from S3
 */
export async function getFileMetadata(s3Key: string): Promise<{
  size: number
  contentType: string
  lastModified: Date
} | null> {
  try {
    const response = await s3Client.send(
      new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
      })
    )
    return {
      size: response.ContentLength || 0,
      contentType: response.ContentType || 'video/mp4',
      lastModified: response.LastModified || new Date(),
    }
  } catch {
    return null
  }
}

/**
 * Read and parse a JSON object from S3. Returns null when the object does
 * not exist or is unparseable (legitimate absence / corrupt index — callers
 * degrade). Any OTHER S3 failure (outage, credentials) is rethrown so an
 * infrastructure problem surfaces as a 5xx instead of masquerading as
 * "no data".
 */
export async function getJsonObject<T = unknown>(
  s3Key: string
): Promise<T | null> {
  let text: string | undefined
  try {
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: s3Key,
      })
    )
    text = await response.Body?.transformToString()
  } catch (err: any) {
    const notFound =
      err?.name === 'NoSuchKey' ||
      err?.name === 'NotFound' ||
      err?.$metadata?.httpStatusCode === 404
    if (notFound) return null
    throw err
  }
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch (err) {
    console.error(`Corrupt JSON object at ${s3Key}:`, err)
    return null
  }
}

// ============================================================================
// Signed URL Functions
// ============================================================================

/**
 * Generate a signed URL for video playback.
 * Uses CloudFront when configured (saves ~$80/mo in S3 egress),
 * falls back to S3 presigned URLs for local dev.
 */
export async function getPlaybackUrl(
  s3Key: string,
  expiresInSeconds: number = 4 * 60 * 60
): Promise<string> {
  if (process.env.CLOUDFRONT_DOMAIN) {
    const { getPlaybackUrl: getCfUrl } = await import('@/lib/cloudfront/signer')
    return getCfUrl(s3Key, expiresInSeconds)
  }

  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
  })

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds })
}

/**
 * Generate a signed URL for downloading
 * @param s3Key - The S3 key of the video
 * @param filename - Suggested download filename
 * @param expiresInSeconds - URL validity (default 1 hour)
 */
export async function getDownloadUrl(
  s3Key: string,
  filename: string,
  expiresInSeconds: number = 60 * 60
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  })

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds })
}

/**
 * Generate a plain S3 presigned GET URL. Unlike getPlaybackUrl this never
 * routes through CloudFront — use it for prefixes the CDN's bucket policy
 * does not cover (e.g. calibration-stills/*).
 */
export async function getSignedObjectUrl(
  s3Key: string,
  expiresInSeconds: number = 60 * 60
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: s3Key,
  })

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds })
}

/**
 * List ALL objects under a prefix (paginated — S3 lists in lexicographic key
 * order, so a single page would silently drop keys once a prefix exceeds
 * 1000 objects, and "newest by LastModified" picked from one page would be
 * wrong with no signal).
 */
export async function listObjects(
  prefix: string
): Promise<{ key: string; size: number; lastModified: Date | null }[]> {
  const out: { key: string; size: number; lastModified: Date | null }[] = []
  let continuationToken: string | undefined
  do {
    const response = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    )
    for (const obj of response.Contents ?? []) {
      if (!obj.Key) continue
      out.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? null,
      })
    }
    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined
  } while (continuationToken)
  return out
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generate S3 key for a match recording
 * @param gameId - Spiideo game ID
 * @param productionId - Spiideo production ID
 * @param matchDate - The actual match date (ISO string or Date)
 * @param extension - File extension (default 'mp4')
 */
export function generateRecordingKey(
  gameId: string,
  productionId: string,
  matchDate?: string | Date,
  extension: string = 'mp4'
): string {
  const date = matchDate
    ? new Date(matchDate).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0]
  return `recordings/${date}/${gameId}/${productionId}.${extension}`
}

/**
 * Move a file within S3 (copy then delete)
 */
export async function moveFile(
  sourceKey: string,
  destinationKey: string
): Promise<void> {
  // Copy to new location
  await s3Client.send(
    new CopyObjectCommand({
      Bucket: S3_BUCKET,
      CopySource: `${S3_BUCKET}/${sourceKey}`,
      Key: destinationKey,
    })
  )

  // Delete from old location
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: sourceKey,
    })
  )
}

/**
 * Delete a file from S3
 */
export async function deleteFile(s3Key: string): Promise<void> {
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key,
    })
  )
}

/**
 * Get bucket name
 */
export function getBucketName(): string {
  return S3_BUCKET
}
