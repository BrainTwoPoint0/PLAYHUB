'use client'

import { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  useAuth,
  validateEmail,
  validatePassword,
  validateUsername,
  getAuthErrorMessage,
} from '@braintwopoint0/playback-commons/auth'
import { createClient } from '@braintwopoint0/playback-commons/supabase'
import { Button, Input, Label } from '@braintwopoint0/playback-commons/ui'
import { LoadingSpinner } from '@/components/ui/loading'
import {
  AlertCircle,
  Mail,
  Lock,
  User,
  AtSign,
  Check,
  X,
  Loader2,
} from 'lucide-react'

function RegisterForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [username, setUsername] = useState('')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [usernameStatus, setUsernameStatus] = useState<
    'idle' | 'checking' | 'available' | 'taken' | 'invalid'
  >('idle')

  const { signUp, user, loading: authLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()

  // Check username availability
  const checkUsernameAvailability = async (username: string) => {
    const supabase = createClient()
    const { data, error } = await supabase
      .from('profiles')
      .select('username')
      .eq('username', username.trim().toLowerCase())
      .single()

    if (error && error.code === 'PGRST116') {
      return { isAvailable: true }
    }
    if (error) {
      return { isAvailable: false, error }
    }
    return { isAvailable: false }
  }

  useEffect(() => {
    if (user) {
      const raw = searchParams.get('redirect') || '/'
      const safe = raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('@') && !raw.includes('\\') ? raw : '/'
      router.push(safe)
    }
  }, [user, router, searchParams])

  // Username availability check with debounce
  useEffect(() => {
    const checkUsername = async () => {
      if (username.length < 3) {
        setUsernameStatus('idle')
        return
      }

      const validation = validateUsername(username)
      if (!validation.isValid) {
        setUsernameStatus('invalid')
        return
      }

      setUsernameStatus('checking')

      try {
        const { isAvailable } = await checkUsernameAvailability(username)
        setUsernameStatus(isAvailable ? 'available' : 'taken')
      } catch {
        setUsernameStatus('idle')
      }
    }

    const timeoutId = setTimeout(checkUsername, 500)
    return () => clearTimeout(timeoutId)
  }, [username])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!email || !password || !confirmPassword || !username || !fullName) {
      setError('Please fill in all fields')
      return
    }

    if (!validateEmail(email)) {
      setError('Please enter a valid email address')
      return
    }

    const usernameValidation = validateUsername(username)
    if (!usernameValidation.isValid) {
      setError(usernameValidation.errors[0])
      return
    }

    if (usernameStatus !== 'available') {
      setError('Please choose an available username')
      return
    }

    if (fullName.trim().length < 2) {
      setError('Full name must be at least 2 characters')
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
      const metadata = {
        username: username.trim().toLowerCase(),
        full_name: fullName.trim(),
      }

      const { data, error } = await signUp(email, password, metadata)

      if (error) {
        setError(getAuthErrorMessage(error))
      } else if (data?.user) {
        if (data.user.identities && data.user.identities.length === 0) {
          setError(
            'An account with this email already exists. Please sign in instead.'
          )
        } else {
          const raw = searchParams.get('redirect') || '/'
          const safe = raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('@') && !raw.includes('\\') ? raw : '/'
          router.push(safe)
        }
      } else {
        setError('Failed to create account. Please try again.')
      }
    } catch {
      setError('An unexpected error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  // Don't show register form while auth is initializing or if already authenticated
  if (authLoading || user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LoadingSpinner size="lg" />
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
              Create account
            </h1>
            <p className="text-sm text-muted-foreground">
              Sign up to purchase match recordings
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
              <Label htmlFor="fullName" className="text-[var(--timberwolf)]">
                Full name
              </Label>
              <div className="relative">
                <Input
                  id="fullName"
                  type="text"
                  placeholder="Your name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="h-11 pl-10"
                  disabled={loading}
                  autoComplete="name"
                />
                <User className="h-4 w-4 absolute left-3 top-3.5 text-muted-foreground" />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="username" className="text-[var(--timberwolf)]">
                Username
              </Label>
              <div className="relative">
                <Input
                  id="username"
                  type="text"
                  placeholder="Choose a username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={`h-11 pl-10 pr-10 ${
                    usernameStatus === 'taken' || usernameStatus === 'invalid'
                      ? 'ring-2 ring-red-500'
                      : usernameStatus === 'available'
                        ? 'ring-2 ring-green-500'
                        : ''
                  }`}
                  disabled={loading}
                  autoComplete="username"
                />
                <AtSign className="h-4 w-4 absolute left-3 top-3.5 text-muted-foreground" />
                <div className="absolute right-3 top-3.5">
                  {usernameStatus === 'checking' && (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  )}
                  {usernameStatus === 'available' && (
                    <Check className="h-4 w-4 text-green-400" />
                  )}
                  {(usernameStatus === 'taken' ||
                    usernameStatus === 'invalid') && (
                    <X className="h-4 w-4 text-red-400" />
                  )}
                </div>
              </div>
              {usernameStatus === 'taken' && (
                <p className="text-xs text-red-400">Username is taken</p>
              )}
              {usernameStatus === 'invalid' && (
                <p className="text-xs text-red-400">
                  3-30 characters, letters, numbers, underscore, hyphen only
                </p>
              )}
              {usernameStatus === 'available' && (
                <p className="text-xs text-green-400">Username is available</p>
              )}
            </div>

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
                  type="password"
                  placeholder="Create a password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11 pl-10"
                  disabled={loading}
                  autoComplete="new-password"
                />
                <Lock className="h-4 w-4 absolute left-3 top-3.5 text-muted-foreground" />
              </div>
              <p className="text-xs text-muted-foreground">
                Min 8 characters with uppercase, lowercase, and number
              </p>
            </div>

            <div className="space-y-2">
              <Label
                htmlFor="confirmPassword"
                className="text-[var(--timberwolf)]"
              >
                Confirm password
              </Label>
              <div className="relative">
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="Re-enter password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="h-11 pl-10"
                  disabled={loading}
                  autoComplete="new-password"
                />
                <Lock className="h-4 w-4 absolute left-3 top-3.5 text-muted-foreground" />
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
                  Creating account...
                </>
              ) : (
                'Sign up'
              )}
            </Button>
          </form>

          <div className="text-center text-sm">
            <p className="text-muted-foreground">
              Already have an account?{' '}
              <Link
                href={searchParams.get('redirect') ? `/auth/login?redirect=${encodeURIComponent(searchParams.get('redirect')!)}` : '/auth/login'}
                className="text-[var(--timberwolf)] hover:underline"
              >
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      }
    >
      <RegisterForm />
    </Suspense>
  )
}
