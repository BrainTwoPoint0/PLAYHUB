'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@/lib/auth/context'

const navItems = [
  { href: '/admin', label: 'Dashboard', icon: '📊' },
  { href: '/admin/venues', label: 'Venues', icon: '🏟️' },
  { href: '/admin/users', label: 'Users', icon: '👥' },
  { href: '/admin/recordings', label: 'Recordings', icon: '🎬' },
]

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const [checkingAdmin, setCheckingAdmin] = useState(true)

  useEffect(() => {
    async function checkAdmin() {
      if (!user) {
        setCheckingAdmin(false)
        return
      }

      try {
        const res = await fetch('/api/admin?section=stats')
        if (res.status === 403) {
          setIsAdmin(false)
        } else if (res.ok) {
          setIsAdmin(true)
        } else {
          setIsAdmin(false)
        }
      } catch {
        setIsAdmin(false)
      } finally {
        setCheckingAdmin(false)
      }
    }

    if (!loading) {
      checkAdmin()
    }
  }, [user, loading])

  // Show loading
  if (loading || checkingAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  // Not logged in
  if (!user) {
    router.push('/auth/login')
    return null
  }

  // Not an admin
  if (isAdmin === false) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-bold mb-4">Access Denied</h1>
          <p className="text-muted-foreground mb-6">
            You do not have permission to access the admin area.
          </p>
          <Link href="/" className="text-[var(--timberwolf)] hover:underline">
            Go back home
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-64 bg-zinc-900 border-r border-zinc-800 p-4">
        <div className="mb-8">
          <Link href="/admin" className="text-xl font-bold">
            PLAYHUB Admin
          </Link>
        </div>

        <nav className="space-y-1">
          {navItems.map((item) => {
            const isActive = pathname === item.href
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-zinc-800 text-[var(--timberwolf)]'
                    : 'text-[var(--ash-grey)] hover:bg-zinc-800/50 hover:text-[var(--timberwolf)]'
                }`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            )
          })}
        </nav>

        <div className="mt-8 pt-8 border-t border-zinc-800">
          <Link
            href="/"
            className="flex items-center gap-3 px-3 py-2 text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
          >
            <span>←</span>
            <span>Back to PLAYHUB</span>
          </Link>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 p-8">{children}</main>
    </div>
  )
}
