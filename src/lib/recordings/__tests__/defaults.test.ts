import { describe, it, expect } from 'vitest'
import {
  buildDefaultTitle,
  buildDefaultDescription,
} from '@/lib/recordings/defaults'

describe('buildDefaultTitle', () => {
  it('appends "Match" to the venue name', () => {
    expect(buildDefaultTitle('Nazwa')).toBe('Nazwa Match')
  })

  it('trims surrounding whitespace from the venue name', () => {
    expect(buildDefaultTitle('  Nazwa  ')).toBe('Nazwa Match')
  })
})

describe('buildDefaultDescription', () => {
  it('formats venue, date, and 12-hour time from a datetime-local string', () => {
    expect(buildDefaultDescription('Nazwa', '2026-07-05T19:00')).toBe(
      'Match at Nazwa — Sun 5 Jul 2026, 7:00 PM'
    )
  })

  it('formats morning times with AM and zero-padded minutes', () => {
    expect(buildDefaultDescription('Nazwa', '2026-07-06T09:05')).toBe(
      'Match at Nazwa — Mon 6 Jul 2026, 9:05 AM'
    )
  })

  it('formats midnight and noon correctly', () => {
    expect(buildDefaultDescription('Nazwa', '2026-07-06T00:00')).toBe(
      'Match at Nazwa — Mon 6 Jul 2026, 12:00 AM'
    )
    expect(buildDefaultDescription('Nazwa', '2026-07-06T12:00')).toBe(
      'Match at Nazwa — Mon 6 Jul 2026, 12:00 PM'
    )
  })

  it('returns an empty string for empty or invalid start times', () => {
    expect(buildDefaultDescription('Nazwa', '')).toBe('')
    expect(buildDefaultDescription('Nazwa', 'not-a-date')).toBe('')
  })
})
