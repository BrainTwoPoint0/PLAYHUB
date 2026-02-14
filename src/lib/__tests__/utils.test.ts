import { describe, it, expect } from 'vitest'
import { formatPrice, formatDate, formatDateTime } from '@/lib/utils'

describe('formatPrice', () => {
  it('formats GBP by default', () => {
    expect(formatPrice(10)).toBe('£10.00')
  })

  it('formats decimal amounts', () => {
    expect(formatPrice(9.99)).toBe('£9.99')
  })

  it('formats zero', () => {
    expect(formatPrice(0)).toBe('£0.00')
  })

  it('formats USD when specified', () => {
    expect(formatPrice(25, 'USD')).toBe('US$25.00')
  })

  it('formats EUR when specified', () => {
    expect(formatPrice(15.5, 'EUR')).toBe('€15.50')
  })
})

describe('formatDate', () => {
  it('formats a Date object with default options', () => {
    const result = formatDate(new Date('2024-06-15'))
    expect(result).toBe('15 Jun 2024')
  })

  it('formats an ISO string with default options', () => {
    const result = formatDate('2024-01-01T00:00:00Z')
    expect(result).toBe('1 Jan 2024')
  })

  it('accepts custom format options', () => {
    const result = formatDate('2024-12-25T00:00:00Z', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })
    expect(result).toContain('December')
    expect(result).toContain('2024')
  })
})

describe('formatDateTime', () => {
  it('includes date and time', () => {
    const result = formatDateTime(new Date('2024-06-15T14:30:00Z'))
    expect(result).toContain('15 Jun 2024')
    // Time portion depends on local timezone but should contain digits
    expect(result).toMatch(/\d{2}:\d{2}/)
  })

  it('formats an ISO string', () => {
    const result = formatDateTime('2024-01-01T09:00:00Z')
    expect(result).toContain('2024')
    expect(result).toMatch(/\d{2}:\d{2}/)
  })
})
