'use client'

import { useState } from 'react'
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
      <DialogContent className="bg-[#0f1610] border-[var(--ash-grey)]/20 text-[var(--timberwolf)] max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[var(--timberwolf)]">
            Share Recording
          </DialogTitle>
          <DialogDescription className="text-[var(--ash-grey)]">
            {recordingTitle}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label className="text-sm text-[var(--ash-grey)]">
              Email addresses
            </label>
            <input
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
              className="w-full px-3 py-2 rounded-lg border border-[var(--ash-grey)]/20 bg-white/5 text-sm text-[var(--timberwolf)] placeholder:text-[var(--ash-grey)]/40 outline-none focus:border-[var(--ash-grey)]/40"
            />
            <p className="text-xs text-[var(--ash-grey)]/60">
              Separate multiple emails with commas
            </p>
          </div>

          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}

          {success && (
            <p className="text-sm text-emerald-400">{success}</p>
          )}

          <button
            onClick={handleShare}
            disabled={loading || !emailInput.trim()}
            className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {loading ? 'Sharing...' : 'Share'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
