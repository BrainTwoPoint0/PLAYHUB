// CloudFront Signed URL Generator
import { getSignedUrl } from '@aws-sdk/cloudfront-signer'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN!
const KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID!
const KEY_BUCKET = process.env.S3_RECORDINGS_BUCKET!
const KEY_OBJECT_KEY = 'keys/cloudfront-private-key.pem'

const s3Client = new S3Client({
  region: process.env.PLAYHUB_AWS_REGION || 'eu-west-2',
  credentials: {
    accessKeyId: process.env.PLAYHUB_AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY!,
  },
})

// Lazy-loaded private key. Cached for the lifetime of the Lambda instance
// to avoid fetching from S3 on every invocation.
let cachedPrivateKey: string | null = null

async function getPrivateKey(): Promise<string> {
  if (cachedPrivateKey) return cachedPrivateKey

  // Local dev fallback: use env var if set, avoids S3 round-trip
  if (process.env.CLOUDFRONT_PRIVATE_KEY) {
    cachedPrivateKey = Buffer.from(
      process.env.CLOUDFRONT_PRIVATE_KEY,
      'base64'
    ).toString('utf-8')
    return cachedPrivateKey
  }

  // Production: fetch from S3. The key stored at keys/cloudfront-private-key.pem
  // is the raw PEM file (not base64-encoded).
  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: KEY_BUCKET,
      Key: KEY_OBJECT_KEY,
    })
  )

  if (!response.Body) {
    throw new Error('CloudFront private key not found in S3')
  }

  cachedPrivateKey = await response.Body.transformToString('utf-8')
  return cachedPrivateKey
}

/**
 * Generate a CloudFront signed URL for video playback.
 */
export async function getPlaybackUrl(
  s3Key: string,
  expiresInSeconds: number = 4 * 60 * 60
): Promise<string> {
  const url = `https://${CLOUDFRONT_DOMAIN}/${s3Key}`
  const dateLessThan = new Date(
    Date.now() + expiresInSeconds * 1000
  ).toISOString()

  return getSignedUrl({
    url,
    keyPairId: KEY_PAIR_ID,
    privateKey: await getPrivateKey(),
    dateLessThan,
  })
}
