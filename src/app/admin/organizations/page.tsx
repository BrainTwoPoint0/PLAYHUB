'use client'

import { useEffect, useState, useCallback } from 'react'
import {
  Card,
  CardContent,
  Skeleton,
  EmptyState,
} from '@braintwopoint0/playback-commons/ui'
import {
  Layers,
  Video,
  Radio,
  Palette,
  ShoppingBag,
  ChevronDown,
  ChevronRight,
  Building2,
  GitBranch,
  Link2,
  Plus,
  Trash2,
  Crown,
  MapPin,
  Trophy,
  GraduationCap,
  ArrowRight,
} from 'lucide-react'

// ── Types ──────────────────────────────────────────────────────────

interface Organization {
  id: string
  name: string
  slug: string | null
  type: string
  logo_url: string | null
  is_active: boolean
  is_verified: boolean
  marketplace_enabled: boolean
  feature_recordings: boolean
  feature_streaming: boolean
  feature_graphic_packages: boolean
  parent_organization_id: string | null
  parent_name: string | null
  children: { id: string; name: string; slug: string; type: string }[]
  created_at: string
}

interface VenueAccess {
  id: string
  organization_id: string
  venue_organization_id: string
  can_record: boolean
  can_stream: boolean
  billing_responsibility: string
  is_active: boolean
  notes: string | null
  created_at: string
}

// ── Constants ──────────────────────────────────────────────────────

const TYPE_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  group: { label: 'Group', icon: Crown, color: 'text-amber-400 bg-amber-400/15 border-amber-400/30' },
  venue: { label: 'Venue', icon: MapPin, color: 'text-emerald-400 bg-emerald-400/15 border-emerald-400/30' },
  league: { label: 'League', icon: Trophy, color: 'text-sky-400 bg-sky-400/15 border-sky-400/30' },
  academy: { label: 'Academy', icon: GraduationCap, color: 'text-violet-400 bg-violet-400/15 border-violet-400/30' },
}

const featureFlags = [
  { key: 'feature_recordings' as const, label: 'Recordings', icon: Video },
  { key: 'feature_streaming' as const, label: 'Streaming', icon: Radio },
  { key: 'feature_graphic_packages' as const, label: 'Graphics', icon: Palette },
  { key: 'marketplace_enabled' as const, label: 'Marketplace', icon: ShoppingBag },
]

const BILLING_LABELS: Record<string, string> = {
  venue: 'Venue pays',
  tenant: 'Tenant pays',
  none: 'Free',
  split: 'Split',
}

// ── Main Page ──────────────────────────────────────────────────────

