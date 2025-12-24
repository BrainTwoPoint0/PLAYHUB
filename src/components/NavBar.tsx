'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { useAuth } from '@/lib/auth/context'

const navItems = [{ href: '/recordings', label: 'My Recordings' }]

export default function NavBar() {
  const { user, loading } = useAuth()
  const [hasVenues, setHasVenues] = useState(false)

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
    <nav className="container mx-auto flex p-5 items-center">
      <Link href="/" className="text-xl font-semibold text-[var(--timberwolf)]">
        PLAYHUB
      </Link>

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
            <span className="text-sm text-[var(--ash-grey)] hidden sm:block">
              {user.email}
            </span>
            <button
              onClick={() => (window.location.href = '/api/auth/signout')}
              className="text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
            >
              Sign out
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
    </nav>
  )
}
