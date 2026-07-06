'use client'

// Renders the current user's pending recording invitations as a small,
// dismissible-per-row card on /recordings. Closes the "salted-account"
// abuse vector flagged by the security review — when access is granted by
// arbitrary peers (not just admins), the recipient gets explicit visibility
// into who invited them and a one-click decline.

import { useEffect, useState } from 'react'
import { Link } from '@/i18n/navigation'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Button,
} from '@braintwopoint0/playback-commons/ui'
import { Loader2, MailOpen, Play, X as XIcon } from 'lucide-react'
import { formatDate } from '@braintwopoint0/playback-commons/utils'

interface PendingGrantRecording {
  id: string
  title: string
  home_team: string | null
  away_team: string | null
  match_date: string | null
  organization_id: string | null
}

interface PendingGrant {
  id: string
  granted_at: string
  expires_at: string | null
  claimed: boolean
  recording: PendingGrantRecording | null
  granted_by: { user_id: string; display: string | null } | null
}

export function PendingInvitations() {
  const [grants, setGrants] = useState<PendingGrant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [decliningId, setDecliningId] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    fetch('/api/me/pending-grants')
      .then((r) => r.json())
      .then((data) => {
        if (!mounted) return
        if (data.error) {
          setError(data.error)
          return
        }
        setGrants(data.grants || [])
      })
      .catch(() => {
        if (mounted) setError('Failed to load invitations')
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [])

  const decline = async (grantId: string) => {
    setDecliningId(grantId)
    try {
      const res = await fetch(`/api/me/pending-grants/${grantId}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Failed to decline')
        return
      }
      // Optimistic remove from the list — the server has already revoked.
      setGrants((prev) => prev.filter((g) => g.id !== grantId))
    } catch {
      setError('Failed to decline')
    } finally {
      setDecliningId(null)
    }
  }

  // Skip rendering entirely while loading or when there's nothing pending.
  // The component lives at the top of /recordings; we don't want a flash
  // of an empty card on every page load for users with no invitations.
  if (loading || (!error && grants.length === 0)) return null

  return (
    <Card className="relative mb-6 overflow-hidden border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-400/30 to-transparent" />
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="flex items-center gap-2.5">
          <MailOpen className="h-4 w-4 text-emerald-300" />
          <CardTitle className="text-base text-[var(--timberwolf)]">
            Pending invitations
          </CardTitle>
          {grants.length > 0 && (
            <span className="grid h-5 min-w-[20px] place-items-center rounded-full bg-emerald-400/10 px-1.5 text-[10px] font-medium tabular-nums text-emerald-300">
              {grants.length}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {error && (
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300">
            <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
            {error}
          </div>
        )}

        {grants.length > 0 && (
          <ul className="space-y-2">
            {grants.map((g) => {
              const inviter = g.granted_by?.display || 'Someone'
              const recording = g.recording
              return (
                <li
                  key={g.id}
                  className="flex flex-col gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[var(--timberwolf)]">
                      {recording?.title || 'Recording'}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      <span className="font-medium text-[var(--timberwolf)]/80">
                        {inviter}
                      </span>{' '}
                      shared with you
                      {recording?.match_date && (
                        <>
                          {' · '}
                          {formatDate(recording.match_date)}
                        </>
                      )}
                      {!g.claimed && (
                        <>
                          {' · '}
                          <span className="text-emerald-300/80">
                            sign-in claimed it for you
                          </span>
                        </>
                      )}
                    </p>
                  </div>

                  <div className="flex items-center gap-2">
                    {recording && (
                      <Button
                        asChild
                        size="sm"
                        className="h-8 px-3 text-xs bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]"
                      >
                        <Link href={`/watch/${recording.id}`}>
                          <Play className="h-3 w-3 mr-1.5" />
                          Watch
                        </Link>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => decline(g.id)}
                      disabled={decliningId === g.id}
                      className="h-8 px-3 text-xs border-white/[0.08] bg-white/[0.02] hover:bg-red-500/10 hover:border-red-400/30 hover:text-red-300"
                    >
                      {decliningId === g.id ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <>
                          <XIcon className="h-3 w-3 mr-1.5" />
                          Decline
                        </>
                      )}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
