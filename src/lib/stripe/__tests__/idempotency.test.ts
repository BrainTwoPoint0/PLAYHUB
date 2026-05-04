import { describe, it, expect } from 'vitest'
import { buildIdempotencyKey, stableStringify } from '@/lib/stripe/idempotency'

describe('stableStringify', () => {
  it('sorts top-level keys before serializing', () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe(
      stableStringify({ a: 1, b: 2 })
    )
  })

  it('sorts nested object keys', () => {
    const a = { outer: { z: 1, a: 2 }, top: 1 }
    const b = { top: 1, outer: { a: 2, z: 1 } }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it('preserves array order (arrays are positional)', () => {
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]')
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]))
  })

  it('serializes primitives via JSON', () => {
    expect(stableStringify('hello')).toBe('"hello"')
    expect(stableStringify(42)).toBe('42')
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(true)).toBe('true')
  })

  it('handles deeply nested objects deterministically', () => {
    const a = { x: { y: { z: 1, a: 2 }, m: 3 }, n: 4 }
    const b = { n: 4, x: { m: 3, y: { a: 2, z: 1 } } }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })
})

describe('buildIdempotencyKey', () => {
  const samplePayload = {
    scope: 'recording',
    productId: 'prod-1',
    userId: 'user-1',
    amount: 20000,
    currency: 'aed',
    name: 'A vs B',
    description: 'desc',
  }

  it('is deterministic for the same payload', () => {
    expect(buildIdempotencyKey('checkout', samplePayload)).toBe(
      buildIdempotencyKey('checkout', samplePayload)
    )
  })

  it('is order-independent (the key fix the bug needed)', () => {
    const reordered = {
      description: 'desc',
      currency: 'aed',
      amount: 20000,
      userId: 'user-1',
      productId: 'prod-1',
      name: 'A vs B',
      scope: 'recording',
    }
    expect(buildIdempotencyKey('checkout', samplePayload)).toBe(
      buildIdempotencyKey('checkout', reordered)
    )
  })

  it('changes when nested object fields change (full-shape hashing)', () => {
    // Regression: an earlier version of the route hashed only a subset of
    // the Stripe request, so changes to success_url / cancel_url / metadata
    // produced silent idempotency conflicts. Hashing the full nested params
    // object catches any field drift.
    const baseline = {
      userId: 'user-1',
      params: {
        line_items: [
          {
            price_data: {
              currency: 'aed',
              unit_amount: 20000,
              product_data: { name: 'A vs B', description: 'd' },
            },
            quantity: 1,
          },
        ],
        success_url: 'https://playhub.playbacksports.ai/purchase/success',
        cancel_url: 'https://playhub.playbacksports.ai/matches/1',
      },
    }
    const changedSuccessUrl = JSON.parse(JSON.stringify(baseline))
    changedSuccessUrl.params.success_url =
      'https://www.playhub.playbacksports.ai/purchase/success'
    expect(buildIdempotencyKey('checkout', baseline)).not.toBe(
      buildIdempotencyKey('checkout', changedSuccessUrl)
    )
  })

  it('changes when any field changes (so admin edits invalidate the key)', () => {
    const renamedTeams = { ...samplePayload, name: 'A vs C' }
    const repriced = { ...samplePayload, amount: 30000 }
    const otherUser = { ...samplePayload, userId: 'user-2' }
    const otherCurrency = { ...samplePayload, currency: 'kwd' }
    const editedDescription = { ...samplePayload, description: 'new desc' }

    const original = buildIdempotencyKey('checkout', samplePayload)
    expect(buildIdempotencyKey('checkout', renamedTeams)).not.toBe(original)
    expect(buildIdempotencyKey('checkout', repriced)).not.toBe(original)
    expect(buildIdempotencyKey('checkout', otherUser)).not.toBe(original)
    expect(buildIdempotencyKey('checkout', otherCurrency)).not.toBe(original)
    expect(buildIdempotencyKey('checkout', editedDescription)).not.toBe(
      original
    )
  })

  it('partitions by scope prefix', () => {
    const a = buildIdempotencyKey('checkout', samplePayload)
    const b = buildIdempotencyKey('refund', samplePayload)
    expect(a).not.toBe(b)
    expect(a.startsWith('checkout-')).toBe(true)
    expect(b.startsWith('refund-')).toBe(true)
  })

  it('produces a 32-char hex digest after the scope prefix', () => {
    const key = buildIdempotencyKey('checkout', samplePayload)
    const hex = key.replace(/^checkout-/, '')
    expect(hex).toMatch(/^[0-9a-f]{32}$/)
  })
})
