'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@braintwopoint0/playback-commons/supabase'
import {
  validatePassword,
  getAuthErrorMessage,
} from '@braintwopoint0/playback-commons/auth'
import {
  Button,
  Input,
  Label,
  LumaSpin,
} from '@braintwopoint0/playback-commons/ui'
import { LoadingSpinner } from '@/components/ui/loading'
import { AlertCircle, CheckCircle, Eye, EyeOff, Lock } from 'lucide-react'

const REDIRECT_DELAY_MS = 3000

function ResetPasswordForm() {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [passwordReset, setPasswordReset] = useState(false)

  const router = useRouter()
  const searchParams = useSearchParams()
  const [supabase] = useState(() => createClient())

  useEffect(() => {
    const urlError = searchParams.get('error')
    if (urlError) {
      setError(decodeURIComponent(urlError))
    }
  }, [searchParams])

  useEffect(() => {
    if (!passwordReset) return
    const id = setTimeout(() => {
      router.push('/auth/login')
    }, REDIRECT_DELAY_MS)
    return () => clearTimeout(id)
  }, [passwordReset, router])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!password || !confirmPassword) {
      setError('Please fill in both fields')
      return
    }

    const { isValid, errors } = validatePassword(password)
    if (!isValid) {
      setError(errors[0])
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setLoading(true)

    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) {
        setError(getAuthErrorMessage(error))
      } else {
        // Best-effort global sign-out. The password has already been
        // rotated on the server, so a failure here must not mask success
        // or leave the user stuck on an error state.
        try {
          await supabase.auth.signOut({ scope: 'global' })
        } catch (signOutError) {
          console.warn(
            '[reset-password] global sign-out failed after successful password update',
            signOutError
          )
        }
        setPasswordReset(true)
      }
    } catch {
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (passwordReset) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="bg-card border border-border rounded-xl p-8 space-y-6 text-center">
            <div className="flex justify-center">
              <div className="h-12 w-12 rounded-full bg-[var(--timberwolf)]/10 border border-[var(--timberwolf)]/20 flex items-center justify-center">
                <CheckCircle className="h-6 w-6 text-[var(--timberwolf)]" />
              </div>
            </div>

            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-[var(--timberwolf)]">
                Password updated
              </h1>
              <p className="text-sm text-muted-foreground">
                Redirecting you to sign in…
              </p>
            </div>

            <Link href="/auth/login" className="block pt-2">
              <Button className="w-full h-11 bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]">
                Continue to sign in
              </Button>
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-card border border-border rounded-xl p-8 space-y-6">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-[var(--timberwolf)] mb-2">
              Reset password
            </h1>
            <p className="text-sm text-muted-foreground">
              Enter a new password for your account.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div
                id="reset-error"
                role="alert"
                aria-live="polite"
                className="bg-red-900/20 border border-red-700/30 rounded-lg p-3"
              >
                <div className="flex items-center gap-2 text-red-400 text-sm">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="password" className="text-[var(--timberwolf)]">
                New password
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter a new password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 pl-10 pr-10"
                  disabled={loading}
                  autoComplete="new-password"
                  autoFocus
                  aria-invalid={!!error}
                  aria-describedby={error ? 'reset-error' : undefined}
                />
                <Lock className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-[var(--timberwolf)]"
                  disabled={loading}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="confirmPassword"
                className="text-[var(--timberwolf)]"
              >
                Confirm new password
              </Label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type={showConfirmPassword ? 'text' : 'password'}
                  placeholder="Re-enter your new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="h-11 pl-10 pr-10"
                  disabled={loading}
                  autoComplete="new-password"
                  aria-invalid={!!error}
                  aria-describedby={error ? 'reset-error' : undefined}
                />
                <Lock className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-[var(--timberwolf)]"
                  disabled={loading}
                  aria-label={
                    showConfirmPassword ? 'Hide password' : 'Show password'
                  }
                  aria-pressed={showConfirmPassword}
                >
                  {showConfirmPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              At least 8 characters with an uppercase letter, a lowercase
              letter, and a number.
            </p>

            <Button
              type="submit"
              className="w-full h-11 bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]"
              disabled={loading}
            >
              {loading ? (
                <>
                  <LoadingSpinner size="sm" className="mr-2" />
                  Updating password...
                </>
              ) : (
                'Update password'
              )}
            </Button>
          </form>

          <div className="text-center text-sm">
            <Link
              href="/auth/login"
              className="text-muted-foreground hover:text-[var(--timberwolf)] transition-colors"
            >
              Back to sign in
            </Link>
          </div>
        </div>
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
      <ResetPasswordForm />
    </Suspense>
  )
}
