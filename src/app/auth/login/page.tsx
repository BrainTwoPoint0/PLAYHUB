'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@braintwopoint0/playback-commons/auth'
import { LumaSpin, SignInForm } from '@braintwopoint0/playback-commons/ui'
import { sanitizeRedirect } from '@braintwopoint0/playback-commons/utils'

function LoginScreen() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, loading: authLoading } = useAuth()
  const [initialError, setInitialError] = useState<string | undefined>(
    undefined
  )

  useEffect(() => {
    const urlError = searchParams.get('error')
    if (urlError) {
      setInitialError(decodeURIComponent(urlError))
    }
  }, [searchParams])

  useEffect(() => {
    if (user) {
      router.push(sanitizeRedirect(searchParams.get('redirect')))
    }
  }, [user, router, searchParams])

  // Don't render the form while auth is still resolving or the user is
  // already signed in — the redirect effect above will kick in shortly.
  if (authLoading || user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LumaSpin />
      </div>
    )
  }

  const redirect = searchParams.get('redirect')
  const signUpHref = redirect
    ? `/auth/register?redirect=${encodeURIComponent(redirect)}`
    : '/auth/register'

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <SignInForm
          subtitle="Sign in to access your purchases"
          forgotPasswordHref="/auth/forgot-password"
          signUpHref={signUpHref}
          initialError={initialError}
          onSuccess={() => {
            router.push(sanitizeRedirect(redirect))
          }}
        />
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <LumaSpin />
        </div>
      }
    >
      <LoginScreen />
    </Suspense>
  )
}
