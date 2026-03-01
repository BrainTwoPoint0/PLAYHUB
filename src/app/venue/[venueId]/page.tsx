'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { Button, Input, Select, SelectTrigger, SelectValue, SelectContent, SelectItem, DateTimePicker } from '@braintwopoint0/playback-commons/ui'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@braintwopoint0/playback-commons/ui'
import type { ChartConfig } from '@braintwopoint0/playback-commons/ui'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
} from 'recharts'
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
  is_billable?: boolean
  billable_amount?: number
  collected_by?: string
  graphic_package_id?: string
  graphicPackageName?: string
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

interface BillingSummary {
  totalRevenue: number
  currency: string
  count: number
  venueCollectedCount: number
  venueCollectedRevenue: number
  venueOwesPlayhub: number
  playhubCollectedCount: number
  playhubCollectedRevenue: number
  playhubOwesVenue: number
  venueKeeps: number // venue's profit share they retain (venue-collected only)
  venueTotalProfit: number // total venue profit from both sources
  netBalance: number // positive = venue owes PLAYHUB, negative = PLAYHUB owes venue
  dailyTarget: number
  todayCount: number
}

interface DailyStats {
  days: Array<{
    date: string
    total: number
    byScene: Record<string, number>
    revenue: number
  }>
  averagePerDay: number
  dailyTarget: number
  scenes: string[]
  currency: string
}

interface BillingConfig {
  default_billable_amount: number
  currency: string
  daily_recording_target: number
  is_active: boolean
  youtube_rtmp_url?: string | null
  youtube_stream_key?: string | null
  marketplace_revenue_split_pct?: number
}

interface Invoice {
  id: string
  period_start: string
  period_end: string
  venue_collected_count: number
  venue_owes_playhub: number
  playhub_collected_count: number
  playhub_owes_venue: number
  net_amount: number
  currency: string
  stripe_invoice_id: string | null
  status: string
}

