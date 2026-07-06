'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useAuthErrorMessages } from '@/lib/auth/use-auth-error-messages'
import { ForgotPasswordForm } from '@braintwopoint0/playback-commons/ui'

export default function ForgotPasswordPage() {
  const t = useTranslations('auth.forgotPassword')
  const authErrorMessages = useAuthErrorMessages()
  // window.location.origin must be read on the client; pre-compute once mounted.
  const [redirectTo, setRedirectTo] = useState('')

  useEffect(() => {
    setRedirectTo(
      `${window.location.origin}/auth/confirm?next=/auth/reset-password`
    )
  }, [])

  if (!redirectTo) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-md" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <ForgotPasswordForm
          authErrorMessages={authErrorMessages}
          redirectTo={redirectTo}
          title={t('title')}
          subtitle={t('subtitle')}
          emailLabel={t('form.emailLabel')}
          emailPlaceholder={t('form.emailPlaceholder')}
          submitLabel={t('form.submit')}
          submittingLabel={t('form.submitting')}
          // t.raw: the commons form substitutes {seconds}/{email} itself, so
          // the raw ICU templates must pass through unformatted.
          cooldownSubmitLabel={t.raw('form.cooldownSubmit')}
          successTitle={t('form.successTitle')}
          successMessage={t.raw('form.successMessage')}
          resendLabel={t('form.resend')}
          resendCooldownLabel={t.raw('form.resendCooldown')}
          backToSignInLabel={t('form.backToSignIn')}
          errorEmailRequired={t('form.errors.emailRequired')}
          errorInvalidEmail={t('form.errors.invalidEmail')}
          errorCooldown={t.raw('form.errors.cooldown')}
          errorUnexpected={t('form.errors.unexpected')}
        />
      </div>
    </div>
  )
}
