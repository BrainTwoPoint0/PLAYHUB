'use client'

import { useState } from 'react'
import { Loader2, Mail, Send } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@braintwopoint0/playback-commons/ui'

interface ShareRecordingModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  recordingId: string
  recordingTitle: string
}

export function ShareRecordingModal({
  open,
  onOpenChange,
  recordingId,
  recordingTitle,
}: ShareRecordingModalProps) {
  const [emailInput, setEmailInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleShare = async () => {
    setError(null)
    setSuccess(null)

    const emails = emailInput
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)

    if (emails.length === 0) {
      setError('Please enter at least one email address')
      return
    }

    setLoading(true)
    try {
      const res = await fetch(`/api/recordings/${recordingId}/access`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
      })

      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to share recording')
        return
      }

      setSuccess(
        emails.length === 1
          ? `Shared with ${emails[0]}`
          : `Shared with ${emails.length} people`
      )
      setEmailInput('')
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setEmailInput('')
      setSuccess(null)
      setError(null)
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="overflow-hidden max-w-[460px] p-0
                   rounded-2xl border border-white/[0.08]
                   bg-[rgba(15,21,18,0.95)]
                   shadow-[0_24px_60px_-12px_rgba(0,0,0,0.7),inset_0_0_0_1px_rgba(255,255,255,0.04)]
                   backdrop-blur-2xl backdrop-saturate-150"
      >
        {/* Wrapper exists ONLY to anchor the absolute-positioned hairline +
            glow without stealing position context from DialogContent (Radix
            uses fixed + translate to centre the modal — overriding that
            with `relative` would render the modal offscreen). */}
        <div className="relative">
          {/* Hairline top highlight — premium card signature, matches tag overlay */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/15 to-transparent" />
          {/* Soft accent glow */}
          <div className="pointer-events-none absolute -top-24 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-emerald-400/[0.07] blur-3xl" />

          <div className="relative p-5 sm:p-6">
            <DialogHeader className="space-y-2 mb-5">
              <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                Share recording
              </p>
              <DialogTitle className="text-lg leading-tight text-[var(--timberwolf)]">
                {recordingTitle}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Each recipient gets the recording on their own account — no
                payment needed. They&apos;ll sign up with the same email to
                claim access. Great for sharing with the whole team.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <label
                htmlFor="share-emails"
                className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground"
              >
                <Mail className="h-3 w-3" />
                Email addresses
              </label>
              <input
                id="share-emails"
                type="text"
                value={emailInput}
                onChange={(e) => {
                  setEmailInput(e.target.value)
                  setError(null)
                  setSuccess(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleShare()
                  }
                }}
                placeholder="email@example.com, another@example.com"
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-white/[0.08] bg-white/[0.02]
                         px-3 py-2.5 text-sm text-[var(--timberwolf)]
                         placeholder:text-muted-foreground/50 outline-none
                         transition-colors hover:border-white/[0.14]
                         focus:border-emerald-400/40 focus:bg-white/[0.04]
                         focus:ring-2 focus:ring-emerald-400/15"
              />
              <p className="text-[11px] text-muted-foreground/70">
                Separate multiple emails with commas. Up to 50 at once.
              </p>
            </div>

            {/* Error — matches the tag overlay's inline error block */}
            {error && (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-400/20 bg-red-400/[0.06] px-3 py-2 text-xs text-red-300">
                <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                {error}
              </div>
            )}

            {/* Success — green pill matching the tag-saved flash */}
            {success && (
              <div className="mt-4 flex items-center gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-xs text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.6)]" />
                {success}
              </div>
            )}

            <button
              onClick={handleShare}
              disabled={loading || !emailInput.trim()}
              className="mt-5 inline-flex w-full items-center justify-center gap-2
                       rounded-lg bg-[var(--timberwolf)] py-2.5
                       text-sm font-medium text-[var(--night)]
                       transition-colors hover:bg-[var(--ash-grey)]
                       disabled:cursor-not-allowed disabled:opacity-40
                       focus-visible:outline-none focus-visible:ring-2
                       focus-visible:ring-emerald-400/40"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sharing…
                </>
              ) : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  Send invitations
                </>
              )}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
