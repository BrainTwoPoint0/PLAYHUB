'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, Input } from '@braintwopoint0/playback-commons/ui'

interface Recording {
  id: string
  title: string
  status: string
  match_date: string
  home_team: string
  away_team: string
  organization_id: string | null
  venueName: string | null
  s3_key: string | null
  accessCount: number
  created_at: string
}

export default function AdminRecordingsPage() {
  const [recordings, setRecordings] = useState<Recording[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')

  useEffect(() => {
    fetchRecordings()
  }, [])

  async function fetchRecordings() {
    try {
      const res = await fetch('/api/admin?section=recordings')
      const data = await res.json()
      setRecordings(data.recordings || [])
    } catch (err) {
      console.error('Failed to fetch recordings:', err)
    } finally {
      setLoading(false)
    }
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const filteredRecordings = recordings.filter((recording) => {
    const searchLower = search.toLowerCase()
    const matchesSearch =
      recording.title.toLowerCase().includes(searchLower) ||
      recording.venueName?.toLowerCase().includes(searchLower) ||
      recording.home_team.toLowerCase().includes(searchLower) ||
      recording.away_team.toLowerCase().includes(searchLower)

    const matchesStatus =
      statusFilter === 'all' || recording.status === statusFilter

    return matchesSearch && matchesStatus
  })

  const statuses = [
    'all',
    ...Array.from(new Set(recordings.map((r) => r.status))),
  ]

  if (loading) {
    return <p className="text-muted-foreground">Loading recordings...</p>
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Recordings</h1>
        <p className="text-muted-foreground">{recordings.length} total</p>
      </div>

      {/* Filters */}
      <div className="flex gap-4 mb-6">
        <Input
          type="text"
          placeholder="Search by title, venue, or team..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-md"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-md border bg-background"
        >
          {statuses.map((status) => (
            <option key={status} value={status}>
              {status === 'all' ? 'All statuses' : status}
            </option>
          ))}
        </select>
      </div>

      {filteredRecordings.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground">
              {search || statusFilter !== 'all'
                ? 'No recordings match your filters'
                : 'No recordings found'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {/* Header */}
          <div className="grid grid-cols-12 gap-4 px-4 py-2 text-sm text-muted-foreground">
            <div className="col-span-4">Title</div>
            <div className="col-span-2">Venue</div>
            <div className="col-span-2">Match Date</div>
            <div className="col-span-1">Status</div>
            <div className="col-span-1">Access</div>
            <div className="col-span-2">Created</div>
          </div>

          {filteredRecordings.map((recording) => (
            <Card key={recording.id}>
              <CardContent className="p-4">
                <div className="grid grid-cols-12 gap-4 items-center">
                  <div className="col-span-4">
                    <p className="font-medium truncate">{recording.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {recording.home_team} vs {recording.away_team}
                    </p>
                  </div>
                  <div className="col-span-2 text-sm text-muted-foreground truncate">
                    {recording.venueName || '-'}
                  </div>
                  <div className="col-span-2 text-sm text-muted-foreground">
                    {formatDate(recording.match_date)}
                  </div>
                  <div className="col-span-1">
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
                  <div className="col-span-1 text-sm text-muted-foreground">
                    {recording.accessCount} users
                  </div>
                  <div className="col-span-2 text-sm text-muted-foreground">
                    {formatDate(recording.created_at)}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
