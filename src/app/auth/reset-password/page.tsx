'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  LumaSpin,
  ResetPasswordForm,
} from '@braintwopoint0/playback-commons/ui'

function ResetPasswordScreen() {
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
        <ResetPasswordForm initialError={initialError} />
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
