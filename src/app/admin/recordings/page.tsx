'use client'

import { useEffect, useState } from 'react'
import {
  Card,
  CardContent,
  Badge,
  SearchBar,
  Skeleton,
  EmptyState,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@braintwopoint0/playback-commons/ui'
import { Film } from 'lucide-react'

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
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-10 w-full max-w-md" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold">Recordings</h1>
        <p className="text-muted-foreground">{recordings.length} total</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-4 mb-6">
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder="Search by title, venue, or team..."
          className="flex-1 max-w-md"
        />
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statuses.map((status) => (
              <SelectItem key={status} value={status}>
                {status === 'all' ? 'All statuses' : status}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {filteredRecordings.length === 0 ? (
        <EmptyState
          icon={<Film className="h-10 w-10" />}
          title={search || statusFilter !== 'all'
            ? 'No recordings match your filters'
            : 'No recordings found'}
        />
      ) : (
        <div className="space-y-2">
          {/* Header - hidden on mobile */}
          <div className="hidden lg:grid grid-cols-12 gap-4 px-4 py-2 text-sm text-muted-foreground">
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
                {/* Desktop grid */}
                <div className="hidden lg:grid grid-cols-12 gap-4 items-center">
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
                    <Badge
                      variant="outline"
                      className={
                        recording.status === 'published'
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                          : recording.status === 'scheduled'
                            ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                            : ''
                      }
                    >
                      {recording.status}
                    </Badge>
                  </div>
                  <div className="col-span-1 text-sm text-muted-foreground">
                    {recording.accessCount} users
                  </div>
                  <div className="col-span-2 text-sm text-muted-foreground">
                    {formatDate(recording.created_at)}
                  </div>
                </div>

                {/* Mobile stacked layout */}
                <div className="lg:hidden space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{recording.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {recording.home_team} vs {recording.away_team}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={
                        recording.status === 'published'
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                          : recording.status === 'scheduled'
                            ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                            : ''
                      }
                    >
                      {recording.status}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    {recording.venueName && <span>{recording.venueName}</span>}
                    <span>{formatDate(recording.match_date)}</span>
                    <span>{recording.accessCount} users</span>
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
