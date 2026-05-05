'use client'

import { useState, useTransition, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  Button,
  Input,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@braintwopoint0/playback-commons/ui'
import { Lock, Save, AlertCircle } from 'lucide-react'

interface RosterPlayer {
  profileId: string
  fullName: string | null
  username: string | null
  defaultJerseyNumber: number | null
}

interface ExistingEntry {
  jerseyNumber: number
  profileId: string | null
  notes: string | null
  lockedAt: string | null
}

interface JerseyMapEditorProps {
  recordingId: string
  recordingTitle: string
  homeTeam: string
  awayTeam: string
  matchDate: string
  roster: RosterPlayer[]
  existingEntries: ExistingEntry[]
  alreadyLocked: boolean
}

interface RowState {
  profileId: string
  jerseyNumber: string // string for input control; coerced to int on submit
}

export function JerseyMapEditor({
  recordingId,
  recordingTitle,
  homeTeam,
  awayTeam,
  matchDate,
  roster,
  existingEntries,
  alreadyLocked,
}: JerseyMapEditorProps) {
  // Seed each row's jersey number from (existing map → roster default → blank).
  const seeded: Record<string, string> = useMemo(() => {
    const fromExisting = new Map<string, number>()
    existingEntries.forEach((e) => {
      if (e.profileId) fromExisting.set(e.profileId, e.jerseyNumber)
    })
    const out: Record<string, string> = {}
    roster.forEach((p) => {
      const n =
        fromExisting.get(p.profileId) ?? p.defaultJerseyNumber ?? null
      out[p.profileId] = n === null ? '' : String(n)
    })
    return out
  }, [roster, existingEntries])

  const [values, setValues] = useState<Record<string, string>>(seeded)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  // Synchronous serialization gate — `pending` from useTransition lags by a
  // tick, so a double-click before the first paint can fire two PUTs and
  // double-trip the lock-time clip-attribution trigger.
  const inFlightRef = useRef(false)
  const router = useRouter()

  function setNumber(profileId: string, value: string) {
    // Allow only digits, max 2 chars (0-99 range enforced on submit).
    const clean = value.replace(/[^0-9]/g, '').slice(0, 2)
    setValues((prev) => ({ ...prev, [profileId]: clean }))
    setError(null)
    setSuccess(null)
  }

  // Detect duplicates in the current state for inline visual feedback.
  const duplicates: Set<string> = useMemo(() => {
    const seen = new Map<string, string>()
    const dupes = new Set<string>()
    Object.entries(values).forEach(([profileId, v]) => {
      if (!v) return
      const existing = seen.get(v)
      if (existing) {
        dupes.add(profileId)
        dupes.add(existing)
      } else {
        seen.set(v, profileId)
      }
    })
    return dupes
  }, [values])

  function submit(lock: boolean) {
    // Short-circuit BEFORE clearing the success/error banner so accidental
    // Enter (after a successful save) doesn't silently blank the user's
    // confirmation message.
    if (pending || inFlightRef.current) return
    setError(null)
    setSuccess(null)

    if (duplicates.size > 0) {
      setError('Two players have the same jersey number — fix before saving.')
      return
    }

    const entries: { jerseyNumber: number; profileId: string }[] = []
    for (const p of roster) {
      const v = values[p.profileId]
      if (!v) continue // unassigned players are skipped; trial players go unmapped
      const num = parseInt(v, 10)
      if (Number.isNaN(num) || num < 0 || num > 99) {
        setError(`${p.fullName ?? p.username}: jersey number must be 0-99.`)
        return
      }
      entries.push({ jerseyNumber: num, profileId: p.profileId })
    }

    inFlightRef.current = true
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/recordings/${recordingId}/jersey-map`,
          {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries, lock }),
          }
        )
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}))
          throw new Error(payload.error ?? `Request failed: ${res.status}`)
        }
        const result = await res.json()
        setSuccess(
          lock
            ? `Locked ${result.count} jersey assignments. Clip attribution running…`
            : `Saved ${result.count} jersey assignments.`
        )
        // Re-fetch the server page so `alreadyLocked` + the existing-entries
        // seed reflect the new state. Without this the lock banner doesn't
        // appear until manual reload.
        router.refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save')
      } finally {
        inFlightRef.current = false
      }
    })
  }

  // Form wrapper makes Enter on any input fire submit(false) — avoids the
  // destructive "Save & lock" path on accidental Enter. Buttons override
  // with explicit type="button" + onClick.
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit(false)
      }}
    >
    <Card>
      <CardHeader>
        <CardTitle>{recordingTitle}</CardTitle>
        <CardDescription>
          {homeTeam} vs {awayTeam} ·{' '}
          {new Date(matchDate).toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          })}
        </CardDescription>
        {alreadyLocked && (
          <div className="mt-3 flex items-start gap-2 text-xs rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300 px-3 py-2">
            <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              This map was already locked. Saving again rewrites the row in
              place — clip attributions for new entries will derive on the next
              lock transition.
            </span>
          </div>
        )}
      </CardHeader>

      <CardContent>
        <p className="text-xs text-muted-foreground mb-4">
          Map a jersey number to each player who took the field. Players left
          blank are not attributed. {roster.length} active player
          {roster.length === 1 ? '' : 's'} on the roster.
        </p>

        <div className="divide-y divide-border">
          {roster.map((p) => {
            const isDuplicate = duplicates.has(p.profileId)
            return (
              <div
                key={p.profileId}
                className="flex items-center justify-between gap-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">
                    {p.fullName ?? p.username ?? 'Unknown player'}
                  </div>
                  {p.username && (
                    <div className="text-xs text-muted-foreground">
                      @{p.username}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={values[p.profileId] ?? ''}
                    onChange={(e) => setNumber(p.profileId, e.target.value)}
                    placeholder="–"
                    aria-label={`Jersey number for ${p.fullName ?? p.username}`}
                    className={`w-16 text-center font-mono ${
                      isDuplicate
                        ? 'border-destructive focus-visible:ring-destructive'
                        : ''
                    }`}
                    maxLength={2}
                    disabled={pending}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>

      <CardFooter className="flex flex-col items-stretch gap-3">
        {error && (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="text-sm text-emerald-400">{success}</div>
        )}
        <div className="flex flex-col sm:flex-row gap-2 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => submit(false)}
            disabled={pending}
          >
            <Save className="mr-1.5 h-4 w-4" />
            {pending ? 'Saving…' : 'Save draft'}
          </Button>
          <Button
            type="button"
            onClick={() => submit(true)}
            disabled={pending}
          >
            <Lock className="mr-1.5 h-4 w-4" />
            {pending ? 'Saving…' : 'Save & lock'}
          </Button>
        </div>
      </CardFooter>
    </Card>
    </form>
  )
}
