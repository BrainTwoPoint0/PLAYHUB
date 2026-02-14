import { describe, it, expect, vi } from 'vitest'

// Set env vars before anything else — vi.hoisted runs alongside vi.mock (both hoisted)
vi.hoisted(() => {
  process.env.S3_RECORDINGS_BUCKET = 'test-bucket'
  process.env.PLAYHUB_AWS_REGION = 'eu-west-2'
  process.env.PLAYHUB_AWS_ACCESS_KEY_ID = 'fake-key'
  process.env.PLAYHUB_AWS_SECRET_ACCESS_KEY = 'fake-secret'
})

// Mock AWS SDK modules before importing client.ts (it creates S3Client at top-level)
vi.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {}
  return {
    S3Client: MockS3Client,
    GetObjectCommand: vi.fn(),
    HeadObjectCommand: vi.fn(),
    CopyObjectCommand: vi.fn(),
    DeleteObjectCommand: vi.fn(),
  }
})
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: vi.fn(),
}))
vi.mock('@aws-sdk/lib-storage', () => ({
  Upload: vi.fn(),
}))

// Now import the functions under test
import { generateRecordingKey, getBucketName } from '@/lib/s3/client'

// ─── generateRecordingKey ───────────────────────────────────────

describe('generateRecordingKey', () => {
  it('generates a key with provided date', () => {
    const key = generateRecordingKey('game-1', 'prod-1', '2024-06-15T10:00:00Z')
    expect(key).toBe('recordings/2024-06-15/game-1/prod-1.mp4')
  })

  it('defaults extension to mp4', () => {
    const key = generateRecordingKey('g', 'p', '2024-01-01')
    expect(key).toMatch(/\.mp4$/)
  })

  it('respects custom extension', () => {
    const key = generateRecordingKey('g', 'p', '2024-01-01', 'ts')
    expect(key).toBe('recordings/2024-01-01/g/p.ts')
  })

  it('accepts a Date object for matchDate', () => {
    const key = generateRecordingKey('g', 'p', new Date('2024-03-20'))
    expect(key).toContain('2024-03-20')
  })

  it('uses today when no matchDate provided', () => {
    const today = new Date().toISOString().split('T')[0]
    const key = generateRecordingKey('g', 'p')
    expect(key).toContain(today)
  })

  it('contains the correct path segments', () => {
    const key = generateRecordingKey('abc', 'xyz', '2024-12-25')
    const parts = key.split('/')
    expect(parts[0]).toBe('recordings')
    expect(parts[1]).toBe('2024-12-25')
    expect(parts[2]).toBe('abc')
    expect(parts[3]).toBe('xyz.mp4')
  })
})

// ─── getBucketName ──────────────────────────────────────────────

describe('getBucketName', () => {
  it('returns the configured bucket name', () => {
    expect(getBucketName()).toBe('test-bucket')
  })

  it('returns a string', () => {
    expect(typeof getBucketName()).toBe('string')
  })
})
