'use client'

import React, { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
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
  teams: VeoTeam[]
  stripeOnlySubscribers: StripeOnlySubscriber[]
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

function stripeStatusColor(status: string | null, hasSub: boolean): string {
  if (!hasSub) return 'bg-red-500/20 text-red-400'
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

function stripeStatusLabel(status: string | null, hasSub: boolean): string {
  if (!hasSub) return 'No subscription'
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

  useEffect(() => {
    fetchVeoData()
    fetchExceptions()
  }, [clubSlug])

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

  const outlineBtnClass =
    'border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10'

  // ============================================================================
  // Loading state
  // ============================================================================

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl animate-pulse">
          <div className="flex items-center justify-between mb-8">
            <div className="space-y-2">
              <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-[180px]" />
              <div className="bg-[var(--ash-grey)]/10 rounded h-8 w-[300px]" />
            </div>
            <div className="bg-[var(--ash-grey)]/10 rounded h-10 w-[110px]" />
          </div>
          <p className="text-[var(--ash-grey)] text-sm mb-6">
            Loading cached data...
          </p>
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-4"
              >
                <div className="bg-[var(--ash-grey)]/10 rounded h-5 w-[200px]" />
              </div>
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
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl">
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-6">
            <p className="text-red-400">{error}</p>
            <div className="flex items-center gap-2 mt-4">
              <Button
                variant="outline"
                className={outlineBtnClass}
                onClick={triggerCacheSync}
                disabled={syncing}
              >
                {syncing ? 'Syncing...' : 'Sync Now'}
              </Button>
              <Button
                className={outlineBtnClass}
                variant="outline"
                onClick={() => router.push('/academy')}
              >
                Switch Club
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!data) return null

  // Stats — deduplicate by email so users in multiple teams are counted once.
  // If someone is a viewer in one team and coach in another, treat them as staff (not flagged).
  const allMembers = data.teams.flatMap((t) => t.members)
  const uniqueByEmail = new Map<string, VeoMember>()
  for (const m of allMembers) {
    const key = m.email?.toLowerCase() || m.id
    const existing = uniqueByEmail.get(key)
    // Prefer non-player role (coach/admin) — if they're staff in any team, they're staff
    if (!existing || (!m.isPlayer && existing.isPlayer)) {
      uniqueByEmail.set(key, m)
    }
  }
  const uniqueMembers = Array.from(uniqueByEmail.values())
  const totalMembers = uniqueMembers.length
  const players = uniqueMembers.filter((m) => m.isPlayer)
  const staff = uniqueMembers.filter((m) => !m.isPlayer)
  const noSub = players.filter((m) => !m.hasSubscription).length
  const scholarships = uniqueMembers.filter((m) => m.isScholarship).length

  return (
    <div className="min-h-screen bg-[var(--night)]">
      <div className="container mx-auto px-5 py-16 max-w-4xl">
        {/* Header */}
        <FadeIn>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-8">
            <div>
              <p className="text-[var(--ash-grey)] text-xs font-semibold tracking-[0.25em] uppercase mb-2">
                Veo Access Audit
              </p>
              <h1 className="text-2xl md:text-3xl font-bold text-[var(--timberwolf)]">
                {data.clubName}
              </h1>
              {data.lastSyncedAt && (
                <p className="text-xs text-[var(--ash-grey)] mt-1">
                  Veo data synced {timeAgo(data.lastSyncedAt)}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 self-start sm:self-auto">
              <Button
                variant="outline"
                className={outlineBtnClass}
                onClick={triggerCacheSync}
                disabled={syncing}
              >
                {syncing ? 'Syncing...' : 'Sync Now'}
              </Button>
              <Button
                variant="outline"
                className={outlineBtnClass}
                onClick={() => fetchVeoData(true)}
              >
                Refresh Stripe
              </Button>
              <Button
                variant="outline"
                className={outlineBtnClass}
                onClick={() => router.push('/academy')}
              >
                Switch Club
              </Button>
            </div>
          </div>
        </FadeIn>

        {/* Summary */}
        <FadeIn delay={100}>
          <div className="grid gap-4 grid-cols-5 mb-6">
            <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-4">
              <p className="text-xs text-[var(--ash-grey)] uppercase tracking-wider mb-1">
                Veo Members
              </p>
              <p className="text-2xl font-bold text-[var(--timberwolf)]">
                {totalMembers}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-4">
              <p className="text-xs text-[var(--ash-grey)] uppercase tracking-wider mb-1">
                Players No Sub
              </p>
              <p className="text-2xl font-bold text-red-400">{noSub}</p>
            </div>
            <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-4">
              <p className="text-xs text-[var(--ash-grey)] uppercase tracking-wider mb-1">
                Paying, Not in Veo
              </p>
              <p className="text-2xl font-bold text-orange-400">
                {data.stripeOnlySubscribers?.length ?? 0}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-4">
              <p className="text-xs text-[var(--ash-grey)] uppercase tracking-wider mb-1">
                Coaches / Staff
              </p>
              <p className="text-2xl font-bold text-amber-400">
                {staff.length}
              </p>
            </div>
            <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-4">
              <p className="text-xs text-[var(--ash-grey)] uppercase tracking-wider mb-1">
                Scholarships
              </p>
              <p className="text-2xl font-bold text-purple-400">
                {scholarships}
              </p>
            </div>
          </div>
        </FadeIn>

        {/* Exceptions */}
        <FadeIn delay={125}>
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] mb-6">
            <button
              onClick={() => setExceptionsOpen(!exceptionsOpen)}
              className="w-full flex items-center justify-between p-4 hover:bg-white/[0.03] transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <span className="text-[var(--ash-grey)] text-xs w-4">
                  {exceptionsOpen ? '\u25BC' : '\u25B6'}
                </span>
                <span className="font-medium text-[var(--timberwolf)]">
                  Sync Exceptions
                </span>
                <span className="text-xs text-[var(--ash-grey)]">
                  {exceptions.length}{' '}
                  {exceptions.length === 1 ? 'user' : 'users'} exempt from
                  auto-removal
                </span>
              </div>
            </button>
            {exceptionsOpen && (
              <div className="border-t border-[var(--ash-grey)]/10 p-4 space-y-3">
                {/* Add exception form */}
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="text-xs text-[var(--ash-grey)] mb-1 block">
                      Email
                    </label>
                    <input
                      type="email"
                      value={newExceptionEmail}
                      onChange={(e) => setNewExceptionEmail(e.target.value)}
                      placeholder="user@example.com"
                      className="w-full text-sm px-3 py-1.5 rounded-lg bg-white/5 border border-[var(--ash-grey)]/20 text-[var(--timberwolf)] placeholder-[var(--ash-grey)]/50 outline-none focus:border-[var(--ash-grey)]/40"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-[var(--ash-grey)] mb-1 block">
                      Reason (optional)
                    </label>
                    <input
                      type="text"
                      value={newExceptionReason}
                      onChange={(e) => setNewExceptionReason(e.target.value)}
                      placeholder="e.g. Staff member"
                      className="w-full text-sm px-3 py-1.5 rounded-lg bg-white/5 border border-[var(--ash-grey)]/20 text-[var(--timberwolf)] placeholder-[var(--ash-grey)]/50 outline-none focus:border-[var(--ash-grey)]/40"
                    />
                  </div>
                  <Button
                    variant="outline"
                    className={`${outlineBtnClass} text-xs`}
                    onClick={addException}
                    disabled={exceptionsLoading || !newExceptionEmail.trim()}
                  >
                    Add
                  </Button>
                </div>

                {/* Exception list */}
                {exceptions.length === 0 ? (
                  <p className="text-xs text-[var(--ash-grey)]">
                    No exceptions configured.
                  </p>
                ) : (
                  <div className="divide-y divide-[var(--ash-grey)]/5">
                    {exceptions.map((exc) => (
                      <div
                        key={exc.id}
                        className="flex items-center justify-between py-2 text-sm"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-[var(--timberwolf)] truncate">
                            {exc.email}
                          </span>
                          {exc.reason && (
                            <span className="text-xs text-[var(--ash-grey)] truncate">
                              {exc.reason}
                            </span>
                          )}
                          <span className="text-xs text-[var(--ash-grey)]/50">
                            {new Date(exc.created_at).toLocaleDateString()}
                          </span>
                        </div>
                        <button
                          onClick={() => removeException(exc.email)}
                          disabled={exceptionsLoading}
                          className="text-xs px-2 py-1 rounded text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </FadeIn>

        {/* Stripe-only subscribers (paying but not in Veo) */}
        {data.stripeOnlySubscribers &&
          data.stripeOnlySubscribers.length > 0 && (
            <FadeIn delay={135}>
              <div className="rounded-xl border border-orange-500/20 bg-white/[0.015] mb-6">
                <button
                  onClick={() => setStripeOnlyOpen(!stripeOnlyOpen)}
                  className="w-full flex items-center justify-between p-4 hover:bg-white/[0.03] transition-colors text-left"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-[var(--ash-grey)] text-xs w-4">
                      {stripeOnlyOpen ? '\u25BC' : '\u25B6'}
                    </span>
                    <span className="font-medium text-[var(--timberwolf)]">
                      Paying, Not in Veo
                    </span>
                    <span className="text-xs text-orange-400">
                      {data.stripeOnlySubscribers.length}{' '}
                      {data.stripeOnlySubscribers.length === 1
                        ? 'subscriber'
                        : 'subscribers'}{' '}
                      not found in any Veo team
                    </span>
                  </div>
                </button>
                {stripeOnlyOpen && (
                  <div className="border-t border-[var(--ash-grey)]/10 bg-white/[0.02]">
                    <div className="divide-y divide-[var(--ash-grey)]/5">
                      {data.stripeOnlySubscribers.map((sub) => (
                        <div
                          key={sub.email}
                          className="flex items-center justify-between gap-2 px-4 py-2 text-sm"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="text-[var(--timberwolf)] truncate">
                              {sub.name || 'Unknown'}
                            </span>
                            <span className="text-xs text-[var(--ash-grey)] truncate">
                              {sub.email}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {sub.registrationTeam && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-[var(--ash-grey)]">
                                {sub.registrationTeam}
                              </span>
                            )}
                            {sub.isScholarship && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400">
                                scholarship
                              </span>
                            )}
                            <span
                              className={`text-xs px-1.5 py-0.5 rounded ${stripeStatusColor(
                                sub.status,
                                true
                              )}`}
                            >
                              {sub.status}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </FadeIn>
          )}

        {/* Controls */}
        <FadeIn delay={150}>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => setFilterNoSub(!filterNoSub)}
              className={`text-xs px-3 py-1.5 rounded-lg transition-colors border ${
                filterNoSub
                  ? 'bg-red-500/20 border-red-500/30 text-red-400'
                  : 'border-[var(--ash-grey)]/20 text-[var(--ash-grey)] hover:text-[var(--timberwolf)]'
              }`}
            >
              {filterNoSub
                ? 'Showing: Players without subscription'
                : 'Filter: Players no sub'}
            </button>
            <button
              onClick={expandAll}
              className="text-xs px-3 py-1.5 rounded-lg border border-[var(--ash-grey)]/20 text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
            >
              Expand all
            </button>
            <button
              onClick={collapseAll}
              className="text-xs px-3 py-1.5 rounded-lg border border-[var(--ash-grey)]/20 text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
            >
              Collapse all
            </button>
          </div>
        </FadeIn>

        {/* Teams */}
        <FadeIn delay={200}>
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6 pb-3">
              <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                Veo Teams
              </h2>
              <p className="text-sm text-[var(--ash-grey)]">
                {data.teams.length} teams across {data.clubName}
              </p>
            </div>
            <div className="px-6 pb-6 space-y-1">
              {data.teams.map((team) => {
                const isExpanded = expandedTeams.has(team.slug)
                const teamNoSub = team.members.filter(
                  (m) => m.isPlayer && !m.hasSubscription
                ).length
                const teamStaff = team.members.filter((m) => !m.isPlayer).length
                const displayMembers = filterNoSub
                  ? team.members.filter((m) => m.isPlayer && !m.hasSubscription)
                  : team.members

                // When filtering, skip teams with no matching members
                if (filterNoSub && displayMembers.length === 0) return null

                return (
                  <div
                    key={team.slug}
                    className="rounded-lg border border-[var(--ash-grey)]/10 overflow-hidden"
                  >
                    {/* Team header */}
                    <button
                      onClick={() => toggleTeam(team.slug)}
                      className="w-full flex items-center justify-between p-3 hover:bg-white/[0.03] transition-colors text-left"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-[var(--ash-grey)] text-xs w-4">
                          {isExpanded ? '\u25BC' : '\u25B6'}
                        </span>
                        <span className="font-medium text-[var(--timberwolf)]">
                          {team.name}
                        </span>
                        <span className="text-xs text-[var(--ash-grey)]">
                          {team.members.length} members
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {teamStaff > 0 && (
                          <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400">
                            {teamStaff} staff
                          </span>
                        )}
                        {teamNoSub > 0 && (
                          <span className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400">
                            {teamNoSub} no sub
                          </span>
                        )}
                      </div>
                    </button>

                    {/* Expanded member list */}
                    {isExpanded && (
                      <div className="border-t border-[var(--ash-grey)]/10 bg-white/[0.02]">
                        {displayMembers.length === 0 ? (
                          <p className="text-xs text-[var(--ash-grey)] p-3">
                            {filterNoSub
                              ? 'All members have subscriptions'
                              : 'No members'}
                          </p>
                        ) : (
                          <div className="divide-y divide-[var(--ash-grey)]/5">
                            {displayMembers.map((member) => (
                              <div
                                key={member.id}
                                className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <span className="text-[var(--timberwolf)] truncate">
                                    {member.name || 'Unknown'}
                                  </span>
                                  <span className="text-xs text-[var(--ash-grey)] truncate">
                                    {member.email}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                  {member.registrationTeam && (
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-white/5 text-[var(--ash-grey)]">
                                      {member.registrationTeam}
                                    </span>
                                  )}
                                  {member.isScholarship && (
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400">
                                      scholarship
                                    </span>
                                  )}
                                  {member.isPlayer ? (
                                    <span
                                      className={`text-xs px-1.5 py-0.5 rounded ${stripeStatusColor(
                                        member.stripeStatus,
                                        member.hasSubscription
                                      )}`}
                                    >
                                      {stripeStatusLabel(
                                        member.stripeStatus,
                                        member.hasSubscription
                                      )}
                                    </span>
                                  ) : (
                                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">
                                      {roleLabel(member.veoRole)}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </FadeIn>
      </div>
    </div>
  )
}