export default function AdminOrganizationsPage() {
  const [orgs, setOrgs] = useState<Organization[]>([])
  const [venueAccess, setVenueAccess] = useState<VenueAccess[]>([])
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState<string | null>(null)
  const [expandedOrg, setExpandedOrg] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'hierarchy' | 'access'>('hierarchy')

  // New venue access form state
  const [showAccessForm, setShowAccessForm] = useState(false)
  const [accessForm, setAccessForm] = useState({
    organization_id: '',
    venue_organization_id: '',
    can_record: true,
    can_stream: false,
    billing_responsibility: 'venue',
  })

  const fetchData = useCallback(async () => {
    try {
      const [orgsRes, accessRes] = await Promise.all([
        fetch('/api/admin?section=organizations'),
        fetch('/api/admin?section=venue-access'),
      ])
      const orgsData = await orgsRes.json()
      const accessData = await accessRes.json()
      setOrgs(orgsData.organizations || [])
      setVenueAccess(accessData.venueAccess || [])
    } catch (err) {
      console.error('Failed to fetch data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchData() }, [fetchData])

  // ── Actions ────────────────────────────────────────────────────

  async function toggleFeature(orgId: string, featureKey: string, currentValue: boolean) {
    setUpdating(`${orgId}-${featureKey}`)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'updateOrgFeatures', orgId, features: { [featureKey]: !currentValue } }),
      })
      if (res.ok) {
        setOrgs((prev) => prev.map((o) => o.id === orgId ? { ...o, [featureKey]: !currentValue } : o))
      }
    } catch (err) {
      console.error('Failed to update feature:', err)
    } finally {
      setUpdating(null)
    }
  }

  async function handleSetParent(childOrgId: string, parentOrgId: string | null) {
    setUpdating(`parent-${childOrgId}`)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setParentOrg', childOrgId, parentOrgId }),
      })
      if (res.ok) {
        await fetchData()
      } else {
        const err = await res.json()
        alert(err.error || 'Failed to set parent')
      }
    } catch (err) {
      console.error('Failed to set parent:', err)
    } finally {
      setUpdating(null)
    }
  }

  async function handleCreateAccess() {
    if (!accessForm.organization_id || !accessForm.venue_organization_id) return
    setUpdating('create-access')
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'upsertVenueAccess', venueAccessData: accessForm }),
      })
      if (res.ok) {
        setShowAccessForm(false)
        setAccessForm({ organization_id: '', venue_organization_id: '', can_record: true, can_stream: false, billing_responsibility: 'venue' })
        await fetchData()
      } else {
        const err = await res.json()
        alert(err.error || 'Failed to create access')
      }
    } catch (err) {
      console.error('Failed to create access:', err)
    } finally {
      setUpdating(null)
    }
  }

  async function handleDeleteAccess(id: string) {
    if (!confirm('Remove this venue access?')) return
    setUpdating(`delete-${id}`)
    try {
      const res = await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteVenueAccess', venueAccessId: id }),
      })
      if (res.ok) await fetchData()
    } catch (err) {
      console.error('Failed to delete access:', err)
    } finally {
      setUpdating(null)
    }
  }

  // ── Helpers ────────────────────────────────────────────────────

  const orgById = (id: string) => orgs.find((o) => o.id === id)
  const groupOrgs = orgs.filter((o) => o.type === 'group')
  const childOrgIds = new Set(orgs.filter((o) => o.parent_organization_id).map((o) => o.id))
  const topLevelOrgs = orgs.filter((o) => !o.parent_organization_id)
  const venueOrgs = orgs.filter((o) => o.type === 'venue')
  const nonVenueOrgs = orgs.filter((o) => o.type !== 'venue' && o.type !== 'group')

  // ── Render ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-3">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
        </div>
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-48 rounded-lg" />)}
      </div>
    )
  }

  return (
    <div>
      {/* Header with stats */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Organizations</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {orgs.length} organizations &middot; {groupOrgs.length} groups &middot; {venueAccess.length} venue access entries
          </p>
        </div>
      </div>

      {/* Type breakdown */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        {Object.entries(TYPE_CONFIG).map(([type, config]) => {
          const count = orgs.filter((o) => o.type === type).length
          const Icon = config.icon
          return (
            <div
              key={type}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg border ${config.color}`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <div>
                <p className="text-xs opacity-70">{config.label}</p>
                <p className="text-lg font-semibold leading-none mt-0.5">{count}</p>
              </div>
            </div>
          )
        })}
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-6 p-1 bg-muted/30 rounded-lg w-fit">
        <button
          onClick={() => setActiveTab('hierarchy')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'hierarchy'
              ? 'bg-[var(--night)] text-[var(--timberwolf)] shadow-sm'
              : 'text-muted-foreground hover:text-[var(--timberwolf)]'
          }`}
        >
          <GitBranch className="h-3.5 w-3.5" />
          Hierarchy & Features
        </button>
        <button
          onClick={() => setActiveTab('access')}
          className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${
            activeTab === 'access'
              ? 'bg-[var(--night)] text-[var(--timberwolf)] shadow-sm'
              : 'text-muted-foreground hover:text-[var(--timberwolf)]'
          }`}
        >
          <Link2 className="h-3.5 w-3.5" />
          Venue Access
        </button>
      </div>

      {/* ── Hierarchy Tab ─────────────────────────────────────── */}
      {activeTab === 'hierarchy' && (
        <div className="space-y-3">
          {orgs.length === 0 ? (
            <EmptyState icon={<Layers className="h-10 w-10" />} title="No organizations found" />
          ) : (
            topLevelOrgs.map((org) => (
              <div key={org.id}>
                <OrgCard
                  org={org}
                  orgs={orgs}
                  groupOrgs={groupOrgs}
                  updating={updating}
                  expandedOrg={expandedOrg}
                  onToggleExpand={() => setExpandedOrg(expandedOrg === org.id ? null : org.id)}
                  onToggleFeature={toggleFeature}
                  onSetParent={handleSetParent}
                  isChild={false}
                />
                {/* Child orgs (indented) */}
                {org.children?.length > 0 && org.children.map((child) => {
                  const childOrg = orgById(child.id)
                  if (!childOrg) return null
                  return (
                    <div key={child.id} className="ml-8 mt-2 relative">
                      <div className="absolute -left-4 top-5 w-4 border-b border-l border-muted-foreground/20 h-6 rounded-bl-md" />
                      <OrgCard
                        org={childOrg}
                        orgs={orgs}
                        groupOrgs={groupOrgs}
                        updating={updating}
                        expandedOrg={expandedOrg}
                        onToggleExpand={() => setExpandedOrg(expandedOrg === childOrg.id ? null : childOrg.id)}
                        onToggleFeature={toggleFeature}
                        onSetParent={handleSetParent}
                        isChild={true}
                      />
                    </div>
                  )
                })}
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Venue Access Tab ──────────────────────────────────── */}
      {activeTab === 'access' && (
        <div className="space-y-4">
          {/* Create new access */}
          {!showAccessForm ? (
            <button
              onClick={() => setShowAccessForm(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-dashed border-muted-foreground/30 text-sm text-muted-foreground hover:border-[var(--timberwolf)]/40 hover:text-[var(--timberwolf)] transition-colors w-full justify-center"
            >
              <Plus className="h-4 w-4" />
              Add Venue Access
            </button>
          ) : (
            <Card>
              <CardContent className="p-4 space-y-4">
                <h3 className="font-semibold text-sm">New Venue Access</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1.5">Tenant Organization</label>
                    <select
                      value={accessForm.organization_id}
                      onChange={(e) => setAccessForm((f) => ({ ...f, organization_id: e.target.value }))}
                      className="w-full bg-muted/50 border border-border rounded-md px-3 py-2 text-sm"
                    >
                      <option value="">Select tenant org...</option>
                      {nonVenueOrgs.map((o) => (
                        <option key={o.id} value={o.id}>{o.name} ({TYPE_CONFIG[o.type]?.label})</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground block mb-1.5">Venue</label>
                    <select
                      value={accessForm.venue_organization_id}
                      onChange={(e) => setAccessForm((f) => ({ ...f, venue_organization_id: e.target.value }))}
                      className="w-full bg-muted/50 border border-border rounded-md px-3 py-2 text-sm"
                    >
                      <option value="">Select venue...</option>
                      {venueOrgs.map((o) => (
                        <option key={o.id} value={o.id}>{o.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={accessForm.can_record}
                      onChange={(e) => setAccessForm((f) => ({ ...f, can_record: e.target.checked }))}
                      className="rounded"
                    />
                    Can Record
                  </label>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={accessForm.can_stream}
                      onChange={(e) => setAccessForm((f) => ({ ...f, can_stream: e.target.checked }))}
                      className="rounded"
                    />
                    Can Stream
                  </label>
                  <div>
                    <select
                      value={accessForm.billing_responsibility}
                      onChange={(e) => setAccessForm((f) => ({ ...f, billing_responsibility: e.target.value }))}
                      className="w-full bg-muted/50 border border-border rounded-md px-3 py-2 text-sm"
                    >
                      <option value="venue">Venue pays</option>
                      <option value="tenant">Tenant pays</option>
                      <option value="none">Free (league model)</option>
                      <option value="split">Split</option>
                    </select>
                  </div>
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => setShowAccessForm(false)}
                    className="px-3 py-1.5 text-sm text-muted-foreground hover:text-[var(--timberwolf)] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleCreateAccess}
                    disabled={updating === 'create-access' || !accessForm.organization_id || !accessForm.venue_organization_id}
                    className="px-4 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors disabled:opacity-40"
                  >
                    {updating === 'create-access' ? 'Creating...' : 'Create Access'}
                  </button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Existing access entries */}
          {venueAccess.length === 0 ? (
            <EmptyState icon={<Link2 className="h-10 w-10" />} title="No venue access entries" />
          ) : (
            venueAccess.map((access) => {
              const tenantOrg = orgById(access.organization_id)
              const venueOrg = orgById(access.venue_organization_id)
              return (
                <Card key={access.id}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        {/* Tenant org */}
                        <div className="flex items-center gap-2">
                          <TypeBadge type={tenantOrg?.type || 'league'} size="sm" />
                          <span className="font-medium text-sm">{tenantOrg?.name || 'Unknown'}</span>
                        </div>
                        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        {/* Venue */}
                        <div className="flex items-center gap-2">
                          <TypeBadge type="venue" size="sm" />
                          <span className="font-medium text-sm">{venueOrg?.name || 'Unknown'}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        {/* Permission badges */}
                        <div className="flex items-center gap-1.5">
                          {access.can_record && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-400/15 text-emerald-400 border border-emerald-400/20">
                              REC
                            </span>
                          )}
                          {access.can_stream && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-400/15 text-sky-400 border border-sky-400/20">
                              LIVE
                            </span>
                          )}
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {BILLING_LABELS[access.billing_responsibility] || access.billing_responsibility}
                          </span>
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${access.is_active ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
                          {access.is_active ? 'Active' : 'Inactive'}
                        </span>
                        <button
                          onClick={() => handleDeleteAccess(access.id)}
                          disabled={updating === `delete-${access.id}`}
                          className="p-1.5 text-muted-foreground hover:text-red-400 transition-colors"
                          title="Remove access"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// ── Subcomponents ────────────────────────────────────────────────

function TypeBadge({ type, size = 'md' }: { type: string; size?: 'sm' | 'md' }) {
  const config = TYPE_CONFIG[type] || TYPE_CONFIG.venue
  const Icon = config.icon
  const sizeClasses = size === 'sm' ? 'text-[10px] px-1.5 py-0.5 gap-1' : 'text-xs px-2 py-0.5 gap-1.5'
  const iconSize = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'

  return (
    <span className={`inline-flex items-center rounded-full border font-medium ${sizeClasses} ${config.color}`}>
      <Icon className={iconSize} />
      {config.label}
    </span>
  )
}

function OrgCard({
  org,
  orgs,
  groupOrgs,
  updating,
  expandedOrg,
  onToggleExpand,
  onToggleFeature,
  onSetParent,
  isChild,
}: {
  org: Organization
  orgs: Organization[]
  groupOrgs: Organization[]
  updating: string | null
  expandedOrg: string | null
  onToggleExpand: () => void
  onToggleFeature: (orgId: string, key: string, val: boolean) => void
  onSetParent: (childId: string, parentId: string | null) => void
  isChild: boolean
}) {
  const isExpanded = expandedOrg === org.id
  const hasChildren = org.children?.length > 0

  return (
    <Card className={isChild ? 'border-muted-foreground/15' : ''}>
      <CardContent className="p-4">
        {/* Header row */}
        <div className="flex items-center gap-3">
          <button onClick={onToggleExpand} className="text-muted-foreground hover:text-[var(--timberwolf)] transition-colors">
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>

          {org.logo_url ? (
            <img src={org.logo_url} alt={org.name} className="w-8 h-8 rounded-md object-cover" />
          ) : (
            <div className="w-8 h-8 rounded-md bg-muted flex items-center justify-center">
              <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
          )}

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-semibold">{org.name}</h3>
              <TypeBadge type={org.type} />
              {isChild && org.parent_name && (
                <span className="text-[10px] text-muted-foreground">
                  child of {org.parent_name}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{org.slug ? `/${org.slug}` : 'No slug'}</p>
          </div>

          <div className="flex items-center gap-2">
            {hasChildren && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-400 border border-amber-400/20">
                {org.children.length} child{org.children.length > 1 ? 'ren' : ''}
              </span>
            )}
            {org.is_verified && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400">
                Verified
              </span>
            )}
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${org.is_active ? 'bg-green-500/15 text-green-400' : 'bg-red-500/15 text-red-400'}`}>
              {org.is_active ? 'Active' : 'Inactive'}
            </span>
          </div>
        </div>

        {/* Expanded content */}
        {isExpanded && (
          <div className="mt-4 space-y-4 pt-4 border-t border-border/50">
            {/* Feature toggles */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Features</p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {featureFlags.map((feature) => {
                  const isEnabled = org[feature.key]
                  const isUpdating = updating === `${org.id}-${feature.key}`
                  const Icon = feature.icon
                  return (
                    <button
                      key={feature.key}
                      onClick={() => onToggleFeature(org.id, feature.key, isEnabled)}
                      disabled={isUpdating}
                      className={`flex items-center gap-2 px-3 py-2 rounded-md border text-xs font-medium transition-all ${
                        isEnabled
                          ? 'border-green-500/30 bg-green-500/10 text-green-400'
                          : 'border-border bg-muted/20 text-muted-foreground opacity-60'
                      } ${isUpdating ? 'opacity-30 cursor-wait' : 'hover:opacity-100 cursor-pointer'}`}
                    >
                      <Icon className="h-3 w-3 shrink-0" />
                      {feature.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Parent org assignment (only for non-group orgs) */}
            {org.type !== 'group' && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">Parent Organization</p>
                <div className="flex items-center gap-3">
                  <select
                    value={org.parent_organization_id || ''}
                    onChange={(e) => onSetParent(org.id, e.target.value || null)}
                    disabled={updating === `parent-${org.id}`}
                    className="bg-muted/50 border border-border rounded-md px-3 py-1.5 text-sm max-w-xs"
                  >
                    <option value="">No parent (independent)</option>
                    {groupOrgs.map((g) => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                  {updating === `parent-${org.id}` && (
                    <span className="text-xs text-muted-foreground animate-pulse">Updating...</span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
