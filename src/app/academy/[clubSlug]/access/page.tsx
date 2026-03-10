'use client'

import React, { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  ChevronDown,
  ChevronRight,
  Search,
  RefreshCw,
  ArrowLeftRight,
  Shield,
  UserCog,
  AlertTriangle,
  X,
} from 'lucide-react'
import { Button } from '@braintwopoint0/playback-commons/ui'
import { FadeIn } from '@/components/FadeIn'

// ============================================================================
// Types
// ============================================================================

interface VeoMember {
  id: string
  email: string
  name: string
  veoRole: string
  isPlayer: boolean
  stripeStatus: string | null
  isScholarship: boolean
  registrationTeam: string | null
  hasSubscription: boolean
}

interface VeoTeam {
  slug: string
  name: string
  memberCount: number
  members: VeoMember[]
}

interface StripeOnlySubscriber {
  email: string
  name: string | null
  status: string
  isScholarship: boolean
  registrationTeam: string | null
}

interface VeoData {
  clubName: string
  veoClubSlug: string
  hasScholarships: boolean
  role: 'platform_admin' | 'org_admin'
  teams: VeoTeam[]
  stripeOnlySubscribers: StripeOnlySubscriber[]
  exemptEmails?: string[]
  lastSyncedAt: string | null
}

interface VeoException {
  id: string
  club_slug: string
  email: string
  reason: string | null
  created_at: string
}

// ============================================================================
// Helpers
// ============================================================================

function stripeStatusColor(
  status: string | null,
  hasSub: boolean,
  isExempt = false
): string {
  if (!hasSub)
    return isExempt
      ? 'bg-blue-500/20 text-blue-400'
      : 'bg-red-500/20 text-red-400'
  switch (status) {
    case 'active':
      return 'bg-green-500/20 text-green-500'
    case 'trialing':
      return 'bg-blue-500/20 text-blue-400'
    case 'past_due':
      return 'bg-yellow-500/20 text-yellow-500'
    case 'canceled':
      return 'bg-red-500/20 text-red-400'
    default:
      return 'bg-gray-500/20 text-gray-400'
  }
}

function stripeStatusLabel(
  status: string | null,
  hasSub: boolean,
  isExempt = false
): string {
  if (!hasSub) return isExempt ? 'exempt' : 'No subscription'
  return status || 'unknown'
}

function timeAgo(dateString: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(dateString).getTime()) / 1000
  )
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function roleLabel(veoRole: string): string {
  switch (veoRole) {
    case 'coach':
      return 'Coach'
    case 'admin':
      return 'Admin'
    case 'owner':
      return 'Owner'
    default:
      return veoRole
  }
}

// ============================================================================
// Page Component
// ============================================================================

