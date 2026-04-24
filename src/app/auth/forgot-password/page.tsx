'use client'

import { useEffect, useState } from 'react'
import { ForgotPasswordForm } from '@braintwopoint0/playback-commons/ui'

export default function ForgotPasswordPage() {
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
        <ForgotPasswordForm redirectTo={redirectTo} />
      </div>
    </div>
  )
}
