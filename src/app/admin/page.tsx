'use client'

import { useEffect, useState } from 'react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  StatsGrid,
  Skeleton,
} from '@braintwopoint0/playback-commons/ui'

interface Stats {
  users: number
  venues: number
  recordings: number
  pendingInvites: number
  recentRecordings: Array<{
    id: string
    title: string
    status: string
    created_at: string
  }>
  recentUsers: Array<{
    id: string
    full_name: string
    email: string
    created_at: string
  }>
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchStats()
  }, [])

  async function fetchStats() {
    try {
      const res = await fetch('/api/admin?section=stats')
      const data = await res.json()
      setStats(data)
    } catch (err) {
      console.error('Failed to fetch stats:', err)
    } finally {
      setLoading(false)
    }
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-8">Dashboard</h1>

      {/* Stats Grid */}
      <StatsGrid
        className="mb-8"
        columns={4}
        stats={[
          { label: 'Total Users', value: stats?.users || 0 },
          { label: 'Venues', value: stats?.venues || 0 },
          { label: 'Recordings', value: stats?.recordings || 0 },
          { label: 'Pending Invites', value: stats?.pendingInvites || 0, color: stats?.pendingInvites ? 'yellow' : 'default' },
        ]}
      />

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Users */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Users</CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.recentUsers && stats.recentUsers.length > 0 ? (
              <div className="space-y-3">
                {stats.recentUsers.map((user) => (
                  <div
                    key={user.id}
                    className="flex items-center justify-between py-2 border-b border-border last:border-0"
                  >
                    <div>
                      <p className="font-medium">
                        {user.full_name || 'No name'}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {user.email}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatDate(user.created_at)}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">No recent users</p>
            )}
          </CardContent>
        </Card>

        {/* Recent Recordings */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Recordings</CardTitle>
          </CardHeader>
          <CardContent>
            {stats?.recentRecordings && stats.recentRecordings.length > 0 ? (
              <div className="space-y-3">
                {stats.recentRecordings.map((recording) => (
                  <div
                    key={recording.id}
                    className="flex items-center justify-between py-2 border-b border-border last:border-0"
                  >
                    <div>
                      <p className="font-medium">{recording.title}</p>
                      <Badge
                        variant={
                          recording.status === 'published'
                            ? 'default'
                            : recording.status === 'scheduled'
                              ? 'secondary'
                              : 'outline'
                        }
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
                    <p className="text-xs text-muted-foreground">
                      {formatDate(recording.created_at)}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">No recent recordings</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