// ── Marketplace Revenue ───────────────────────────────────────────
function MarketplaceRevenue({
  venueId,
  outlineBtnClass,
}: {
  venueId: string
  outlineBtnClass: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [data, setData] = useState<{
    totalSales: number
    totalRevenue: number
    orgShare: number
    playhubShare: number
    splitPct: number
    currency: string
    perRecording: Array<{
      recordingId: string
      title: string
      matchDate: string
      sales: number
      revenue: number
      orgShare: number
    }>
  } | null>(null)

  async function fetchRevenue() {
    setLoading(true)
    try {
      const res = await fetch(`/api/venue/${venueId}/billing/marketplace`)
      const json = await res.json()
      if (!json.error) setData(json)
    } catch {
      // Non-critical
    } finally {
      setLoading(false)
    }
  }

  function handleToggle() {
    if (!expanded && !data) fetchRevenue()
    setExpanded(!expanded)
  }

  function formatPrice(amount: number, currency: string) {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(amount)
  }

  return (
    <div className="mb-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
      <div className="p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
              Marketplace Revenue
            </h2>
            <p className="text-sm text-[var(--ash-grey)]">
              Sales from recordings listed on the marketplace
            </p>
          </div>
          <Button
            variant="outline"
            className={`w-full md:w-auto ${outlineBtnClass}`}
            onClick={handleToggle}
          >
            {expanded ? 'Hide' : 'View Revenue'}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="px-6 pb-6">
          {loading ? (
            <p className="text-sm text-[var(--ash-grey)]">Loading...</p>
          ) : !data || data.totalSales === 0 ? (
            <p className="text-sm text-[var(--ash-grey)]">No marketplace sales yet.</p>
          ) : (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-[var(--ash-grey)]/[0.06]">
                {[
                  { label: 'Total Sales', value: String(data.totalSales) },
                  {
                    label: 'Total Revenue',
                    value: formatPrice(data.totalRevenue, data.currency),
                  },
                  {
                    label: `Your Share (${100 - data.splitPct}%)`,
                    value: formatPrice(data.orgShare, data.currency),
                  },
                  {
                    label: `PLAYHUB (${data.splitPct}%)`,
                    value: formatPrice(data.playhubShare, data.currency),
                  },
                ].map((card) => (
                  <div key={card.label} className="bg-[var(--night)] p-3.5">
                    <p className="text-xs text-[var(--ash-grey)] mb-1">
                      {card.label}
                    </p>
                    <p className="text-lg font-semibold text-[var(--timberwolf)]">
                      {card.value}
                    </p>
                  </div>
                ))}
              </div>

              {/* Per-recording breakdown */}
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-[var(--timberwolf)]">
                  Per Recording
                </h3>
                {data.perRecording.map((rec) => (
                  <div
                    key={rec.recordingId}
                    className="flex items-center justify-between p-3 rounded-lg bg-white/[0.03] border border-[var(--ash-grey)]/10"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-[var(--timberwolf)] truncate">
                        {rec.title}
                      </p>
                      <p className="text-xs text-[var(--ash-grey)]">
                        {rec.sales} sale{rec.sales !== 1 ? 's' : ''}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                      <p className="text-sm font-semibold text-[var(--timberwolf)]">
                        {formatPrice(rec.orgShare, data.currency)}
                      </p>
                      <p className="text-xs text-[var(--ash-grey)]">
                        of {formatPrice(rec.revenue, data.currency)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Venue Settings (YouTube, Marketplace, Media Pack) ─────────────
function VenueSettings({
  venueId,
  billingConfig,
  onSaved,
  inputClass,
  outlineBtnClass,
  primaryBtnClass,
}: {
  venueId: string
  billingConfig: BillingConfig | null
  onSaved: (config: BillingConfig) => void
  inputClass: string
  outlineBtnClass: string
  primaryBtnClass: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  // Local form state
  const [youtubeRtmpUrl, setYoutubeRtmpUrl] = useState(billingConfig?.youtube_rtmp_url || '')
  const [youtubeStreamKey, setYoutubeStreamKey] = useState(billingConfig?.youtube_stream_key || '')

  // Sync when billingConfig loads/changes
  useEffect(() => {
    if (!billingConfig) return
    setYoutubeRtmpUrl(billingConfig.youtube_rtmp_url || '')
    setYoutubeStreamKey(billingConfig.youtube_stream_key || '')
  }, [billingConfig])

  async function handleSave() {
    setSaving(true)
    setSavedMsg(null)
    try {
      const res = await fetch(`/api/venue/${venueId}/billing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...billingConfig,
          youtube_rtmp_url: youtubeRtmpUrl || null,
          youtube_stream_key: youtubeStreamKey || null,
        }),
      })
      const data = await res.json()
      if (data.config) {
        onSaved(data.config)
        setSavedMsg('Settings saved')
        setTimeout(() => setSavedMsg(null), 3000)
      }
    } catch {
      setSavedMsg('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
      <div className="p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
            Venue Settings
          </h2>
          <Button
            variant="outline"
            className={`w-full md:w-auto ${outlineBtnClass}`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Hide' : 'Configure'}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="px-6 pb-6 space-y-6">
          {/* YouTube Settings */}
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-[var(--timberwolf)] uppercase tracking-wider">
              YouTube Broadcasting
            </h3>
            <p className="text-xs text-[var(--ash-grey)]">
              Configure RTMP to broadcast recordings live to YouTube
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-[var(--ash-grey)]">RTMP URL</label>
                <Input
                  value={youtubeRtmpUrl}
                  onChange={(e) => setYoutubeRtmpUrl(e.target.value)}
                  placeholder="rtmp://a.rtmp.youtube.com/live2"
                  className={inputClass}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-[var(--ash-grey)]">Stream Key</label>
                <Input
                  type="password"
                  value={youtubeStreamKey}
                  onChange={(e) => setYoutubeStreamKey(e.target.value)}
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  className={inputClass}
                />
              </div>
            </div>
          </div>

          {/* Save button */}
          <div className="flex items-center gap-3">
            <Button
              onClick={handleSave}
              disabled={saving}
              className={primaryBtnClass}
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </Button>
            {savedMsg && (
              <span className="text-sm text-emerald-400">{savedMsg}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Graphic Packages (Account-based) ──────────────────────────────
interface GraphicPackage {
  id: string
  organization_id: string
  name: string
  is_default: boolean
  logo_url: string | null
  logo_position: string
  sponsor_logo_url: string | null
  sponsor_position: string
  spiideo_graphic_package_id: string | null
  created_at: string
  updated_at: string
}

function GraphicPackagesSection({
  venueSlug,
  inputClass,
  outlineBtnClass,
  primaryBtnClass,
}: {
  venueSlug: string | null
  inputClass: string
  outlineBtnClass: string
  primaryBtnClass: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [packages, setPackages] = useState<GraphicPackage[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Create/Edit form state
  const [showForm, setShowForm] = useState(false)
  const [editingPkg, setEditingPkg] = useState<GraphicPackage | null>(null)
  const [formName, setFormName] = useState('')
  const [formLogoUrl, setFormLogoUrl] = useState('')
  const [formLogoPosition, setFormLogoPosition] = useState('top-right')
  const [formSponsorUrl, setFormSponsorUrl] = useState('')
  const [formSponsorPosition, setFormSponsorPosition] = useState('bottom-left')
  const [formIsDefault, setFormIsDefault] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [uploadingSponsor, setUploadingSponsor] = useState(false)

  async function uploadFile(file: File, type: 'logo' | 'sponsor'): Promise<string | null> {
    if (!venueSlug) return null
    const formData = new FormData()
    formData.append('file', file)
    formData.append('type', type)
    const res = await fetch(`/api/org/${venueSlug}/graphic-packages/upload`, {
      method: 'POST',
      body: formData,
    })
    if (!res.ok) {
      const data = await res.json()
      setError(data.error || 'Upload failed')
      return null
    }
    const data = await res.json()
    return data.url
  }

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingLogo(true)
    setError(null)
    const url = await uploadFile(file, 'logo')
    if (url) setFormLogoUrl(url)
    setUploadingLogo(false)
    e.target.value = ''
  }

  async function handleSponsorUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploadingSponsor(true)
    setError(null)
    const url = await uploadFile(file, 'sponsor')
    if (url) setFormSponsorUrl(url)
    setUploadingSponsor(false)
    e.target.value = ''
  }

  async function fetchPackages() {
    if (!venueSlug) return
    setLoading(true)
    try {
      const res = await fetch(`/api/org/${venueSlug}/graphic-packages`)
      const data = await res.json()
      setPackages(data.packages || [])
    } catch {
      setError('Failed to load graphic packages')
    } finally {
      setLoading(false)
    }
  }

  function openCreateForm() {
    setEditingPkg(null)
    setFormName('')
    setFormLogoUrl('')
    setFormLogoPosition('top-right')
    setFormSponsorUrl('')
    setFormSponsorPosition('bottom-left')
    setFormIsDefault(packages.length === 0)
    setShowForm(true)
  }

  function openEditForm(pkg: GraphicPackage) {
    setEditingPkg(pkg)
    setFormName(pkg.name)
    setFormLogoUrl(pkg.logo_url || '')
    setFormLogoPosition(pkg.logo_position)
    setFormSponsorUrl(pkg.sponsor_logo_url || '')
    setFormSponsorPosition(pkg.sponsor_position)
    setFormIsDefault(pkg.is_default)
    setShowForm(true)
  }

  async function handleSave() {
    if (!venueSlug || !formName.trim()) return
    setSaving(true)
    setError(null)
    try {
      const body: any = {
        name: formName.trim(),
        logo_url: formLogoUrl || null,
        logo_position: formLogoPosition,
        sponsor_logo_url: formSponsorUrl || null,
        sponsor_position: formSponsorPosition,
        is_default: formIsDefault,
      }

      let res: Response
      if (editingPkg) {
        body.id = editingPkg.id
        res = await fetch(`/api/org/${venueSlug}/graphic-packages`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        res = await fetch(`/api/org/${venueSlug}/graphic-packages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }

      if (res.ok) {
        setShowForm(false)
        setSuccessMsg(editingPkg ? 'Package updated' : 'Package created')
        setTimeout(() => setSuccessMsg(null), 3000)
        fetchPackages()
      } else {
        const data = await res.json()
        setError(data.error || 'Failed to save')
      }
    } catch {
      setError('Failed to save package')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(pkg: GraphicPackage) {
    if (!venueSlug || !confirm(`Delete "${pkg.name}"?`)) return
    try {
      const res = await fetch(`/api/org/${venueSlug}/graphic-packages?id=${pkg.id}`, { method: 'DELETE' })
      if (res.ok) {
        setPackages((prev) => prev.filter((p) => p.id !== pkg.id))
        setSuccessMsg('Package deleted')
        setTimeout(() => setSuccessMsg(null), 3000)
      }
    } catch {
      setError('Failed to delete')
    }
  }

  async function setDefault(pkg: GraphicPackage) {
    if (!venueSlug) return
    try {
      const res = await fetch(`/api/org/${venueSlug}/graphic-packages`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pkg.id, is_default: true }),
      })
      if (res.ok) fetchPackages()
    } catch {
      setError('Failed to set default')
    }
  }

  // Spiideo import state
  const [showImport, setShowImport] = useState(false)
  const [spiideoPackages, setSpiideoPackages] = useState<Array<{ id: string; name: string; type: string; alreadyImported: boolean }>>([])
  const [loadingImport, setLoadingImport] = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)

  async function fetchSpiideoPackages() {
    if (!venueSlug) return
    setLoadingImport(true)
    setError(null)
    try {
      const res = await fetch(`/api/org/${venueSlug}/graphic-packages/import`)
      if (!res.ok) {
        const data = await res.json()
        setError(data.error || 'Failed to fetch Spiideo packages')
        return
      }
      const data = await res.json()
      setSpiideoPackages(data.packages || [])
    } catch {
      setError('Failed to fetch Spiideo packages')
    } finally {
      setLoadingImport(false)
    }
  }

  async function importSpiideoPackage(pkg: { id: string; name: string }) {
    if (!venueSlug) return
    setImportingId(pkg.id)
    setError(null)
    try {
      const res = await fetch(`/api/org/${venueSlug}/graphic-packages/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spiideoId: pkg.id, name: pkg.name }),
      })
      if (res.ok) {
        setSuccessMsg(`Imported "${pkg.name}"`)
        setTimeout(() => setSuccessMsg(null), 3000)
        setSpiideoPackages((prev) => prev.map((p) => p.id === pkg.id ? { ...p, alreadyImported: true } : p))
        fetchPackages()
      } else {
        const data = await res.json()
        setError(data.error || 'Import failed')
      }
    } catch {
      setError('Failed to import package')
    } finally {
      setImportingId(null)
    }
  }

  const positionLabel = (pos: string) => {
    const labels: Record<string, string> = {
      'top-left': 'Top Left',
      'top-right': 'Top Right',
      'bottom-left': 'Bottom Left',
      'bottom-right': 'Bottom Right',
    }
    return labels[pos] || pos
  }

  return (
    <div className="mt-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
      <div className="p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
              Graphic Packages
            </h2>
            <p className="text-xs text-[var(--ash-grey)] mt-1">
              Logo overlays shown on recordings — applies to all venues for this account
            </p>
          </div>
          <Button
            variant="outline"
            className={`w-full md:w-auto ${outlineBtnClass}`}
            onClick={() => {
              setExpanded(!expanded)
              if (!expanded && packages.length === 0) fetchPackages()
            }}
          >
            {expanded ? 'Hide' : 'Manage'}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="px-6 pb-6 space-y-4">
          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}
          {successMsg && (
            <p className="text-sm text-emerald-400">{successMsg}</p>
          )}

          {loading ? (
            <p className="text-sm text-[var(--ash-grey)]">Loading...</p>
          ) : packages.length === 0 && !showForm ? (
            <p className="text-sm text-[var(--ash-grey)]">
              No graphic packages yet. Create one to add logo overlays to your recordings.
            </p>
          ) : (
            <div className="space-y-3">
              {packages.map((pkg) => (
                <div
                  key={pkg.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-lg bg-white/[0.03] border border-[var(--ash-grey)]/10"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Logo preview */}
                    {pkg.logo_url ? (
                      <img
                        src={pkg.logo_url}
                        alt=""
                        className="w-10 h-10 rounded object-contain bg-white/10 p-1 flex-shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded bg-white/5 flex items-center justify-center flex-shrink-0">
                        <span className="text-xs text-[var(--ash-grey)]">No logo</span>
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-[var(--timberwolf)] truncate">
                          {pkg.name}
                        </span>
                        {pkg.is_default && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 flex-shrink-0">
                            Default
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 text-xs text-[var(--ash-grey)]">
                        <span>Logo: {positionLabel(pkg.logo_position)}</span>
                        {pkg.sponsor_logo_url && (
                          <span>Sponsor: {positionLabel(pkg.sponsor_position)}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {!pkg.is_default && (
                      <button
                        onClick={() => setDefault(pkg)}
                        className="text-xs px-2 py-1 rounded text-[var(--ash-grey)] hover:text-[var(--timberwolf)] hover:bg-white/5 transition-colors"
                      >
                        Set Default
                      </button>
                    )}
                    <button
                      onClick={() => openEditForm(pkg)}
                      className="text-xs px-2 py-1 rounded text-[var(--ash-grey)] hover:text-[var(--timberwolf)] hover:bg-white/5 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleDelete(pkg)}
                      className="text-xs px-2 py-1 rounded text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Create/Edit Form */}
          {showForm ? (
            <div className="space-y-3 p-4 rounded-lg border border-[var(--ash-grey)]/20 bg-white/[0.02]">
              <h3 className="text-sm font-semibold text-[var(--timberwolf)]">
                {editingPkg ? 'Edit Package' : 'New Package'}
              </h3>
              <div className="space-y-1">
                <label className="text-xs text-[var(--ash-grey)]">Package Name</label>
                <Input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. DAFL Season 2025-26"
                  className={inputClass}
                />
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-[var(--ash-grey)]">Logo</label>
                  <div className="flex gap-2">
                    <Input
                      value={formLogoUrl}
                      onChange={(e) => setFormLogoUrl(e.target.value)}
                      placeholder="https://... or upload"
                      className={`flex-1 ${inputClass}`}
                    />
                    <label className={`inline-flex items-center px-3 text-xs rounded cursor-pointer whitespace-nowrap ${outlineBtnClass} border`}>
                      {uploadingLogo ? '...' : 'Upload'}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/svg+xml"
                        className="hidden"
                        onChange={handleLogoUpload}
                        disabled={uploadingLogo}
                      />
                    </label>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-[var(--ash-grey)]">Logo Position</label>
                  <Select value={formLogoPosition} onValueChange={setFormLogoPosition}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="top-left">Top Left</SelectItem>
                      <SelectItem value="top-right">Top Right</SelectItem>
                      <SelectItem value="bottom-left">Bottom Left</SelectItem>
                      <SelectItem value="bottom-right">Bottom Right</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-[var(--ash-grey)]">Sponsor Logo</label>
                  <div className="flex gap-2">
                    <Input
                      value={formSponsorUrl}
                      onChange={(e) => setFormSponsorUrl(e.target.value)}
                      placeholder="https://... or upload"
                      className={`flex-1 ${inputClass}`}
                    />
                    <label className={`inline-flex items-center px-3 text-xs rounded cursor-pointer whitespace-nowrap ${outlineBtnClass} border`}>
                      {uploadingSponsor ? '...' : 'Upload'}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/svg+xml"
                        className="hidden"
                        onChange={handleSponsorUpload}
                        disabled={uploadingSponsor}
                      />
                    </label>
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-[var(--ash-grey)]">Sponsor Position</label>
                  <Select value={formSponsorPosition} onValueChange={setFormSponsorPosition}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="top-left">Top Left</SelectItem>
                      <SelectItem value="top-right">Top Right</SelectItem>
                      <SelectItem value="bottom-left">Bottom Left</SelectItem>
                      <SelectItem value="bottom-right">Bottom Right</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formIsDefault}
                  onChange={(e) => setFormIsDefault(e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--ash-grey)]/20 bg-white/5 accent-[var(--timberwolf)]"
                />
                <span className="text-sm text-[var(--timberwolf)]">
                  Set as default package
                </span>
              </label>

              {/* Logo preview */}
              {(formLogoUrl || formSponsorUrl) && (
                <div className="relative w-full aspect-video bg-zinc-900 rounded-lg overflow-hidden border border-[var(--ash-grey)]/10">
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-[var(--ash-grey)]">
                    Preview
                  </div>
                  {formLogoUrl && (
                    <img
                      src={formLogoUrl}
                      alt="Logo"
                      className={`absolute w-12 h-12 object-contain opacity-70 ${
                        formLogoPosition === 'top-left' ? 'top-2 left-2' :
                        formLogoPosition === 'top-right' ? 'top-2 right-2' :
                        formLogoPosition === 'bottom-left' ? 'bottom-2 left-2' :
                        'bottom-2 right-2'
                      }`}
                    />
                  )}
                  {formSponsorUrl && (
                    <img
                      src={formSponsorUrl}
                      alt="Sponsor"
                      className={`absolute w-16 h-8 object-contain opacity-70 ${
                        formSponsorPosition === 'top-left' ? 'top-2 left-2' :
                        formSponsorPosition === 'top-right' ? 'top-2 right-2' :
                        formSponsorPosition === 'bottom-left' ? 'bottom-2 left-2' :
                        'bottom-2 right-2'
                      }`}
                    />
                  )}
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button onClick={handleSave} disabled={saving || !formName.trim()} className={primaryBtnClass}>
                  {saving ? 'Saving...' : editingPkg ? 'Update' : 'Create'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowForm(false)}
                  className={outlineBtnClass}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={openCreateForm}
                className={`flex-1 ${outlineBtnClass}`}
              >
                + New Package
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowImport(!showImport)
                  if (!showImport) fetchSpiideoPackages()
                }}
                className={outlineBtnClass}
              >
                {showImport ? 'Hide Spiideo' : 'Import from Spiideo'}
              </Button>
            </div>
          )}

          {/* Spiideo Import Panel */}
          {showImport && !showForm && (
            <div className="space-y-2 p-4 rounded-lg border border-[var(--ash-grey)]/20 bg-white/[0.02]">
              <h3 className="text-sm font-semibold text-[var(--timberwolf)]">
                Import from Spiideo
              </h3>
              {loadingImport ? (
                <p className="text-xs text-[var(--ash-grey)]">Loading...</p>
              ) : spiideoPackages.length === 0 ? (
                <p className="text-xs text-[var(--ash-grey)]">No Spiideo packages found</p>
              ) : (
                <div className="space-y-1">
                  {spiideoPackages.map((pkg) => (
                    <div
                      key={pkg.id}
                      className="flex items-center justify-between py-2 px-3 rounded bg-white/[0.02]"
                    >
                      <div>
                        <span className="text-sm text-[var(--timberwolf)]">{pkg.name}</span>
                        <span className="text-xs text-[var(--ash-grey)] ml-2">({pkg.type})</span>
                      </div>
                      {pkg.alreadyImported ? (
                        <span className="text-xs text-[var(--ash-grey)]">Imported</span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className={outlineBtnClass}
                          disabled={importingId === pkg.id}
                          onClick={() => importSpiideoPackage(pkg)}
                        >
                          {importingId === pkg.id ? '...' : 'Import'}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Marketplace Settings (Org-level) ────────────────────────────────
function MarketplaceSettingsSection({
  venueSlug,
  inputClass,
  outlineBtnClass,
  primaryBtnClass,
  onUpdate,
}: {
  venueSlug: string | null
  inputClass: string
  outlineBtnClass: string
  primaryBtnClass: string
  onUpdate: (settings: { marketplace_enabled: boolean; default_price_amount: number | null; default_price_currency: string }) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  const [enabled, setEnabled] = useState(false)
  const [price, setPrice] = useState('')
  const [currency, setCurrency] = useState('AED')

  async function fetchSettings() {
    if (!venueSlug) return
    setLoading(true)
    try {
      const res = await fetch(`/api/org/${venueSlug}/marketplace`)
      if (res.ok) {
        const data = await res.json()
        setEnabled(data.marketplace_enabled || false)
        setPrice(data.default_price_amount ? String(data.default_price_amount) : '')
        setCurrency(data.default_price_currency || 'AED')
      }
    } catch {
      // non-critical
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    if (!venueSlug) return
    setSaving(true)
    setSavedMsg(null)
    try {
      const res = await fetch(`/api/org/${venueSlug}/marketplace`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplace_enabled: enabled,
          default_price_amount: price ? Number(price) : null,
          default_price_currency: currency,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        onUpdate(data)
        setSavedMsg('Saved')
        setTimeout(() => setSavedMsg(null), 3000)
      }
    } catch {
      setSavedMsg('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
      <div className="p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
              Marketplace
            </h2>
            <p className="text-xs text-[var(--ash-grey)] mt-1">
              Sell recordings through the PLAYHUB marketplace
            </p>
          </div>
          <Button
            variant="outline"
            className={`w-full md:w-auto ${outlineBtnClass}`}
            onClick={() => {
              setExpanded(!expanded)
              if (!expanded) fetchSettings()
            }}
          >
            {expanded ? 'Hide' : 'Configure'}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="px-6 pb-6 space-y-4">
          {loading ? (
            <p className="text-xs text-[var(--ash-grey)]">Loading...</p>
          ) : (
            <>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--ash-grey)]/20 bg-white/5 accent-[var(--timberwolf)]"
                />
                <span className="text-sm text-[var(--timberwolf)]">
                  Enable marketplace for this organization
                </span>
              </label>
              {enabled && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs text-[var(--ash-grey)]">Default Price</label>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={price}
                      onChange={(e) => setPrice(e.target.value)}
                      placeholder="25.00"
                      className={inputClass}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-[var(--ash-grey)]">Currency</label>
                    <Select value={currency} onValueChange={setCurrency}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="AED">AED</SelectItem>
                        <SelectItem value="USD">USD</SelectItem>
                        <SelectItem value="GBP">GBP</SelectItem>
                        <SelectItem value="EUR">EUR</SelectItem>
                        <SelectItem value="KWD">KWD</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              )}
              <div className="flex items-center gap-3">
                <Button onClick={handleSave} disabled={saving} className={primaryBtnClass}>
                  {saving ? 'Saving...' : 'Save'}
                </Button>
                {savedMsg && (
                  <span className="text-sm text-emerald-400">{savedMsg}</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
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

  // Edit recording modal state
  const [editingRecording, setEditingRecording] = useState<Recording | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editHomeTeam, setEditHomeTeam] = useState('')
  const [editAwayTeam, setEditAwayTeam] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [togglingBillable, setTogglingBillable] = useState<string | null>(null)
  const [editingAmountId, setEditingAmountId] = useState<string | null>(null)
  const [editingAmountValue, setEditingAmountValue] = useState('')
  const [deletingRecording, setDeletingRecording] = useState<string | null>(null)

  // Delete confirmation modal state
  const [deleteConfirmRecording, setDeleteConfirmRecording] =
    useState<Recording | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')

  // Video playback (removed — redirects to /recordings/[id] now)

  // Public link
  const [generatingLink, setGeneratingLink] = useState<string | null>(null)

  // Recordings pagination + filter state
  const [currentPage, setCurrentPage] = useState(1)
  const [totalRecordings, setTotalRecordings] = useState(0)
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [billableFilter, setBillableFilter] = useState('')
  const [loadingRecordings, setLoadingRecordings] = useState(false)
  const pageSize = 20

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

  // Billing state
  const [billingSummary, setBillingSummary] = useState<BillingSummary | null>(
    null
  )
  const [billingConfig, setBillingConfig] = useState<BillingConfig | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [dailyStats, setDailyStats] = useState<DailyStats | null>(null)
  const [showBillingSection, setShowBillingSection] = useState(false)
  const [isBillable, setIsBillable] = useState(true)
  const [billableAmount, setBillableAmount] = useState('')
  const [billingMonth, setBillingMonth] = useState(new Date().getMonth() + 1) // 1-indexed
  const [billingYear, setBillingYear] = useState(new Date().getFullYear())
  const isCurrentBillingMonth =
    billingMonth === new Date().getMonth() + 1 &&
    billingYear === new Date().getFullYear()

  // Live stream scheduling state
  const [showStreamScheduleForm, setShowStreamScheduleForm] = useState(false)
  const [streamTitle, setStreamTitle] = useState('')
  const [streamSceneId, setStreamSceneId] = useState('')
  const [streamStartTime, setStreamStartTime] = useState('')
  const [streamEndTime, setStreamEndTime] = useState('')
  const [schedulingStream, setSchedulingStream] = useState(false)

  // YouTube state (for schedule form)
  const [broadcastToYoutube, setBroadcastToYoutube] = useState(false)
  const [marketplaceEnabled, setMarketplaceEnabled] = useState(false)
  const [marketplacePrice, setMarketplacePrice] = useState('')

  // Org-level marketplace settings
  const [orgMarketplace, setOrgMarketplace] = useState<{
    marketplace_enabled: boolean
    default_price_amount: number | null
    default_price_currency: string
  } | null>(null)

  // Graphic package state (for schedule form)
  const [scheduleGraphicPackages, setScheduleGraphicPackages] = useState<GraphicPackage[]>([])
  const [selectedGraphicPackageId, setSelectedGraphicPackageId] = useState<string>('default')

  // Fetch graphic packages when schedule form opens
  useEffect(() => {
    if (showScheduleForm && venue?.slug) {
      fetch(`/api/org/${venue.slug}/graphic-packages`)
        .then((r) => r.json())
        .then((data) => setScheduleGraphicPackages(data.packages || []))
        .catch(() => {})
    }
  }, [showScheduleForm, venue?.slug])

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

      // Fetch org marketplace settings
      if (currentVenue.slug) {
        try {
          const mpRes = await fetch(`/api/org/${currentVenue.slug}/marketplace`)
          if (mpRes.ok) {
            const mpData = await mpRes.json()
            setOrgMarketplace(mpData)
          }
        } catch {
          // Non-critical
        }
      }

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

      // Fetch billing data
      await fetchBillingData()
    } catch (err) {
      setError('Failed to load venue data')
    } finally {
      setLoading(false)
    }
  }

  // Debounce search input
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput)
      setCurrentPage(1)
    }, 300)
    return () => clearTimeout(timeout)
  }, [searchInput])

  // Separate recordings fetch with pagination + filters
  async function fetchRecordings(page?: number, search?: string, status?: string, billable?: string) {
    const p = page ?? currentPage
    const s = search ?? debouncedSearch
    const st = status ?? statusFilter
    const b = billable ?? billableFilter

    setLoadingRecordings(true)
    try {
      const params = new URLSearchParams({
        page: String(p),
        limit: String(pageSize),
      })
      if (s) params.set('search', s)
      if (st) params.set('status', st)
      if (b) params.set('billable', b)

      const res = await fetch(`/api/venue/${venueId}/recordings?${params}`)
      const data = await res.json()
      setRecordings(data.recordings || [])
      setTotalRecordings(data.total || 0)
      setCurrentPage(data.page || 1)
    } catch {
      // Non-critical — recordings list just won't update
    } finally {
      setLoadingRecordings(false)
    }
  }

  // Fetch recordings when filters/page change or venue loads
  useEffect(() => {
    if (venue) {
      fetchRecordings(currentPage, debouncedSearch, statusFilter, billableFilter)
    }
  }, [currentPage, debouncedSearch, statusFilter, billableFilter, venue])

  async function fetchBillingData(month = billingMonth, year = billingYear) {
    const monthParams = `?month=${month}&year=${year}`
    try {
      const [configRes, summaryRes, invoicesRes] = await Promise.all([
        fetch(`/api/venue/${venueId}/billing`),
        fetch(`/api/venue/${venueId}/billing/summary${monthParams}`),
        fetch(`/api/venue/${venueId}/billing/invoices`),
      ])
      const [configData, summaryData, invoicesData] = await Promise.all([
        configRes.json(),
        summaryRes.json(),
        invoicesRes.json(),
      ])
      if (configData.config) {
        setBillingConfig(configData.config)
        setBillableAmount(
          String(configData.config.default_billable_amount || '')
        )
      }
      if (!summaryData.error) setBillingSummary(summaryData)
      if (invoicesData.invoices) setInvoices(invoicesData.invoices)
    } catch {
      // Billing data is supplementary — don't block the page
    }

    // Fetch daily stats separately so it can't break billing
    try {
      const res = await fetch(
        `/api/venue/${venueId}/billing/daily-stats${monthParams}`
      )
      const data = await res.json()
      if (!data.error) setDailyStats(data)
    } catch {
      // Chart is optional
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
        fetchRecordings()
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
      fetchRecordings()
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

  async function toggleBillable(recording: Recording) {
    setTogglingBillable(recording.id)
    try {
      const res = await fetch(`/api/recordings/${recording.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_billable: !recording.is_billable }),
      })
      if (res.ok) {
        setRecordings((prev) =>
          prev.map((r) =>
            r.id === recording.id
              ? { ...r, is_billable: !recording.is_billable }
              : r
          )
        )
      } else {
        const data = await res.json()
        setError(data.error || 'Failed to update')
      }
    } catch {
      setError('Failed to update billable status')
    } finally {
      setTogglingBillable(null)
    }
  }

  async function saveBillableAmount(recording: Recording) {
    const newAmount = parseFloat(editingAmountValue)
    if (isNaN(newAmount) || newAmount < 0) {
      setEditingAmountId(null)
      return
    }
    try {
      const res = await fetch(`/api/recordings/${recording.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ billable_amount: newAmount }),
      })
      if (res.ok) {
        setRecordings((prev) =>
          prev.map((r) =>
            r.id === recording.id ? { ...r, billable_amount: newAmount } : r
          )
        )
      } else {
        const data = await res.json()
        setError(data.error || 'Failed to update amount')
      }
    } catch {
      setError('Failed to update amount')
    } finally {
      setEditingAmountId(null)
    }
  }

  function openEditModal(recording: Recording) {
    setEditingRecording(recording)
    setEditTitle(recording.title)
    setEditHomeTeam(recording.home_team)
    setEditAwayTeam(recording.away_team)
  }

  async function handleSaveEdit() {
    if (!editingRecording) return
    setSavingEdit(true)
    try {
      const res = await fetch(`/api/recordings/${editingRecording.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle,
          home_team: editHomeTeam,
          away_team: editAwayTeam,
        }),
      })
      if (res.ok) {
        setRecordings((prev) =>
          prev.map((r) =>
            r.id === editingRecording.id
              ? { ...r, title: editTitle, home_team: editHomeTeam, away_team: editAwayTeam }
              : r
          )
        )
        setEditingRecording(null)
      } else {
        const data = await res.json()
        setError(data.error || 'Failed to save')
      }
    } catch {
      setError('Failed to save changes')
    } finally {
      setSavingEdit(false)
    }
  }

  function promptDeleteRecording(recording: Recording) {
    setDeleteConfirmRecording(recording)
    setDeleteConfirmText('')
  }

  async function confirmDeleteRecording() {
    if (!deleteConfirmRecording) return
    setDeletingRecording(deleteConfirmRecording.id)
    try {
      const res = await fetch(`/api/recordings/${deleteConfirmRecording.id}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        setDeleteConfirmRecording(null)
        fetchRecordings()
      } else {
        const data = await res.json()
        setError(data.error || 'Failed to delete')
      }
    } catch {
      setError('Failed to delete recording')
    } finally {
      setDeletingRecording(null)
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
          isBillable,
          billableAmount:
            isBillable && billableAmount ? Number(billableAmount) : undefined,
          broadcastToYoutube,
          marketplaceEnabled,
          priceAmount: marketplaceEnabled && marketplacePrice ? Number(marketplacePrice) : undefined,
          priceCurrency: orgMarketplace?.default_price_currency || 'AED',
          graphicPackageId: selectedGraphicPackageId === 'default' ? undefined : selectedGraphicPackageId === 'none' ? null : selectedGraphicPackageId,
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
        setBroadcastToYoutube(false)
        setMarketplaceEnabled(false)
        setMarketplacePrice('')
        setSelectedGraphicPackageId('default')
        setShowScheduleForm(false)
        fetchRecordings()
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
    'bg-zinc-800 border-[var(--ash-grey)]/20 text-[var(--timberwolf)] placeholder:text-[var(--ash-grey)]/40'
  const outlineBtnClass =
    'border-[var(--ash-grey)]/20 text-[var(--timberwolf)] hover:bg-white/10'
  const primaryBtnClass =
    'bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]'

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-6xl animate-pulse">
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

          {/* Billing skeleton */}
          <div className="mb-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-5">
              {/* Header row */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div className="space-y-1.5">
                  <div className="bg-[var(--ash-grey)]/10 rounded h-5 w-[60px]" />
                  <div className="bg-[var(--ash-grey)]/10 rounded h-3 w-[100px]" />
                </div>
                <div className="flex items-center gap-4">
                  <div className="bg-[var(--ash-grey)]/10 rounded h-6 w-[80px]" />
                  <div className="bg-[var(--ash-grey)]/10 rounded h-6 w-[70px]" />
                </div>
              </div>
              {/* 4-column financial grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-[var(--ash-grey)]/[0.06]">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="bg-[var(--night)] p-3.5 space-y-2">
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-1.5 rounded-full bg-[var(--ash-grey)]/10" />
                      <div className="bg-[var(--ash-grey)]/10 rounded h-2.5 w-[60px]" />
                    </div>
                    <div className="bg-[var(--ash-grey)]/10 rounded h-6 w-[90px]" />
                    <div className="bg-[var(--ash-grey)]/10 rounded h-2.5 w-[70px]" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Recordings skeleton */}
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6 space-y-1">
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
        <div className="container mx-auto px-5 py-16 max-w-6xl">
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
      <div className="container mx-auto px-5 py-16 max-w-6xl">
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

        {/* Billing Overview */}
        {billingConfig?.is_active && (
          <FadeIn delay={100}>
            <div className="mb-6 rounded-xl border border-[var(--ash-grey)]/8 bg-white/[0.02]">
              <div className="p-5">
                {/* Header row */}
                <div className="relative flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 mb-4">
                  <h2 className="text-base font-semibold text-[var(--timberwolf)]">
                    Billing
                  </h2>
                  <div className="flex items-center gap-3 order-last sm:order-none ml-auto sm:ml-0 sm:absolute sm:left-1/2 sm:-translate-x-1/2">
                    <button
                      onClick={() => {
                        const prev = billingMonth === 1
                          ? { m: 12, y: billingYear - 1 }
                          : { m: billingMonth - 1, y: billingYear }
                        setBillingMonth(prev.m)
                        setBillingYear(prev.y)
                        fetchBillingData(prev.m, prev.y)
                      }}
                      className="text-[var(--ash-grey)]/70 hover:text-[var(--timberwolf)] text-base px-1.5 py-0.5"
                    >
                      ‹
                    </button>
                    <p className="text-sm text-[var(--ash-grey)] font-medium min-w-[120px] text-center">
                      {new Date(billingYear, billingMonth - 1).toLocaleDateString('en-GB', {
                        month: 'long',
                        year: 'numeric',
                      })}
                    </p>
                    <button
                      onClick={() => {
                        if (isCurrentBillingMonth) return
                        const next = billingMonth === 12
                          ? { m: 1, y: billingYear + 1 }
                          : { m: billingMonth + 1, y: billingYear }
                        setBillingMonth(next.m)
                        setBillingYear(next.y)
                        fetchBillingData(next.m, next.y)
                      }}
                      disabled={isCurrentBillingMonth}
                      className={`text-base px-1.5 py-0.5 ${isCurrentBillingMonth ? 'text-[var(--ash-grey)]/20 cursor-not-allowed' : 'text-[var(--ash-grey)]/70 hover:text-[var(--timberwolf)]'}`}
                    >
                      ›
                    </button>
                  </div>
                  {billingSummary && (
                    <div className="flex items-center gap-3 sm:gap-4 text-sm">
                      <div>
                        <span
                          className="text-[var(--timberwolf)] font-semibold text-base sm:text-lg"
                          style={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                          {billingSummary.totalRevenue.toFixed(3)}
                        </span>
                        <span className="text-[var(--ash-grey)]/60 ml-1 text-xs">
                          {billingSummary.currency}
                        </span>
                      </div>
                      <div className="border-l border-[var(--ash-grey)]/10 pl-3 sm:pl-4">
                        <span
                          className="text-[var(--timberwolf)] font-medium"
                          style={{ fontVariantNumeric: 'tabular-nums' }}
                        >
                          {billingSummary.count}
                        </span>
                        <span className="text-[var(--ash-grey)]/60 ml-1 text-xs">
                          recordings
                        </span>
                      </div>
                      {billingSummary.dailyTarget > 0 && isCurrentBillingMonth && (
                        <div className="border-l border-[var(--ash-grey)]/10 pl-3 sm:pl-4">
                          <span
                            className="text-[var(--timberwolf)] font-medium"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {billingSummary.todayCount}
                          </span>
                          <span className="text-[var(--ash-grey)]/60 text-xs">
                            /{billingSummary.dailyTarget} today
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Financial summary — 3 columns with 1px gap borders */}
                {billingSummary && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-[var(--ash-grey)]/[0.06] mb-4">
                    {/* Venue-collected revenue */}
                    <div className="bg-[var(--night)] p-3.5">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <div className="h-1.5 w-1.5 rounded-full bg-amber-400/60" />
                        <p className="text-[10px] text-[var(--ash-grey)]/60 uppercase tracking-widest">
                          At venue
                        </p>
                      </div>
                      <p
                        className="text-lg font-semibold text-[var(--timberwolf)]"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {billingSummary.venueCollectedRevenue.toFixed(3)}
                        <span className="text-[10px] font-normal text-[var(--ash-grey)]/50 ml-1">
                          {billingSummary.currency}
                        </span>
                      </p>
                      <p className="text-[10px] text-[var(--ash-grey)]/40 mt-1">
                        {billingSummary.venueCollectedCount} recording
                        {billingSummary.venueCollectedCount === 1 ? '' : 's'}
                      </p>
                    </div>
                    {/* QR Code-collected revenue */}
                    <div className="bg-[var(--night)] p-3.5">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <div className="h-1.5 w-1.5 rounded-full bg-indigo-400/60" />
                        <p className="text-[10px] text-[var(--ash-grey)]/60 uppercase tracking-widest">
                          QR Code
                        </p>
                      </div>
                      <p
                        className="text-lg font-semibold text-[var(--timberwolf)]"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {billingSummary.playhubCollectedRevenue.toFixed(3)}
                        <span className="text-[10px] font-normal text-[var(--ash-grey)]/50 ml-1">
                          {billingSummary.currency}
                        </span>
                      </p>
                      <p className="text-[10px] text-[var(--ash-grey)]/40 mt-1">
                        {billingSummary.playhubCollectedCount} recording
                        {billingSummary.playhubCollectedCount === 1 ? '' : 's'}
                      </p>
                    </div>
                    {/* Venue profit share */}
                    <div className="bg-[var(--night)] p-3.5">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <div className="h-1.5 w-1.5 rounded-full bg-emerald-400/60" />
                        <p className="text-[10px] text-[var(--ash-grey)]/60 uppercase tracking-widest">
                          Your profit
                        </p>
                      </div>
                      <p
                        className="text-lg font-semibold text-emerald-400"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {billingSummary.venueTotalProfit.toFixed(3)}
                        <span className="text-[10px] font-normal text-[var(--ash-grey)]/50 ml-1">
                          {billingSummary.currency}
                        </span>
                      </p>
                      <p className="text-[10px] text-[var(--ash-grey)]/40 mt-1">
                        {billingSummary.count} recording
                        {billingSummary.count === 1 ? '' : 's'} in {new Date(billingYear, billingMonth - 1).toLocaleDateString('en-GB', { month: 'long' })}
                      </p>
                    </div>
                    {/* Net settlement */}
                    <div className="bg-[var(--night)] p-3.5">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <div
                          className={`h-1.5 w-1.5 rounded-full ${billingSummary.netBalance > 0 ? 'bg-amber-400/60' : billingSummary.netBalance < 0 ? 'bg-emerald-400/60' : 'bg-[var(--ash-grey)]/40'}`}
                        />
                        <p className="text-[10px] text-[var(--ash-grey)]/60 uppercase tracking-widest">
                          Net settlement
                        </p>
                      </div>
                      <p
                        className="text-lg font-semibold text-[var(--timberwolf)]"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {Math.abs(billingSummary.netBalance).toFixed(3)}
                        <span className="text-[10px] font-normal text-[var(--ash-grey)]/50 ml-1">
                          {billingSummary.currency}
                        </span>
                      </p>
                      <p className="text-[10px] text-[var(--ash-grey)]/40 mt-1">
                        {billingSummary.netBalance > 0
                          ? 'venue owes PLAYBACK'
                          : billingSummary.netBalance < 0
                            ? 'PLAYBACK owes venue'
                            : 'settled'}
                      </p>
                    </div>
                  </div>
                )}

                {/* Daily recordings chart */}
                {dailyStats && dailyStats.scenes.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] text-[var(--ash-grey)]/60 uppercase tracking-widest">
                        Daily activity
                      </p>
                      {dailyStats.scenes.length > 1 && (
                        <div className="flex items-center gap-3">
                          {dailyStats.scenes.map((scene, i) => (
                            <div
                              key={scene}
                              className="flex items-center gap-1 text-[10px] text-[var(--ash-grey)]/50"
                            >
                              <div
                                className="h-1.5 w-1.5 rounded-full"
                                style={{
                                  backgroundColor: [
                                    '#6366f1',
                                    '#22c55e',
                                    '#f59e0b',
                                    '#ef4444',
                                    '#06b6d4',
                                    '#ec4899',
                                    '#8b5cf6',
                                    '#14b8a6',
                                  ][i % 8],
                                }}
                              />
                              {scene}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <ChartContainer
                      config={
                        Object.fromEntries(
                          dailyStats.scenes.map((scene, i) => [
                            scene,
                            {
                              label: scene,
                              color: [
                                '#6366f1',
                                '#22c55e',
                                '#f59e0b',
                                '#ef4444',
                                '#06b6d4',
                                '#ec4899',
                                '#8b5cf6',
                                '#14b8a6',
                              ][i % 8],
                            },
                          ])
                        ) as ChartConfig
                      }
                      className="aspect-[2/1] sm:aspect-[3/1] md:aspect-[4/1] w-full"
                    >
                      <AreaChart
                        data={dailyStats.days.map((d) => ({
                          date: d.date.slice(8),
                          ...d.byScene,
                          total: d.total,
                        }))}
                        margin={{ top: 4, right: 4, left: 0, bottom: 0 }}
                      >
                        <defs>
                          {dailyStats.scenes.map((scene, i) => {
                            const color = [
                              '#6366f1',
                              '#22c55e',
                              '#f59e0b',
                              '#ef4444',
                              '#06b6d4',
                              '#ec4899',
                              '#8b5cf6',
                              '#14b8a6',
                            ][i % 8]
                            return (
                              <linearGradient
                                key={scene}
                                id={`fill-${i}`}
                                x1="0"
                                y1="0"
                                x2="0"
                                y2="1"
                              >
                                <stop
                                  offset="5%"
                                  stopColor={color}
                                  stopOpacity={0.25}
                                />
                                <stop
                                  offset="95%"
                                  stopColor={color}
                                  stopOpacity={0}
                                />
                              </linearGradient>
                            )
                          })}
                        </defs>
                        <CartesianGrid
                          strokeDasharray="3 3"
                          stroke="rgba(185,186,163,0.05)"
                          vertical={false}
                        />
                        <XAxis
                          dataKey="date"
                          tick={{ fill: 'rgba(185,186,163,0.4)', fontSize: 9 }}
                          axisLine={false}
                          tickLine={false}
                          interval="preserveStartEnd"
                        />
                        <YAxis
                          allowDecimals={false}
                          tick={{ fill: 'rgba(185,186,163,0.4)', fontSize: 9 }}
                          axisLine={false}
                          tickLine={false}
                          width={20}
                        />
                        <ChartTooltip
                          content={
                            <ChartTooltipContent
                              indicator="dot"
                              labelFormatter={(value) => {
                                const dayNum =
                                  typeof value === 'string'
                                    ? value
                                    : String(value)
                                const now = new Date()
                                return `${dayNum} ${now.toLocaleDateString('en-GB', { month: 'short' })}`
                              }}
                            />
                          }
                        />
                        {dailyStats.scenes.map((scene, i) => {
                          const color = [
                            '#6366f1',
                            '#22c55e',
                            '#f59e0b',
                            '#ef4444',
                            '#06b6d4',
                            '#ec4899',
                            '#8b5cf6',
                            '#14b8a6',
                          ][i % 8]
                          return (
                            <Area
                              key={scene}
                              dataKey={scene}
                              type="monotone"
                              stackId="a"
                              stroke={color}
                              fill={`url(#fill-${i})`}
                              strokeWidth={1.5}
                            />
                          )
                        })}
                        {/* Target line */}
                        {dailyStats.dailyTarget > 0 && (
                          <ReferenceLine
                            y={dailyStats.dailyTarget}
                            stroke="rgba(245,158,11,0.35)"
                            strokeDasharray="6 3"
                            label={{
                              value: `Target: ${dailyStats.dailyTarget}/day`,
                              position: 'insideTopRight',
                              fill: 'rgba(245,158,11,0.5)',
                              fontSize: 9,
                            }}
                          />
                        )}
                        {/* Average line */}
                        {dailyStats.averagePerDay > 0 && (
                          <ReferenceLine
                            y={dailyStats.averagePerDay}
                            stroke="rgba(99,102,241,0.4)"
                            strokeDasharray="3 3"
                            label={{
                              value: `Avg: ${dailyStats.averagePerDay}/day`,
                              position: 'insideBottomRight',
                              fill: 'rgba(99,102,241,0.6)',
                              fontSize: 9,
                            }}
                          />
                        )}
                      </AreaChart>
                    </ChartContainer>
                  </div>
                )}
              </div>

              {/* Invoice toggle */}
              <div className="px-5 pb-4">
                <button
                  className="text-[11px] text-[var(--ash-grey)]/40 hover:text-[var(--ash-grey)] transition-colors"
                  onClick={() => {
                    setShowBillingSection(!showBillingSection)
                    if (!showBillingSection) fetchBillingData()
                  }}
                >
                  {showBillingSection
                    ? 'Hide invoices'
                    : 'View invoices \u2192'}
                </button>
              </div>

              {/* Invoices */}
              {showBillingSection && (
                <div className="px-5 pb-5 border-t border-[var(--ash-grey)]/[0.06] pt-4 space-y-2">
                  {invoices.length === 0 ? (
                    <p className="text-xs text-[var(--ash-grey)]/50">
                      No invoices yet
                    </p>
                  ) : (
                    invoices.map((inv) => {
                      const net = Number(inv.net_amount)
                      const totalRecordings =
                        inv.venue_collected_count + inv.playhub_collected_count
                      return (
                        <div
                          key={inv.id}
                          className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-white/[0.02] rounded-lg border border-[var(--ash-grey)]/[0.06]"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium text-[var(--timberwolf)]">
                              {new Date(inv.period_start).toLocaleDateString(
                                'en-GB',
                                { month: 'long', year: 'numeric' }
                              )}
                            </p>
                            <p className="text-[11px] text-[var(--ash-grey)]/50">
                              {totalRecordings} recording
                              {totalRecordings === 1 ? '' : 's'}
                              {inv.venue_collected_count > 0 &&
                                inv.playhub_collected_count > 0 &&
                                ` (${inv.venue_collected_count} venue, ${inv.playhub_collected_count} QR code)`}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <span
                              className={`text-sm font-medium ${net >= 0 ? 'text-[var(--timberwolf)]' : 'text-emerald-400'}`}
                              style={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                              {net >= 0 ? '' : '-'}
                              {Math.abs(net).toFixed(3)} {inv.currency}
                            </span>
                            <span className="text-[10px] text-[var(--ash-grey)]/40">
                              {net >= 0 ? 'owed' : 'due to venue'}
                            </span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded ${
                                inv.status === 'paid'
                                  ? 'bg-emerald-500/10 text-emerald-400'
                                  : inv.status === 'pending'
                                    ? 'bg-amber-500/10 text-amber-400'
                                    : inv.status === 'overdue'
                                      ? 'bg-red-500/10 text-red-400'
                                      : 'bg-gray-500/10 text-gray-400'
                              }`}
                            >
                              {inv.status}
                            </span>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          </FadeIn>
        )}

        {/* Schedule Recording */}
        {scenes.length > 0 && (
          <FadeIn delay={100}>
            <div className="mb-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
              <div className="p-6">
                <div className="flex flex-col md:flex-row items-center justify-between gap-2">
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
                        <Select value={sceneId} onValueChange={setSceneId} disabled={scenes.length <= 1}>
                          <SelectTrigger>
                            <SelectValue placeholder="Select pitch..." />
                          </SelectTrigger>
                          <SelectContent>
                            {scenes.map((scene) => (
                              <SelectItem key={scene.id} value={scene.id}>
                                {scene.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
                        <DateTimePicker
                          value={startTime}
                          onChange={setStartTime}
                          required
                          className={inputClass}
                          placeholder="Select start time"
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
                        <DateTimePicker
                          value={endTime}
                          onChange={setEndTime}
                          required
                          className={inputClass}
                          placeholder="Select end time"
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

                    {/* Paid recording */}
                    {billingConfig?.is_active && (
                      <div className="space-y-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isBillable}
                            onChange={(e) => setIsBillable(e.target.checked)}
                            className="w-4 h-4 rounded border-[var(--ash-grey)]/20 bg-white/5 accent-[var(--timberwolf)]"
                          />
                          <span className="text-sm font-medium text-[var(--timberwolf)]">
                            Paid recording
                          </span>
                        </label>
                        {isBillable && (
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              step="0.001"
                              min="0"
                              value={billableAmount}
                              onChange={(e) =>
                                setBillableAmount(e.target.value)
                              }
                              placeholder={String(
                                billingConfig.default_billable_amount || '5.000'
                              )}
                              className={`w-32 ${inputClass}`}
                            />
                            <span className="text-sm text-[var(--ash-grey)]">
                              {billingConfig.currency || 'KWD'}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Broadcast to YouTube */}
                    {billingConfig?.youtube_rtmp_url && billingConfig?.youtube_stream_key && (
                      <div className="space-y-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={broadcastToYoutube}
                            onChange={(e) => setBroadcastToYoutube(e.target.checked)}
                            className="w-4 h-4 rounded border-[var(--ash-grey)]/20 bg-white/5 accent-[var(--timberwolf)]"
                          />
                          <span className="text-sm font-medium text-[var(--timberwolf)]">
                            Broadcast to YouTube
                          </span>
                        </label>
                        <p className="text-xs text-[var(--ash-grey)]">
                          Stream will be pushed to the configured YouTube channel via RTMP
                        </p>
                      </div>
                    )}

                    {/* List on marketplace */}
                    {orgMarketplace?.marketplace_enabled && (
                      <div className="space-y-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={marketplaceEnabled}
                            onChange={(e) => setMarketplaceEnabled(e.target.checked)}
                            className="w-4 h-4 rounded border-[var(--ash-grey)]/20 bg-white/5 accent-[var(--timberwolf)]"
                          />
                          <span className="text-sm font-medium text-[var(--timberwolf)]">
                            List on marketplace
                          </span>
                        </label>
                        {marketplaceEnabled && (
                          <div className="flex items-center gap-2">
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              value={marketplacePrice}
                              onChange={(e) => setMarketplacePrice(e.target.value)}
                              placeholder={String(orgMarketplace.default_price_amount || '25.00')}
                              className={`w-32 ${inputClass}`}
                            />
                            <span className="text-sm text-[var(--ash-grey)]">
                              {orgMarketplace.default_price_currency || 'AED'}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Graphic Package */}
                    {scheduleGraphicPackages.length > 0 && (
                      <div className="space-y-2">
                        <label className="text-sm font-medium text-[var(--timberwolf)]">
                          Graphic Package
                        </label>
                        <Select value={selectedGraphicPackageId} onValueChange={setSelectedGraphicPackageId}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="default">Use Default</SelectItem>
                            <SelectItem value="none">None</SelectItem>
                            {scheduleGraphicPackages.map((pkg) => (
                              <SelectItem key={pkg.id} value={pkg.id}>
                                {pkg.name}{pkg.is_default ? ' (default)' : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <p className="text-xs text-[var(--ash-grey)]">
                          Logo overlays applied to this recording
                        </p>
                      </div>
                    )}

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
            <div className="p-6">
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
                          <Select value={streamSceneId} onValueChange={setStreamSceneId}>
                            <SelectTrigger>
                              <SelectValue placeholder="Select pitch..." />
                            </SelectTrigger>
                            <SelectContent>
                              {scenes.map((scene) => (
                                <SelectItem key={scene.id} value={scene.id}>
                                  {scene.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className="text-sm text-[var(--ash-grey)]">
                            Start Time *
                          </label>
                          <DateTimePicker
                            value={streamStartTime}
                            onChange={setStreamStartTime}
                            required
                            className={inputClass}
                            placeholder="Select start time"
                          />
                        </div>
                        <div>
                          <label className="text-sm text-[var(--ash-grey)]">
                            End Time *
                          </label>
                          <DateTimePicker
                            value={streamEndTime}
                            onChange={setStreamEndTime}
                            required
                            className={inputClass}
                            placeholder="Select end time"
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

        {/* Marketplace Revenue */}
        {orgMarketplace?.marketplace_enabled && (
          <FadeIn delay={250}>
            <MarketplaceRevenue
              venueId={venueId}
              outlineBtnClass={outlineBtnClass}
            />
          </FadeIn>
        )}

        {/* Recordings List */}
        <FadeIn delay={300}>
          <div className="rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6">
              <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                Recordings
              </h2>
              <p className="text-sm text-[var(--ash-grey)]">
                {totalRecordings} recording
                {totalRecordings === 1 ? '' : 's'}
              </p>

              {/* Search + Filters */}
              <div className="mt-4 flex flex-col sm:flex-row gap-3">
                <Input
                  placeholder="Search title or team..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className={`sm:max-w-xs ${inputClass}`}
                />
                <Select value={statusFilter || 'all'} onValueChange={(v) => { setStatusFilter(v === 'all' ? '' : v); setCurrentPage(1) }}>
                  <SelectTrigger className="sm:w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="published">Published</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={billableFilter || 'all'} onValueChange={(v) => { setBillableFilter(v === 'all' ? '' : v); setCurrentPage(1) }}>
                  <SelectTrigger className="sm:w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="true">Billable</SelectItem>
                    <SelectItem value="false">Not Billable</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="px-6 pb-6">
              {recordings.length === 0 ? (
                <p className="text-[var(--ash-grey)] text-center py-8">
                  {debouncedSearch || statusFilter || billableFilter
                    ? 'No recordings match your filters.'
                    : 'No recordings yet. Schedule a recording to get started.'}
                </p>
              ) : (
                <div className="space-y-3">
                  {recordings.map((recording) => (
                    <div
                      key={recording.id}
                      className="p-4 rounded-lg bg-white/[0.03] border border-[var(--ash-grey)]/10"
                    >
                      {/* Top row: Play button + Info + Status */}
                      <div className="flex items-start gap-3">
                        {/* Play Button — links to recording detail page */}
                        {recording.s3_key && (
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => router.push(`/recordings/${recording.id}`)}
                            className={`flex-shrink-0 ${outlineBtnClass}`}
                          >
                            <svg
                              className="w-4 h-4 ml-0.5"
                              fill="currentColor"
                              viewBox="0 0 24 24"
                            >
                              <path d="M8 5v14l11-7z" />
                            </svg>
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
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-[var(--ash-grey)]">
                            {recording.accessCount || 0} user
                            {(recording.accessCount || 0) === 1 ? '' : 's'}
                          </span>
                          <button
                            onClick={() => toggleBillable(recording)}
                            disabled={togglingBillable === recording.id}
                            className={`text-xs px-2 py-0.5 rounded cursor-pointer transition-colors ${
                              recording.is_billable !== false
                                ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                                : 'bg-gray-500/20 text-gray-400 hover:bg-gray-500/30'
                            }`}
                          >
                            {togglingBillable === recording.id
                              ? '...'
                              : recording.is_billable !== false
                                ? 'Billable'
                                : 'Not Billable'}
                          </button>
                          {recording.is_billable !== false && (
                            editingAmountId === recording.id ? (
                              <input
                                type="number"
                                step="0.001"
                                min="0"
                                autoFocus
                                className="w-24 text-xs px-2 py-0.5 rounded bg-zinc-800 text-[var(--timberwolf)] border border-[var(--ash-grey)]/30 outline-none"
                                value={editingAmountValue}
                                onChange={(e) => setEditingAmountValue(e.target.value)}
                                onBlur={() => saveBillableAmount(recording)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') saveBillableAmount(recording)
                                  if (e.key === 'Escape') setEditingAmountId(null)
                                }}
                              />
                            ) : (
                              <span
                                className={`text-xs px-2 py-0.5 rounded ${
                                  recording.collected_by !== 'playhub'
                                    ? 'cursor-pointer hover:bg-zinc-700/50'
                                    : ''
                                } text-[var(--ash-grey)]`}
                                title={recording.collected_by === 'playhub' ? 'Amount locked (verified transaction)' : 'Click to edit amount'}
                                onClick={() => {
                                  if (recording.collected_by !== 'playhub') {
                                    setEditingAmountId(recording.id)
                                    setEditingAmountValue(
                                      String(recording.billable_amount ?? billingConfig?.default_billable_amount ?? '')
                                    )
                                  }
                                }}
                              >
                                {(recording.billable_amount ?? billingConfig?.default_billable_amount ?? 0).toFixed(3)}{' '}
                                {billingConfig?.currency || 'KWD'}
                              </span>
                            )
                          )}
                          {recording.graphicPackageName && (
                            <span className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400" title="Graphic Package">
                              {recording.graphicPackageName}
                            </span>
                          )}
                        </div>
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
                          <Button
                            variant="outline"
                            size="sm"
                            className={`flex-shrink-0 ${outlineBtnClass}`}
                            onClick={() => openEditModal(recording)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-shrink-0 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                            onClick={() => promptDeleteRecording(recording)}
                            disabled={deletingRecording === recording.id}
                          >
                            {deletingRecording === recording.id ? '...' : 'Delete'}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}

                  {/* Pagination controls */}
                  {totalRecordings > pageSize && (
                    <div className="flex items-center justify-between mt-4 pt-4 border-t border-[var(--ash-grey)]/10">
                      <p className="text-sm text-[var(--ash-grey)]">
                        {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, totalRecordings)} of {totalRecordings}
                      </p>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className={outlineBtnClass}
                          disabled={currentPage <= 1}
                          onClick={() => setCurrentPage((p) => p - 1)}
                        >
                          Previous
                        </Button>
                        <span className="text-sm text-[var(--ash-grey)] px-2">
                          Page {currentPage} of {Math.ceil(totalRecordings / pageSize)}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className={outlineBtnClass}
                          disabled={currentPage >= Math.ceil(totalRecordings / pageSize)}
                          onClick={() => setCurrentPage((p) => p + 1)}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </FadeIn>

        {/* Venue Settings (YouTube, Marketplace, Media Pack) */}
        <FadeIn delay={350}>
          <VenueSettings
            venueId={venueId}
            billingConfig={billingConfig}
            onSaved={(updated) => setBillingConfig(updated)}
            inputClass={inputClass}
            outlineBtnClass={outlineBtnClass}
            primaryBtnClass={primaryBtnClass}
          />
        </FadeIn>

        {/* Graphic Packages (Account-level) */}
        <FadeIn delay={375}>
          <GraphicPackagesSection
            venueSlug={venue?.slug || null}
            inputClass={inputClass}
            outlineBtnClass={outlineBtnClass}
            primaryBtnClass={primaryBtnClass}
          />
        </FadeIn>

        {/* Marketplace Settings (Org-level) */}
        <FadeIn delay={400}>
          <MarketplaceSettingsSection
            venueSlug={venue?.slug || null}
            inputClass={inputClass}
            outlineBtnClass={outlineBtnClass}
            primaryBtnClass={primaryBtnClass}
            onUpdate={setOrgMarketplace}
          />
        </FadeIn>

        {/* Venue Admins Section */}
        <FadeIn delay={400}>
          <div className="mt-6 rounded-xl border border-[var(--ash-grey)]/10 bg-white/[0.015]">
            <div className="p-6">
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
              <div className="p-6">
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

        {/* Edit Recording Modal */}
        {editingRecording && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="w-full max-w-lg m-4 rounded-xl border border-[var(--ash-grey)]/10 bg-[var(--night)]">
              <div className="p-6">
                <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                  Edit Recording
                </h2>
              </div>
              <div className="px-6 pb-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--timberwolf)]">
                    Title
                  </label>
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--timberwolf)]">
                    Home Team
                  </label>
                  <Input
                    value={editHomeTeam}
                    onChange={(e) => setEditHomeTeam(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--timberwolf)]">
                    Away Team
                  </label>
                  <Input
                    value={editAwayTeam}
                    onChange={(e) => setEditAwayTeam(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    className={`flex-1 ${primaryBtnClass}`}
                    onClick={handleSaveEdit}
                    disabled={savingEdit}
                  >
                    {savingEdit ? 'Saving...' : 'Save'}
                  </Button>
                  <Button
                    variant="outline"
                    className={`flex-1 ${outlineBtnClass}`}
                    onClick={() => setEditingRecording(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Delete Confirmation Modal */}
        {deleteConfirmRecording && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="w-full max-w-md m-4 rounded-xl border border-red-500/30 bg-[var(--night)]">
              <div className="p-6">
                <h2 className="text-lg font-semibold text-red-400">
                  Delete Recording
                </h2>
                <p className="text-sm text-[var(--ash-grey)] mt-2">
                  This will permanently delete{' '}
                  <span className="text-[var(--timberwolf)] font-medium">
                    {deleteConfirmRecording.title}
                  </span>{' '}
                  including the video file from storage. This cannot be undone.
                </p>
              </div>
              <div className="px-6 pb-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--timberwolf)]">
                    Type DELETE to confirm
                  </label>
                  <Input
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder="DELETE"
                    className={inputClass}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1 bg-red-600 hover:bg-red-700 text-white border-0"
                    onClick={confirmDeleteRecording}
                    disabled={
                      deleteConfirmText !== 'DELETE' ||
                      deletingRecording === deleteConfirmRecording.id
                    }
                  >
                    {deletingRecording === deleteConfirmRecording.id
                      ? 'Deleting...'
                      : 'Delete Forever'}
                  </Button>
                  <Button
                    variant="outline"
                    className={`flex-1 ${outlineBtnClass}`}
                    onClick={() => setDeleteConfirmRecording(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
