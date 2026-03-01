'use client'

import { motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { formatDateTime } from '@braintwopoint0/playback-commons/utils'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, DatePicker } from '@braintwopoint0/playback-commons/ui'
import { FadeIn } from '@/components/FadeIn'
import { ShareRecordingModal } from '@/components/ShareRecordingModal'

interface Recording {
  id: string
  title: string
  description?: string
  home_team: string
  away_team: string
  match_date: string
  venue?: string
  pitch_name?: string
  s3_key: string
  file_size_bytes?: number
  spiideo_game_id?: string
}

export default function RecordingsPage() {
  const router = useRouter()
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading] = useState(true)
  const [loginRequired, setLoginRequired] = useState(false)
  const [shareRecording, setShareRecording] = useState<Recording | null>(null)
  const [showAll, setShowAll] = useState(false)

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [sortBy, setSortBy] = useState('date_desc')
  const PREVIEW_COUNT = 15

  const hasActiveFilters = dateFrom || dateTo

  const filteredRecordings = useMemo(() => {
    let result = [...recordings]

    if (dateFrom) {
      result = result.filter((r) => r.match_date >= dateFrom)
    }
    if (dateTo) {
      const toEnd = dateTo + 'T23:59:59'
      result = result.filter((r) => r.match_date <= toEnd)
    }

    switch (sortBy) {
      case 'date_asc':
        result.sort((a, b) => a.match_date.localeCompare(b.match_date))
        break
      case 'date_desc':
        result.sort((a, b) => b.match_date.localeCompare(a.match_date))
        break
      case 'title_asc':
        result.sort((a, b) => a.title.localeCompare(b.title))
        break
      case 'title_desc':
        result.sort((a, b) => b.title.localeCompare(a.title))
        break
    }

    return result
  }, [recordings, dateFrom, dateTo, sortBy])

  const clearFilters = () => {
    setDateFrom('')
    setDateTo('')
    setSortBy('date_desc')
    setShowAll(false)
  }

  useEffect(() => {
    async function fetchRecordings() {
      try {
        const res = await fetch('/api/recordings')
        const data = await res.json()

        if (data.message === 'Login required to view recordings') {
          setLoginRequired(true)
          setRecordings([])
        } else {
          const withS3 =
            data.recordings?.filter((r: Recording) => r.s3_key) || []
          setRecordings(withS3)
        }
      } catch (error) {
        console.error('Error fetching recordings:', error)
      }
      setLoading(false)
    }

    fetchRecordings()
  }, [])

  const handleDownload = async (recording: Recording) => {
    try {
      const res = await fetch(
        `/api/recordings?id=${recording.id}&action=download`
      )
      const data = await res.json()
      if (data.downloadUrl) {
        const a = document.createElement('a')
        a.href = data.downloadUrl
        a.download = `${recording.title}.mp4`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      }
    } catch (error) {
      console.error('Error getting download URL:', error)
    }
  }

  return (
    <div className="min-h-screen bg-[var(--night)]">
      <div className="container mx-auto px-5 py-16">
        {/* Header */}
        <FadeIn className="mb-12">
          <p className="text-[var(--ash-grey)] text-xs font-semibold tracking-[0.25em] uppercase mb-3">
            Your Library
          </p>
          <h1 className="text-3xl md:text-5xl lg:text-6xl font-bold text-[var(--timberwolf)] mb-4">
            My Recordings
          </h1>
          <p className="text-base md:text-xl text-[var(--ash-grey)] mb-6">
            Match recordings you have access to
          </p>

          {/* Filters row */}
          <div className="flex flex-wrap items-stretch justify-center md:justify-between gap-x-3 gap-y-4">
            {/* Left: date pickers */}
            {!loading && !loginRequired && recordings.length > 0 ? (
              <div className="flex items-end gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-[var(--ash-grey)]">From</label>
                  <DatePicker
                    value={dateFrom}
                    onChange={(v) => {
                      setDateFrom(v)
                      setShowAll(false)
                    }}
                    max={dateTo || undefined}
                    placeholder="From date"
                    className="h-9 min-w-[130px]"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-[var(--ash-grey)]">To</label>
                  <DatePicker
                    value={dateTo}
                    onChange={(v) => {
                      setDateTo(v)
                      setShowAll(false)
                    }}
                    min={dateFrom || undefined}
                    placeholder="To date"
                    className="h-9 min-w-[130px]"
                  />
                </div>

                {hasActiveFilters && (
                  <button
                    onClick={clearFilters}
                    className="h-9 px-3 text-sm text-[var(--ash-grey)] hover:text-[var(--timberwolf)] transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
            ) : (
              <div />
            )}

            {/* Right: count + sort */}
            <div className="flex items-stretch gap-3">
              <div className="px-4 py-3 flex items-center bg-black/30 border border-[var(--ash-grey)]/20 rounded-xl">
                <span className="text-xl font-bold text-[var(--timberwolf)]">
                  {loading
                    ? '...'
                    : hasActiveFilters
                      ? `${filteredRecordings.length} of ${recordings.length}`
                      : recordings.length}
                </span>
                <span className="text-[var(--ash-grey)]/60 ml-2 text-sm">
                  {recordings.length === 1 ? 'recording' : 'recordings'}
                </span>
              </div>

              {!loading && !loginRequired && recordings.length > 0 && (
                <Select value={sortBy} onValueChange={setSortBy}>
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="date_desc">Newest first</SelectItem>
                    <SelectItem value="date_asc">Oldest first</SelectItem>
                    <SelectItem value="title_asc">Title A-Z</SelectItem>
                    <SelectItem value="title_desc">Title Z-A</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        </FadeIn>

        {/* Recordings List */}
        {loading ? (
          <div className="space-y-4 animate-pulse">
            {[1, 2, 3, 4, 5].map((i) => (
              <div
                key={i}
                className="bg-black/30 border border-[var(--ash-grey)]/10 rounded-xl p-4 md:p-5 space-y-3"
              >
                <div className="flex items-center gap-3 md:gap-5">
                  <div className="flex-shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-full bg-[var(--ash-grey)]/10" />
                  <div className="flex-1 min-w-0 space-y-2">
                    <div className="h-5 bg-[var(--ash-grey)]/10 rounded w-3/5" />
                    <div className="h-3 bg-[var(--ash-grey)]/10 rounded w-2/5" />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1 md:flex-none h-9 w-24 bg-[var(--ash-grey)]/10 rounded-lg" />
                  <div className="flex-1 md:flex-none h-9 w-28 bg-[var(--ash-grey)]/10 rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        ) : loginRequired ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="text-center py-24"
          >
            <div className="text-7xl mb-6 opacity-30">🔒</div>
            <p className="text-2xl md:text-3xl font-bold text-[var(--timberwolf)] mb-3">
              Login Required
            </p>
            <p className="text-base md:text-lg text-[var(--ash-grey)]/60 mb-6">
              Please log in to view your recordings
            </p>
            <a
              href="/auth/login"
              className="inline-block px-6 py-3 bg-white/10 hover:bg-white/20 border border-[var(--ash-grey)]/20 rounded-lg text-[var(--timberwolf)] transition-colors"
            >
              Log In
            </a>
          </motion.div>
        ) : recordings.length > 0 ? (
          <div className="space-y-4">
            {(showAll
              ? filteredRecordings
              : filteredRecordings.slice(0, PREVIEW_COUNT)
            ).map((recording) => (
              <div
                key={recording.id}
                onClick={() => router.push(`/recordings/${recording.id}`)}
                className="bg-black/30 border border-[var(--ash-grey)]/10 hover:border-[var(--ash-grey)]/30 rounded-xl overflow-hidden transition-colors cursor-pointer"
              >
                <div className="p-4 md:p-5 space-y-3 md:space-y-0 md:flex md:items-center md:gap-5">
                  {/* Play icon + Info */}
                  <div className="flex items-center gap-3 md:gap-5 flex-1 min-w-0">
                    <div className="flex-shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-full bg-white/10 text-[var(--timberwolf)] flex items-center justify-center">
                      <svg
                        className="w-5 h-5 md:w-6 md:h-6 ml-0.5"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <h3 className="text-base md:text-lg font-semibold text-[var(--timberwolf)] truncate">
                        {recording.title}
                      </h3>
                      <div className="mt-1 text-sm text-[var(--ash-grey)]/60">
                        <span>{formatDateTime(recording.match_date)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div
                    className="flex items-center gap-2 md:flex-shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => setShareRecording(recording)}
                      className="flex-1 md:flex-none px-4 py-2 border rounded-lg text-sm transition-colors flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 border-[var(--ash-grey)]/20 text-[var(--timberwolf)]"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
                        />
                      </svg>
                      Share
                    </button>
                    <button
                      onClick={() => handleDownload(recording)}
                      className="flex-1 md:flex-none px-4 py-2 bg-white/5 hover:bg-white/10 border border-[var(--ash-grey)]/20 rounded-lg text-sm text-[var(--timberwolf)] transition-colors flex items-center justify-center gap-2"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                        />
                      </svg>
                      Download
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {filteredRecordings.length > PREVIEW_COUNT && (
              <button
                onClick={() => setShowAll(!showAll)}
                className="w-full py-3 text-sm text-[var(--timberwolf)] hover:bg-white/5 border border-[var(--ash-grey)]/10 rounded-xl transition-colors"
              >
                {showAll
                  ? 'Show less'
                  : `Show all ${filteredRecordings.length} recordings`}
              </button>
            )}
          </div>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5 }}
            className="text-center py-24"
          >
            <div className="text-7xl mb-6 opacity-30">🎬</div>
            <p className="text-2xl md:text-3xl font-bold text-[var(--timberwolf)] mb-3">
              No recordings yet
            </p>
            <p className="text-base md:text-lg text-[var(--ash-grey)]/60">
              Recordings will appear here once transferred from Spiideo
            </p>
          </motion.div>
        )}
      </div>
      {shareRecording && (
        <ShareRecordingModal
          open={!!shareRecording}
          onOpenChange={(open) => {
            if (!open) setShareRecording(null)
          }}
          recordingId={shareRecording.id}
          recordingTitle={shareRecording.title}
        />
      )}
    </div>
  )
}
