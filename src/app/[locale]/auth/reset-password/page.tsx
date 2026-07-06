'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useAuthErrorMessages } from '@/lib/auth/use-auth-error-messages'
import {
  LumaSpin,
  ResetPasswordForm,
} from '@braintwopoint0/playback-commons/ui'

function ResetPasswordScreen() {
  const t = useTranslations('auth.resetPassword')
  const authErrorMessages = useAuthErrorMessages()
  const searchParams = useSearchParams()
  const [initialError, setInitialError] = useState<string | undefined>(
    undefined
  )

  useEffect(() => {
    const urlError = searchParams.get('error')
    if (urlError) {
      setInitialError(decodeURIComponent(urlError))
    }
  }, [searchParams])

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <ResetPasswordForm
          authErrorMessages={authErrorMessages}
          initialError={initialError}
          title={t('title')}
          subtitle={t('subtitle')}
          passwordLabel={t('form.passwordLabel')}
          passwordPlaceholder={t('form.passwordPlaceholder')}
          confirmPasswordLabel={t('form.confirmPasswordLabel')}
          confirmPasswordPlaceholder={t('form.confirmPasswordPlaceholder')}
          passwordHint={t('form.passwordHint')}
          submitLabel={t('form.submit')}
          submittingLabel={t('form.submitting')}
          successTitle={t('form.successTitle')}
          successMessage={t('form.successMessage')}
          continueLabel={t('form.continue')}
          backToSignInLabel={t('form.backToSignIn')}
          showPasswordAriaLabel={t('form.showPassword')}
          hidePasswordAriaLabel={t('form.hidePassword')}
          errorFillBothFields={t('form.errors.fillBothFields')}
          errorPasswordsMismatch={t('form.errors.passwordsMismatch')}
          errorUnexpected={t('form.errors.unexpected')}
        />
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <LumaSpin />
        </div>
      }
    >
      <ResetPasswordScreen />
    </Suspense>
  )
}
