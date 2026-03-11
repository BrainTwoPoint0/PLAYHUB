'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { useAuth } from '@braintwopoint0/playback-commons/auth'
import { LumaSpin } from '@braintwopoint0/playback-commons/ui'
import {
  BarChart3,
  Building2,
  Users,
  Film,
  Layers,
  ArrowLeft,
  Menu,
  X,
} from 'lucide-react'

const navItems = [
  { href: '/admin', label: 'Dashboard', icon: BarChart3 },
  { href: '/admin/venues', label: 'Venues', icon: Building2 },
  { href: '/admin/organizations', label: 'Organizations', icon: Layers },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/recordings', label: 'Recordings', icon: Film },
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
  const [sidebarOpen, setSidebarOpen] = useState(false)

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

  // Close sidebar on route change
  useEffect(() => {
    setSidebarOpen(false)
  }, [pathname])

  // Show loading
  if (loading || checkingAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <LumaSpin />
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

  const sidebarContent = (
    <>
      <div className="mb-8">
        <Link href="/admin" className="text-xl font-bold tracking-tight">
          PLAYHUB Admin
        </Link>
      </div>

      <nav className="space-y-1">
        {navItems.map((item) => {
          const isActive = pathname === item.href
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-muted text-[var(--timberwolf)]'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-[var(--timberwolf)]'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      <div className="mt-8 pt-8 border-t border-border">
        <Link
          href="/"
          className="flex items-center gap-3 px-3 py-2 text-sm text-muted-foreground hover:text-[var(--timberwolf)] transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to PLAYHUB</span>
        </Link>
      </div>
    </>
  )

  return (
    <div className="min-h-screen flex">
      {/* Mobile sidebar toggle */}
      <button
        className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-md bg-card border border-border text-muted-foreground hover:text-[var(--timberwolf)] transition-colors"
        onClick={() => setSidebarOpen(!sidebarOpen)}
      >
        {sidebarOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/60"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static z-40 h-full w-64 bg-card border-r border-border p-4 transition-transform duration-200 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {sidebarContent}
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 p-4 pt-16 lg:p-8 lg:pt-8">
        {children}
      </main>
    </div>
  )
}
