'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  useAuth,
  validateEmail,
  getAuthErrorMessage,
} from '@braintwopoint0/playback-commons/auth'
import { Button, Input, Label, LumaSpin } from '@braintwopoint0/playback-commons/ui'
import { sanitizeRedirect } from '@braintwopoint0/playback-commons/utils'
import { LoadingSpinner } from '@/components/ui/loading'
import { AlertCircle, Eye, EyeOff, Mail, Lock } from 'lucide-react'

function LoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [consecutiveErrors, setConsecutiveErrors] = useState(0)
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)

  const { signIn, user, loading: authLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()

  useEffect(() => {
    const urlError = searchParams.get('error')
    if (urlError) {
      setError(decodeURIComponent(urlError))
    }
  }, [searchParams])

  useEffect(() => {
    if (user) {
      router.push(sanitizeRedirect(searchParams.get('redirect')))
    }
  }, [user, router, searchParams])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    // Client-side cooldown to prevent Supabase rate limiting
    if (cooldownUntil && Date.now() < cooldownUntil) {
      const secondsLeft = Math.ceil((cooldownUntil - Date.now()) / 1000)
      setError(`Too many attempts. Please wait ${secondsLeft} seconds.`)
      return
    }

    if (!email || !password) {
      setError('Please fill in all fields')
      return
    }

    if (!validateEmail(email)) {
      setError('Please enter a valid email address')
      return
    }

    setLoading(true)

    try {
      const { error } = await signIn(email, password)

      if (error) {
        const msg = getAuthErrorMessage(error)
        setError(msg)
        const newCount = consecutiveErrors + 1
        setConsecutiveErrors(newCount)

        // After 3 consecutive errors, enforce a 30-second cooldown
        if (newCount >= 3) {
          setCooldownUntil(Date.now() + 30_000)
          setConsecutiveErrors(0)
        }
      } else {
        setConsecutiveErrors(0)
        setCooldownUntil(null)
        const raw = searchParams.get('redirect') || '/'
        const safe = raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('@') && !raw.includes('\\') ? raw : '/'
        router.push(safe)
      }
    } catch {
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Don't show login form while auth is initializing or if already authenticated
  if (authLoading || user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LumaSpin />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-card border border-border rounded-xl p-8 space-y-6">
          {/* Header */}
          <div className="text-center">
            <h1 className="text-2xl font-bold text-[var(--timberwolf)] mb-2">
              Welcome back
            </h1>
            <p className="text-sm text-muted-foreground">
              Sign in to access your purchases
            </p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-red-900/20 border border-red-700/30 rounded-lg p-3">
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
                />
                <Mail className="h-4 w-4 absolute left-3 top-3.5 text-muted-foreground" />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="password" className="text-[var(--timberwolf)]">
                Password
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 pl-10 pr-10"
                  disabled={loading}
                  autoComplete="current-password"
                />
                <Lock className="h-4 w-4 absolute left-3 top-3.5 text-muted-foreground" />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-3.5 text-muted-foreground hover:text-[var(--timberwolf)]"
                  disabled={loading}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full h-11 bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]"
              disabled={loading}
            >
              {loading ? (
                <>
                  <LoadingSpinner size="sm" className="mr-2" />
                  Signing in...
                </>
              ) : (
                'Sign in'
              )}
            </Button>
          </form>

          <div className="text-center text-sm">
            <p className="text-muted-foreground">
              Don&apos;t have an account?{' '}
              <Link
                href={searchParams.get('redirect') ? `/auth/register?redirect=${encodeURIComponent(searchParams.get('redirect')!)}` : '/auth/register'}
                className="text-[var(--timberwolf)] hover:underline"
              >
                Sign up
              </Link>
            </p>
          </div>
        </div>
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
      <LoginForm />
    </Suspense>
  )
}
