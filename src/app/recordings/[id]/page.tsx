'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
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
import { createClient } from '@braintwopoint0/playback-commons/supabase'
import { FadeIn } from '@/components/FadeIn'
import { VideoPlayer } from '@/components/video/VideoPlayer'
import { ArrowLeft, Lock, Globe, Pencil, Trash2, Plus, Share2, Download } from 'lucide-react'
import { ShareRecordingModal } from '@/components/ShareRecordingModal'
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
  description: string | null
  matchDate: string
  homeTeam: string
  awayTeam: string
  venue: string | null
  pitchName: string | null
  status: string
  duration: number | null
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

// ─── Main Page ───────────────────────────────────────────────────

export default function RecordingPage() {
  const params = useParams()
  const router = useRouter()
  const recordingId = params.id as string

  const [recording, setRecording] = useState<Recording | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Events state
  const [events, setEvents] = useState<RecordingEvent[]>([])
  const [userId, setUserId] = useState<string | null>(null)

  // Share modal state
  const [showShareModal, setShowShareModal] = useState(false)

  // Tag form state
  const [showAddForm, setShowAddForm] = useState(false)
  const [addFormTimestamp, setAddFormTimestamp] = useState(0)
  const [editingEventId, setEditingEventId] = useState<string | null>(null)

  useEffect(() => {
    fetchRecording()
    fetchCurrentUser()
  }, [recordingId])

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

  async function fetchRecording() {
    try {
      setLoading(true)
      const res = await fetch(`/api/recordings/${recordingId}`)
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to load recording')
        return
      }

      setRecording(data.recording)
      setVideoUrl(data.videoUrl)

      // Fetch events after recording loads successfully
      fetchEvents()
    } catch (err) {
      setError('Failed to load recording')
    } finally {
      setLoading(false)
    }
  }

  async function fetchEvents() {
    try {
      const res = await fetch(`/api/recordings/${recordingId}/events`)
      if (res.ok) {
        const data = await res.json()
        setEvents(data.events || [])
      }
    } catch {
      // Events are non-critical, fail silently
    }
  }

  const handleAddTag = useCallback((timestampSeconds: number) => {
    setAddFormTimestamp(Math.round(timestampSeconds * 100) / 100)
    setShowAddForm(true)
    setEditingEventId(null)
  }, [])

  async function handleDownload() {
    try {
      const res = await fetch(
        `/api/recordings?id=${recordingId}&action=download`
      )
      const data = await res.json()
      if (data.downloadUrl) {
        const a = document.createElement('a')
        a.href = data.downloadUrl
        a.download = `${recording?.title || 'recording'}.mp4`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
      }
    } catch (error) {
      console.error('Error getting download URL:', error)
    }
  }

  async function handleCreateEvent(data: TagFormData) {
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
    } catch {
      // Fail silently, user can retry
    }
  }

  async function handleUpdateEvent(eventId: string, data: TagFormData) {
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
    } catch {
      // Fail silently
    }
  }

  async function handleDeleteEvent(eventId: string) {
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
    } catch {
      // Fail silently
    }
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-4 md:px-5 py-6 md:py-16 max-w-4xl animate-pulse">
          <div className="bg-[var(--ash-grey)]/10 rounded h-9 w-[170px] mb-4 md:mb-6" />
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-black/20">
            <div className="p-4 md:p-6 pb-2 md:pb-3 space-y-2">
              <div className="bg-[var(--ash-grey)]/10 rounded h-6 md:h-7 w-[200px] md:w-[260px]" />
              <div className="bg-[var(--ash-grey)]/10 rounded h-3 md:h-4 w-[160px] md:w-[200px]" />
            </div>
            <div className="px-4 md:px-6 pb-4 md:pb-6 space-y-4">
              <div className="aspect-video bg-black/30 md:rounded-lg -mx-4 md:mx-0" />
              <div className="grid grid-cols-2 gap-4 pt-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="space-y-2">
                    <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-[80px]" />
                    <div className="bg-[var(--ash-grey)]/10 rounded h-5 w-[120px]" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl">
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-6">
            <p className="text-red-400 mb-4">{error}</p>
            <Button
              variant="outline"
              onClick={() => router.push('/recordings')}
              className="border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Recordings
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (!recording) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl">
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-6">
            <p className="text-[var(--ash-grey)]">Recording not found</p>
            <Button
              variant="outline"
              onClick={() => router.push('/recordings')}
              className="mt-4 border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Recordings
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const canEdit = !!userId

  return (
    <div className="min-h-screen bg-[var(--night)]">
      <div className="container mx-auto px-4 md:px-5 py-6 md:py-16 max-w-4xl">
        <Button
          variant="ghost"
          onClick={() => router.push('/recordings')}
          className="mb-4 md:mb-6 text-[var(--timberwolf)] hover:bg-white/10"
        >
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to Recordings
        </Button>

        <FadeIn>
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-4 md:p-6 pb-2 md:pb-3">
              <h1 className="text-xl md:text-3xl font-bold text-[var(--timberwolf)]">
                {recording.title}
              </h1>
              <p className="text-xs md:text-sm text-[var(--ash-grey)] mt-1">
                {formatDate(recording.matchDate)}
              </p>
              <div className="flex gap-2 mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowShareModal(true)}
                  className="border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10 gap-1.5"
                >
                  <Share2 className="w-3.5 h-3.5" />
                  Share
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDownload}
                  className="border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10 gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </Button>
              </div>
            </div>
            <div className="px-4 md:px-6 pb-4 md:pb-6 space-y-4">
              {/* Video Player */}
              {videoUrl ? (
                <div className="-mx-4 md:mx-0">
                  <VideoPlayer
                    src={videoUrl}
                    events={events}
                    canEdit={canEdit}
                    onAddTag={handleAddTag}
                    className="w-full aspect-video md:rounded-lg"
                  />
                </div>
              ) : (
                <div className="aspect-video bg-black/30 md:rounded-lg flex items-center justify-center border-y md:border border-[var(--ash-grey)]/10 -mx-4 md:mx-0">
                  <p className="text-[var(--ash-grey)]">
                    {recording.status === 'scheduled'
                      ? 'Recording not yet available'
                      : recording.status === 'processing'
                        ? 'Recording is being processed...'
                        : 'Video not available'}
                  </p>
                </div>
              )}

              {/* Match Info */}
              <div className="grid grid-cols-2 gap-3 md:gap-4 pt-4">
                <div>
                  <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                    Home Team
                  </p>
                  <p className="font-medium text-[var(--timberwolf)]">
                    {recording.homeTeam}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                    Away Team
                  </p>
                  <p className="font-medium text-[var(--timberwolf)]">
                    {recording.awayTeam}
                  </p>
                </div>
                {recording.venue && (
                  <div>
                    <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                      Venue
                    </p>
                    <p className="font-medium text-[var(--timberwolf)]">
                      {recording.venue}
                    </p>
                  </div>
                )}
                {recording.pitchName && (
                  <div>
                    <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                      Pitch
                    </p>
                    <p className="font-medium text-[var(--timberwolf)]">
                      {recording.pitchName}
                    </p>
                  </div>
                )}
              </div>

              {recording.description && (
                <div className="pt-4 border-t border-[var(--ash-grey)]/10">
                  <p className="text-xs font-semibold tracking-[0.15em] uppercase text-[var(--ash-grey)] mb-1">
                    Description
                  </p>
                  <p className="text-[var(--timberwolf)]">
                    {recording.description}
                  </p>
                </div>
              )}
            </div>
          </div>
        </FadeIn>

        {/* Event Tags Section */}
        <FadeIn delay={100}>
          <div className="mt-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                  Event Tags
                </h2>
                {canEdit && !showAddForm && (
                  <Button
                    onClick={() => handleAddTag(0)}
                    size="sm"
                    variant="ghost"
                    className="text-emerald-400 hover:bg-emerald-500/10 text-xs gap-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Tag
                  </Button>
                )}
              </div>

              {/* Add form */}
              {showAddForm && (
                <div className="mb-4">
                  <TagForm
                    initial={{
                      event_type: 'goal',
                      timestamp_seconds: addFormTimestamp,
                      team: null,
                      label: '',
                      visibility: 'public',
                    }}
                    homeTeam={recording.homeTeam}
                    awayTeam={recording.awayTeam}
                    onSubmit={handleCreateEvent}
                    onCancel={() => setShowAddForm(false)}
                    submitLabel="Add Tag"
                  />
                </div>
              )}

              {/* Events list */}
              {events.length === 0 && !showAddForm ? (
                <p className="text-sm text-[var(--ash-grey)]">
                  No events tagged yet.
                  {canEdit ? ' Click "Add Tag" to get started.' : ''}
                </p>
              ) : (
                <div className="space-y-2">
                  {events.map((event) => {
                    const isOwn = event.created_by === userId
                    const isEditing = editingEventId === event.id

                    if (isEditing) {
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
                          homeTeam={recording.homeTeam}
                          awayTeam={recording.awayTeam}
                          onSubmit={(data) => handleUpdateEvent(event.id, data)}
                          onCancel={() => setEditingEventId(null)}
                          submitLabel="Save"
                        />
                      )
                    }

                    return (
                      <div
                        key={event.id}
                        className="flex items-center gap-3 p-3 rounded-lg hover:bg-white/[0.03] transition-colors group"
                      >
                        {/* Color dot */}
                        <div
                          className="w-3 h-3 rounded-full flex-shrink-0"
                          style={{
                            backgroundColor:
                              EVENT_TYPE_COLORS[event.event_type],
                          }}
                        />

                        {/* Timestamp — clickable (5s pre-roll) */}
                        <button
                          onClick={() => {
                            const video = document.querySelector('video')
                            if (video) {
                              video.currentTime = Math.max(0, event.timestamp_seconds - 5)
                            }
                          }}
                          className="text-xs font-mono text-emerald-400 hover:text-emerald-300 w-14 text-left flex-shrink-0"
                        >
                          {formatTimestamp(event.timestamp_seconds)}
                        </button>

                        {/* Event type badge */}
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

                        {/* Team */}
                        {event.team && (
                          <span className="text-xs text-[var(--ash-grey)]">
                            {event.team === 'home'
                              ? recording.homeTeam
                              : recording.awayTeam}
                          </span>
                        )}

                        {/* Label */}
                        {event.label && (
                          <span className="text-xs text-[var(--timberwolf)] truncate">
                            {event.label}
                          </span>
                        )}

                        {/* Visibility icon */}
                        {event.visibility === 'private' && (
                          <Lock className="w-3 h-3 text-[var(--ash-grey)] flex-shrink-0 ml-auto" />
                        )}

                        {/* Edit/Delete buttons (own events only) */}
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
                              onClick={() => handleDeleteEvent(event.id)}
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
          </div>
        </FadeIn>

        {recording && (
          <ShareRecordingModal
            open={showShareModal}
            onOpenChange={setShowShareModal}
            recordingId={recording.id}
            recordingTitle={recording.title}
          />
        )}
      </div>
    </div>
  )
}
