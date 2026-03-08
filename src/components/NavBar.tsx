'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useAuth, useProfile } from '@braintwopoint0/playback-commons/auth'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetTitle,
  Separator,
} from '@braintwopoint0/playback-commons/ui'
import {
  NavigationMenu,
  NavigationMenuList,
  NavigationMenuItem,
  NavigationMenuLink,
} from '@/components/ui/navigation-menu'
import {
  LogOut,
  ExternalLink,
  Menu,
  Compass,
  Film,
  Building2,
  GraduationCap,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'

function getUserInitials(
  fullName: string | null | undefined,
  email: string | undefined
): string {
  if (fullName) {
    const parts = fullName.trim().split(/\s+/)
    if (parts.length >= 2)
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return parts[0][0].toUpperCase()
  }
  return email ? email[0].toUpperCase() : '?'
}

export default function NavBar() {
  const pathname = usePathname()
  const { user, loading } = useAuth()
  const { profile } = useProfile()
  const [hasVenues, setHasVenues] = useState(false)
  const [hasAcademy, setHasAcademy] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [managedOrgs, setManagedOrgs] = useState<Array<{ slug: string; name: string; type: string }>>([])
  const [navReady, setNavReady] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [popoverOpen, setPopoverOpen] = useState(false)

  useEffect(() => {
    if (user) {
      setNavReady(false)
      fetch('/api/nav')
        .then((res) => res.json())
        .then((data) => {
          setHasVenues(data.hasVenues ?? false)
          setHasAcademy(data.hasAcademy ?? false)
          setIsAdmin(data.isAdmin ?? false)
          setManagedOrgs(data.managedOrgs ?? [])
        })
        .catch(() => {
          setHasVenues(false)
          setHasAcademy(false)
          setIsAdmin(false)
          setManagedOrgs([])
        })
        .finally(() => setNavReady(true))
    } else {
      setHasVenues(false)
      setHasAcademy(false)
      setIsAdmin(false)
      setManagedOrgs([])
      setNavReady(true)
    }
  }, [user])

  // Build nav links — static ones always, conditional ones only after all checks complete
  const navLinks = [
    { href: '/matches', label: 'Browse', icon: Compass },
    { href: '/recordings', label: 'My Recordings', icon: Film },
    ...(navReady && hasVenues
      ? [{ href: '/venue', label: 'Manage Venue', icon: Building2 }]
      : []),
    ...(navReady && hasAcademy
      ? [{ href: '/academy', label: 'Academy', icon: GraduationCap }]
      : []),
    ...(navReady && managedOrgs.length > 0
      ? [{
          href: managedOrgs.length === 1
            ? `/org/${managedOrgs[0].slug}/manage`
            : '/org',
          label: 'Manage Org',
          icon: Building2,
        }]
      : []),
    ...(navReady && isAdmin
      ? [{ href: '/admin', label: 'Admin', icon: ShieldCheck }]
      : []),
  ]

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + '/')

  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto max-w-screen-xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center">
          {/* Logo */}
          <Link
            href="/"
            className="text-lg font-semibold tracking-tight text-[var(--timberwolf)] shrink-0"
          >
            PLAYHUB
          </Link>

          {/* Desktop Navigation */}
          <NavigationMenu className="hidden md:flex ml-8">
            <NavigationMenuList>
              {navLinks.map(({ href, label }) => (
                <NavigationMenuItem key={href}>
                  <NavigationMenuLink asChild>
                    <Link
                      href={href}
                      className={cn(
                        'inline-flex h-9 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors',
                        'hover:bg-accent hover:text-accent-foreground',
                        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                        isActive(href)
                          ? 'bg-accent/60 text-[var(--timberwolf)]'
                          : 'text-muted-foreground'
                      )}
                    >
                      {label}
                    </Link>
                  </NavigationMenuLink>
                </NavigationMenuItem>
              ))}
            </NavigationMenuList>
          </NavigationMenu>

          {/* Right side */}
          <div className="ml-auto flex items-center gap-2">
            {/* Desktop auth controls */}
            <div className="hidden md:flex items-center gap-2">
              {loading ? (
                <div className="h-8 w-8 animate-pulse rounded-full bg-muted" />
              ) : user ? (
                <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                  <PopoverTrigger asChild>
                    <button className="h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-medium text-[var(--timberwolf)] hover:bg-secondary/80 transition-colors ring-1 ring-border flex">
                      {getUserInitials(profile.data?.full_name, user.email)}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-52 bg-card border-border p-0"
                  >
                    <div className="px-3 py-2.5 border-b border-border">
                      <p className="text-sm font-medium text-[var(--timberwolf)] truncate">
                        {profile.data?.full_name || user.email}
                      </p>
                      {profile.data?.username && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          @{profile.data.username}
                        </p>
                      )}
                    </div>
                    <div className="py-1">
                      <a
                        href="https://playbacksports.ai/dashboard"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-muted/50 transition-colors"
                        onClick={() => setPopoverOpen(false)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Edit Profile
                      </a>
                    </div>
                    <div className="border-t border-border py-1">
                      <button
                        onClick={() =>
                          (window.location.href = '/api/auth/signout')
                        }
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-400 hover:text-red-300 hover:bg-muted/50 transition-colors"
                      >
                        <LogOut className="h-3.5 w-3.5" />
                        Sign out
                      </button>
                    </div>
                  </PopoverContent>
                </Popover>
              ) : (
                <>
                  <Link
                    href="/auth/login"
                    className="text-sm text-muted-foreground hover:text-[var(--timberwolf)] transition-colors"
                  >
                    Sign in
                  </Link>
                  <Link
                    href="/auth/register"
                    className="text-sm bg-[var(--timberwolf)] text-[var(--night)] px-3.5 py-1.5 rounded-md hover:bg-[var(--ash-grey)] transition-colors font-medium"
                  >
                    Sign up
                  </Link>
                </>
              )}
            </div>

            {/* Mobile menu — always visible on mobile */}
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <button className="md:hidden flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-accent transition-colors">
                  <Menu className="h-4 w-4" />
                </button>
              </SheetTrigger>
              <SheetContent
                side="right"
                className="w-72 bg-card border-border p-0"
              >
                <SheetTitle className="sr-only">Navigation</SheetTitle>

                {/* User card (when logged in) */}
                {user && (
                  <>
                    <div className="px-5 pt-12 pb-4">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 shrink-0 rounded-full bg-secondary flex items-center justify-center text-xs font-medium text-[var(--timberwolf)] ring-1 ring-border">
                          {getUserInitials(
                            profile.data?.full_name,
                            user.email
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[var(--timberwolf)] truncate">
                            {profile.data?.full_name || 'Account'}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {user.email}
                          </p>
                        </div>
                      </div>
                    </div>
                    <Separator className="bg-border" />
                  </>
                )}

                {/* Navigation links */}
                <nav className={cn('px-2 py-2', !user && 'pt-12')}>
                  {navLinks.map(({ href, label, icon: Icon }) => (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-colors',
                        isActive(href)
                          ? 'bg-accent text-[var(--timberwolf)] font-medium'
                          : 'text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-accent/50'
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {label}
                    </Link>
                  ))}
                </nav>

                <Separator className="bg-border" />

                {/* Bottom actions */}
                <div className="px-2 py-2">
                  {user ? (
                    <>
                      <a
                        href="https://playbacksports.ai/dashboard"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-accent/50 transition-colors"
                      >
                        <ExternalLink className="h-4 w-4 shrink-0" />
                        Edit Profile
                      </a>
                      <button
                        onClick={() =>
                          (window.location.href = '/api/auth/signout')
                        }
                        className="flex items-center gap-3 w-full rounded-md px-3 py-2.5 text-sm text-red-400 hover:text-red-300 hover:bg-accent/50 transition-colors"
                      >
                        <LogOut className="h-4 w-4 shrink-0" />
                        Sign out
                      </button>
                    </>
                  ) : (
                    <div className="space-y-2 px-3">
                      <Link
                        href="/auth/login"
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center justify-center w-full py-2 rounded-md text-sm font-medium text-[var(--timberwolf)] border border-border hover:bg-accent/50 transition-colors"
                      >
                        Sign in
                      </Link>
                      <Link
                        href="/auth/register"
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center justify-center w-full py-2 rounded-md text-sm font-medium bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)] transition-colors"
                      >
                        Sign up
                      </Link>
                    </div>
                  )}
                </div>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </header>
  )
}
