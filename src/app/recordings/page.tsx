'use client'

import { motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatDateTime } from '@braintwopoint0/playback-commons/utils'
import { createClient } from '@braintwopoint0/playback-commons/supabase'
import { FadeIn } from '@/components/FadeIn'
import { VideoPlayer } from '@/components/video/VideoPlayer'
import { Lock, Globe, Pencil, Trash2, Plus } from 'lucide-react'
import {
  Button,
  Badge,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@braintwopoint0/playback-commons/ui'
import type {
  RecordingEvent,
  EventType,
  EventVisibility,
  EventTeam,
} from '@/lib/recordings/event-types'
import {
  EVENT_TYPES,
  EVENT_TYPE_LABELS,
  EVENT_TYPE_COLORS,
  formatTimestamp,
} from '@/lib/recordings/event-types'

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

// ─── Tag Form ────────────────────────────────────────────────────

interface TagFormData {
  event_type: EventType
  timestamp_seconds: number
  team: EventTeam | null
  label: string
  visibility: EventVisibility
}

function TagForm({
  initial,
  homeTeam,
  awayTeam,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial: TagFormData
  homeTeam: string
  awayTeam: string
  onSubmit: (data: TagFormData) => void
  onCancel: () => void
  submitLabel: string
}) {
  const [form, setForm] = useState<TagFormData>(initial)

  return (
    <div className="space-y-3 p-4 rounded-lg border border-[var(--ash-grey)]/10 bg-white/[0.03]">
      {/* Event type */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)]">
          Event Type
        </Label>
        <Select
          value={form.event_type}
          onValueChange={(val) =>
            setForm({ ...form, event_type: val as EventType })
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVENT_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {EVENT_TYPE_LABELS[type]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Timestamp */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)]">
          Timestamp
        </Label>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min="0"
            step="0.1"
            value={form.timestamp_seconds}
            onChange={(e) =>
              setForm({
                ...form,
                timestamp_seconds: Math.max(0, parseFloat(e.target.value) || 0),
              })
            }
            className="w-24"
          />
          <span className="text-xs text-[var(--ash-grey)]">
            {formatTimestamp(form.timestamp_seconds)}
          </span>
        </div>
      </div>

      {/* Team */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)]">
          Team (optional)
        </Label>
        <div className="flex gap-2">
          {[
            { value: null, label: 'None' },
            { value: 'home' as const, label: homeTeam },
            { value: 'away' as const, label: awayTeam },
          ].map((opt) => (
            <Button
              key={opt.label}
              type="button"
              size="sm"
              variant={form.team === opt.value ? 'default' : 'outline'}
              onClick={() => setForm({ ...form, team: opt.value })}
              className={
                form.team === opt.value
                  ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 hover:bg-emerald-500/30 text-xs'
                  : 'border-[var(--ash-grey)]/20 text-[var(--ash-grey)] hover:border-[var(--ash-grey)]/40 text-xs'
              }
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Label */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)]">
          Label (optional)
        </Label>
        <Input
          type="text"
          value={form.label}
          onChange={(e) => setForm({ ...form, label: e.target.value })}
          placeholder="e.g. Player name, notes..."
        />
      </div>

      {/* Visibility */}
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)]">
          Visibility
        </Label>
        <div className="flex gap-2">
          {[
            { value: 'public' as const, label: 'Public', icon: Globe },
            { value: 'private' as const, label: 'Private', icon: Lock },
          ].map((opt) => (
            <Button
              key={opt.value}
              type="button"
              size="sm"
              variant={form.visibility === opt.value ? 'default' : 'outline'}
              onClick={() => setForm({ ...form, visibility: opt.value })}
              className={
                form.visibility === opt.value
                  ? 'bg-emerald-500/20 border-emerald-500 text-emerald-400 hover:bg-emerald-500/30 text-xs gap-1.5'
                  : 'border-[var(--ash-grey)]/20 text-[var(--ash-grey)] hover:border-[var(--ash-grey)]/40 text-xs gap-1.5'
              }
            >
              <opt.icon className="w-3 h-3" />
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Button
          onClick={() => onSubmit(form)}
          size="sm"
          className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs"
        >
          {submitLabel}
        </Button>
        <Button
          onClick={onCancel}
          size="sm"
          variant="ghost"
          className="text-[var(--ash-grey)] hover:bg-white/10 text-xs"
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}

export default function RecordingsPage() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading] = useState(true)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)
  const [loadingPlayback, setLoadingPlayback] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [loginRequired, setLoginRequired] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // Event tagging state
  const [events, setEvents] = useState<RecordingEvent[]>([])
  const [userId, setUserId] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [addFormTimestamp, setAddFormTimestamp] = useState(0)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)
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
          // Filter to only show recordings with S3 keys
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
    fetchCurrentUser()
  }, [])

  async function fetchCurrentUser() {
    try {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      setUserId(user?.id || null)
    } catch {
      // Not logged in
    }
  }

  async function fetchEvents(recordingId: string) {
    try {
      const res = await fetch(`/api/recordings/${recordingId}/events`)
      if (res.ok) {
        const data = await res.json()
        setEvents(data.events || [])
      }
    } catch {
      setEvents([])
    }
  }

  const handleAddTag = useCallback((timestampSeconds: number) => {
    setAddFormTimestamp(Math.round(timestampSeconds * 100) / 100)
    setShowAddForm(true)
    setEditingEventId(null)
  }, [])

  async function handleCreateEvent(recordingId: string, data: TagFormData) {
    try {
      const res = await fetch(`/api/recordings/${recordingId}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_type: data.event_type,
          timestamp_seconds: data.timestamp_seconds,
          team: data.team,
          label: data.label || null,
          visibility: data.visibility,
        }),
      })
      if (res.ok) {
        const result = await res.json()
        setEvents((prev) =>
          [...prev, result.event].sort(
            (a, b) => a.timestamp_seconds - b.timestamp_seconds
          )
        )
        setShowAddForm(false)
      }
    } catch {}
  }

  async function handleUpdateEvent(
    recordingId: string,
    eventId: string,
    data: TagFormData
  ) {
    try {
      const res = await fetch(
        `/api/recordings/${recordingId}/events/${eventId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_type: data.event_type,
            timestamp_seconds: data.timestamp_seconds,
            team: data.team,
            label: data.label || null,
            visibility: data.visibility,
          }),
        }
      )
      if (res.ok) {
        const result = await res.json()
        setEvents((prev) =>
          prev
            .map((e) => (e.id === eventId ? result.event : e))
            .sort((a, b) => a.timestamp_seconds - b.timestamp_seconds)
        )
        setEditingEventId(null)
      }
    } catch {}
  }

  async function handleDeleteEvent(recordingId: string, eventId: string) {
    try {
      const res = await fetch(
        `/api/recordings/${recordingId}/events/${eventId}`,
        {
          method: 'DELETE',
        }
      )
      if (res.ok) {
        setEvents((prev) => prev.filter((e) => e.id !== eventId))
      }
    } catch {}
  }

  const handlePlay = async (recording: Recording) => {
    if (playingId === recording.id) {
      // Already playing, close it
      setPlayingId(null)
      setPlaybackUrl(null)
      setEvents([])
      setShowAddForm(false)
      setEditingEventId(null)
      return
    }

    setLoadingPlayback(true)
    setEvents([])
    setShowAddForm(false)
    setEditingEventId(null)
    try {
      const res = await fetch(
        `/api/recordings?id=${recording.id}&action=playback`
      )
      const data = await res.json()
      if (data.playbackUrl) {
        setPlayingId(recording.id)
        setPlaybackUrl(data.playbackUrl)
        fetchEvents(recording.id)
      }
    } catch (error) {
      console.error('Error getting playback URL:', error)
    }
    setLoadingPlayback(false)
  }

  const handleDownload = async (recording: Recording) => {
    try {
      const res = await fetch(
        `/api/recordings?id=${recording.id}&action=download`
      )
      const data = await res.json()
      if (data.downloadUrl) {
        window.open(data.downloadUrl, '_blank')
      }
    } catch (error) {
      console.error('Error getting download URL:', error)
    }
  }

  const handleShare = async (recording: Recording) => {
    const shareUrl = `${window.location.origin}/api/recordings/share/${recording.id}`
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopiedId(recording.id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch (error) {
      console.error('Error copying to clipboard:', error)
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
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => {
                      setDateFrom(e.target.value)
                      setShowAll(false)
                    }}
                    className="h-9 min-w-[130px] px-3 rounded-md border border-[var(--ash-grey)]/20 bg-white/5 text-sm text-[var(--timberwolf)] outline-none [&::-webkit-calendar-picker-indicator]:invert"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-sm text-[var(--ash-grey)]">To</label>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => {
                      setDateTo(e.target.value)
                      setShowAll(false)
                    }}
                    className="h-9 min-w-[130px] px-3 rounded-md border border-[var(--ash-grey)]/20 bg-white/5 text-sm text-[var(--timberwolf)] outline-none [&::-webkit-calendar-picker-indicator]:invert"
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
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="px-3 pr-8 rounded-xl border border-[var(--ash-grey)]/20 bg-black/30 text-sm text-[var(--timberwolf)] appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%23888%22%20d%3D%22M6%208L1%203h10z%22%2F%3E%3C%2Fsvg%3E')] bg-[length:12px] bg-[right_8px_center] bg-no-repeat outline-none"
                >
                  <option value="date_desc">Newest first</option>
                  <option value="date_asc">Oldest first</option>
                  <option value="title_asc">Title A-Z</option>
                  <option value="title_desc">Title Z-A</option>
                </select>
              )}
            </div>
          </div>
        </FadeIn>

        {/* Video Player Modal */}
        {playingId &&
          playbackUrl &&
          (() => {
            const playingRecording = recordings.find((r) => r.id === playingId)
            const canEdit = !!userId
            return (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                className="mb-8 bg-black/50 border border-[var(--ash-grey)]/20 rounded-2xl overflow-hidden"
              >
                <div className="p-4 border-b border-[var(--ash-grey)]/20 flex items-center justify-between">
                  <h2 className="text-sm md:text-lg font-semibold text-[var(--timberwolf)] truncate mr-2">
                    Now Playing: {playingRecording?.title}
                  </h2>
                  <button
                    onClick={() => {
                      setPlayingId(null)
                      setPlaybackUrl(null)
                      setEvents([])
                      setShowAddForm(false)
                      setEditingEventId(null)
                    }}
                    className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                  >
                    <svg
                      className="w-5 h-5 text-[var(--ash-grey)]"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M6 18L18 6M6 6l12 12"
                      />
                    </svg>
                  </button>
                </div>
                <div className="aspect-video bg-black">
                  <VideoPlayer
                    src={playbackUrl}
                    events={events}
                    canEdit={canEdit}
                    onAddTag={handleAddTag}
                    className="w-full h-full"
                  />
                </div>

                {/* Event Tags Panel */}
                <div className="p-4 border-t border-[var(--ash-grey)]/20">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-[var(--timberwolf)]">
                      Event Tags
                    </h3>
                    {canEdit && !showAddForm && (
                      <Button
                        onClick={() => handleAddTag(0)}
                        size="sm"
                        variant="ghost"
                        className="text-emerald-400 hover:bg-emerald-500/10 text-xs gap-1 h-7"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add Tag
                      </Button>
                    )}
                  </div>

                  {showAddForm && playingRecording && (
                    <div className="mb-3">
                      <TagForm
                        initial={{
                          event_type: 'goal',
                          timestamp_seconds: addFormTimestamp,
                          team: null,
                          label: '',
                          visibility: 'public',
                        }}
                        homeTeam={playingRecording.home_team}
                        awayTeam={playingRecording.away_team}
                        onSubmit={(data) => handleCreateEvent(playingId, data)}
                        onCancel={() => setShowAddForm(false)}
                        submitLabel="Add Tag"
                      />
                    </div>
                  )}

                  {events.length === 0 && !showAddForm ? (
                    <p className="text-xs text-[var(--ash-grey)]">
                      No events tagged yet.
                      {canEdit
                        ? ' Click "Add Tag" or use the Tag button in the player.'
                        : ''}
                    </p>
                  ) : (
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {events.map((event) => {
                        const isOwn = event.created_by === userId
                        const isEditing = editingEventId === event.id

                        if (isEditing && playingRecording) {
                          return (
                            <TagForm
                              key={event.id}
                              initial={{
                                event_type: event.event_type,
                                timestamp_seconds: event.timestamp_seconds,
                                team: event.team,
                                label: event.label || '',
                                visibility: event.visibility,
                              }}
                              homeTeam={playingRecording.home_team}
                              awayTeam={playingRecording.away_team}
                              onSubmit={(data) =>
                                handleUpdateEvent(playingId, event.id, data)
                              }
                              onCancel={() => setEditingEventId(null)}
                              submitLabel="Save"
                            />
                          )
                        }

                        return (
                          <div
                            key={event.id}
                            className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-white/[0.03] transition-colors group"
                          >
                            <div
                              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              style={{
                                backgroundColor:
                                  EVENT_TYPE_COLORS[event.event_type],
                              }}
                            />
                            <button
                              onClick={() => {
                                const video = document.querySelector('video')
                                if (video)
                                  video.currentTime = event.timestamp_seconds
                              }}
                              className="text-xs font-mono text-emerald-400 hover:text-emerald-300 w-12 text-left flex-shrink-0"
                            >
                              {formatTimestamp(event.timestamp_seconds)}
                            </button>
                            <Badge
                              variant="outline"
                              className="text-xs flex-shrink-0"
                              style={{
                                backgroundColor:
                                  EVENT_TYPE_COLORS[event.event_type] + '20',
                                color: EVENT_TYPE_COLORS[event.event_type],
                                borderColor:
                                  EVENT_TYPE_COLORS[event.event_type] + '40',
                              }}
                            >
                              {EVENT_TYPE_LABELS[event.event_type]}
                            </Badge>
                            {event.team && playingRecording && (
                              <span className="text-xs text-[var(--ash-grey)]">
                                {event.team === 'home'
                                  ? playingRecording.home_team
                                  : playingRecording.away_team}
                              </span>
                            )}
                            {event.label && (
                              <span className="text-xs text-[var(--timberwolf)] truncate">
                                {event.label}
                              </span>
                            )}
                            {event.visibility === 'private' && (
                              <Lock className="w-3 h-3 text-[var(--ash-grey)] flex-shrink-0 ml-auto" />
                            )}
                            {isOwn && (
                              <div className="flex gap-1 ml-auto opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => setEditingEventId(event.id)}
                                  className="h-6 w-6 text-[var(--ash-grey)] hover:text-[var(--timberwolf)] hover:bg-white/10"
                                >
                                  <Pencil className="w-3 h-3" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() =>
                                    handleDeleteEvent(playingId, event.id)
                                  }
                                  className="h-6 w-6 text-[var(--ash-grey)] hover:text-red-400 hover:bg-red-500/10"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </motion.div>
            )
          })()}

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
                className={`bg-black/30 border rounded-xl overflow-hidden transition-colors ${
                  playingId === recording.id
                    ? 'border-[var(--accent-purple)] shadow-lg shadow-purple-500/20'
                    : 'border-[var(--ash-grey)]/10 hover:border-[var(--ash-grey)]/30'
                }`}
              >
                <div className="p-4 md:p-5 space-y-3 md:space-y-0 md:flex md:items-center md:gap-5">
                  {/* Play button + Info */}
                  <div className="flex items-center gap-3 md:gap-5 flex-1 min-w-0">
                    {/* Play Button */}
                    <button
                      onClick={() => handlePlay(recording)}
                      disabled={loadingPlayback}
                      className={`flex-shrink-0 w-12 h-12 md:w-14 md:h-14 rounded-full flex items-center justify-center transition-all ${
                        playingId === recording.id
                          ? 'bg-[var(--accent-purple)] text-white'
                          : 'bg-white/10 text-[var(--timberwolf)] hover:bg-white/20'
                      }`}
                    >
                      {loadingPlayback && playingId !== recording.id ? (
                        <svg
                          className="w-5 h-5 md:w-6 md:h-6 animate-spin"
                          fill="none"
                          viewBox="0 0 24 24"
                        >
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          />
                        </svg>
                      ) : playingId === recording.id ? (
                        <svg
                          className="w-5 h-5 md:w-6 md:h-6"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                        </svg>
                      ) : (
                        <svg
                          className="w-5 h-5 md:w-6 md:h-6 ml-0.5"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      )}
                    </button>

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
                  <div className="flex items-center gap-2 md:flex-shrink-0">
                    <button
                      onClick={() => handleShare(recording)}
                      className={`flex-1 md:flex-none px-4 py-2 border rounded-lg text-sm transition-colors flex items-center justify-center gap-2 ${
                        copiedId === recording.id
                          ? 'bg-green-500/20 border-green-500/50 text-green-400'
                          : 'bg-white/5 hover:bg-white/10 border-[var(--ash-grey)]/20 text-[var(--timberwolf)]'
                      }`}
                    >
                      {copiedId === recording.id ? (
                        <>
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
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                          Copied!
                        </>
                      ) : (
                        <>
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
                        </>
                      )}
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
    </div>
  )
}