export default function AcademyAccessPage() {
  const params = useParams()
  const clubSlug = params.clubSlug as string
  const router = useRouter()

  const [data, setData] = useState<VeoData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set())
  const [filterNoSub, setFilterNoSub] = useState(false)

  // Sync state
  const [syncing, setSyncing] = useState(false)

  // Exceptions state
  const [exceptions, setExceptions] = useState<VeoException[]>([])
  const [exceptionsOpen, setExceptionsOpen] = useState(false)
  const [newExceptionEmail, setNewExceptionEmail] = useState('')
  const [newExceptionReason, setNewExceptionReason] = useState('')
  const [exceptionsLoading, setExceptionsLoading] = useState(false)

  // Stripe-only subscribers state
  const [stripeOnlyOpen, setStripeOnlyOpen] = useState(false)

  // Admin management state
  const [adminsOpen, setAdminsOpen] = useState(false)
  const [admins, setAdmins] = useState<
    {
      id: string
      role: string
      fullName: string
      email: string
      createdAt: string
    }[]
  >([])
  const [newAdminEmail, setNewAdminEmail] = useState('')
  const [adminsLoading, setAdminsLoading] = useState(false)
  const [adminMessage, setAdminMessage] = useState<string | null>(null)

  // Search state
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    fetchVeoData()
    fetchExceptions()
  }, [clubSlug])

  // Fetch admins once we know the user is a platform admin
  useEffect(() => {
    if (data?.role === 'platform_admin') {
      fetchAdmins()
    }
  }, [data?.role, clubSlug])

  async function fetchVeoData(refresh = false) {
    try {
      setLoading(true)
      setError(null)
      const qs = refresh ? '?refresh=1' : ''
      const res = await fetch(`/api/academy/${clubSlug}/veo${qs}`)
      const json = await res.json()

      if (json.error) {
        setError(json.detail ? `${json.error}: ${json.detail}` : json.error)
        return
      }

      setData(json)
    } catch {
      setError('Failed to load Veo data')
    } finally {
      setLoading(false)
    }
  }

  async function fetchExceptions() {
    try {
      const res = await fetch(`/api/academy/${clubSlug}/veo/exceptions`)
      const json = await res.json()
      if (json.exceptions) setExceptions(json.exceptions)
    } catch {
      // Silently fail — exceptions are supplementary
    }
  }

  async function triggerCacheSync() {
    try {
      setSyncing(true)
      setError(null)
      const res = await fetch(`/api/academy/${clubSlug}/veo/cache-sync`, {
        method: 'POST',
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json.error || 'Sync failed')
        return
      }
      // Lambda runs async — poll until data refreshes (~20-30s)
      const prevSync = data?.lastSyncedAt
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 5000))
        const res2 = await fetch(`/api/academy/${clubSlug}/veo`)
        const json2 = await res2.json()
        if (!json2.error) {
          setData(json2)
          if (json2.lastSyncedAt && json2.lastSyncedAt !== prevSync) break
        }
      }
    } catch {
      setError('Sync request failed')
    } finally {
      setSyncing(false)
    }
  }

  async function addException() {
    if (!newExceptionEmail.trim()) return
    setExceptionsLoading(true)
    try {
      const res = await fetch(`/api/academy/${clubSlug}/veo/exceptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: newExceptionEmail.trim(),
          reason: newExceptionReason.trim() || null,
        }),
      })
      if (res.ok) {
        setNewExceptionEmail('')
        setNewExceptionReason('')
        await fetchExceptions()
      }
    } catch {
      // ignore
    } finally {
      setExceptionsLoading(false)
    }
  }

  async function removeException(email: string) {
    setExceptionsLoading(true)
    try {
      await fetch(`/api/academy/${clubSlug}/veo/exceptions`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      await fetchExceptions()
    } catch {
      // ignore
    } finally {
      setExceptionsLoading(false)
    }
  }

  async function fetchAdmins() {
    try {
      const res = await fetch(`/api/academy/${clubSlug}/admins`)
      const json = await res.json()
      if (json.admins) setAdmins(json.admins)
    } catch {
      // Silently fail — admins section is supplementary
    }
  }

  async function removeAdmin(memberId: string) {
    setAdminsLoading(true)
    setAdminMessage(null)
    try {
      const res = await fetch(`/api/academy/${clubSlug}/admins/${memberId}`, {
        method: 'DELETE',
      })
      const json = await res.json()
      if (res.ok) {
        setAdminMessage('Admin removed')
        await fetchAdmins()
      } else {
        setAdminMessage(json.error || 'Failed to remove admin')
      }
    } catch {
      setAdminMessage('Failed to remove admin')
    } finally {
      setAdminsLoading(false)
    }
  }

  async function inviteAdmin() {
    if (!newAdminEmail.trim()) return
    setAdminsLoading(true)
    setAdminMessage(null)
    try {
      const res = await fetch(`/api/academy/${clubSlug}/admins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newAdminEmail.trim() }),
      })
      const json = await res.json()
      if (res.ok) {
        setNewAdminEmail('')
        setAdminMessage(
          json.invited ? json.message : 'Admin added successfully'
        )
        await fetchAdmins()
      } else {
        setAdminMessage(json.error || 'Failed to invite admin')
      }
    } catch {
      setAdminMessage('Failed to invite admin')
    } finally {
      setAdminsLoading(false)
    }
  }

  function toggleTeam(slug: string) {
    setExpandedTeams((prev) => {
      const next = new Set(prev)
      if (next.has(slug)) next.delete(slug)
      else next.add(slug)
      return next
    })
  }

  function expandAll() {
    if (data) {
      setExpandedTeams(new Set(data.teams.map((t) => t.slug)))
    }
  }

  function collapseAll() {
    setExpandedTeams(new Set())
  }

  // ============================================================================
  // Loading state
  // ============================================================================

  if (loading) {
    return (
      <div>
        <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 max-w-5xl animate-pulse">
          <div className="space-y-2 mb-10">
            <div className="bg-white/5 rounded h-3 w-32" />
            <div className="bg-white/5 rounded h-8 w-64" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded-lg bg-muted/50 p-4 h-20" />
            ))}
          </div>
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="rounded-lg bg-muted/50 h-12" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  // ============================================================================
  // Error state
  // ============================================================================

  if (error) {
    return (
      <div>
        <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 max-w-5xl">
          <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div className="space-y-3">
                <p className="text-sm text-red-300">{error}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={triggerCacheSync}
                    disabled={syncing}
                    className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[var(--timberwolf)] hover:bg-white/10 transition-colors disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`h-3 w-3 inline mr-1.5 ${syncing ? 'animate-spin' : ''}`}
                    />
                    {syncing ? 'Syncing...' : 'Sync Now'}
                  </button>
                  <button
                    onClick={() => router.push('/academy')}
                    className="text-xs px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-[var(--timberwolf)] hover:bg-white/10 transition-colors"
                  >
                    Switch Club
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!data) return null

  const isPlatAdmin = data.role === 'platform_admin'

  // Set of exempt emails for quick lookup — merge from main endpoint (all roles) and exceptions list (admin CRUD)
  const exemptEmails = new Set([
    ...(data.exemptEmails || []),
    ...exceptions.map((e) => e.email.toLowerCase()),
  ])

  // Stats — deduplicate by email so users in multiple teams are counted once.
  const allMembers = data.teams.flatMap((t) => t.members)
  const uniqueByEmail = new Map<string, VeoMember>()
  for (const m of allMembers) {
    const key = m.email?.toLowerCase() || m.id
    const existing = uniqueByEmail.get(key)
    if (!existing || (!m.isPlayer && existing.isPlayer)) {
      uniqueByEmail.set(key, m)
    }
  }
  const uniqueMembers = Array.from(uniqueByEmail.values())
  const totalMembers = uniqueMembers.length
  const players = uniqueMembers.filter((m) => m.isPlayer)
  const staff = uniqueMembers.filter((m) => !m.isPlayer)
  const noSub = players.filter(
    (m) =>
      (!m.hasSubscription || m.stripeStatus === 'canceled') &&
      !exemptEmails.has(m.email?.toLowerCase())
  ).length
  const scholarships = data.hasScholarships
    ? uniqueMembers.filter((m) => m.isScholarship).length
    : 0

  const activeSubEmails = new Set<string>()
  for (const m of uniqueMembers) {
    if (m.hasSubscription && m.stripeStatus !== 'canceled' && m.email) {
      activeSubEmails.add(m.email.toLowerCase())
    }
  }
  const academySubs =
    activeSubEmails.size + (data.stripeOnlySubscribers?.length ?? 0)

  // Stat card config
  const stats = [
    {
      label: 'Active Subs',
      value: academySubs,
      color: 'text-emerald-400',
      dot: 'bg-emerald-400',
    },
    {
      label: 'Veo Members',
      value: totalMembers,
      color: 'text-[var(--timberwolf)]',
      dot: 'bg-muted-foreground',
    },
    {
      label: 'No Sub',
      value: noSub,
      color: 'text-red-400',
      dot: 'bg-red-400',
      alert: noSub > 0,
    },
    {
      label: 'Not in Veo',
      value: data.stripeOnlySubscribers?.length ?? 0,
      color: 'text-orange-400',
      dot: 'bg-orange-400',
      alert: (data.stripeOnlySubscribers?.length ?? 0) > 0,
    },
    {
      label: 'Staff',
      value: staff.length,
      color: 'text-amber-400',
      dot: 'bg-amber-400',
    },
    ...(data.hasScholarships && scholarships > 0
      ? [
          {
            label: 'Scholarships',
            value: scholarships,
            color: 'text-purple-400',
            dot: 'bg-purple-400',
          },
        ]
      : []),
  ]

  return (
    <div>
      <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 max-w-5xl">
        {/* ── Header ──────────────────────────────────────── */}
        <FadeIn>
          <div className="mb-10">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <p className="text-muted-foreground/70 text-[11px] font-medium tracking-[0.2em] uppercase mb-1.5">
                  Access Audit
                </p>
                <h1 className="text-2xl sm:text-3xl font-semibold text-[var(--timberwolf)] tracking-tight">
                  {data.clubName}
                </h1>
                {data.lastSyncedAt && (
                  <p className="text-[11px] text-muted-foreground/50 mt-1.5">
                    Last synced {timeAgo(data.lastSyncedAt)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {isPlatAdmin && (
                  <>
                    <button
                      onClick={triggerCacheSync}
                      disabled={syncing}
                      className="text-[11px] px-3 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-muted transition-all disabled:opacity-50"
                    >
                      <RefreshCw
                        className={`h-3 w-3 inline mr-1 ${syncing ? 'animate-spin' : ''}`}
                      />
                      {syncing ? 'Syncing' : 'Sync'}
                    </button>
                    <button
                      onClick={() => fetchVeoData(true)}
                      className="text-[11px] px-3 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-muted transition-all"
                    >
                      <ArrowLeftRight className="h-3 w-3 inline mr-1" />
                      Refresh
                    </button>
                  </>
                )}
                <button
                  onClick={() => router.push('/academy')}
                  className="text-[11px] px-3 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-muted transition-all"
                >
                  Switch
                </button>
              </div>
            </div>
          </div>
        </FadeIn>

        {/* ── Stats ───────────────────────────────────────── */}
        <FadeIn delay={80}>
          <div
            className={`grid gap-px bg-muted rounded-xl overflow-hidden mb-8 ${
              stats.length === 6
                ? 'grid-cols-3 sm:grid-cols-6'
                : 'grid-cols-6 sm:grid-cols-5'
            }`}
          >
            {stats.map((s, i) => (
              <div
                key={s.label}
                className={`bg-[var(--night)] px-3 py-3.5 sm:py-4 text-center ${
                  stats.length === 5
                    ? i < 2
                      ? 'col-span-3 sm:col-span-1'
                      : 'col-span-2 sm:col-span-1'
                    : ''
                }`}
              >
                <div
                  className={`text-xl sm:text-2xl font-semibold tabular-nums ${s.color}`}
                >
                  {s.value}
                </div>
                <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider mt-0.5">
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </FadeIn>

        {/* ── Admin Panels (platform admin only) ─────────── */}
        {isPlatAdmin && (
          <FadeIn delay={100}>
            <div className="space-y-2 mb-8">
              {/* Exceptions */}
              <div className="rounded-xl bg-card overflow-hidden">
                <button
                  onClick={() => setExceptionsOpen(!exceptionsOpen)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                >
                  <Shield className="h-3.5 w-3.5 text-blue-400/70" />
                  <span className="text-sm font-medium text-[var(--timberwolf)]">
                    Exceptions
                  </span>
                  <span className="text-[11px] text-muted-foreground/50">
                    {exceptions.length}
                  </span>
                  <ChevronDown
                    className={`h-3 w-3 text-muted-foreground/40 ml-auto transition-transform ${exceptionsOpen ? '' : '-rotate-90'}`}
                  />
                </button>
                {exceptionsOpen && (
                  <div className="border-t border-white/[0.04] px-4 py-3 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                      <div className="flex-1">
                        <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1 block">
                          Email
                        </label>
                        <input
                          type="email"
                          value={newExceptionEmail}
                          onChange={(e) => setNewExceptionEmail(e.target.value)}
                          placeholder="user@example.com"
                          className="w-full text-sm px-3 py-1.5 rounded-lg bg-muted border border-border text-[var(--timberwolf)] placeholder-muted-foreground outline-none focus:border-ring transition-colors"
                        />
                      </div>
                      <div className="flex-1">
                        <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1 block">
                          Reason
                        </label>
                        <input
                          type="text"
                          value={newExceptionReason}
                          onChange={(e) =>
                            setNewExceptionReason(e.target.value)
                          }
                          placeholder="Optional"
                          className="w-full text-sm px-3 py-1.5 rounded-lg bg-muted border border-border text-[var(--timberwolf)] placeholder-muted-foreground outline-none focus:border-ring transition-colors"
                        />
                      </div>
                      <button
                        onClick={addException}
                        disabled={
                          exceptionsLoading || !newExceptionEmail.trim()
                        }
                        className="text-xs px-4 py-1.5 rounded-lg bg-blue-500/15 text-blue-400 hover:bg-blue-500/25 transition-colors disabled:opacity-30"
                      >
                        Add
                      </button>
                    </div>
                    {exceptions.length > 0 && (
                      <div className="space-y-0.5">
                        {exceptions.map((exc) => (
                          <div
                            key={exc.id}
                            className="flex items-center justify-between gap-2 py-1.5 group"
                          >
                            <div className="flex items-center gap-2 min-w-0 text-sm">
                              <span className="text-[var(--timberwolf)]/80 truncate">
                                {exc.email}
                              </span>
                              {exc.reason && (
                                <span className="text-[11px] text-muted-foreground/40 truncate hidden sm:inline">
                                  {exc.reason}
                                </span>
                              )}
                            </div>
                            <button
                              onClick={() => removeException(exc.email)}
                              disabled={exceptionsLoading}
                              className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-red-400 transition-all p-1"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Admins */}
              <div className="rounded-xl bg-card overflow-hidden">
                <button
                  onClick={() => setAdminsOpen(!adminsOpen)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                >
                  <UserCog className="h-3.5 w-3.5 text-muted-foreground/50" />
                  <span className="text-sm font-medium text-[var(--timberwolf)]">
                    Admins
                  </span>
                  <span className="text-[11px] text-muted-foreground/50">
                    {admins.length}
                  </span>
                  <ChevronDown
                    className={`h-3 w-3 text-muted-foreground/40 ml-auto transition-transform ${adminsOpen ? '' : '-rotate-90'}`}
                  />
                </button>
                {adminsOpen && (
                  <div className="border-t border-white/[0.04] px-4 py-3 space-y-3">
                    <div className="flex flex-col sm:flex-row sm:items-end gap-2">
                      <div className="flex-1">
                        <label className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mb-1 block">
                          Email
                        </label>
                        <input
                          type="email"
                          value={newAdminEmail}
                          onChange={(e) => setNewAdminEmail(e.target.value)}
                          placeholder="admin@example.com"
                          className="w-full text-sm px-3 py-1.5 rounded-lg bg-muted border border-border text-[var(--timberwolf)] placeholder-muted-foreground outline-none focus:border-ring transition-colors"
                        />
                      </div>
                      <button
                        onClick={inviteAdmin}
                        disabled={adminsLoading || !newAdminEmail.trim()}
                        className="text-xs px-4 py-1.5 rounded-lg bg-muted text-[var(--timberwolf)] hover:bg-white/[0.1] transition-colors disabled:opacity-30"
                      >
                        Invite
                      </button>
                    </div>
                    {adminMessage && (
                      <p className="text-[11px] text-muted-foreground/60">
                        {adminMessage}
                      </p>
                    )}
                    {admins.length > 0 && (
                      <div className="space-y-0.5">
                        {admins.map((admin) => (
                          <div
                            key={admin.id}
                            className="flex items-center justify-between gap-2 py-1.5 group"
                          >
                            <div className="min-w-0">
                              <span className="text-sm text-[var(--timberwolf)]/80 truncate block">
                                {admin.fullName || 'Unknown'}
                              </span>
                              <span className="text-[11px] text-muted-foreground/40 truncate block">
                                {admin.email}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span className="text-[10px] text-muted-foreground/40">
                                {admin.role === 'admin'
                                  ? 'Admin'
                                  : admin.role === 'manager'
                                    ? 'Manager'
                                    : admin.role === 'league_admin'
                                      ? 'League'
                                      : 'Admin'}
                              </span>
                              <button
                                onClick={() => removeAdmin(admin.id)}
                                disabled={adminsLoading}
                                className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-red-400 transition-all p-1"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </FadeIn>
        )}

        {/* ── Stripe-only (not in Veo) ───────────────────── */}
        {data.stripeOnlySubscribers &&
          data.stripeOnlySubscribers.length > 0 && (
            <FadeIn delay={120}>
              <div className="rounded-xl bg-card overflow-hidden mb-8">
                <button
                  onClick={() => setStripeOnlyOpen(!stripeOnlyOpen)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                >
                  <AlertTriangle className="h-3.5 w-3.5 text-orange-400/70" />
                  <span className="text-sm font-medium text-[var(--timberwolf)]">
                    Not in Veo
                  </span>
                  <span className="text-[11px] text-orange-400/70">
                    {data.stripeOnlySubscribers.length} paying but missing
                  </span>
                  <ChevronDown
                    className={`h-3 w-3 text-muted-foreground/40 ml-auto transition-transform ${stripeOnlyOpen ? '' : '-rotate-90'}`}
                  />
                </button>
                {stripeOnlyOpen && (
                  <div className="border-t border-white/[0.04]">
                    {data.stripeOnlySubscribers.map((sub, i) => (
                      <div
                        key={sub.email}
                        className={`flex items-center justify-between gap-2 px-4 py-2 ${
                          i > 0 ? 'border-t border-white/[0.02]' : ''
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-sm text-[var(--timberwolf)]/90 truncate">
                            {sub.name || 'Unknown'}
                          </div>
                          <div className="text-[11px] text-muted-foreground/40 truncate">
                            {sub.email}
                            {sub.registrationTeam && (
                              <span className="ml-2 text-muted-foreground/25">
                                {sub.registrationTeam}
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {data.hasScholarships && sub.isScholarship && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400/80">
                              scholarship
                            </span>
                          )}
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded-full ${stripeStatusColor(sub.status, true)}`}
                          >
                            {sub.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </FadeIn>
          )}

        {/* ── Search & Filters ───────────────────────────── */}
        <FadeIn delay={140}>
          <div className="flex flex-wrap items-center gap-2 mb-4">
            <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/30" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search members..."
                className="w-full text-sm pl-9 pr-3 py-2 rounded-lg bg-muted border border-border text-[var(--timberwolf)] placeholder-muted-foreground outline-none focus:border-ring transition-colors"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setFilterNoSub(!filterNoSub)}
                className={`text-[11px] px-3 py-2 rounded-lg transition-all ${
                  filterNoSub
                    ? 'bg-red-500/15 text-red-400 ring-1 ring-red-500/20'
                    : 'bg-muted text-muted-foreground/60 hover:text-[var(--timberwolf)] hover:bg-muted'
                }`}
              >
                No sub
              </button>
              <button
                onClick={expandAll}
                className="text-[11px] px-3 py-2 rounded-lg bg-muted text-muted-foreground/60 hover:text-[var(--timberwolf)] hover:bg-muted transition-all"
              >
                Expand
              </button>
              <button
                onClick={collapseAll}
                className="text-[11px] px-3 py-2 rounded-lg bg-muted text-muted-foreground/60 hover:text-[var(--timberwolf)] hover:bg-muted transition-all"
              >
                Collapse
              </button>
            </div>
          </div>
        </FadeIn>

        {/* ── Teams ──────────────────────────────────────── */}
        <FadeIn delay={180}>
          <div className="space-y-1.5">
            {data.teams.map((team) => {
              const query = searchQuery.toLowerCase().trim()
              const isExpanded = expandedTeams.has(team.slug) || !!query
              const teamPlayers = team.members.filter((m) => m.isPlayer)
              const teamNoSub = teamPlayers.filter(
                (m) =>
                  (!m.hasSubscription || m.stripeStatus === 'canceled') &&
                  !exemptEmails.has(m.email?.toLowerCase())
              ).length
              const teamStaff = team.members.filter((m) => !m.isPlayer).length
              const subRate =
                teamPlayers.length > 0
                  ? Math.round(
                      ((teamPlayers.length - teamNoSub) / teamPlayers.length) *
                        100
                    )
                  : 100

              let displayMembers = filterNoSub
                ? team.members.filter(
                    (m) =>
                      m.isPlayer &&
                      (!m.hasSubscription || m.stripeStatus === 'canceled') &&
                      !exemptEmails.has(m.email?.toLowerCase())
                  )
                : team.members
              if (query) {
                displayMembers = displayMembers.filter(
                  (m) =>
                    m.name?.toLowerCase().includes(query) ||
                    m.email?.toLowerCase().includes(query)
                )
              }

              if ((filterNoSub || query) && displayMembers.length === 0)
                return null

              return (
                <div
                  key={team.slug}
                  className="rounded-xl bg-card overflow-hidden"
                >
                  {/* Team header */}
                  <button
                    onClick={() => toggleTeam(team.slug)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                  >
                    <ChevronDown
                      className={`h-3.5 w-3.5 text-muted-foreground/40 flex-shrink-0 transition-transform ${isExpanded ? '' : '-rotate-90'}`}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--timberwolf)] truncate">
                          {team.name}
                        </span>
                        <span className="text-[11px] text-muted-foreground/40">
                          {team.members.length}
                        </span>
                      </div>
                      {/* Sub coverage bar */}
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="h-1 flex-1 max-w-[120px] rounded-full bg-muted overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all ${
                              subRate === 100
                                ? 'bg-emerald-500/60'
                                : subRate >= 70
                                  ? 'bg-yellow-500/60'
                                  : 'bg-red-500/60'
                            }`}
                            style={{ width: `${subRate}%` }}
                          />
                        </div>
                        <span
                          className={`text-[10px] tabular-nums ${
                            subRate === 100
                              ? 'text-emerald-400/60'
                              : subRate >= 70
                                ? 'text-yellow-400/60'
                                : 'text-red-400/60'
                          }`}
                        >
                          {subRate}%
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {teamStaff > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400/70">
                          {teamStaff} staff
                        </span>
                      )}
                      {teamNoSub > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-400/70">
                          {teamNoSub} no sub
                        </span>
                      )}
                    </div>
                  </button>

                  {/* Members */}
                  {isExpanded && (
                    <div className="border-t border-white/[0.04]">
                      {displayMembers.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground/40 px-4 py-3">
                          {filterNoSub
                            ? 'All members have subscriptions'
                            : 'No members'}
                        </p>
                      ) : (
                        displayMembers.map((member, i) => {
                          const isExempt = exemptEmails.has(
                            member.email?.toLowerCase()
                          )
                          return (
                            <div
                              key={member.id}
                              className={`flex items-center gap-3 px-4 py-2 hover:bg-white/[0.015] transition-colors ${
                                i > 0 ? 'border-t border-white/[0.02]' : ''
                              }`}
                            >
                              {/* Status dot */}
                              <div
                                className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                                  !member.isPlayer
                                    ? 'bg-amber-400/60'
                                    : member.hasSubscription &&
                                        member.stripeStatus !== 'canceled'
                                      ? 'bg-emerald-400/60'
                                      : isExempt
                                        ? 'bg-blue-400/60'
                                        : 'bg-red-400/60'
                                }`}
                              />
                              {/* Name & email */}
                              <div className="flex-1 min-w-0">
                                <div className="text-sm text-[var(--timberwolf)]/90 truncate">
                                  {member.name || 'Unknown'}
                                </div>
                                <div className="text-[11px] text-muted-foreground/35 truncate">
                                  {member.email}
                                </div>
                              </div>
                              {/* Badges */}
                              <div className="flex items-center gap-1.5 flex-shrink-0">
                                {data.hasScholarships &&
                                  member.isScholarship && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400/80">
                                      scholarship
                                    </span>
                                  )}
                                {member.isPlayer ? (
                                  <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded-full ${stripeStatusColor(
                                      member.stripeStatus,
                                      member.hasSubscription,
                                      isExempt
                                    )}`}
                                  >
                                    {stripeStatusLabel(
                                      member.stripeStatus,
                                      member.hasSubscription,
                                      isExempt
                                    )}
                                  </span>
                                ) : (
                                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400/70">
                                    {roleLabel(member.veoRole)}
                                  </span>
                                )}
                              </div>
                            </div>
                          )
                        })
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </FadeIn>
      </div>
    </div>
  )
}
