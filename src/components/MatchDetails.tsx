'use client'

import { useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'

interface MatchDetailsProps {
  homeTeam: string
  awayTeam: string
  venue?: string | null
  pitchName?: string | null
  description?: string | null
}

export function MatchDetails({
  homeTeam,
  awayTeam,
  venue,
  pitchName,
  description,
}: MatchDetailsProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors pt-2"
      >
        {open ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
        Match Details
      </button>

      {open && (
        <>
          <div className="grid grid-cols-2 gap-3 md:gap-4">
            <div>
              <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                Home Team
              </p>
              <p className="font-medium text-[var(--timberwolf)]">
                {homeTeam}
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                Away Team
              </p>
              <p className="font-medium text-[var(--timberwolf)]">
                {awayTeam}
              </p>
            </div>
            {venue && (
              <div>
                <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                  Venue
                </p>
                <p className="font-medium text-[var(--timberwolf)]">
                  {venue}
                </p>
              </div>
            )}
            {pitchName && (
              <div>
                <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                  Pitch
                </p>
                <p className="font-medium text-[var(--timberwolf)]">
                  {pitchName}
                </p>
              </div>
            )}
          </div>

          {description && (
            <div className="pt-4 border-t border-[var(--ash-grey)]/10">
              <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                Description
              </p>
              <p className="text-[var(--timberwolf)]">{description}</p>
            </div>
          )}
        </>
      )}
    </>
  )
}
