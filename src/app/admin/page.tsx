'use client'

import { useEffect, useState } from 'react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
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
    return <p className="text-muted-foreground">Loading dashboard...</p>
  }

  return (
    <div>
      <h1 className="text-3xl font-bold mb-8">Dashboard</h1>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Users
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats?.users || 0}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Venues
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats?.venues || 0}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Recordings
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats?.recordings || 0}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Pending Invites
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats?.pendingInvites || 0}</p>
          </CardContent>
        </Card>
      </div>

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
                    className="flex items-center justify-between py-2 border-b border-zinc-800 last:border-0"
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
                    className="flex items-center justify-between py-2 border-b border-zinc-800 last:border-0"
                  >
                    <div>
                      <p className="font-medium">{recording.title}</p>
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
