import { describe, it, expect } from 'vitest'
import {
  validateEmail,
  validatePassword,
  validateUsername,
  hasRole,
  hasAnyRole,
  getAuthErrorMessage,
} from '@/lib/auth/shared'
import type { User } from '@supabase/supabase-js'

// Helper to create a minimal User-like object
function mockUser(role?: string): User {
  return {
    id: 'test-id',
    aud: 'authenticated',
    created_at: '',
    app_metadata: {},
    user_metadata: role ? { role } : {},
  } as User
}

// ─── validateEmail ──────────────────────────────────────────────

describe('validateEmail', () => {
  it('accepts a valid email', () => {
    expect(validateEmail('user@example.com')).toBe(true)
  })

  it('rejects missing @', () => {
    expect(validateEmail('userexample.com')).toBe(false)
  })

  it('rejects missing domain', () => {
    expect(validateEmail('user@')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(validateEmail('')).toBe(false)
  })

  it('rejects spaces', () => {
    expect(validateEmail('user @example.com')).toBe(false)
  })
})

// ─── validatePassword ───────────────────────────────────────────

describe('validatePassword', () => {
  it('accepts a strong password', () => {
    const result = validatePassword('StrongPass1')
    expect(result.isValid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects too short', () => {
    const result = validatePassword('Ab1')
    expect(result.isValid).toBe(false)
    expect(result.errors).toContain(
      'Password must be at least 8 characters long'
    )
  })

  it('rejects missing lowercase', () => {
    const result = validatePassword('ALLCAPS123')
    expect(result.isValid).toBe(false)
    expect(result.errors).toContain(
      'Password must contain at least one lowercase letter'
    )
  })

  it('rejects missing uppercase', () => {
    const result = validatePassword('alllower123')
    expect(result.isValid).toBe(false)
    expect(result.errors).toContain(
      'Password must contain at least one uppercase letter'
    )
  })

  it('rejects missing number', () => {
    const result = validatePassword('NoNumbersHere')
    expect(result.isValid).toBe(false)
    expect(result.errors).toContain('Password must contain at least one number')
  })

  it('returns multiple errors when applicable', () => {
    const result = validatePassword('ab')
    expect(result.isValid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(1)
  })
})

// ─── validateUsername ───────────────────────────────────────────

describe('validateUsername', () => {
  it('accepts a valid username', () => {
    const result = validateUsername('cool_user-99')
    expect(result.isValid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects too short', () => {
    const result = validateUsername('ab')
    expect(result.isValid).toBe(false)
    expect(result.errors).toContain(
      'Username must be at least 3 characters long'
    )
  })

  it('rejects too long', () => {
    const result = validateUsername('a'.repeat(31))
    expect(result.isValid).toBe(false)
    expect(result.errors).toContain(
      'Username cannot be longer than 30 characters'
    )
  })

  it('rejects special characters', () => {
    const result = validateUsername('user@name!')
    expect(result.isValid).toBe(false)
    expect(result.errors).toContain(
      'Username can only contain letters, numbers, underscores, and hyphens'
    )
  })
})

// ─── hasRole / hasAnyRole ───────────────────────────────────────

describe('hasRole', () => {
  it('returns true when user has the role', () => {
    expect(hasRole(mockUser('player'), 'player')).toBe(true)
  })

  it('returns false for wrong role', () => {
    expect(hasRole(mockUser('coach'), 'player')).toBe(false)
  })

  it('returns false for null user', () => {
    expect(hasRole(null, 'player')).toBe(false)
  })
})

describe('hasAnyRole', () => {
  it('returns true when user has one of the roles', () => {
    expect(hasAnyRole(mockUser('scout'), ['player', 'scout'])).toBe(true)
  })

  it('returns false when user has none of the roles', () => {
    expect(hasAnyRole(mockUser('fan'), ['player', 'coach'])).toBe(false)
  })

  it('returns false for null user', () => {
    expect(hasAnyRole(null, ['player'])).toBe(false)
  })
})

// ─── getAuthErrorMessage ────────────────────────────────────────

describe('getAuthErrorMessage', () => {
  it('maps known error messages', () => {
    const result = getAuthErrorMessage({ message: 'Invalid login credentials' })
    expect(result).toContain('Invalid email or password')
  })

  it('maps email not confirmed', () => {
    const result = getAuthErrorMessage({ message: 'Email not confirmed' })
    expect(result).toContain('confirmation link')
  })

  it('returns original message for unknown errors', () => {
    const result = getAuthErrorMessage({ message: 'Something unexpected' })
    expect(result).toBe('Something unexpected')
  })

  it('handles null/undefined error', () => {
    expect(getAuthErrorMessage(null)).toBe('An unknown error occurred')
    expect(getAuthErrorMessage(undefined)).toBe('An unknown error occurred')
  })
})
