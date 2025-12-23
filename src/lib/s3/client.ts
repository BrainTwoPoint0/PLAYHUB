// S3 Client for PLAYHUB Match Recordings
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Upload } from '@aws-sdk/lib-storage'
import { Readable } from 'stream'

// ============================================================================
// Configuration
// ============================================================================

const S3_BUCKET = process.env.S3_RECORDINGS_BUCKET!
const AWS_REGION = process.env.AWS_REGION || 'eu-west-2'

const s3Client = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
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

// ============================================================================
// Signed URL Functions
// ============================================================================

/**
 * Generate a signed URL for video playback
 * @param s3Key - The S3 key of the video
 * @param expiresInSeconds - URL validity (default 4 hours)
 */
export async function getPlaybackUrl(
  s3Key: string,
  expiresInSeconds: number = 4 * 60 * 60
): Promise<string> {
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
 * Get bucket name
 */
export function getBucketName(): string {
  return S3_BUCKET
}

