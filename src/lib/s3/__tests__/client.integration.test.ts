import { describe, it, expect } from 'vitest'
import { fileExists, getBucketName, getPlaybackUrl } from '@/lib/s3/client'

const hasCredentials =
  !!process.env.PLAYHUB_AWS_ACCESS_KEY_ID &&
  !!process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY &&
  !!process.env.S3_RECORDINGS_BUCKET

describe.skipIf(!hasCredentials)('S3 Integration', () => {
  it('returns false for a non-existent key', async () => {
    const exists = await fileExists('nonexistent-key-' + Date.now())
    expect(exists).toBe(false)
  })

  it('returns a non-empty bucket name', () => {
    const bucket = getBucketName()
    expect(bucket).toBeTruthy()
    expect(typeof bucket).toBe('string')
  })

  it('generates a signed playback URL', async () => {
    const url = await getPlaybackUrl('any-test-key')
    expect(typeof url).toBe('string')
    expect(url).toContain('any-test-key')
  })
})
