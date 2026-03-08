'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
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
  logo_x: number
  logo_y: number
  logo_scale: number
  sponsor_logo_url: string | null
  sponsor_position: string
  sponsor_x: number
  sponsor_y: number
  sponsor_scale: number
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
  const [formLogoX, setFormLogoX] = useState(85)
  const [formLogoY, setFormLogoY] = useState(3)
  const [formLogoScale, setFormLogoScale] = useState(8)
  const [formSponsorUrl, setFormSponsorUrl] = useState('')
  const [formSponsorPosition, setFormSponsorPosition] = useState('bottom-left')
  const [formSponsorX, setFormSponsorX] = useState(3)
  const [formSponsorY, setFormSponsorY] = useState(85)
  const [formSponsorScale, setFormSponsorScale] = useState(10)
  const [formIsDefault, setFormIsDefault] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [uploadingSponsor, setUploadingSponsor] = useState(false)
  const [dragging, setDragging] = useState<'logo' | 'sponsor' | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)

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
    setFormLogoX(85)
    setFormLogoY(3)
    setFormLogoScale(8)
    setFormSponsorUrl('')
    setFormSponsorPosition('bottom-left')
    setFormSponsorX(3)
    setFormSponsorY(85)
    setFormSponsorScale(10)
    setFormIsDefault(packages.length === 0)
    setShowForm(true)
  }

  function openEditForm(pkg: GraphicPackage) {
    setEditingPkg(pkg)
    setFormName(pkg.name)
    setFormLogoUrl(pkg.logo_url || '')
    setFormLogoPosition(pkg.logo_position)
    setFormLogoX(pkg.logo_x ?? 85)
    setFormLogoY(pkg.logo_y ?? 3)
    setFormLogoScale(pkg.logo_scale ?? 8)
    setFormSponsorUrl(pkg.sponsor_logo_url || '')
    setFormSponsorPosition(pkg.sponsor_position)
    setFormSponsorX(pkg.sponsor_x ?? 3)
    setFormSponsorY(pkg.sponsor_y ?? 85)
    setFormSponsorScale(pkg.sponsor_scale ?? 10)
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
        logo_x: formLogoX,
        logo_y: formLogoY,
        logo_scale: formLogoScale,
        sponsor_logo_url: formSponsorUrl || null,
        sponsor_position: formSponsorPosition,
        sponsor_x: formSponsorX,
        sponsor_y: formSponsorY,
        sponsor_scale: formSponsorScale,
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
        <div className="space-y-4 p-4 rounded-lg border border-border bg-[var(--night)]">
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

          {/* Upload row */}
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
          </div>

          {/* Scale sliders */}
          {(formLogoUrl || formSponsorUrl) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {formLogoUrl && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    Logo Size — {formLogoScale}%
                  </label>
                  <input
                    type="range"
                    min="2"
                    max="30"
                    step="0.5"
                    value={formLogoScale}
                    onChange={(e) => setFormLogoScale(parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[var(--timberwolf)]"
                  />
                </div>
              )}
              {formSponsorUrl && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">
                    Sponsor Size — {formSponsorScale}%
                  </label>
                  <input
                    type="range"
                    min="2"
                    max="30"
                    step="0.5"
                    value={formSponsorScale}
                    onChange={(e) => setFormSponsorScale(parseFloat(e.target.value))}
                    className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-[var(--timberwolf)]"
                  />
                </div>
              )}
            </div>
          )}

          {/* Drag-and-drop preview */}
          {(formLogoUrl || formSponsorUrl) && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                Drag to position overlays
              </label>
              <div
                ref={previewRef}
                className="relative w-full aspect-video bg-zinc-900 rounded-lg overflow-hidden border border-border select-none"
                onMouseMove={(e) => {
                  if (!dragging || !previewRef.current) return
                  const rect = previewRef.current.getBoundingClientRect()
                  const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100))
                  const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100))
                  if (dragging === 'logo') { setFormLogoX(Math.round(x * 10) / 10); setFormLogoY(Math.round(y * 10) / 10) }
                  else { setFormSponsorX(Math.round(x * 10) / 10); setFormSponsorY(Math.round(y * 10) / 10) }
                }}
                onMouseUp={() => setDragging(null)}
                onMouseLeave={() => setDragging(null)}
                onTouchMove={(e) => {
                  if (!dragging || !previewRef.current) return
                  e.preventDefault()
                  const touch = e.touches[0]
                  const rect = previewRef.current.getBoundingClientRect()
                  const x = Math.max(0, Math.min(100, ((touch.clientX - rect.left) / rect.width) * 100))
                  const y = Math.max(0, Math.min(100, ((touch.clientY - rect.top) / rect.height) * 100))
                  if (dragging === 'logo') { setFormLogoX(Math.round(x * 10) / 10); setFormLogoY(Math.round(y * 10) / 10) }
                  else { setFormSponsorX(Math.round(x * 10) / 10); setFormSponsorY(Math.round(y * 10) / 10) }
                }}
                onTouchEnd={() => setDragging(null)}
              >
                {/* Grid lines for guidance */}
                <div className="absolute inset-0 pointer-events-none">
                  <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white/5" />
                  <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white/5" />
                  <div className="absolute top-1/3 left-0 right-0 h-px bg-white/5" />
                  <div className="absolute top-2/3 left-0 right-0 h-px bg-white/5" />
                </div>
                <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground/30 pointer-events-none">
                  16:9 Preview
                </div>
                {formLogoUrl && (
                  <img
                    src={formLogoUrl}
                    alt="Logo"
                    draggable={false}
                    className={`absolute object-contain opacity-80 cursor-grab ${dragging === 'logo' ? 'cursor-grabbing ring-2 ring-emerald-500/50' : 'hover:ring-2 hover:ring-white/30'} rounded transition-shadow`}
                    style={{
                      left: `${formLogoX}%`,
                      top: `${formLogoY}%`,
                      width: `${formLogoScale}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                    onMouseDown={(e) => { e.preventDefault(); setDragging('logo') }}
                    onTouchStart={() => setDragging('logo')}
                  />
                )}
                {formSponsorUrl && (
                  <img
                    src={formSponsorUrl}
                    alt="Sponsor"
                    draggable={false}
                    className={`absolute object-contain opacity-80 cursor-grab ${dragging === 'sponsor' ? 'cursor-grabbing ring-2 ring-blue-500/50' : 'hover:ring-2 hover:ring-white/30'} rounded transition-shadow`}
                    style={{
                      left: `${formSponsorX}%`,
                      top: `${formSponsorY}%`,
                      width: `${formSponsorScale}%`,
                      transform: 'translate(-50%, -50%)',
                    }}
                    onMouseDown={(e) => { e.preventDefault(); setDragging('sponsor') }}
                    onTouchStart={() => setDragging('sponsor')}
                  />
                )}
              </div>
            </div>
          )}

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

// ── Recordings Tab ────────────────────────────────────────────────────

interface OrgRecording {
  id: string
  title: string
  home_team: string
  away_team: string
  match_date: string
  pitch_name: string | null
  status: string
  is_billable: boolean
  billable_amount: number | null
  marketplace_enabled: boolean
  created_at: string
}

function RecordingsTab({ slug }: { slug: string }) {
  const [recordings, setRecordings] = useState<OrgRecording[]>([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [statusFilter, setStatusFilter] = useState<string>('')

  useEffect(() => {
    fetchRecordings()
  }, [slug, page, statusFilter])

  async function fetchRecordings() {
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: String(page) })
      if (statusFilter) params.set('status', statusFilter)
      const res = await fetch(`/api/org/${slug}/manage/recordings?${params}`)
      const data = await res.json()
      setRecordings(data.recordings || [])
      setTotalPages(data.totalPages || 1)
      setTotal(data.total || 0)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  }

  const statusColor: Record<string, string> = {
    published: 'bg-emerald-500/15 text-emerald-400',
    draft: 'bg-zinc-500/15 text-zinc-400',
    processing: 'bg-amber-500/15 text-amber-400',
    archived: 'bg-red-500/15 text-red-400',
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
      {/* Filter + count */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{total} recordings</p>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v === 'all' ? '' : v); setPage(1) }}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="published">Published</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {recordings.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border py-16 text-center">
          <Film className="mx-auto h-8 w-8 text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">No recordings found</p>
        </div>
      ) : (
        <div className="space-y-2">
          {recordings.map((rec) => (
            <div
              key={rec.id}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-4 rounded-lg border border-border bg-card"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--timberwolf)] truncate">
                  {rec.title || `${rec.home_team} vs ${rec.away_team}`}
                </p>
                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  <span>{formatDate(rec.match_date || rec.created_at)}</span>
                  {rec.pitch_name && <span>{rec.pitch_name}</span>}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${statusColor[rec.status] || 'bg-zinc-500/15 text-zinc-400'}`}>
                  {rec.status}
                </span>
                {rec.marketplace_enabled && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-medium">
                    Marketplace
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 pt-2">
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="text-xs px-3 py-1.5 rounded-md text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-muted disabled:opacity-30 transition-colors"
          >
            Previous
          </button>
          <span className="text-xs text-muted-foreground">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
            className="text-xs px-3 py-1.5 rounded-md text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-muted disabled:opacity-30 transition-colors"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

// ── Team Tab ──────────────────────────────────────────────────────────

interface TeamMember {
  id: string
  role: string
  createdAt: string
  fullName: string | null
  email: string | null
  isCurrentUser: boolean
}

interface PendingInvite {
  id: string
  invited_email: string
  role: string
  invited_at: string
}

function TeamTab({ slug }: { slug: string }) {
  const [admins, setAdmins] = useState<TeamMember[]>([])
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('admin')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  useEffect(() => {
    fetchTeam()
  }, [slug])

  async function fetchTeam() {
    setLoading(true)
    try {
      const res = await fetch(`/api/org/${slug}/manage/team`)
      const data = await res.json()
      setAdmins(data.admins || [])
      setPendingInvites(data.pendingInvites || [])
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  async function handleInvite() {
    if (!inviteEmail.trim()) return
    setSaving(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/org/${slug}/manage/team`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      })
      const data = await res.json()
      if (res.ok) {
        setMessage({ text: data.message || 'Added successfully', type: 'success' })
        setInviteEmail('')
        fetchTeam()
      } else {
        setMessage({ text: data.error || 'Failed', type: 'error' })
      }
    } catch {
      setMessage({ text: 'Failed to send invite', type: 'error' })
    } finally {
      setSaving(false)
      setTimeout(() => setMessage(null), 4000)
    }
  }

  async function handleRemove(membershipId: string) {
    if (!confirm('Remove this team member?')) return
    try {
      const res = await fetch(`/api/org/${slug}/manage/team?id=${membershipId}`, {
        method: 'DELETE',
      })
      if (res.ok) {
        setAdmins((prev) => prev.filter((a) => a.id !== membershipId))
        setMessage({ text: 'Removed', type: 'success' })
        setTimeout(() => setMessage(null), 3000)
      }
    } catch {
      setMessage({ text: 'Failed to remove', type: 'error' })
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
      {message && (
        <p className={`text-sm ${message.type === 'success' ? 'text-emerald-400' : 'text-red-400'}`}>
          {message.text}
        </p>
      )}

      {/* Invite form */}
      <div className="flex flex-col sm:flex-row gap-2">
        <Input
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          placeholder="Email address"
          type="email"
          className={`flex-1 ${inputClass}`}
          onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
        />
        <Select value={inviteRole} onValueChange={setInviteRole}>
          <SelectTrigger className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="manager">Manager</SelectItem>
          </SelectContent>
        </Select>
        <Button
          onClick={handleInvite}
          disabled={saving || !inviteEmail.trim()}
          className={primaryBtnClass}
        >
          {saving ? '...' : 'Invite'}
        </Button>
      </div>

      {/* Current members */}
      <div className="space-y-2">
        {admins.map((admin) => (
          <div
            key={admin.id}
            className="flex items-center justify-between p-3 rounded-lg border border-border bg-card"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-[var(--timberwolf)] truncate">
                  {admin.fullName || admin.email}
                </p>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-700 text-muted-foreground font-medium">
                  {admin.role}
                </span>
                {admin.isCurrentUser && (
                  <span className="text-[10px] text-muted-foreground">(you)</span>
                )}
              </div>
              {admin.fullName && admin.email && (
                <p className="text-xs text-muted-foreground mt-0.5">{admin.email}</p>
              )}
            </div>
            {!admin.isCurrentUser && (
              <button
                onClick={() => handleRemove(admin.id)}
                className="text-xs px-2.5 py-1.5 rounded-md text-red-400/60 hover:text-red-400 hover:bg-red-500/10 transition-colors"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Pending invites */}
      {pendingInvites.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground mb-2">Pending invites</p>
          <div className="space-y-1">
            {pendingInvites.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between p-2.5 rounded-lg border border-dashed border-border"
              >
                <div className="flex items-center gap-2">
                  <p className="text-sm text-muted-foreground">{inv.invited_email}</p>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">
                    Pending
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
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

type GroupTab = 'overview' | 'graphics' | 'team'

function GroupDashboardView({ slug, hasGraphicPackages }: { slug: string; hasGraphicPackages: boolean }) {
  const router = useRouter()
  const [data, setData] = useState<GroupDashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<GroupTab>('overview')

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

  if (!data && !loading && activeTab === 'overview') return null

  const currency = data?.currency || 'KWD'

  const groupTabs: Array<{ id: GroupTab; label: string }> = [
    { id: 'overview', label: 'Overview' },
    ...(hasGraphicPackages ? [{ id: 'graphics' as GroupTab, label: 'Graphic Packages' }] : []),
    { id: 'team', label: 'Team' },
  ]

  return (
    <div className="space-y-6">
      {/* Tab navigation */}
      <div className="flex gap-1 border-b border-border pb-px overflow-x-auto">
        {groupTabs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`px-3.5 py-2 text-sm rounded-t-md transition-colors whitespace-nowrap -mb-px border-b-2 ${
              activeTab === id
                ? 'text-[var(--timberwolf)] border-[var(--timberwolf)] bg-muted/30'
                : 'text-muted-foreground border-transparent hover:text-[var(--timberwolf)] hover:bg-muted/20'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'graphics' && <GraphicPackagesTab slug={slug} />}
      {activeTab === 'team' && <TeamTab slug={slug} />}

      {activeTab === 'overview' && loading && (
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
      )}

      {activeTab === 'overview' && data && <>
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
      </>}
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
        <GroupDashboardView slug={slug} hasGraphicPackages={org.featureGraphicPackages} />
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
            {activeTab === 'recordings' && <RecordingsTab slug={slug} />}
            {activeTab === 'team' && <TeamTab slug={slug} />}
          </div>
        </>
      )}
    </div>
  )
}
