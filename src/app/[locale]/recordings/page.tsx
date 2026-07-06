'use client'

import { useEffect, useMemo, useState } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { Link, useRouter } from '@/i18n/navigation'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  DatePicker,
  Button,
  Skeleton,
  EmptyState,
} from '@braintwopoint0/playback-commons/ui'
import { FadeIn } from '@/components/FadeIn'
import { ShareRecordingModal } from '@/components/ShareRecordingModal'
import { PendingInvitations } from '@/components/PendingInvitations'
import { Play, Share2, Download, Film, Lock } from 'lucide-react'

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
  const t = useTranslations('library')
  const tc = useTranslations('common')
  const format = useFormatter()
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
    <div className="mx-auto max-w-screen-xl px-4 py-12 sm:px-6 lg:px-8">
      {/* Pending invitations — only renders when the current user has
          unwatched grants. Closes the silent-auto-claim concern: every
          grant they hold (or that's been queued for them by email) is
          surfaced here with a Watch / Decline action. */}
      <PendingInvitations />

      {/* Header */}
      <FadeIn className="mb-10">
        <p className="text-muted-foreground text-xs font-semibold tracking-[0.25em] uppercase mb-3">
          {t('eyebrow')}
        </p>
        <h1 className="text-3xl md:text-4xl font-bold text-[var(--timberwolf)] mb-2">
          {t('title')}
        </h1>
        <p className="text-muted-foreground mb-6">{t('subtitle')}</p>

        {/* Filters row */}
        <div className="flex flex-wrap items-center justify-center md:justify-between gap-3">
          {/* Left: date pickers */}
          {!loading && !loginRequired && recordings.length > 0 ? (
            <div className="flex items-center gap-3">
              <DatePicker
                value={dateFrom}
                onChange={(v) => {
                  setDateFrom(v)
                  setShowAll(false)
                }}
                max={dateTo || undefined}
                placeholder={t('fromDate')}
                className="h-10 min-w-[130px]"
              />
              <DatePicker
                value={dateTo}
                onChange={(v) => {
                  setDateTo(v)
                  setShowAll(false)
                }}
                min={dateFrom || undefined}
                placeholder={t('toDate')}
                className="h-10 min-w-[130px]"
              />
              {hasActiveFilters && (
                <button
                  onClick={clearFilters}
                  className="h-9 px-3 text-sm text-muted-foreground hover:text-[var(--timberwolf)] transition-colors"
                >
                  {t('clear')}
                </button>
              )}
            </div>
          ) : (
            <div />
          )}

          {/* Right: count + sort */}
          <div className="flex items-center gap-3">
            <div className="h-10 px-3 flex items-center rounded-md bg-zinc-800 shadow-[0px_0px_1px_1px_var(--neutral-700)]">
              <span className="text-sm font-bold text-[var(--timberwolf)]">
                {loading
                  ? '...'
                  : hasActiveFilters
                    ? t('countFiltered', {
                        filtered: filteredRecordings.length,
                        total: recordings.length,
                      })
                    : recordings.length}
              </span>
              <span className="text-muted-foreground ms-1.5 text-sm">
                {t('recordingsWord', { count: recordings.length })}
              </span>
            </div>

            {!loading && !loginRequired && recordings.length > 0 && (
              <Select value={sortBy} onValueChange={setSortBy}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="date_desc">{t('sortNewest')}</SelectItem>
                  <SelectItem value="date_asc">{t('sortOldest')}</SelectItem>
                  <SelectItem value="title_asc">{t('sortTitleAZ')}</SelectItem>
                  <SelectItem value="title_desc">{t('sortTitleZA')}</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
        </div>
      </FadeIn>

      {/* Recordings List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-border bg-card p-4 md:p-5"
            >
              <div className="flex items-center gap-4">
                <Skeleton className="w-12 h-12 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-5 w-3/5" />
                  <Skeleton className="h-3 w-2/5" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : loginRequired ? (
        <EmptyState
          icon={<Lock className="h-10 w-10" />}
          title={t('loginRequiredTitle')}
          description={t('loginRequiredDescription')}
          action={
            <Button asChild variant="outline">
              <Link href="/auth/login">{t('logIn')}</Link>
            </Button>
          }
        />
      ) : recordings.length > 0 ? (
        <div className="space-y-3">
          {(showAll
            ? filteredRecordings
            : filteredRecordings.slice(0, PREVIEW_COUNT)
          ).map((recording) => (
            <div
              key={recording.id}
              onClick={() =>
                router.push(`/watch/${recording.id}?from=recordings`)
              }
              className="rounded-xl border border-border bg-card hover:border-[var(--timberwolf)]/20 overflow-hidden transition-colors cursor-pointer"
            >
              <div className="p-4 md:p-5 space-y-3 md:space-y-0 md:flex md:items-center md:gap-5">
                {/* Play icon + Info */}
                <div className="flex items-center gap-3 md:gap-5 flex-1 min-w-0">
                  <div className="flex-shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-full bg-muted text-[var(--timberwolf)] flex items-center justify-center">
                    <Play className="h-5 w-5 md:h-6 md:w-6 ml-0.5" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <h3 className="text-base md:text-lg font-semibold text-[var(--timberwolf)] truncate">
                      {recording.title}
                    </h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {format.dateTime(new Date(recording.match_date), 'full')}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div
                  className="flex items-center gap-2 md:flex-shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShareRecording(recording)}
                    className="flex-1 md:flex-none"
                  >
                    <Share2 className="h-4 w-4 me-1.5" />
                    {tc('share')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDownload(recording)}
                    className="flex-1 md:flex-none"
                  >
                    <Download className="h-4 w-4 me-1.5" />
                    {t('download')}
                  </Button>
                </div>
              </div>
            </div>
          ))}
          {filteredRecordings.length > PREVIEW_COUNT && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="w-full py-3 text-sm text-[var(--timberwolf)] hover:bg-muted/50 border border-border rounded-xl transition-colors"
            >
              {showAll
                ? t('showLess')
                : t('showAll', { count: filteredRecordings.length })}
            </button>
          )}
        </div>
      ) : (
        <EmptyState
          icon={<Film className="h-10 w-10" />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      )}
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
