import { describe, it, expect } from 'vitest'
import {
  parseProcessingStatus,
  isProcessingDone,
  isContentReady,
} from '../processing-status'

describe('parseProcessingStatus', () => {
  it('returns null for done / empty / {} variants', () => {
    expect(parseProcessingStatus(undefined)).toBeNull()
    expect(parseProcessingStatus(null)).toBeNull()
    expect(parseProcessingStatus('')).toBeNull()
    expect(parseProcessingStatus('done')).toBeNull()
    expect(parseProcessingStatus('{}')).toBeNull()
    expect(parseProcessingStatus('{"status":"done"}')).toBeNull()
  })

  it('returns the label for in-progress JSON states', () => {
    expect(
      parseProcessingStatus('{"status":"uploading","label":"Uploading"}')
    ).toBe('Uploading')
  })

  it('falls back to status when no label present', () => {
    expect(parseProcessingStatus('{"status":"uploading"}')).toBe('uploading')
  })

  it('returns a plain non-done string verbatim', () => {
    expect(parseProcessingStatus('processing')).toBe('processing')
  })

  // Veo's real shape: processing_status arrives as a JSON OBJECT, not a string.
  it('handles the OBJECT form Veo actually returns', () => {
    expect(parseProcessingStatus({})).toBeNull() // {} = done
    expect(parseProcessingStatus({ status: 'done' })).toBeNull()
    expect(
      parseProcessingStatus({ status: 'uploading', label: 'Uploading' })
    ).toBe('Uploading')
    expect(parseProcessingStatus({ status: 'uploading' })).toBe('uploading')
  })

  it('treats a done object as content-ready (regression: the {} object bug)', () => {
    // Before the fix this returned false → the gate deferred every share.
    expect(
      isContentReady({ processing_status: {}, thumbnail: 'https://x/t.jpg' })
    ).toBe(true)
  })
})

describe('isProcessingDone', () => {
  it('is true for done/empty states', () => {
    expect(isProcessingDone('done')).toBe(true)
    expect(isProcessingDone('{}')).toBe(true)
    expect(isProcessingDone(undefined)).toBe(true)
    expect(isProcessingDone('{"status":"done"}')).toBe(true)
  })

  it('is false while still processing', () => {
    expect(isProcessingDone('{"status":"uploading"}')).toBe(false)
    expect(isProcessingDone('processing')).toBe(false)
  })
})

describe('isContentReady', () => {
  it('is ready when processing is done AND a thumbnail exists', () => {
    expect(
      isContentReady({
        processing_status: 'done',
        thumbnail: 'https://x/t.jpg',
      })
    ).toBe(true)
  })

  it('is NOT ready when still processing (even with a thumbnail)', () => {
    expect(
      isContentReady({
        processing_status: '{"status":"uploading"}',
        thumbnail: 'https://x/t.jpg',
      })
    ).toBe(false)
  })

  it('is NOT ready when done but thumbnail is empty (the broken-copy tell)', () => {
    expect(isContentReady({ processing_status: 'done', thumbnail: '' })).toBe(
      false
    )
    expect(
      isContentReady({ processing_status: 'done', thumbnail: '   ' })
    ).toBe(false)
    expect(isContentReady({ processing_status: 'done', thumbnail: null })).toBe(
      false
    )
    expect(isContentReady({ processing_status: 'done' })).toBe(false)
  })
})
