'use client'

import { useState, useTransition, useRef } from 'react'
import { useRouter } from '@/i18n/navigation'
import { Button, Badge } from '@braintwopoint0/playback-commons/ui'
import { ShieldCheck } from 'lucide-react'

interface VerifyPlayerButtonProps {
  profileId: string
  organizationId: string
  initialVerified: boolean
}

/**
 * One-click verify/revoke. Optimistic local state — a failed call rolls back
 * and surfaces the error inline so the row stays accurate without a full
 * round-trip to the server component.
 */
export function VerifyPlayerButton({
  profileId,
  organizationId,
  initialVerified,
}: VerifyPlayerButtonProps) {
  const [verified, setVerified] = useState(initialVerified)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  // useTransition's `pending` flag lags by a tick on first call — without a
  // ref guard, two rapid clicks both pass the disabled gate and fire racing
  // requests. The ref serializes synchronously.
  const inFlightRef = useRef(false)
  const router = useRouter()

  function toggle() {
    if (inFlightRef.current) return
    inFlightRef.current = true

    const next = !verified
    setVerified(next)
    setError(null)
    startTransition(async () => {
      try {
        const url = `/api/profile/${profileId}/verify${
          next ? '' : `?organizationId=${encodeURIComponent(organizationId)}`
        }`
        const res = await fetch(url, {
          method: next ? 'POST' : 'DELETE',
          credentials: 'same-origin',
          headers: next ? { 'Content-Type': 'application/json' } : undefined,
          body: next ? JSON.stringify({ organizationId }) : undefined,
        })
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}))
          throw new Error(payload.error ?? `Request failed: ${res.status}`)
        }
        // Re-fetch the server component so the verification count + downstream
        // public profile reflect the new state on next nav.
        router.refresh()
      } catch (err) {
        setVerified(!next)
        setError(err instanceof Error ? err.message : 'Failed')
      } finally {
        inFlightRef.current = false
      }
    })
  }

  if (verified) {
    return (
      <div className="flex items-center gap-2">
        <Badge
          variant="secondary"
          className="bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/15"
        >
          <ShieldCheck className="mr-1 h-3 w-3" /> Verified
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggle}
          disabled={pending}
          className="text-xs text-muted-foreground hover:text-destructive"
        >
          Revoke
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="outline" size="sm" onClick={toggle} disabled={pending}>
        <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
        {pending ? 'Verifying…' : 'Verify'}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  )
}
