import { describe, it, expect } from 'vitest'
import { routing } from '../routing'

describe('i18n routing config', () => {
  it('supports exactly en, ar, es', () => {
    expect(routing.locales).toEqual(['en', 'ar', 'es'])
  })

  it('defaults to English', () => {
    expect(routing.defaultLocale).toBe('en')
  })

  it('keeps English URLs unprefixed', () => {
    // as-needed = default locale has no /en prefix; existing URLs must not change
    expect(routing.localePrefix).toBe('as-needed')
  })
})
