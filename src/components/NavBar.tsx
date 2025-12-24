'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth/context'

const navItems = [{ href: '/recordings', label: 'My Recordings' }]

export default function NavBar() {
  const { user, loading } = useAuth()
  const [hasVenues, setHasVenues] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  useEffect(() => {
    if (user) {
      fetch('/api/venue')
        .then((res) => res.json())
        .then((data) => {
          setHasVenues(data.venues?.length > 0)
        })
        .catch(() => setHasVenues(false))
    } else {
      setHasVenues(false)
    }
  }, [user])

  return (
    <nav className="container mx-auto p-5">
      <div className="flex items-center">
        <Link href="/" className="text-xl font-semibold text-[var(--timberwolf)]">
          PLAYHUB
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex ml-4 pl-4 border-l border-[var(--timberwolf)] items-center gap-6">
          {navItems.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
            >
              {label}
            </Link>
          ))}
          {hasVenues && (
            <Link
              href="/venue"
              className="text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
            >
              Manage Venue
            </Link>
          )}
        </div>

        <div className="ml-auto flex items-center gap-4">
          {loading ? (
            <div className="h-8 w-16 bg-zinc-800/50 animate-pulse rounded" />
          ) : user ? (
            <>
              {/* Desktop: show email and sign out */}
              <span className="text-sm text-[var(--ash-grey)] hidden md:block">
                {user.email}
              </span>
              <button
                onClick={() => (window.location.href = '/api/auth/signout')}
                className="hidden md:block text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
              >
                Sign out
              </button>

              {/* Mobile menu button */}
              <button
                className="md:hidden p-2"
                onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              >
                <svg
                  className="w-6 h-6 text-[var(--timberwolf)]"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  {mobileMenuOpen ? (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  ) : (
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  )}
                </svg>
              </button>
            </>
          ) : (
            <>
              <Link
                href="/auth/login"
                className="text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
              >
                Sign in
              </Link>
              <Link
                href="/auth/register"
                className="text-sm bg-[var(--timberwolf)] text-[var(--night)] px-4 py-2 rounded hover:bg-[var(--ash-grey)] transition-colors"
              >
                Sign up
              </Link>
            </>
          )}
        </div>
      </div>

      {/* Mobile menu */}
      {mobileMenuOpen && user && (
        <div className="md:hidden mt-4 pt-4 border-t border-zinc-700 space-y-3">
          <p className="text-xs text-[var(--ash-grey)] truncate">{user.email}</p>
          {navItems.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMobileMenuOpen(false)}
              className="block text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors py-2"
            >
              {label}
            </Link>
          ))}
          {hasVenues && (
            <Link
              href="/venue"
              onClick={() => setMobileMenuOpen(false)}
              className="block text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors py-2"
            >
              Manage Venue
            </Link>
          )}
          <button
            onClick={() => (window.location.href = '/api/auth/signout')}
            className="block w-full text-left text-sm text-red-400 hover:text-red-300 transition-colors py-2 mt-2 pt-3 border-t border-zinc-700"
          >
            Sign out
          </button>
        </div>
      )}
    </nav>
  )
}
