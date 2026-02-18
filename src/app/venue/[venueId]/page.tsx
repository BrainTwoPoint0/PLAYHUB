'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button, Input } from '@braintwopoint0/playback-commons/ui'
import { FadeIn } from '@/components/FadeIn'
import { HlsPlayer } from '@/components/streaming/HlsPlayer'

interface Recording {
  id: string
  title: string
  description?: string
  home_team: string
  away_team: string
  match_date: string
  venue?: string
  pitch_name?: string
  status: string
  s3_key?: string
  file_size_bytes?: number
  spiideo_game_id?: string
  accessCount?: number
}

interface AccessGrant {
  id: string
  userId: string | null
  userEmail: string | null
  invitedEmail: string | null
  grantedAt: string
  expiresAt: string | null
  isActive: boolean
  notes: string | null
}

interface Venue {
  id: string
  name: string
  slug: string | null
  logo_url: string | null
}

interface Scene {
  id: string
  name: string
}

interface Admin {
  id: string
  role: string
  createdAt: string
  userId: string
  fullName: string | null
  email: string | null
  isCurrentUser: boolean
}

interface StreamChannel {
  id: string
  name: string
  state: string
  rtmp?: {
    url: string
    streamKey: string
    fullUrl: string
  }
  playbackUrl?: string
}

