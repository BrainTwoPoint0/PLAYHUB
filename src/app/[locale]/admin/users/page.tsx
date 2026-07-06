'use client'

import { useEffect, useState } from 'react'
import {
  Card,
  CardContent,
  Button,
  Badge,
  SearchBar,
  Skeleton,
  EmptyState,
} from '@braintwopoint0/playback-commons/ui'
import { Users } from 'lucide-react'

interface User {
  id: string
  user_id: string
  full_name: string | null
  username: string | null
  email: string | null
  is_platform_admin: boolean
  created_at: string
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    fetchUsers()
  }, [])

  async function fetchUsers() {
    try {
      const res = await fetch('/api/admin?section=users')
      const data = await res.json()
      setUsers(data.users || [])
    } catch (err) {
      console.error('Failed to fetch users:', err)
    } finally {
      setLoading(false)
    }
  }

  async function toggleAdmin(user: User) {
    setTogglingId(user.id)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'toggleAdmin',
          profileId: user.id,
          isAdmin: !user.is_platform_admin,
        }),
      })

      if (res.ok) {
        setUsers((prev) =>
          prev.map((u) =>
            u.id === user.id
              ? { ...u, is_platform_admin: !u.is_platform_admin }
              : u
          )
        )
      }
    } catch (err) {
      console.error('Failed to toggle admin:', err)
    } finally {
      setTogglingId(null)
    }
  }

  async function handleDelete(user: User) {
    setDeleteError(null)

    const confirmed = window.confirm(
      `Are you sure you want to delete ${user.full_name || user.email || 'this user'}?\n\nThis will:\n- Remove their account permanently\n- Remove all their venue memberships\n- Remove all their recording access\n\nThis action cannot be undone.`
    )

    if (!confirmed) return

    setDeletingId(user.id)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'deleteUser',
          profileId: user.id,
        }),
      })

      const data = await res.json()

      if (res.ok && data.success) {
        setUsers((prev) => prev.filter((u) => u.id !== user.id))
      } else {
        setDeleteError(data.error || 'Failed to delete user')
      }
    } catch (err) {
      console.error('Failed to delete user:', err)
      setDeleteError('Failed to delete user')
    } finally {
      setDeletingId(null)
    }
  }

  function formatDate(dateString: string) {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }

  const filteredUsers = users.filter((user) => {
    const searchLower = search.toLowerCase()
    return (
      user.full_name?.toLowerCase().includes(searchLower) ||
      user.email?.toLowerCase().includes(searchLower) ||
      user.username?.toLowerCase().includes(searchLower)
    )
  })

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-32" />
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
        <h1 className="text-3xl font-bold">Users</h1>
        <p className="text-muted-foreground">{users.length} total</p>
      </div>

      {/* Error display */}
      {deleteError && (
        <Card className="mb-4 bg-red-500/10 border-red-500/20">
          <CardContent className="py-3 px-4 flex items-center justify-between">
            <p className="text-red-400 text-sm">{deleteError}</p>
            <button
              onClick={() => setDeleteError(null)}
              className="text-red-400 hover:text-red-300 text-sm underline hover:no-underline"
            >
              Dismiss
            </button>
          </CardContent>
        </Card>
      )}

      {/* Search */}
      <div className="mb-6">
        <SearchBar
          value={search}
          onChange={setSearch}
          placeholder="Search by name, email, or username..."
          className="max-w-md"
        />
      </div>

      {filteredUsers.length === 0 ? (
        <EmptyState
          icon={<Users className="h-10 w-10" />}
          title={search ? 'No users match your search' : 'No users found'}
        />
      ) : (
        <div className="space-y-2">
          {/* Header - hidden on mobile */}
          <div className="hidden lg:grid grid-cols-12 gap-4 px-4 py-2 text-sm text-muted-foreground">
            <div className="col-span-3">Name</div>
            <div className="col-span-3">Email</div>
            <div className="col-span-2">Username</div>
            <div className="col-span-2">Joined</div>
            <div className="col-span-2 text-right">Actions</div>
          </div>

          {filteredUsers.map((user) => (
            <Card key={user.id}>
              <CardContent className="p-4">
                {/* Desktop grid */}
                <div className="hidden lg:grid grid-cols-12 gap-4 items-center">
                  <div className="col-span-3">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">
                        {user.full_name || 'No name'}
                      </p>
                      {user.is_platform_admin && (
                        <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30">
                          Admin
                        </Badge>
                      )}
                    </div>
                  </div>
                  <div className="col-span-3 text-sm text-muted-foreground truncate">
                    {user.email || '-'}
                  </div>
                  <div className="col-span-2 text-sm text-muted-foreground">
                    @{user.username || '-'}
                  </div>
                  <div className="col-span-2 text-sm text-muted-foreground">
                    {formatDate(user.created_at)}
                  </div>
                  <div className="col-span-2 text-right flex items-center justify-end gap-2">
                    <Button
                      variant={
                        user.is_platform_admin ? 'destructive' : 'outline'
                      }
                      size="sm"
                      onClick={() => toggleAdmin(user)}
                      disabled={
                        togglingId === user.id || deletingId === user.id
                      }
                    >
                      {togglingId === user.id
                        ? '...'
                        : user.is_platform_admin
                          ? 'Remove Admin'
                          : 'Make Admin'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(user)}
                      disabled={
                        deletingId === user.id ||
                        togglingId === user.id ||
                        user.is_platform_admin
                      }
                      className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                      title={
                        user.is_platform_admin
                          ? 'Remove admin status first'
                          : 'Delete user'
                      }
                    >
                      {deletingId === user.id ? '...' : 'Delete'}
                    </Button>
                  </div>
                </div>

                {/* Mobile stacked layout */}
                <div className="lg:hidden space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">
                          {user.full_name || 'No name'}
                        </p>
                        {user.is_platform_admin && (
                          <Badge className="bg-purple-500/20 text-purple-400 border-purple-500/30">
                            Admin
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground truncate">
                        {user.email || '-'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        @{user.username || '-'} · Joined{' '}
                        {formatDate(user.created_at)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant={
                        user.is_platform_admin ? 'destructive' : 'outline'
                      }
                      size="sm"
                      onClick={() => toggleAdmin(user)}
                      disabled={
                        togglingId === user.id || deletingId === user.id
                      }
                    >
                      {togglingId === user.id
                        ? '...'
                        : user.is_platform_admin
                          ? 'Remove Admin'
                          : 'Make Admin'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(user)}
                      disabled={
                        deletingId === user.id ||
                        togglingId === user.id ||
                        user.is_platform_admin
                      }
                      className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    >
                      {deletingId === user.id ? '...' : 'Delete'}
                    </Button>
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
