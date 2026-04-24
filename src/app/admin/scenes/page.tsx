'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Card,
  CardContent,
  Skeleton,
  EmptyState,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@braintwopoint0/playback-commons/ui'
import {
  Camera,
  MapPin,
  Save,
  Unlink,
  AlertTriangle,
  Building2,
  X,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────

interface SpiideoScene {
  id: string
  name: string
  accountId: string
}

interface SceneMapping {
  scene_id: string
  organization_id: string | null
  scene_name: string | null
  created_at: string | null
}

interface Organization {
  id: string
  name: string
  slug: string | null
  type: string
  logo_url: string | null
}

// ── Main Page ──────────────────────────────────────────────────────

export default function AdminScenesPage() {
  const [scenes, setScenes] = useState<SpiideoScene[]>([])
  const [mappings, setMappings] = useState<SceneMapping[]>([])
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [loading, setLoading] = useState(true)
  const [spiideoError, setSpiideoError] = useState<string | null>(null)
  const [updating, setUpdating] = useState<string | null>(null)

  // Local edits per scene (only set when user changes something)
  const [edits, setEdits] = useState<
    Record<string, { organizationId: string; sceneName: string }>
  >({})
  const [actionError, setActionError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const [scenesRes, orgsRes] = await Promise.all([
        fetch('/api/admin?section=scenes'),
        fetch('/api/admin?section=organizations'),
      ])
      const scenesData = await scenesRes.json()
      const orgsData = await orgsRes.json()

      setScenes(scenesData.spiideoScenes || [])
      setMappings(scenesData.mappings || [])
      setSpiideoError(scenesData.error || null)
      setOrgs(orgsData.organizations || [])
    } catch (err) {
      console.error('Failed to fetch data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // ── Helpers ────────────────────────────────────────────────────

  const mappingBySceneId = new Map(mappings.map((m) => [m.scene_id, m]))
  const venueOrgs = orgs.filter((o) => o.type === 'venue')
  const orgById = (id: string) => orgs.find((o) => o.id === id)

  const assignedCount = scenes.filter((s) => mappingBySceneId.has(s.id)).length
  const unassignedCount = scenes.length - assignedCount

  // Count scenes per venue
  const scenesPerVenue = new Map<string, number>()
  mappings.forEach((m) => {
    if (m.organization_id) {
      scenesPerVenue.set(
        m.organization_id,
        (scenesPerVenue.get(m.organization_id) || 0) + 1
      )
    }
  })

  function getSceneState(sceneId: string) {
    const edit = edits[sceneId]
    const mapping = mappingBySceneId.get(sceneId)
    return {
      organizationId: edit?.organizationId ?? mapping?.organization_id ?? '',
      sceneName: edit?.sceneName ?? mapping?.scene_name ?? '',
    }
  }

  function hasUnsavedChanges(sceneId: string) {
    const edit = edits[sceneId]
    if (!edit) return false
    const mapping = mappingBySceneId.get(sceneId)
    const currentOrgId = mapping?.organization_id ?? ''
    const currentName = mapping?.scene_name ?? ''
    return (
      edit.organizationId !== currentOrgId || edit.sceneName !== currentName
    )
  }

  function updateEdit(
    sceneId: string,
    field: 'organizationId' | 'sceneName',
    value: string
  ) {
    setEdits((prev) => {
      const mapping = mappingBySceneId.get(sceneId)
      const current = prev[sceneId] ?? {
        organizationId: mapping?.organization_id ?? '',
        sceneName: mapping?.scene_name ?? '',
      }
      return { ...prev, [sceneId]: { ...current, [field]: value } }
    })
  }

  // ── Actions ────────────────────────────────────────────────────

  async function handleSave(sceneId: string) {
    const state = getSceneState(sceneId)
    setUpdating(sceneId)
    setActionError(null)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsertSceneMapping',
          sceneId,
          organizationId: state.organizationId || null,
          sceneName: state.sceneName || null,
        }),
      })
      if (res.ok) {
        setEdits((prev) => {
          const next = { ...prev }
          delete next[sceneId]
          return next
        })
        await fetchData()
      } else {
        const data = await res.json()
        setActionError(data.error || 'Failed to save scene mapping')
      }
    } catch (err) {
      setActionError('Network error')
    } finally {
      setUpdating(null)
    }
  }

  async function handleUnassign(sceneId: string) {
    setUpdating(sceneId)
    setActionError(null)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'upsertSceneMapping',
          sceneId,
          organizationId: null,
        }),
      })
      if (res.ok) {
        setEdits((prev) => {
          const next = { ...prev }
          delete next[sceneId]
          return next
        })
        await fetchData()
      } else {
        const data = await res.json()
        setActionError(data.error || 'Failed to unassign scene')
      }
    } catch (err) {
      setActionError('Network error')
    } finally {
      setUpdating(null)
    }
  }

  // ── Render ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-20 rounded-lg" />
        ))}
      </div>
    )
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Scene Management</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {scenes.length} scene{scenes.length !== 1 ? 's' : ''} from Spiideo
          &middot; {assignedCount} assigned &middot; {unassignedCount}{' '}
          unassigned
        </p>
      </div>

      {/* Spiideo error warning */}
      {spiideoError && (
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-amber-400/30 bg-amber-400/10 text-amber-400 text-sm mb-6">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Could not fetch scenes from Spiideo: {spiideoError}. Showing cached
            mappings only.
          </span>
        </div>
      )}

      {/* Action error */}
      {actionError && (
        <div className="flex items-center justify-between px-4 py-3 rounded-lg border border-red-500/20 bg-red-500/10 text-red-400 text-sm mb-6">
          <span>{actionError}</span>
          <button
            onClick={() => setActionError(null)}
            className="text-red-400 hover:text-red-300 ml-3"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-[var(--timberwolf)]/20 bg-[var(--timberwolf)]/5">
          <Camera className="h-4 w-4 shrink-0 text-[var(--timberwolf)]" />
          <div>
            <p className="text-xs text-muted-foreground">Total Scenes</p>
            <p className="text-lg font-semibold leading-none mt-0.5">
              {scenes.length}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 px-4 py-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10">
          <MapPin className="h-4 w-4 shrink-0 text-emerald-400" />
          <div>
            <p className="text-xs text-muted-foreground">Assigned</p>
            <p className="text-lg font-semibold leading-none mt-0.5 text-emerald-400">
              {assignedCount}
            </p>
          </div>
        </div>
        <div
          className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
            unassignedCount > 0
              ? 'border-amber-400/30 bg-amber-400/10'
              : 'border-emerald-400/30 bg-emerald-400/10'
          }`}
        >
          <Unlink
            className={`h-4 w-4 shrink-0 ${unassignedCount > 0 ? 'text-amber-400' : 'text-emerald-400'}`}
          />
          <div>
            <p className="text-xs text-muted-foreground">Unassigned</p>
            <p
              className={`text-lg font-semibold leading-none mt-0.5 ${unassignedCount > 0 ? 'text-amber-400' : 'text-emerald-400'}`}
            >
              {unassignedCount}
            </p>
          </div>
        </div>
      </div>

      {/* Scene list */}
      {scenes.length === 0 && !spiideoError ? (
        <EmptyState
          icon={<Camera className="h-10 w-10" />}
          title="No scenes found"
          description="No scenes available from the Spiideo account."
        />
      ) : (
        <div className="space-y-3 mb-8">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
            Spiideo Scenes
          </h2>
          {scenes.map((scene) => {
            const state = getSceneState(scene.id)
            const mapping = mappingBySceneId.get(scene.id)
            const isAssigned = !!mapping?.organization_id
            const venue = isAssigned ? orgById(mapping!.organization_id!) : null
            const isUpdating = updating === scene.id
            const hasChanges = hasUnsavedChanges(scene.id)

            return (
              <Card key={scene.id}>
                <CardContent className="p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    {/* Scene info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Camera className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-medium text-sm">
                          {scene.name}
                        </span>
                        {isAssigned && venue && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-400/15 text-emerald-400 border border-emerald-400/20">
                            {venue.name}
                          </span>
                        )}
                        {!isAssigned && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-400 border border-amber-400/20">
                            Unassigned
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                        {scene.id}
                      </p>
                    </div>

                    {/* Assignment controls */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Select
                        value={state.organizationId || '_unassigned'}
                        onValueChange={(val) =>
                          updateEdit(
                            scene.id,
                            'organizationId',
                            val === '_unassigned' ? '' : val
                          )
                        }
                        disabled={isUpdating}
                      >
                        <SelectTrigger className="w-[200px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="_unassigned">
                            Unassigned
                          </SelectItem>
                          {venueOrgs.map((v) => (
                            <SelectItem key={v.id} value={v.id}>
                              {v.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Input
                        value={state.sceneName}
                        onChange={(e) =>
                          updateEdit(scene.id, 'sceneName', e.target.value)
                        }
                        disabled={isUpdating}
                        placeholder={scene.name}
                        title="Custom scene name"
                        maxLength={100}
                        className="w-[140px]"
                      />

                      <button
                        onClick={() => handleSave(scene.id)}
                        disabled={isUpdating || !hasChanges}
                        title="Save changes"
                        className="p-1.5 text-muted-foreground hover:text-emerald-400 transition-colors disabled:opacity-30"
                      >
                        <Save className="h-4 w-4" />
                      </button>

                      {isAssigned && (
                        <button
                          onClick={() => handleUnassign(scene.id)}
                          disabled={isUpdating}
                          title="Unassign from venue"
                          className="p-1.5 text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-30"
                        >
                          <Unlink className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Venue coverage */}
      {venueOrgs.length > 0 && (
        <div>
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
            Venue Coverage
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {venueOrgs.map((venue) => {
              const count = scenesPerVenue.get(venue.id) || 0
              return (
                <div
                  key={venue.id}
                  className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${
                    count > 0
                      ? 'border-emerald-400/20 bg-emerald-400/5'
                      : 'border-amber-400/20 bg-amber-400/5'
                  }`}
                >
                  {venue.logo_url ? (
                    <img
                      src={venue.logo_url}
                      alt={venue.name}
                      className="w-6 h-6 rounded object-cover"
                    />
                  ) : (
                    <Building2 className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{venue.name}</p>
                    <p
                      className={`text-xs ${count > 0 ? 'text-emerald-400' : 'text-amber-400'}`}
                    >
                      {count > 0
                        ? `${count} scene${count > 1 ? 's' : ''}`
                        : 'No scenes assigned'}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