export default function VenueManagementPage() {
  const params = useParams()
  const venueId = params.venueId as string
  const router = useRouter()

  const [venue, setVenue] = useState<Venue | null>(null)
  const [venueCount, setVenueCount] = useState(0)
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Scheduling state
  const [scenes, setScenes] = useState<Scene[]>([])
  const [showScheduleForm, setShowScheduleForm] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [sceneId, setSceneId] = useState('')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [homeTeam, setHomeTeam] = useState('Home')
  const [awayTeam, setAwayTeam] = useState('Away')
  const [accessEmails, setAccessEmails] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)

  // Access modal state
  const [showAccessModal, setShowAccessModal] = useState(false)
  const [selectedRecording, setSelectedRecording] = useState<Recording | null>(
    null
  )
  const [accessList, setAccessList] = useState<AccessGrant[]>([])
  const [newEmails, setNewEmails] = useState('')
  const [grantingAccess, setGrantingAccess] = useState(false)

  // Video playback
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null)

  // Public link
  const [generatingLink, setGeneratingLink] = useState<string | null>(null)

  // Recordings section state
  const [showAllRecordings, setShowAllRecordings] = useState(false)
  const RECORDINGS_PREVIEW_COUNT = 10

  // Admin management state
  const [admins, setAdmins] = useState<Admin[]>([])
  const [showAdminSection, setShowAdminSection] = useState(false)
  const [newAdminEmail, setNewAdminEmail] = useState('')
  const [addingAdmin, setAddingAdmin] = useState(false)
  const [removingAdminId, setRemovingAdminId] = useState<string | null>(null)

  // Live streaming state
  const [channels, setChannels] = useState<StreamChannel[]>([])
  const [showStreamingSection, setShowStreamingSection] = useState(false)
  const [loadingChannels, setLoadingChannels] = useState(false)
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [newChannelName, setNewChannelName] = useState('')
  const [startingChannelId, setStartingChannelId] = useState<string | null>(
    null
  )
  const [stoppingChannelId, setStoppingChannelId] = useState<string | null>(
    null
  )
  const [deletingChannelId, setDeletingChannelId] = useState<string | null>(
    null
  )
  const [copiedField, setCopiedField] = useState<string | null>(null)

  // Live stream scheduling state
  const [showStreamScheduleForm, setShowStreamScheduleForm] = useState(false)
  const [streamTitle, setStreamTitle] = useState('')
  const [streamSceneId, setStreamSceneId] = useState('')
  const [streamStartTime, setStreamStartTime] = useState('')
  const [streamEndTime, setStreamEndTime] = useState('')
  const [schedulingStream, setSchedulingStream] = useState(false)

  useEffect(() => {
    fetchVenueData()
  }, [venueId])

  // Poll for channel state changes
  useEffect(() => {
    if (!showStreamingSection || channels.length === 0) return

    const hasTransitionalState = channels.some((c) =>
      ['CREATING', 'STARTING', 'STOPPING', 'DELETING'].includes(c.state)
    )

    if (hasTransitionalState) {
      const interval = setInterval(fetchChannels, 5000)
      return () => clearInterval(interval)
    }
  }, [channels, showStreamingSection])

  async function fetchVenueData() {
    try {
      setLoading(true)

      // Fetch venue info
      const venuesRes = await fetch('/api/venue')
      const venuesData = await venuesRes.json()

      if (venuesData.error) {
        setError(venuesData.error)
        return
      }

      const venuesList = venuesData.venues || []
      setVenueCount(venuesList.length)

      const currentVenue = venuesList.find((v: Venue) => v.id === venueId)
      if (!currentVenue) {
        setError('Venue not found or you do not have access')
        return
      }
      setVenue(currentVenue)

      // Fetch recordings
      const recordingsRes = await fetch(`/api/venue/${venueId}/recordings`)
      const recordingsData = await recordingsRes.json()
      setRecordings(recordingsData.recordings || [])

      // Fetch scenes for scheduling
      try {
        const scenesRes = await fetch(`/api/venue/${venueId}/spiideo/scenes`)
        const scenesData = await scenesRes.json()
        console.log('Scenes response:', scenesData)
        if (scenesData.scenes) {
          setScenes(scenesData.scenes)
          if (scenesData.scenes.length > 0 && !sceneId) {
            setSceneId(scenesData.scenes[0].id)
          }
        } else if (scenesData.error) {
          console.error('Scenes error:', scenesData.error)
        }
      } catch (e) {
        // Scenes not available - scheduling will be disabled
        console.error('Scenes fetch failed:', e)
      }
    } catch (err) {
      setError('Failed to load venue data')
    } finally {
      setLoading(false)
    }
  }

  async function openAccessModal(recording: Recording) {
    setSelectedRecording(recording)
    setShowAccessModal(true)
    setNewEmails('')

    try {
      const res = await fetch(`/api/recordings/${recording.id}/access`)
      const data = await res.json()
      setAccessList(data.access || [])
    } catch (err) {
      console.error('Failed to fetch access list:', err)
    }
  }

  async function handleGrantAccess() {
    if (!selectedRecording || !newEmails) return

    setGrantingAccess(true)
    try {
      const emails = newEmails
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e)

      const res = await fetch(
        `/api/recordings/${selectedRecording.id}/access`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emails }),
        }
      )

      const data = await res.json()

      if (data.error) {
        setError(data.error)
      } else {
        setNewEmails('')
        // Refresh access list
        openAccessModal(selectedRecording)
        // Refresh recordings to update access count
        fetchVenueData()
      }
    } catch (err) {
      setError('Failed to grant access')
    } finally {
      setGrantingAccess(false)
    }
  }

  async function handleRevokeAccess(accessId: string) {
    if (!selectedRecording) return

    if (!confirm('Are you sure you want to revoke this access?')) return

    try {
      await fetch(
        `/api/recordings/${selectedRecording.id}/access/${accessId}`,
        {
          method: 'DELETE',
        }
      )
      // Refresh access list
      openAccessModal(selectedRecording)
      // Refresh recordings to update access count
      fetchVenueData()
    } catch (err) {
      console.error('Failed to revoke access:', err)
    }
  }

  async function getPublicLink(recording: Recording) {
    setGeneratingLink(recording.id)
    try {
      const res = await fetch(`/api/recordings/${recording.id}/share-token`, {
        method: 'POST',
      })
      const data = await res.json()

      if (data.shareUrl) {
        // Ensure full URL (API may return relative path if NEXT_PUBLIC_APP_URL not set)
        const fullUrl = data.shareUrl.startsWith('/')
          ? `${window.location.origin}${data.shareUrl}`
          : data.shareUrl

        // Try to copy to clipboard, with fallback for Safari/strict browsers
        try {
          await navigator.clipboard.writeText(fullUrl)
          setSuccess('Public link copied to clipboard!')
          setTimeout(() => setSuccess(null), 3000)
        } catch (clipboardErr) {
          // Clipboard failed (Safari permissions) - show prompt for manual copy
          window.prompt('Copy this link:', fullUrl)
        }
      } else {
        setError('Failed to generate public link')
      }
    } catch (err) {
      setError('Failed to generate public link')
    } finally {
      setGeneratingLink(null)
    }
  }

  async function fetchAdmins() {
    try {
      const res = await fetch(`/api/venue/${venueId}/admins`)
      const data = await res.json()
      if (data.admins) {
        setAdmins(data.admins)
      }
    } catch (err) {
      console.error('Failed to fetch admins:', err)
    }
  }

  async function handleAddAdmin(e: React.FormEvent) {
    e.preventDefault()
    if (!newAdminEmail.trim()) return

    setAddingAdmin(true)
    try {
      const res = await fetch(`/api/venue/${venueId}/admins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newAdminEmail.trim() }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to add admin')
        return
      }

      if (data.invited) {
        setSuccess(
          'Invitation email sent! They will be added as admin after creating an account.'
        )
      } else {
        setSuccess('Admin added successfully!')
        fetchAdmins()
      }
      setNewAdminEmail('')
      setTimeout(() => setSuccess(null), 5000)
    } catch (err) {
      setError('Failed to add admin')
    } finally {
      setAddingAdmin(false)
    }
  }

  async function handleRemoveAdmin(memberId: string) {
    setRemovingAdminId(memberId)
    try {
      const res = await fetch(`/api/venue/${venueId}/admins/${memberId}`, {
        method: 'DELETE',
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to remove admin')
        return
      }

      setSuccess('Admin removed successfully!')
      fetchAdmins()
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError('Failed to remove admin')
    } finally {
      setRemovingAdminId(null)
    }
  }

  // Streaming functions
  async function fetchChannels() {
    try {
      setLoadingChannels(true)
      const res = await fetch(`/api/streaming/channels?venueId=${venueId}`)
      const data = await res.json()

      if (data.channels) {
        // Fetch full details for each channel to get RTMP credentials
        const channelsWithDetails = await Promise.all(
          data.channels.map(async (ch: any) => {
            try {
              const detailRes = await fetch(`/api/streaming/channels/${ch.id}`)
              const detailData = await detailRes.json()
              return detailData.channel || ch
            } catch {
              return ch
            }
          })
        )
        setChannels(channelsWithDetails)
      }
    } catch (err) {
      console.error('Failed to fetch channels:', err)
    } finally {
      setLoadingChannels(false)
    }
  }

  async function handleCreateChannel(e: React.FormEvent) {
    e.preventDefault()
    if (!newChannelName.trim()) return

    setCreatingChannel(true)
    try {
      const res = await fetch('/api/streaming/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newChannelName.trim(),
          venueId,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to create channel')
        return
      }

      setNewChannelName('')
      setSuccess('Channel created! It may take a minute to become ready.')
      setTimeout(() => setSuccess(null), 5000)
      fetchChannels()
    } catch (err) {
      setError('Failed to create channel')
    } finally {
      setCreatingChannel(false)
    }
  }

  async function handleStartChannel(channelId: string) {
    if (
      !confirm(
        'Starting the stream will begin AWS billing (~$0.35/hour). Continue?'
      )
    ) {
      return
    }

    setStartingChannelId(channelId)
    try {
      const res = await fetch(`/api/streaming/channels/${channelId}/start`, {
        method: 'POST',
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to start channel')
        return
      }

      setSuccess('Channel starting... It may take 1-2 minutes.')
      setTimeout(() => setSuccess(null), 5000)
      fetchChannels()
    } catch (err) {
      setError('Failed to start channel')
    } finally {
      setStartingChannelId(null)
    }
  }

  async function handleStopChannel(channelId: string) {
    setStoppingChannelId(channelId)
    try {
      const res = await fetch(`/api/streaming/channels/${channelId}/stop`, {
        method: 'POST',
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to stop channel')
        return
      }

      setSuccess('Channel stopping... Billing will stop when it reaches IDLE.')
      setTimeout(() => setSuccess(null), 5000)
      fetchChannels()
    } catch (err) {
      setError('Failed to stop channel')
    } finally {
      setStoppingChannelId(null)
    }
  }

  async function handleDeleteChannel(channelId: string) {
    if (
      !confirm(
        'Are you sure you want to delete this channel? This cannot be undone.'
      )
    ) {
      return
    }

    setDeletingChannelId(channelId)
    try {
      const res = await fetch(`/api/streaming/channels/${channelId}`, {
        method: 'DELETE',
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Failed to delete channel')
        return
      }

      setSuccess('Channel deleted successfully!')
      setTimeout(() => setSuccess(null), 3000)
      fetchChannels()
    } catch (err) {
      setError('Failed to delete channel')
    } finally {
      setDeletingChannelId(null)
    }
  }

  async function copyToClipboard(text: string, fieldName: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(fieldName)
      setTimeout(() => setCopiedField(null), 2000)
    } catch {
      // Clipboard failed (Safari permissions) - show prompt for manual copy
      window.prompt('Copy this value:', text)
    }
  }

  function getStateColor(state: string) {
    switch (state) {
      case 'RUNNING':
        return 'bg-green-500/20 text-green-500'
      case 'IDLE':
        return 'bg-gray-500/20 text-gray-400'
      case 'STARTING':
      case 'STOPPING':
      case 'CREATING':
        return 'bg-yellow-500/20 text-yellow-500'
      case 'DELETING':
        return 'bg-red-500/20 text-red-500'
      default:
        return 'bg-gray-500/20 text-gray-400'
    }
  }

  // Schedule live stream function
  async function handleScheduleLiveStream(e: React.FormEvent) {
    e.preventDefault()

    if (!streamTitle || !streamSceneId || !streamStartTime || !streamEndTime) {
      setError('Please fill in all required fields')
      return
    }

    setSchedulingStream(true)
    setError(null)

    try {
      const res = await fetch('/api/streaming/spiideo/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          venueId,
          title: streamTitle,
          sceneId: streamSceneId,
          scheduledStartTime: new Date(streamStartTime).toISOString(),
          scheduledStopTime: new Date(streamEndTime).toISOString(),
          sport: 'football',
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Failed to schedule live stream')
      }

      setSuccess(
        `Live stream scheduled! Playback URL: ${data.channel.playbackUrl}`
      )
      setTimeout(() => setSuccess(null), 15000)

      // Reset form and refresh channels
      setStreamTitle('')
      setStreamStartTime('')
      setStreamEndTime('')
      setShowStreamScheduleForm(false)
      fetchChannels()
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to schedule live stream'
      )
    } finally {
      setSchedulingStream(false)
    }
  }

  async function handlePlayRecording(recording: Recording) {
    if (playingId === recording.id) {
      setPlayingId(null)
      setPlaybackUrl(null)
      return
    }

    try {
      const res = await fetch(
        `/api/recordings?id=${recording.id}&action=playback`
      )
      const data = await res.json()
      if (data.playbackUrl) {
        setPlayingId(recording.id)
        setPlaybackUrl(data.playbackUrl)
      }
    } catch (err) {
      console.error('Error getting playback URL:', err)
    }
  }

  function formatTime(isoString: string): string {
    return new Date(isoString).toLocaleString()
  }

  async function handleSchedule(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setSubmitting(true)

    try {
      const emails = accessEmails
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e)

      const res = await fetch(`/api/venue/${venueId}/spiideo/games`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: description || undefined,
          sceneId,
          scheduledStartTime: new Date(startTime).toISOString(),
          scheduledStopTime: new Date(endTime).toISOString(),
          homeTeam: homeTeam || 'Home',
          awayTeam: awayTeam || 'Away',
          pitchName: scenes.find((s) => s.id === sceneId)?.name || null,
          accessEmails: emails.length > 0 ? emails : undefined,
        }),
      })

      const data = await res.json()

      if (data.error) {
        setError(data.error)
      } else {
        setSuccess('Recording scheduled successfully!')
        setTitle('')
        setDescription('')
        setStartTime('')
        setEndTime('')
        setHomeTeam('Home')
        setAwayTeam('Away')
        setAccessEmails('')
        setShowScheduleForm(false)
        fetchVenueData()
      }
    } catch (err) {
      setError('Failed to schedule recording')
    } finally {
      setSubmitting(false)
    }
  }

  function setStartNow() {
    const now = new Date()
    const startDate = new Date(now.getTime() + 1 * 60 * 1000)
    setStartTime(formatDateTimeLocal(startDate))
  }

  function setDuration(minutes: number) {
    if (startTime) {
      const start = new Date(startTime)
      const end = new Date(start.getTime() + minutes * 60 * 1000)
      setEndTime(formatDateTimeLocal(end))
    }
  }

  function formatDateTimeLocal(date: Date): string {
    const offset = date.getTimezoneOffset()
    const local = new Date(date.getTime() - offset * 60 * 1000)
    return local.toISOString().slice(0, 16)
  }

  // Shared input styling
  const inputClass =
    'bg-white/5 border-[var(--ash-grey)]/20 text-[var(--timberwolf)] placeholder:text-[var(--ash-grey)]/40'
  const selectClass =
    "w-full p-2 pr-8 rounded-md border border-[var(--ash-grey)]/20 bg-white/5 text-[var(--timberwolf)] appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%23888%22%20d%3D%22M6%208L1%203h10z%22%2F%3E%3C%2Fsvg%3E')] bg-[length:12px] bg-[right_8px_center] bg-no-repeat disabled:opacity-60 disabled:cursor-not-allowed"
  const outlineBtnClass =
    'border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10'
  const primaryBtnClass =
    'bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]'

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl animate-pulse">
          {/* Header skeleton */}
          <div className="flex items-center justify-between mb-8">
            <div className="space-y-2">
              <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-[140px]" />
              <div className="bg-[var(--ash-grey)]/10 rounded h-8 w-[200px]" />
            </div>
            <div className="bg-[var(--ash-grey)]/10 rounded h-10 w-[110px]" />
          </div>

          {/* Schedule Recording skeleton */}
          <div className="mb-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-6">
            <div className="flex items-center justify-between">
              <div className="bg-[var(--ash-grey)]/10 rounded h-5 w-[160px]" />
              <div className="bg-[var(--ash-grey)]/10 rounded h-10 w-[140px]" />
            </div>
          </div>

          {/* Live Streaming skeleton */}
          <div className="mb-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <div className="bg-[var(--ash-grey)]/10 rounded h-5 w-[130px]" />
                <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-[260px]" />
              </div>
              <div className="bg-[var(--ash-grey)]/10 rounded h-10 w-[130px]" />
            </div>
          </div>

          {/* Recordings skeleton */}
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6 pb-3 space-y-1">
              <div className="bg-[var(--ash-grey)]/10 rounded h-5 w-[100px]" />
              <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-[120px]" />
            </div>
            <div className="px-6 pb-6 space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="p-4 rounded-lg bg-white/[0.03] border border-[var(--ash-grey)]/10"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-10 h-10 rounded bg-[var(--ash-grey)]/10" />
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="bg-[var(--ash-grey)]/10 rounded h-4 w-2/5" />
                        <div className="bg-[var(--ash-grey)]/10 rounded h-4 w-16" />
                      </div>
                      <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-3/5" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-[var(--ash-grey)]/10">
                    <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-16" />
                    <div className="flex gap-2">
                      <div className="bg-[var(--ash-grey)]/10 rounded h-8 w-24" />
                      <div className="bg-[var(--ash-grey)]/10 rounded h-8 w-28" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Venue Admins skeleton */}
          <div className="mt-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-6">
            <div className="flex items-center justify-between mb-1">
              <div className="bg-[var(--ash-grey)]/10 rounded h-5 w-[120px]" />
              <div className="bg-[var(--ash-grey)]/10 rounded h-10 w-[130px]" />
            </div>
            <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-[300px]" />
          </div>
        </div>
      </div>
    )
  }

  if (error && !venue) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-4xl">
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015] p-6">
            <p className="text-red-400">{error}</p>
            <Button
              className={`mt-4 ${outlineBtnClass}`}
              variant="outline"
              onClick={() => router.push('/venue')}
            >
              Back to Venues
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--night)]">
      <div className="container mx-auto px-5 py-16 max-w-4xl">
        <FadeIn>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-8">
            <div>
              <p className="text-[var(--ash-grey)] text-xs font-semibold tracking-[0.25em] uppercase mb-2">
                Venue Management
              </p>
              <h1 className="text-2xl md:text-3xl font-bold text-[var(--timberwolf)]">
                {venue?.name}
              </h1>
            </div>
            {venueCount > 1 && (
              <Button
                variant="outline"
                className={`self-start sm:self-auto ${outlineBtnClass}`}
                onClick={() => router.push('/venue')}
              >
                Switch Venue
              </Button>
            )}
          </div>
        </FadeIn>

        {/* Schedule Recording */}
        {scenes.length > 0 && (
          <FadeIn delay={100}>
            <div className="mb-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
              <div className="p-6 pb-3">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                    Schedule Recording
                  </h2>
                  {!showScheduleForm && (
                    <Button
                      className={`w-full md:w-auto ${primaryBtnClass}`}
                      onClick={() => setShowScheduleForm(true)}
                    >
                      + New Recording
                    </Button>
                  )}
                </div>
              </div>
              {showScheduleForm && (
                <div className="px-6 pb-6">
                  <form onSubmit={handleSchedule} className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-[var(--timberwolf)]">
                          Title *
                        </label>
                        <Input
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder="Match title"
                          required
                          className={inputClass}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-[var(--timberwolf)]">
                          Pitch/Camera *
                        </label>
                        <select
                          className={selectClass}
                          value={sceneId}
                          onChange={(e) => setSceneId(e.target.value)}
                          disabled={scenes.length <= 1}
                          required
                        >
                          {scenes.map((scene) => (
                            <option key={scene.id} value={scene.id}>
                              {scene.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium text-[var(--timberwolf)]">
                        Description
                      </label>
                      <Input
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="Optional description"
                        className={inputClass}
                      />
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-[var(--timberwolf)]">
                          Home Team
                        </label>
                        <Input
                          value={homeTeam}
                          onChange={(e) => setHomeTeam(e.target.value)}
                          placeholder="Home team name"
                          className={inputClass}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-[var(--timberwolf)]">
                          Away Team
                        </label>
                        <Input
                          value={awayTeam}
                          onChange={(e) => setAwayTeam(e.target.value)}
                          placeholder="Away team name"
                          className={inputClass}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-[var(--timberwolf)]">
                          Start Time *
                        </label>
                        <Input
                          type="datetime-local"
                          value={startTime}
                          onChange={(e) => setStartTime(e.target.value)}
                          required
                          className={inputClass}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={setStartNow}
                          className={`w-full ${outlineBtnClass}`}
                        >
                          Start Now (+1 min)
                        </Button>
                      </div>
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-[var(--timberwolf)]">
                          End Time *
                        </label>
                        <Input
                          type="datetime-local"
                          value={endTime}
                          onChange={(e) => setEndTime(e.target.value)}
                          required
                          className={inputClass}
                        />
                        {startTime && (
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setDuration(60)}
                              className={outlineBtnClass}
                            >
                              +1h
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setDuration(90)}
                              className={outlineBtnClass}
                            >
                              +1.5h
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setDuration(120)}
                              className={outlineBtnClass}
                            >
                              +2h
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium text-[var(--timberwolf)]">
                        Grant Access (emails, comma-separated)
                      </label>
                      <Input
                        value={accessEmails}
                        onChange={(e) => setAccessEmails(e.target.value)}
                        placeholder="user1@example.com, user2@example.com"
                        className={inputClass}
                      />
                      <p className="text-xs text-[var(--ash-grey)]">
                        These users will have access immediately (even before
                        recording is ready)
                      </p>
                    </div>

                    {error && (
                      <div className="bg-red-500/10 text-red-400 p-3 rounded-lg">
                        {error}
                      </div>
                    )}

                    {success && (
                      <div className="bg-green-500/10 text-green-400 p-3 rounded-lg">
                        {success}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button
                        type="submit"
                        disabled={submitting}
                        className={`flex-1 ${primaryBtnClass}`}
                      >
                        {submitting ? 'Scheduling...' : 'Schedule Recording'}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setShowScheduleForm(false)}
                        className={outlineBtnClass}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                </div>
              )}
            </div>
          </FadeIn>
        )}

        {/* Live Streaming Section */}
        <FadeIn delay={200}>
          <div className="mb-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6 pb-3">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                    Live Streaming
                  </h2>
                  <p className="text-sm text-[var(--ash-grey)]">
                    Manage live stream channels for this venue
                  </p>
                </div>
                <Button
                  variant="outline"
                  className={`w-full md:w-auto ${outlineBtnClass}`}
                  onClick={() => {
                    setShowStreamingSection(!showStreamingSection)
                    if (!showStreamingSection && channels.length === 0) {
                      fetchChannels()
                    }
                  }}
                >
                  {showStreamingSection ? 'Hide' : 'Manage Streams'}
                </Button>
              </div>
            </div>
            {showStreamingSection && (
              <div className="px-6 pb-6 space-y-4">
                {/* Create new channel form */}
                <form
                  onSubmit={handleCreateChannel}
                  className="flex flex-col sm:flex-row gap-2"
                >
                  <Input
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    placeholder="Channel name (e.g., Pitch 1 Live)"
                    className={`flex-1 ${inputClass}`}
                  />
                  <Button
                    type="submit"
                    className={`w-full sm:w-auto ${primaryBtnClass}`}
                    disabled={creatingChannel || !newChannelName.trim()}
                  >
                    {creatingChannel ? 'Creating...' : '+ Create Channel'}
                  </Button>
                </form>

                {/* Schedule Live Stream */}
                <div className="p-4 bg-white/[0.03] rounded-lg border border-[var(--ash-grey)]/10">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                    <div>
                      <h4 className="font-medium text-[var(--timberwolf)]">
                        Schedule Live Stream
                      </h4>
                      <p className="text-sm text-[var(--ash-grey)]">
                        Create a Spiideo recording + MediaLive stream in one
                        step
                      </p>
                    </div>
                    {!showStreamScheduleForm && (
                      <Button
                        size="sm"
                        className={`w-full sm:w-auto ${primaryBtnClass}`}
                        onClick={() => {
                          setShowStreamScheduleForm(true)
                          // Set default scene if available
                          if (scenes.length > 0 && !streamSceneId) {
                            setStreamSceneId(scenes[0].id)
                          }
                        }}
                      >
                        + Schedule Stream
                      </Button>
                    )}
                  </div>

                  {showStreamScheduleForm && (
                    <form
                      onSubmit={handleScheduleLiveStream}
                      className="space-y-3"
                    >
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <div>
                          <label className="text-sm text-[var(--ash-grey)]">
                            Title *
                          </label>
                          <Input
                            value={streamTitle}
                            onChange={(e) => setStreamTitle(e.target.value)}
                            placeholder="Match title"
                            required
                            className={inputClass}
                          />
                        </div>
                        <div>
                          <label className="text-sm text-[var(--ash-grey)]">
                            Camera/Pitch *
                          </label>
                          <select
                            value={streamSceneId}
                            onChange={(e) => setStreamSceneId(e.target.value)}
                            className={selectClass}
                            required
                          >
                            {scenes.map((scene) => (
                              <option key={scene.id} value={scene.id}>
                                {scene.name}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="text-sm text-[var(--ash-grey)]">
                            Start Time *
                          </label>
                          <Input
                            type="datetime-local"
                            value={streamStartTime}
                            onChange={(e) => setStreamStartTime(e.target.value)}
                            required
                            className={inputClass}
                          />
                        </div>
                        <div>
                          <label className="text-sm text-[var(--ash-grey)]">
                            End Time *
                          </label>
                          <Input
                            type="datetime-local"
                            value={streamEndTime}
                            onChange={(e) => setStreamEndTime(e.target.value)}
                            required
                            className={inputClass}
                          />
                        </div>
                      </div>
                      <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => setShowStreamScheduleForm(false)}
                          className="text-[var(--timberwolf)] hover:bg-white/10"
                        >
                          Cancel
                        </Button>
                        <Button
                          type="submit"
                          disabled={schedulingStream}
                          className={primaryBtnClass}
                        >
                          {schedulingStream
                            ? 'Setting up...'
                            : 'Create & Start Stream'}
                        </Button>
                      </div>
                    </form>
                  )}
                </div>

                {/* Channels list */}
                {loadingChannels ? (
                  <p className="text-sm text-[var(--ash-grey)]">
                    Loading channels...
                  </p>
                ) : channels.length === 0 ? (
                  <p className="text-sm text-[var(--ash-grey)] text-center py-4">
                    No streaming channels yet. Create one to get started.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {channels.map((channel) => (
                      <div
                        key={channel.id}
                        className="p-4 bg-white/[0.03] rounded-lg border border-[var(--ash-grey)]/10 space-y-3"
                      >
                        {/* Channel header */}
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-[var(--timberwolf)]">
                              {channel.name}
                            </span>
                            <span
                              className={`text-xs px-2 py-0.5 rounded ${getStateColor(channel.state)}`}
                            >
                              {channel.state}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            {channel.state === 'IDLE' && (
                              <Button
                                size="sm"
                                className={primaryBtnClass}
                                onClick={() => handleStartChannel(channel.id)}
                                disabled={startingChannelId === channel.id}
                              >
                                {startingChannelId === channel.id
                                  ? 'Starting...'
                                  : 'Start'}
                              </Button>
                            )}
                            {channel.state === 'RUNNING' && (
                              <Button
                                size="sm"
                                variant="outline"
                                className={outlineBtnClass}
                                onClick={() => handleStopChannel(channel.id)}
                                disabled={stoppingChannelId === channel.id}
                              >
                                {stoppingChannelId === channel.id
                                  ? 'Stopping...'
                                  : 'Stop'}
                              </Button>
                            )}
                            {(channel.state === 'IDLE' ||
                              channel.state === 'CREATING') && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                                onClick={() => handleDeleteChannel(channel.id)}
                                disabled={deletingChannelId === channel.id}
                              >
                                {deletingChannelId === channel.id
                                  ? 'Deleting...'
                                  : 'Delete'}
                              </Button>
                            )}
                          </div>
                        </div>

                        {/* RTMP credentials (show when not CREATING) */}
                        {channel.state !== 'CREATING' && channel.rtmp && (
                          <div className="space-y-2 text-sm">
                            <div>
                              <span className="text-[var(--ash-grey)] text-xs block mb-1">
                                RTMP URL
                              </span>
                              <div className="flex items-center gap-2">
                                <code className="flex-1 min-w-0 bg-black/30 px-2 py-1 rounded text-xs truncate text-[var(--timberwolf)]">
                                  {channel.rtmp.url}
                                </code>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="flex-shrink-0 text-[var(--timberwolf)] hover:bg-white/10"
                                  onClick={() =>
                                    copyToClipboard(
                                      channel.rtmp!.url,
                                      `rtmp-${channel.id}`
                                    )
                                  }
                                >
                                  {copiedField === `rtmp-${channel.id}`
                                    ? 'Copied!'
                                    : 'Copy'}
                                </Button>
                              </div>
                            </div>
                            <div>
                              <span className="text-[var(--ash-grey)] text-xs block mb-1">
                                Stream Key
                              </span>
                              <div className="flex items-center gap-2">
                                <code className="flex-1 min-w-0 bg-black/30 px-2 py-1 rounded text-xs truncate text-[var(--timberwolf)]">
                                  {channel.rtmp.streamKey}
                                </code>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="flex-shrink-0 text-[var(--timberwolf)] hover:bg-white/10"
                                  onClick={() =>
                                    copyToClipboard(
                                      channel.rtmp!.streamKey,
                                      `key-${channel.id}`
                                    )
                                  }
                                >
                                  {copiedField === `key-${channel.id}`
                                    ? 'Copied!'
                                    : 'Copy'}
                                </Button>
                              </div>
                            </div>
                            {channel.playbackUrl && (
                              <div>
                                <span className="text-[var(--ash-grey)] text-xs block mb-1">
                                  Playback
                                </span>
                                <div className="flex items-center gap-2">
                                  <code className="flex-1 min-w-0 bg-black/30 px-2 py-1 rounded text-xs truncate text-[var(--timberwolf)]">
                                    {channel.playbackUrl}
                                  </code>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="flex-shrink-0 text-[var(--timberwolf)] hover:bg-white/10"
                                    onClick={() =>
                                      copyToClipboard(
                                        channel.playbackUrl!,
                                        `hls-${channel.id}`
                                      )
                                    }
                                  >
                                    {copiedField === `hls-${channel.id}`
                                      ? 'Copied!'
                                      : 'Copy'}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Video player when RUNNING */}
                        {channel.state === 'RUNNING' && channel.playbackUrl && (
                          <div className="mt-3">
                            <p className="text-xs text-[var(--ash-grey)] mb-2">
                              Live Preview:
                            </p>
                            <div className="aspect-video bg-black rounded-lg overflow-hidden">
                              <HlsPlayer
                                src={channel.playbackUrl}
                                className="w-full h-full"
                                autoPlay
                                muted
                              />
                            </div>
                          </div>
                        )}

                        {/* State-specific messages */}
                        {channel.state === 'CREATING' && (
                          <p className="text-xs text-yellow-500">
                            Channel is being created. This may take a minute...
                          </p>
                        )}
                        {channel.state === 'STARTING' && (
                          <p className="text-xs text-yellow-500">
                            Channel is starting. This may take 1-2 minutes.
                            Billing has started.
                          </p>
                        )}
                        {channel.state === 'STOPPING' && (
                          <p className="text-xs text-yellow-500">
                            Channel is stopping. Billing will stop when it
                            reaches IDLE.
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </FadeIn>

        {/* Recordings List */}
        <FadeIn delay={300}>
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6 pb-3">
              <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                Recordings
              </h2>
              <p className="text-sm text-[var(--ash-grey)]">
                {recordings.length} recording
                {recordings.length === 1 ? '' : 's'}
              </p>
            </div>
            <div className="px-6 pb-6">
              {/* Video Player */}
              {playingId && playbackUrl && (
                <div className="mb-6 bg-black rounded-lg overflow-hidden">
                  <div className="p-3 border-b border-white/10 flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate min-w-0 text-[var(--timberwolf)]">
                      Now Playing:{' '}
                      {recordings.find((r) => r.id === playingId)?.title}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[var(--timberwolf)] hover:bg-white/10"
                      onClick={() => {
                        setPlayingId(null)
                        setPlaybackUrl(null)
                      }}
                    >
                      Close
                    </Button>
                  </div>
                  <div className="aspect-video">
                    <video
                      src={playbackUrl}
                      controls
                      autoPlay
                      className="w-full h-full"
                    />
                  </div>
                </div>
              )}

              {recordings.length === 0 ? (
                <p className="text-[var(--ash-grey)] text-center py-8">
                  No recordings yet. Schedule a recording to get started.
                </p>
              ) : (
                <div className="space-y-3">
                  {(showAllRecordings
                    ? recordings
                    : recordings.slice(0, RECORDINGS_PREVIEW_COUNT)
                  ).map((recording) => (
                    <div
                      key={recording.id}
                      className={`p-4 rounded-lg ${
                        playingId === recording.id
                          ? 'bg-[var(--timberwolf)]/10 border border-[var(--timberwolf)]/30'
                          : 'bg-white/[0.03] border border-[var(--ash-grey)]/10'
                      }`}
                    >
                      {/* Top row: Play button + Info + Status */}
                      <div className="flex items-start gap-3">
                        {/* Play Button */}
                        {recording.s3_key && (
                          <Button
                            variant={
                              playingId === recording.id ? 'default' : 'outline'
                            }
                            size="icon"
                            onClick={() => handlePlayRecording(recording)}
                            className={`flex-shrink-0 ${
                              playingId === recording.id
                                ? primaryBtnClass
                                : outlineBtnClass
                            }`}
                          >
                            {playingId === recording.id ? (
                              <svg
                                className="w-4 h-4"
                                fill="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                              </svg>
                            ) : (
                              <svg
                                className="w-4 h-4 ml-0.5"
                                fill="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path d="M8 5v14l11-7z" />
                              </svg>
                            )}
                          </Button>
                        )}

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-medium truncate text-[var(--timberwolf)]">
                              {recording.title}
                            </p>
                            <span
                              className={`text-xs px-2 py-0.5 rounded flex-shrink-0 ${
                                recording.status === 'published'
                                  ? 'bg-green-500/20 text-green-500'
                                  : recording.status === 'scheduled'
                                    ? 'bg-yellow-500/20 text-yellow-500'
                                    : 'bg-gray-500/20 text-gray-500'
                              }`}
                            >
                              {recording.status}
                            </span>
                          </div>
                          <p className="text-sm text-[var(--ash-grey)]">
                            {recording.pitch_name &&
                              `${recording.pitch_name} | `}
                            {formatTime(recording.match_date)}
                          </p>
                        </div>
                      </div>

                      {/* Bottom row: Access count & Actions */}
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between mt-3 pt-3 border-t border-[var(--ash-grey)]/10 gap-2">
                        <span className="text-sm text-[var(--ash-grey)]">
                          {recording.accessCount || 0} user
                          {(recording.accessCount || 0) === 1 ? '' : 's'}
                        </span>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className={`flex-1 sm:flex-none ${outlineBtnClass}`}
                            onClick={() => getPublicLink(recording)}
                            disabled={
                              generatingLink === recording.id ||
                              recording.status !== 'published'
                            }
                          >
                            {generatingLink === recording.id
                              ? 'Copying...'
                              : 'Public Link'}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className={`flex-1 sm:flex-none ${outlineBtnClass}`}
                            onClick={() => openAccessModal(recording)}
                          >
                            Manage Access
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Show more/less button */}
                  {recordings.length > RECORDINGS_PREVIEW_COUNT && (
                    <Button
                      variant="ghost"
                      className="w-full mt-2 text-[var(--timberwolf)] hover:bg-white/10"
                      onClick={() => setShowAllRecordings(!showAllRecordings)}
                    >
                      {showAllRecordings
                        ? 'Show less'
                        : `Show all ${recordings.length} recordings`}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </FadeIn>

        {/* Venue Admins Section */}
        <FadeIn delay={400}>
          <div className="mt-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6 pb-3">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                  Venue Admins
                </h2>
                <Button
                  variant="outline"
                  className={`w-full md:w-auto ${outlineBtnClass}`}
                  onClick={() => {
                    setShowAdminSection(!showAdminSection)
                    if (!showAdminSection && admins.length === 0) {
                      fetchAdmins()
                    }
                  }}
                >
                  {showAdminSection ? 'Hide' : 'Manage Admins'}
                </Button>
              </div>
              <p className="text-sm text-[var(--ash-grey)]">
                Users who can manage this venue and its recordings
              </p>
            </div>
            {showAdminSection && (
              <div className="px-6 pb-6 space-y-4">
                {/* Success/Error messages */}
                {success && (
                  <div className="bg-green-500/10 text-green-400 p-3 rounded-lg text-sm">
                    {success}
                  </div>
                )}
                {error && (
                  <div className="bg-red-500/10 text-red-400 p-3 rounded-lg text-sm">
                    {error}
                  </div>
                )}

                {/* Add new admin */}
                <form
                  onSubmit={handleAddAdmin}
                  className="flex flex-col sm:flex-row gap-2"
                >
                  <Input
                    type="email"
                    value={newAdminEmail}
                    onChange={(e) => setNewAdminEmail(e.target.value)}
                    placeholder="admin@example.com"
                    className={`flex-1 ${inputClass}`}
                  />
                  <Button
                    type="submit"
                    className={`w-full sm:w-auto ${primaryBtnClass}`}
                    disabled={addingAdmin || !newAdminEmail}
                  >
                    {addingAdmin ? 'Adding...' : 'Add Admin'}
                  </Button>
                </form>

                {/* Admin list */}
                <div className="space-y-2">
                  {admins.length === 0 ? (
                    <p className="text-sm text-[var(--ash-grey)]">
                      Loading admins...
                    </p>
                  ) : (
                    admins.map((admin) => (
                      <div
                        key={admin.id}
                        className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-white/[0.03] rounded-lg border border-[var(--ash-grey)]/10"
                      >
                        <div className="min-w-0">
                          <p className="font-medium truncate text-[var(--timberwolf)]">
                            {admin.fullName || admin.email || 'Unknown'}
                            {admin.isCurrentUser && (
                              <span className="ml-2 text-xs text-[var(--ash-grey)]">
                                (you)
                              </span>
                            )}
                          </p>
                          <p className="text-sm text-[var(--ash-grey)] truncate">
                            {admin.email}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400">
                            {admin.role.replace('_', ' ')}
                          </span>
                          {!admin.isCurrentUser && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveAdmin(admin.id)}
                              disabled={removingAdminId === admin.id}
                              className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                            >
                              {removingAdminId === admin.id
                                ? 'Removing...'
                                : 'Remove'}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </FadeIn>

        {/* Access Modal */}
        {showAccessModal && selectedRecording && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="w-full max-w-lg m-4 rounded-xl border border-[var(--ash-grey)]/10 bg-[var(--night)]">
              <div className="p-6 pb-3">
                <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                  Manage Access
                </h2>
                <p className="text-sm text-[var(--ash-grey)]">
                  {selectedRecording.title}
                </p>
              </div>
              <div className="px-6 pb-6 space-y-4">
                {/* Add new access */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--timberwolf)]">
                    Grant access (emails, comma-separated)
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      value={newEmails}
                      onChange={(e) => setNewEmails(e.target.value)}
                      placeholder="user@example.com"
                      className={`flex-1 ${inputClass}`}
                    />
                    <Button
                      className={`w-full sm:w-auto ${primaryBtnClass}`}
                      onClick={handleGrantAccess}
                      disabled={grantingAccess || !newEmails}
                    >
                      {grantingAccess ? 'Adding...' : 'Add'}
                    </Button>
                  </div>
                </div>

                {/* Access list */}
                <div className="space-y-2">
                  <p className="text-sm font-medium text-[var(--timberwolf)]">
                    Current Access
                  </p>
                  {accessList.length === 0 ? (
                    <p className="text-sm text-[var(--ash-grey)]">
                      No one has access yet
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {accessList.map((access) => (
                        <div
                          key={access.id}
                          className="flex items-center justify-between p-2 bg-white/[0.03] rounded border border-[var(--ash-grey)]/10"
                        >
                          <div>
                            <p className="text-sm text-[var(--timberwolf)]">
                              {access.invitedEmail ||
                                access.userEmail ||
                                access.userId?.slice(0, 8) + '...'}
                            </p>
                            {access.expiresAt && (
                              <p className="text-xs text-[var(--ash-grey)]">
                                Expires: {formatTime(access.expiresAt)}
                              </p>
                            )}
                          </div>
                          {access.isActive && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                              onClick={() => handleRevokeAccess(access.id)}
                            >
                              Revoke
                            </Button>
                          )}
                          {!access.isActive && (
                            <span className="text-xs text-[var(--ash-grey)]">
                              Revoked
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <Button
                  variant="outline"
                  className={`w-full ${outlineBtnClass}`}
                  onClick={() => {
                    setShowAccessModal(false)
                    setSelectedRecording(null)
                    setAccessList([])
                  }}
                >
                  Close
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
