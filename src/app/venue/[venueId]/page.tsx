'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'

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

  useEffect(() => {
    fetchVenueData()
  }, [venueId])

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
        await navigator.clipboard.writeText(fullUrl)
        setSuccess('Public link copied to clipboard!')
        setTimeout(() => setSuccess(null), 3000)
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

      setSuccess('Admin added successfully!')
      setNewAdminEmail('')
      fetchAdmins()
      setTimeout(() => setSuccess(null), 3000)
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

  if (loading) {
    return (
      <div className="container mx-auto p-6 max-w-4xl">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (error && !venue) {
    return (
      <div className="container mx-auto p-6 max-w-4xl">
        <Card>
          <CardContent className="p-6">
            <p className="text-red-500">{error}</p>
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => router.push('/venue')}
            >
              Back to Venues
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">{venue?.name}</h1>
          <p className="text-muted-foreground">Venue Management</p>
        </div>
        {venueCount > 1 && (
          <Button variant="outline" onClick={() => router.push('/venue')}>
            Switch Venue
          </Button>
        )}
      </div>

      {/* Schedule Recording */}
      {scenes.length > 0 && (
        <Card className="mb-6">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle>Schedule Recording</CardTitle>
              {!showScheduleForm && (
                <Button onClick={() => setShowScheduleForm(true)}>
                  + New Recording
                </Button>
              )}
            </div>
          </CardHeader>
          {showScheduleForm && (
            <CardContent>
              <form onSubmit={handleSchedule} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Title *</label>
                    <Input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Match title"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Pitch/Camera *
                    </label>
                    <select
                      className="w-full p-2 pr-8 rounded-md border bg-background appearance-none bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2012%2012%22%3E%3Cpath%20fill%3D%22%23888%22%20d%3D%22M6%208L1%203h10z%22%2F%3E%3C%2Fsvg%3E')] bg-[length:12px] bg-[right_8px_center] bg-no-repeat disabled:opacity-60 disabled:cursor-not-allowed"
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
                  <label className="text-sm font-medium">Description</label>
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Optional description"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Home Team</label>
                    <Input
                      value={homeTeam}
                      onChange={(e) => setHomeTeam(e.target.value)}
                      placeholder="Home team name"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Away Team</label>
                    <Input
                      value={awayTeam}
                      onChange={(e) => setAwayTeam(e.target.value)}
                      placeholder="Away team name"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Start Time *</label>
                    <Input
                      type="datetime-local"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      required
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={setStartNow}
                      className="w-full"
                    >
                      Start Now (+1 min)
                    </Button>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">End Time *</label>
                    <Input
                      type="datetime-local"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      required
                    />
                    {startTime && (
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setDuration(60)}
                        >
                          +1h
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setDuration(90)}
                        >
                          +1.5h
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setDuration(120)}
                        >
                          +2h
                        </Button>
                      </div>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Grant Access (emails, comma-separated)
                  </label>
                  <Input
                    value={accessEmails}
                    onChange={(e) => setAccessEmails(e.target.value)}
                    placeholder="user1@example.com, user2@example.com"
                  />
                  <p className="text-xs text-muted-foreground">
                    These users will have access immediately (even before
                    recording is ready)
                  </p>
                </div>

                {error && (
                  <div className="bg-red-500/10 text-red-500 p-3 rounded-md">
                    {error}
                  </div>
                )}

                {success && (
                  <div className="bg-green-500/10 text-green-500 p-3 rounded-md">
                    {success}
                  </div>
                )}

                <div className="flex gap-2">
                  <Button
                    type="submit"
                    disabled={submitting}
                    className="flex-1"
                  >
                    {submitting ? 'Scheduling...' : 'Schedule Recording'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setShowScheduleForm(false)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </CardContent>
          )}
        </Card>
      )}

      {/* Recordings List */}
      <Card>
        <CardHeader>
          <CardTitle>Recordings</CardTitle>
          <CardDescription>
            {recordings.length} recording{recordings.length === 1 ? '' : 's'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Video Player */}
          {playingId && playbackUrl && (
            <div className="mb-6 bg-black rounded-lg overflow-hidden">
              <div className="p-3 border-b border-white/10 flex items-center justify-between">
                <span className="text-sm font-medium">
                  Now Playing:{' '}
                  {recordings.find((r) => r.id === playingId)?.title}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
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
            <p className="text-muted-foreground text-center py-8">
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
                  className={`p-4 rounded-md ${
                    playingId === recording.id
                      ? 'bg-primary/10 border border-primary/30'
                      : 'bg-muted'
                  }`}
                >
                  <div className="flex items-center gap-4">
                    {/* Play Button */}
                    {recording.s3_key && (
                      <Button
                        variant={
                          playingId === recording.id ? 'default' : 'outline'
                        }
                        size="icon"
                        onClick={() => handlePlayRecording(recording)}
                        className="flex-shrink-0"
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
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">
                          {recording.title}
                        </p>
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
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
                      <p className="text-sm text-muted-foreground">
                        {recording.pitch_name && `${recording.pitch_name} | `}
                        {formatTime(recording.match_date)}
                      </p>
                    </div>

                    {/* Access Count & Manage */}
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">
                        {recording.accessCount || 0} user
                        {(recording.accessCount || 0) === 1 ? '' : 's'}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
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
                  className="w-full mt-2"
                  onClick={() => setShowAllRecordings(!showAllRecordings)}
                >
                  {showAllRecordings
                    ? 'Show less'
                    : `Show all ${recordings.length} recordings`}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Venue Admins Section */}
      <Card className="mt-6">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>Venue Admins</CardTitle>
            <Button
              variant="outline"
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
          <CardDescription>
            Users who can manage this venue and its recordings
          </CardDescription>
        </CardHeader>
        {showAdminSection && (
          <CardContent className="space-y-4">
            {/* Add new admin */}
            <form onSubmit={handleAddAdmin} className="flex gap-2">
              <Input
                type="email"
                value={newAdminEmail}
                onChange={(e) => setNewAdminEmail(e.target.value)}
                placeholder="admin@example.com"
                className="flex-1"
              />
              <Button type="submit" disabled={addingAdmin || !newAdminEmail}>
                {addingAdmin ? 'Adding...' : 'Add Admin'}
              </Button>
            </form>

            {/* Admin list */}
            <div className="space-y-2">
              {admins.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Loading admins...
                </p>
              ) : (
                admins.map((admin) => (
                  <div
                    key={admin.id}
                    className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg"
                  >
                    <div>
                      <p className="font-medium">
                        {admin.fullName || admin.email || 'Unknown'}
                        {admin.isCurrentUser && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            (you)
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {admin.email}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
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
          </CardContent>
        )}
      </Card>

      {/* Access Modal */}
      {showAccessModal && selectedRecording && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <Card className="w-full max-w-lg m-4 bg-zinc-900 border border-zinc-700">
            <CardHeader>
              <CardTitle>Manage Access</CardTitle>
              <CardDescription>{selectedRecording.title}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Add new access */}
              <div className="space-y-2">
                <label className="text-sm font-medium">
                  Grant access (emails, comma-separated)
                </label>
                <div className="flex gap-2">
                  <Input
                    value={newEmails}
                    onChange={(e) => setNewEmails(e.target.value)}
                    placeholder="user@example.com"
                    className="flex-1"
                  />
                  <Button
                    onClick={handleGrantAccess}
                    disabled={grantingAccess || !newEmails}
                  >
                    {grantingAccess ? 'Adding...' : 'Add'}
                  </Button>
                </div>
              </div>

              {/* Access list */}
              <div className="space-y-2">
                <p className="text-sm font-medium">Current Access</p>
                {accessList.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No one has access yet
                  </p>
                ) : (
                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {accessList.map((access) => (
                      <div
                        key={access.id}
                        className="flex items-center justify-between p-2 bg-muted rounded"
                      >
                        <div>
                          <p className="text-sm">
                            {access.invitedEmail ||
                              access.userEmail ||
                              access.userId?.slice(0, 8) + '...'}
                          </p>
                          {access.expiresAt && (
                            <p className="text-xs text-muted-foreground">
                              Expires: {formatTime(access.expiresAt)}
                            </p>
                          )}
                        </div>
                        {access.isActive && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-red-500 hover:text-red-400"
                            onClick={() => handleRevokeAccess(access.id)}
                          >
                            Revoke
                          </Button>
                        )}
                        {!access.isActive && (
                          <span className="text-xs text-muted-foreground">
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
                className="w-full"
                onClick={() => {
                  setShowAccessModal(false)
                  setSelectedRecording(null)
                  setAccessList([])
                }}
              >
                Close
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
