'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@braintwopoint0/playback-commons/supabase'
import {
  validateEmail,
  getAuthErrorMessage,
} from '@braintwopoint0/playback-commons/auth'
import { Button, Input, Label } from '@braintwopoint0/playback-commons/ui'
import { LoadingSpinner } from '@/components/ui/loading'
import { AlertCircle, ArrowLeft, CheckCircle, Mail } from 'lucide-react'

const RESEND_COOLDOWN_MS = 30_000
const COOLDOWN_STORAGE_KEY = 'playhub:pwreset-cooldown-until'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [emailSent, setEmailSent] = useState(false)
  const [cooldownUntil, setCooldownUntilState] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const [supabase] = useState(() => createClient())

  // Persist cooldown across page refresh within the same tab. Prevents the
  // obvious "hit F5 to bypass the 30-second countdown" workaround. Cleared
  // automatically when the tab closes (sessionStorage lifetime).
  const setCooldownUntil = (value: number | null) => {
    setCooldownUntilState(value)
    if (typeof window === 'undefined') return
    if (value === null) {
      window.sessionStorage.removeItem(COOLDOWN_STORAGE_KEY)
    } else {
      window.sessionStorage.setItem(COOLDOWN_STORAGE_KEY, String(value))
    }
  }

  // Hydrate cooldown from sessionStorage on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const stored = window.sessionStorage.getItem(COOLDOWN_STORAGE_KEY)
    if (!stored) return
    const parsed = Number(stored)
    if (!Number.isFinite(parsed) || parsed <= Date.now()) {
      window.sessionStorage.removeItem(COOLDOWN_STORAGE_KEY)
      return
    }
    setCooldownUntilState(parsed)
  }, [])

  // Tick while cooldown is active so the countdown re-renders every second.
  useEffect(() => {
    if (!cooldownUntil) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [cooldownUntil])

  const cooldownSecondsLeft =
    cooldownUntil && cooldownUntil > now
      ? Math.ceil((cooldownUntil - now) / 1000)
      : 0

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (cooldownSecondsLeft > 0) {
      setError(`Please wait ${cooldownSecondsLeft} seconds before resending.`)
      return
    }

    if (!email) {
      setError('Please enter your email address')
      return
    }

    if (!validateEmail(email)) {
      setError('Please enter a valid email address')
      return
    }

    setLoading(true)

    try {
      // Use verifyOtp flow (via /auth/confirm) rather than PKCE
      // exchangeCodeForSession — the latter is fragile across the
      // email-click boundary because the code-verifier cookie needs to
      // survive a cross-site redirect from Supabase back to the app.
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/confirm?next=/auth/reset-password`,
      })
      if (error) {
        setError(getAuthErrorMessage(error))
      } else {
        setEmailSent(true)
        setCooldownUntil(Date.now() + RESEND_COOLDOWN_MS)
      }
    } catch {
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  if (emailSent) {
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
                Check your email
              </h1>
              <p className="text-sm text-muted-foreground">
                We sent a reset link to{' '}
                <span className="text-[var(--timberwolf)] font-medium">
                  {email}
                </span>
                . If it&apos;s not in your inbox, check spam.
              </p>
            </div>

            <div className="space-y-3 pt-2">
              <Button
                onClick={() => {
                  setEmailSent(false)
                  setEmail('')
                  setError('')
                }}
                variant="outline"
                className="w-full h-11"
                disabled={cooldownSecondsLeft > 0}
              >
                {cooldownSecondsLeft > 0
                  ? `Send another email in ${cooldownSecondsLeft}s`
                  : 'Send another email'}
              </Button>

              <Link href="/auth/login" className="block">
                <Button className="w-full h-11 bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]">
                  <ArrowLeft className="h-4 w-4 mr-2" />
                  Back to sign in
                </Button>
              </Link>
            </div>
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
              Forgot password?
            </h1>
            <p className="text-sm text-muted-foreground">
              Enter your email and we&apos;ll send you a reset link.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div
                id="forgot-error"
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
              <Label htmlFor="email" className="text-[var(--timberwolf)]">
                Email
              </Label>
              <div className="relative">
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11 pl-10"
                  disabled={loading}
                  autoComplete="email"
                  autoFocus
                  aria-invalid={!!error}
                  aria-describedby={error ? 'forgot-error' : undefined}
                />
                <Mail className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              </div>
            </div>

            <Button
              type="submit"
              className="w-full h-11 bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]"
              disabled={loading || cooldownSecondsLeft > 0}
            >
              {loading ? (
                <>
                  <LoadingSpinner size="sm" className="mr-2" />
                  Sending email...
                </>
              ) : cooldownSecondsLeft > 0 ? (
                `Try again in ${cooldownSecondsLeft}s`
              ) : (
                'Send reset link'
              )}
            </Button>
          </form>

          <div className="text-center text-sm">
            <Link
              href="/auth/login"
              className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-[var(--timberwolf)] transition-colors"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
