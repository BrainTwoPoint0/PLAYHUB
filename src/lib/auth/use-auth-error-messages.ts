'use client'

import { useTranslations } from 'next-intl'
import type { AuthErrorCode } from '@braintwopoint0/playback-commons/auth'

// Localized copy for the server auth errors commons recognizes; passed to
// the commons auth forms via their authErrorMessages prop. Unrecognized
// errors fall back to commons' English getAuthErrorMessage.
const CODES: AuthErrorCode[] = [
  'invalid_credentials',
  'email_not_confirmed',
  'user_exists',
  'password_too_short',
  'invalid_password',
  'invalid_email',
  'email_rate_limit',
  'username_taken',
]

export function useAuthErrorMessages(): Record<AuthErrorCode, string> {
  const t = useTranslations('auth.serverErrors')
  return Object.fromEntries(CODES.map((c) => [c, t(c)])) as Record<
    AuthErrorCode,
    string
  >
}
