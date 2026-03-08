'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
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
import { LoadingSpinner } from '@/components/ui/loading'
import {
  Layers,
  ShoppingBag,
  Users,
  Film,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────

interface OrgInfo {
  id: string
  name: string
  slug: string
  type: string
  logoUrl: string | null
  featureRecordings: boolean
  featureStreaming: boolean
  featureGraphicPackages: boolean
  marketplaceEnabled: boolean
}

interface ChildVenueStat {
  id: string
  name: string
  slug: string | null
  type: string
  totalRecordings: number
  publishedRecordings: number
  monthRecordings: number
  monthRevenue: number
  todayCount: number
  dailyTarget: number
  currency: string
}

interface GroupDashboardData {
  childVenues: ChildVenueStat[]
  totals: {
    totalRecordings: number
    publishedRecordings: number
    monthRecordings: number
    monthRevenue: number
    todayCount: number
  }
  dailyChart: Array<Record<string, number | string>>
  venueNames: string[]
  totalDailyTarget: number
  averagePerDay: number
  currency: string
}

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

// ── Shared styling ────────────────────────────────────────────────────

const inputClass =
  'bg-zinc-800 border-border text-[var(--timberwolf)] placeholder:text-muted-foreground/40'
const outlineBtnClass =
  'border-border text-[var(--timberwolf)] hover:bg-muted'
const primaryBtnClass =
  'bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]'

// ── Nav tabs ──────────────────────────────────────────────────────────

const allTabs = [
  { id: 'graphics' as const, label: 'Graphic Packages', icon: Layers, featureKey: 'featureGraphicPackages' as const },
  { id: 'marketplace' as const, label: 'Marketplace', icon: ShoppingBag, featureKey: 'marketplaceEnabled' as const },
  { id: 'recordings' as const, label: 'Recordings', icon: Film, featureKey: 'featureRecordings' as const },
  { id: 'team' as const, label: 'Team', icon: Users, featureKey: null },
]

type TabId = 'graphics' | 'marketplace' | 'recordings' | 'team'

function getVisibleTabs(org: OrgInfo | null) {
  if (!org) return allTabs.filter((t) => !t.featureKey)
  return allTabs.filter((t) => !t.featureKey || org[t.featureKey])
}

// ── Graphic Packages Tab ──────────────────────────────────────────────

function GraphicPackagesTab({ slug }: { slug: string }) {
  const [packages, setPackages] = useState<GraphicPackage[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)

  // Form state
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

  // Spiideo import
  const [showImport, setShowImport] = useState(false)
  const [spiideoPackages, setSpiideoPackages] = useState<
    Array<{ id: string; name: string; type: string; alreadyImported: boolean }>
  >([])
  const [loadingImport, setLoadingImport] = useState(false)
  const [importingId, setImportingId] = useState<string | null>(null)

  useEffect(() => {
    fetchPackages()
  }, [slug])

  async function fetchPackages() {
    setLoading(true)
    try {
      const res = await fetch(`/api/org/${slug}/graphic-packages`)
      const data = await res.json()
      setPackages(data.packages || [])
    } catch {
      setError('Failed to load graphic packages')
    } finally {
      setLoading(false)
    }
  }

  async function uploadFile(
    file: File,
    type: 'logo' | 'sponsor'
  ): Promise<string | null> {
    const formData = new FormData()
    formData.append('file', file)
    formData.append('type', type)
    const res = await fetch(`/api/org/${slug}/graphic-packages/upload`, {
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
    if (!formName.trim()) return
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
        res = await fetch(`/api/org/${slug}/graphic-packages`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        res = await fetch(`/api/org/${slug}/graphic-packages`, {
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
    if (!confirm(`Delete "${pkg.name}"?`)) return
    try {
      const res = await fetch(
        `/api/org/${slug}/graphic-packages?id=${pkg.id}`,
        { method: 'DELETE' }
      )
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
    try {
      const res = await fetch(`/api/org/${slug}/graphic-packages`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pkg.id, is_default: true }),
      })
      if (res.ok) fetchPackages()
    } catch {
      setError('Failed to set default')
    }
  }

  async function fetchSpiideoPackages() {
    setLoadingImport(true)
    setError(null)
    try {
      const res = await fetch(`/api/org/${slug}/graphic-packages/import`)
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
    setImportingId(pkg.id)
    setError(null)
    try {
      const res = await fetch(`/api/org/${slug}/graphic-packages/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spiideoId: pkg.id, name: pkg.name }),
      })
      if (res.ok) {
        setSuccessMsg(`Imported "${pkg.name}"`)
        setTimeout(() => setSuccessMsg(null), 3000)
        setSpiideoPackages((prev) =>
          prev.map((p) =>
            p.id === pkg.id ? { ...p, alreadyImported: true } : p
          )
        )
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner size="sm" className="text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-400">{error}</p>}
      {successMsg && <p className="text-sm text-emerald-400">{successMsg}</p>}

      {/* Package list */}
      {packages.length === 0 && !showForm ? (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <Layers className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">
            No graphic packages yet
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1 mb-4">
            Create one to add logo overlays to your recordings
          </p>
          <div className="flex items-center justify-center gap-2">
            <Button onClick={openCreateForm} className={primaryBtnClass}>
              + New Package
            </Button>
            <Button
              variant="outline"
              className={outlineBtnClass}
              onClick={() => {
                setShowImport(true)
                fetchSpiideoPackages()
              }}
            >
              Import from Spiideo
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-2">
            {packages.map((pkg) => (
              <div
                key={pkg.id}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-lg border border-border bg-card"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {pkg.logo_url ? (
                    <img
                      src={pkg.logo_url}
                      alt=""
                      className="w-10 h-10 rounded object-contain bg-white/10 p-1 flex-shrink-0"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded bg-white/5 flex items-center justify-center flex-shrink-0">
                      <span className="text-[10px] text-muted-foreground">
                        No logo
                      </span>
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--timberwolf)] truncate">
                        {pkg.name}
                      </span>
                      {pkg.is_default && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium flex-shrink-0">
                          Default
                        </span>
                      )}
                      {pkg.spiideo_graphic_package_id && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-medium flex-shrink-0">
                          Spiideo
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                      <span>Logo: {positionLabel(pkg.logo_position)}</span>
                      {pkg.sponsor_logo_url && (
                        <span>
                          Sponsor: {positionLabel(pkg.sponsor_position)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {!pkg.is_default && (
                    <button
                      onClick={() => setDefault(pkg)}
                      className="text-xs px-2.5 py-1.5 rounded-md text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-muted transition-colors"
                    >
                      Set Default
                    </button>
                  )}
                  <button
                    onClick={() => openEditForm(pkg)}
                    className="text-xs px-2.5 py-1.5 rounded-md text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-muted transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(pkg)}
                    className="text-xs px-2.5 py-1.5 rounded-md text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          {!showForm && (
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
        </>
      )}

      {/* Create/Edit Form */}
      {showForm && (
        <div className="space-y-3 p-4 rounded-lg border border-border bg-[var(--night)]">
          <h3 className="text-sm font-semibold text-[var(--timberwolf)]">
            {editingPkg ? 'Edit Package' : 'New Package'}
          </h3>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Package Name
            </label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. DAFL Season 2025-26"
              className={inputClass}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Logo</label>
              <div className="flex gap-2">
                <Input
                  value={formLogoUrl}
                  onChange={(e) => setFormLogoUrl(e.target.value)}
                  placeholder="https://... or upload"
                  className={`flex-1 ${inputClass}`}
                />
                <label
                  className={`inline-flex items-center px-3 text-xs rounded cursor-pointer whitespace-nowrap ${outlineBtnClass} border`}
                >
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
              <label className="text-xs text-muted-foreground">
                Logo Position
              </label>
              <Select
                value={formLogoPosition}
                onValueChange={setFormLogoPosition}
              >
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
              <label className="text-xs text-muted-foreground">
                Sponsor Logo
              </label>
              <div className="flex gap-2">
                <Input
                  value={formSponsorUrl}
                  onChange={(e) => setFormSponsorUrl(e.target.value)}
                  placeholder="https://... or upload"
                  className={`flex-1 ${inputClass}`}
                />
                <label
                  className={`inline-flex items-center px-3 text-xs rounded cursor-pointer whitespace-nowrap ${outlineBtnClass} border`}
                >
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
              <label className="text-xs text-muted-foreground">
                Sponsor Position
              </label>
              <Select
                value={formSponsorPosition}
                onValueChange={setFormSponsorPosition}
              >
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
              className="w-4 h-4 rounded border-border bg-white/5 accent-[var(--timberwolf)]"
            />
            <span className="text-sm text-[var(--timberwolf)]">
              Set as default package
            </span>
          </label>

          {/* Preview */}
          {(formLogoUrl || formSponsorUrl) && (
            <div className="relative w-full aspect-video bg-muted rounded-lg overflow-hidden border border-border">
              <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                Preview
              </div>
              {formLogoUrl && (
                <img
                  src={formLogoUrl}
                  alt="Logo"
                  className={`absolute w-12 h-12 object-contain opacity-70 ${
                    formLogoPosition === 'top-left'
                      ? 'top-2 left-2'
                      : formLogoPosition === 'top-right'
                        ? 'top-2 right-2'
                        : formLogoPosition === 'bottom-left'
                          ? 'bottom-2 left-2'
                          : 'bottom-2 right-2'
                  }`}
                />
              )}
              {formSponsorUrl && (
                <img
                  src={formSponsorUrl}
                  alt="Sponsor"
                  className={`absolute w-16 h-8 object-contain opacity-70 ${
                    formSponsorPosition === 'top-left'
                      ? 'top-2 left-2'
                      : formSponsorPosition === 'top-right'
                        ? 'top-2 right-2'
                        : formSponsorPosition === 'bottom-left'
                          ? 'bottom-2 left-2'
                          : 'bottom-2 right-2'
                  }`}
                />
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <Button
              onClick={handleSave}
              disabled={saving || !formName.trim()}
              className={primaryBtnClass}
            >
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
      )}

      {/* Spiideo Import */}
      {showImport && !showForm && (
        <div className="space-y-2 p-4 rounded-lg border border-border bg-[var(--night)]">
          <h3 className="text-sm font-semibold text-[var(--timberwolf)]">
            Import from Spiideo
          </h3>
          {loadingImport ? (
            <LoadingSpinner size="sm" className="text-muted-foreground" />
          ) : spiideoPackages.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No Spiideo packages found
            </p>
          ) : (
            <div className="space-y-1">
              {spiideoPackages.map((pkg) => (
                <div
                  key={pkg.id}
                  className="flex items-center justify-between py-2 px-3 rounded-md hover:bg-muted/30 transition-colors"
                >
                  <div>
                    <span className="text-sm text-[var(--timberwolf)]">
                      {pkg.name}
                    </span>
                    <span className="text-xs text-muted-foreground ml-2">
                      ({pkg.type})
                    </span>
                  </div>
                  {pkg.alreadyImported ? (
                    <span className="text-xs text-muted-foreground">
                      Imported
                    </span>
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
  )
}

// ── Marketplace Tab ───────────────────────────────────────────────────

function MarketplaceTab({ slug }: { slug: string }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [price, setPrice] = useState('')
  const [currency, setCurrency] = useState('AED')

  useEffect(() => {
    fetchSettings()
  }, [slug])

  async function fetchSettings() {
    setLoading(true)
    try {
      const res = await fetch(`/api/org/${slug}/marketplace`)
      if (res.ok) {
        const data = await res.json()
        setEnabled(data.marketplace_enabled || false)
        setPrice(
          data.default_price_amount ? String(data.default_price_amount) : ''
        )
        setCurrency(data.default_price_currency || 'AED')
      }
    } catch {
      // non-critical
    } finally {
      setLoading(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    setSavedMsg(null)
    try {
      const res = await fetch(`/api/org/${slug}/marketplace`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplace_enabled: enabled,
          default_price_amount: price ? Number(price) : null,
          default_price_currency: currency,
        }),
      })
      if (res.ok) {
        setSavedMsg('Saved')
        setTimeout(() => setSavedMsg(null), 3000)
      }
    } catch {
      setSavedMsg('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <LoadingSpinner size="sm" className="text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <label className="flex items-center gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="w-4 h-4 rounded border-border bg-white/5 accent-[var(--timberwolf)]"
        />
        <div>
          <span className="text-sm text-[var(--timberwolf)]">
            Enable marketplace
          </span>
          <p className="text-xs text-muted-foreground">
            Allow recordings to be sold through the PLAYHUB marketplace
          </p>
        </div>
      </label>

      {enabled && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4 rounded-lg border border-border bg-[var(--night)]">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">
              Default Price
            </label>
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
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">
              Currency
            </label>
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
  )
}

// ── Placeholder tabs ──────────────────────────────────────────────────

function ComingSoonTab({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="rounded-lg border border-dashed border-border py-16 text-center">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="text-xs text-muted-foreground/60 mt-1">{description}</p>
    </div>
  )
}

// ── Group Dashboard ───────────────────────────────────────────────────

const CHART_COLORS = [
  'hsl(142, 71%, 45%)',
  'hsl(217, 91%, 60%)',
  'hsl(47, 96%, 53%)',
  'hsl(280, 65%, 60%)',
  'hsl(15, 90%, 55%)',
]

function GroupDashboardView({ slug }: { slug: string }) {
  const router = useRouter()
  const [data, setData] = useState<GroupDashboardData | null>(null)
  const [loading, setLoading] = useState(true)

  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())

  const isCurrentMonth = month === now.getMonth() + 1 && year === now.getFullYear()

  useEffect(() => {
    fetchGroupData()
  }, [slug, month, year])

  async function fetchGroupData() {
    setLoading(true)
    try {
      const res = await fetch(
        `/api/org/${slug}/manage/group-dashboard?month=${month}&year=${year}`
      )
      const json = await res.json()
      if (res.ok) setData(json)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  function prevMonth() {
    if (month === 1) {
      setMonth(12)
      setYear(year - 1)
    } else {
      setMonth(month - 1)
    }
  }

  function nextMonth() {
    if (isCurrentMonth) return
    if (month === 12) {
      setMonth(1)
      setYear(year + 1)
    } else {
      setMonth(month + 1)
    }
  }

  const monthLabel = new Date(year, month - 1).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  })

  function formatCurrency(amount: number, currency: string) {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 3,
    }).format(amount)
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="rounded-xl border border-border bg-card animate-pulse p-6">
          <div className="space-y-4">
            <div className="bg-muted rounded h-5 w-[200px]" />
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-muted">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="bg-[var(--night)] p-3.5 space-y-2">
                  <div className="bg-muted rounded h-2.5 w-[60px]" />
                  <div className="bg-muted rounded h-6 w-[90px]" />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!data) return null

  const currency = data.currency || 'KWD'

  return (
    <div className="space-y-6">
      {/* Month selector */}
      <div className="flex items-center gap-3">
        <button
          onClick={prevMonth}
          className="p-1.5 rounded-md text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-muted transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-[var(--timberwolf)] min-w-[140px] text-center">
          {monthLabel}
        </span>
        <button
          onClick={nextMonth}
          disabled={isCurrentMonth}
          className="p-1.5 rounded-md text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-muted transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      {/* Portfolio Overview */}
      <div className="rounded-xl border border-border bg-card">
        <div className="p-5">
          <h2 className="text-base font-semibold text-[var(--timberwolf)] mb-4">
            Portfolio Overview
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-muted">
            {[
              {
                label: 'Total Recordings',
                value: String(data.totals.totalRecordings),
                sub: `${data.totals.publishedRecordings} published`,
              },
              {
                label: 'This Month',
                value: String(data.totals.monthRecordings),
                sub: 'recordings',
              },
              {
                label: 'Monthly Revenue',
                value: data.totals.monthRevenue > 0
                  ? formatCurrency(data.totals.monthRevenue, currency)
                  : '0',
                sub: 'billable',
              },
              {
                label: 'Today',
                value: String(data.totals.todayCount),
                sub: 'recordings',
              },
            ].map((card) => (
              <div key={card.label} className="bg-[var(--night)] p-3.5">
                <p className="text-xs text-muted-foreground mb-1">
                  {card.label}
                </p>
                <p className="text-lg font-semibold text-[var(--timberwolf)]">
                  {card.value}
                </p>
                <p className="text-xs text-muted-foreground">{card.sub}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Daily Performance Chart */}
      {data.dailyChart.length > 0 && (
        <div className="rounded-xl border border-border bg-card">
          <div className="p-5">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
              <div>
                <h2 className="text-base font-semibold text-[var(--timberwolf)]">
                  Daily Performance
                </h2>
                <p className="text-xs text-muted-foreground">
                  Avg {data.averagePerDay}/day
                  {data.totalDailyTarget > 0 && ` · Target: ${data.totalDailyTarget}/day`}
                </p>
              </div>
            </div>
            <ChartContainer
              config={Object.fromEntries(
                data.venueNames.map((name, i) => [
                  name,
                  { label: name, color: CHART_COLORS[i % 5] },
                ])
              ) as ChartConfig}
              className="h-[220px] w-full"
            >
              <AreaChart data={data.dailyChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(d: string) => {
                    const day = parseInt(d.split('-')[2], 10)
                    return day % 5 === 1 || day === 1 ? String(day) : ''
                  }}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  allowDecimals={false}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(label: string) => {
                        const d = new Date(label + 'T00:00:00')
                        return d.toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                        })
                      }}
                    />
                  }
                />
                {data.totalDailyTarget > 0 && (
                  <ReferenceLine
                    y={data.totalDailyTarget}
                    stroke="hsl(var(--muted-foreground))"
                    strokeDasharray="6 4"
                    strokeOpacity={0.5}
                  />
                )}
                {data.venueNames.map((name, i) => (
                  <Area
                    key={name}
                    type="monotone"
                    dataKey={name}
                    stackId="1"
                    fill={CHART_COLORS[i % 5]}
                    fillOpacity={0.4}
                    stroke={CHART_COLORS[i % 5]}
                    strokeWidth={1.5}
                  />
                ))}
              </AreaChart>
            </ChartContainer>
          </div>
        </div>
      )}

      {/* Child Venues */}
      <div className="rounded-xl border border-border bg-card">
        <div className="p-5">
          <h2 className="text-base font-semibold text-[var(--timberwolf)] mb-4">
            Venues ({data.childVenues.length})
          </h2>
          <div className="space-y-3">
            {data.childVenues.map((child) => (
              <div
                key={child.id}
                className="p-4 rounded-lg bg-muted/50 border border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-[var(--timberwolf)] truncate">
                      {child.name}
                    </p>
                    <span className="text-xs px-2 py-0.5 rounded bg-zinc-700 text-muted-foreground flex-shrink-0">
                      {child.type}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                    <span>{child.totalRecordings} recordings</span>
                    <span>{child.monthRecordings} this month</span>
                    {child.dailyTarget > 0 && (
                      <span>
                        Today: {child.todayCount}/{child.dailyTarget}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {child.monthRevenue > 0 && (
                    <span className="text-sm font-semibold text-[var(--timberwolf)]">
                      {formatCurrency(child.monthRevenue, child.currency)}
                    </span>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className={outlineBtnClass}
                    onClick={() => router.push(`/venue/${child.id}`)}
                  >
                    Manage
                  </Button>
                </div>
              </div>
            ))}
            {data.childVenues.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No child venues found
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────

export default function OrgManagePage() {
  const params = useParams()
  const router = useRouter()
  const slug = params.slug as string

  const [org, setOrg] = useState<OrgInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabId | null>(null)

  useEffect(() => {
    fetchOrg()
  }, [slug])

  async function fetchOrg() {
    try {
      setLoading(true)
      const res = await fetch(`/api/org/${slug}/manage`)
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || 'Not found')
        return
      }

      setOrg(data)
      const visible = getVisibleTabs(data)
      if (visible.length > 0) setActiveTab(visible[0].id)
    } catch {
      setError('Failed to load organization')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <div className="animate-pulse space-y-6">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-full bg-muted" />
            <div className="space-y-2">
              <div className="bg-muted rounded h-6 w-[180px]" />
              <div className="bg-muted rounded h-3 w-[100px]" />
            </div>
          </div>
          <div className="flex gap-1">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="bg-muted rounded-md h-9 w-[120px]" />
            ))}
          </div>
          <div className="bg-muted rounded-xl h-[300px]" />
        </div>
      </div>
    )
  }

  if (error || !org) {
    return (
      <div className="min-h-[50vh] flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">{error || 'Not found'}</p>
        <Button
          variant="outline"
          className={outlineBtnClass}
          onClick={() => router.push('/venue')}
        >
          Back
        </Button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      {/* Header */}
      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={() => router.back()}
          className="text-muted-foreground hover:text-[var(--timberwolf)] transition-colors"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        {org.logoUrl ? (
          <img
            src={org.logoUrl}
            alt={org.name}
            className="w-11 h-11 rounded-full object-cover border border-border"
          />
        ) : (
          <div className="w-11 h-11 rounded-full bg-muted flex items-center justify-center text-lg font-semibold text-[var(--timberwolf)]">
            {org.name.charAt(0)}
          </div>
        )}
        <div>
          <h1 className="text-xl font-semibold text-[var(--timberwolf)] leading-tight">
            {org.name}
          </h1>
          <p className="text-xs text-muted-foreground">
            {org.type === 'group' ? 'Group Dashboard' : 'Organization Settings'}
          </p>
        </div>
      </div>

      {org.type === 'group' ? (
        <GroupDashboardView slug={slug} />
      ) : (
        <>
          {/* Tab navigation */}
          <div className="flex gap-1 mb-6 border-b border-border pb-px overflow-x-auto">
            {getVisibleTabs(org).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2 px-3.5 py-2 text-sm rounded-t-md transition-colors whitespace-nowrap -mb-px border-b-2 ${
                  activeTab === id
                    ? 'text-[var(--timberwolf)] border-[var(--timberwolf)] bg-muted/30'
                    : 'text-muted-foreground border-transparent hover:text-[var(--timberwolf)] hover:bg-muted/20'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="min-h-[400px]">
            {activeTab === 'graphics' && <GraphicPackagesTab slug={slug} />}
            {activeTab === 'marketplace' && <MarketplaceTab slug={slug} />}
            {activeTab === 'recordings' && (
              <ComingSoonTab
                title="Recordings"
                description="View and manage all recordings across venues — coming soon"
              />
            )}
            {activeTab === 'team' && (
              <ComingSoonTab
                title="Team Management"
                description="Invite employees and manage access — coming soon"
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
