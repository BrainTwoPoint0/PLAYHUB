'use client'

import Link from 'next/link'
import { useAuth } from '@/lib/auth/context'
import { Button } from '@/components/ui/button'

export default function NavBar() {
  const { user, loading } = useAuth()

  return (
    <nav className="container mx-auto flex p-5 items-center justify-between border-b border-[var(--ash-grey)]/20">
      {/* Logo */}
      <Link href="/" className="text-2xl font-bold text-[var(--timberwolf)]">
        PLAYHUB
      </Link>

      {/* Navigation Links */}
      <div className="hidden md:flex items-center space-x-6">
        <Link
          href="/matches"
          className="text-[var(--timberwolf)] hover:text-[var(--ash-grey)] transition-colors"
        >
          Browse Matches
        </Link>
        {user && (
          <Link
            href="/library"
            className="text-[var(--timberwolf)] hover:text-[var(--ash-grey)] transition-colors"
          >
            My Library
          </Link>
        )}
      </div>

      {/* Auth Buttons */}
      <div className="flex items-center space-x-4">
        {loading ? (
          <div className="h-10 w-20 bg-zinc-800 animate-pulse rounded-md" />
        ) : user ? (
          <>
            <span className="text-sm text-[var(--ash-grey)]">
              {user.email}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.href = '/api/auth/signout'}
            >
              Sign Out
            </Button>
          </>
        ) : (
          <>
            <Link href="/auth/login">
              <Button variant="ghost" size="sm">
                Sign In
              </Button>
            </Link>
            <Link href="/auth/register">
              <Button size="sm">
                Sign Up
              </Button>
            </Link>
          </>
        )}
      </div>
    </nav>
  )
}
