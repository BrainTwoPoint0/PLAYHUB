// CloudFront Signed URL Generator
import { getSignedUrl } from '@aws-sdk/cloudfront-signer'

const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN!
const KEY_PAIR_ID = process.env.CLOUDFRONT_KEY_PAIR_ID!
const PRIVATE_KEY = Buffer.from(
  process.env.CLOUDFRONT_PRIVATE_KEY!,
  'base64'
).toString('utf-8')

/**
 * Generate a CloudFront signed URL for video playback.
 * Synchronous — returns string, not Promise.
 */
export function getPlaybackUrl(
  s3Key: string,
  expiresInSeconds: number = 4 * 60 * 60
): string {
  const url = `https://${CLOUDFRONT_DOMAIN}/${s3Key}`
  const dateLessThan = new Date(
    Date.now() + expiresInSeconds * 1000
  ).toISOString()

  return getSignedUrl({
    url,
    keyPairId: KEY_PAIR_ID,
    privateKey: PRIVATE_KEY,
    dateLessThan,
  })
}
