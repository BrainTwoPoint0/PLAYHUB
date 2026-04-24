'use client'

import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import {
  Button,
  Input,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  DateTimePicker,
} from '@braintwopoint0/playback-commons/ui'
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
import { LoadingSpinner } from '@/components/ui/loading'
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
  ownerOrgName?: string
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
  type?: string
  feature_recordings?: boolean
  feature_streaming?: boolean
  feature_graphic_packages?: boolean
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

interface PendingInvite {
  id: string
  email: string
  role: string
  invitedAt: string
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
    <div className="mb-6 rounded-xl border border-border bg-card">
      <div className="p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
              Marketplace Revenue
            </h2>
            <p className="text-sm text-muted-foreground">
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
            <LoadingSpinner size="sm" className="text-muted-foreground" />
          ) : !data || data.totalSales === 0 ? (
            <p className="text-sm text-muted-foreground">
              No marketplace sales yet.
            </p>
          ) : (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-muted">
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
                    <p className="text-xs text-muted-foreground mb-1">
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
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50 border border-border"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-[var(--timberwolf)] truncate">
                        {rec.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {rec.sales} sale{rec.sales !== 1 ? 's' : ''}
                      </p>
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                      <p className="text-sm font-semibold text-[var(--timberwolf)]">
                        {formatPrice(rec.orgShare, data.currency)}
                      </p>
                      <p className="text-xs text-muted-foreground">
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

interface GraphicPackage {
  id: string
  name: string
  is_default: boolean
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

  // Group dashboard state (for group-type orgs)
  const [groupData, setGroupData] = useState<GroupDashboardData | null>(null)
  const [groupLoading, setGroupLoading] = useState(false)

  // Section loading states (for independent async sections)
  const [billingLoading, setBillingLoading] = useState(true)
  const [scenesLoading, setScenesLoading] = useState(true)
  const [marketplaceLoading, setMarketplaceLoading] = useState(true)

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
  const [editingRecording, setEditingRecording] = useState<Recording | null>(
    null
  )
  const [editTitle, setEditTitle] = useState('')
  const [editHomeTeam, setEditHomeTeam] = useState('')
  const [editAwayTeam, setEditAwayTeam] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [togglingBillable, setTogglingBillable] = useState<string | null>(null)
  const [editingAmountId, setEditingAmountId] = useState<string | null>(null)
  const [editingAmountValue, setEditingAmountValue] = useState('')
  const [deletingRecording, setDeletingRecording] = useState<string | null>(
    null
  )

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
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([])
  const [adminsLoading, setAdminsLoading] = useState(false)
  const [adminsLoaded, setAdminsLoaded] = useState(false)
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

  // Marketplace state (for schedule form)
  const [marketplaceEnabled, setMarketplaceEnabled] = useState(false)
  const [marketplacePrice, setMarketplacePrice] = useState('')

  // Org-level marketplace settings
  const [orgMarketplace, setOrgMarketplace] = useState<{
    marketplace_enabled: boolean
    default_price_amount: number | null
    default_price_currency: string
  } | null>(null)

  // Graphic package state (for schedule form)
  const [scheduleGraphicPackages, setScheduleGraphicPackages] = useState<
    GraphicPackage[]
  >([])
  const [selectedGraphicPackageId, setSelectedGraphicPackageId] =
    useState<string>('default')

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

      // Fetch venue info first — this is the critical data
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
    } catch (err) {
      setError('Failed to load venue data')
    } finally {
      setLoading(false)
    }
  }

  // Load supplementary data independently once venue is available
  useEffect(() => {
    if (!venue) return

    // If group org, fetch group dashboard data instead of venue-specific data
    if (venue.type === 'group') {
      setGroupLoading(true)
      fetch(`/api/venue/${venueId}/group-dashboard`)
        .then((res) => res.json())
        .then((data) => {
          if (!data.error) setGroupData(data)
        })
        .catch(() => {})
        .finally(() => {
          setGroupLoading(false)
          setBillingLoading(false)
          setScenesLoading(false)
          setMarketplaceLoading(false)
        })
      // Also fetch recordings (aggregated from child venues via Phase 4)
      fetchRecordings()
      return
    }

    // Fetch org marketplace settings
    if (venue.slug) {
      fetch(`/api/org/${venue.slug}/marketplace`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data) setOrgMarketplace(data)
        })
        .catch(() => {})
        .finally(() => setMarketplaceLoading(false))
    } else {
      setMarketplaceLoading(false)
    }

    // Fetch scenes for scheduling
    fetch(`/api/venue/${venueId}/spiideo/scenes`)
      .then((res) => res.json())
      .then((data) => {
        if (data.scenes) {
          setScenes(data.scenes)
          if (data.scenes.length > 0 && !sceneId) {
            setSceneId(data.scenes[0].id)
          }
        }
      })
      .catch(() => {})
      .finally(() => setScenesLoading(false))

    // Fetch billing data
    fetchBillingData().finally(() => setBillingLoading(false))
  }, [venue])

  // Debounce search input
  useEffect(() => {
    const timeout = setTimeout(() => {
      setDebouncedSearch(searchInput)
      setCurrentPage(1)
    }, 300)
    return () => clearTimeout(timeout)
  }, [searchInput])

  // Separate recordings fetch with pagination + filters
  async function fetchRecordings(
    page?: number,
    search?: string,
    status?: string,
    billable?: string
  ) {
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
      fetchRecordings(
        currentPage,
        debouncedSearch,
        statusFilter,
        billableFilter
      )
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
              ? {
                  ...r,
                  title: editTitle,
                  home_team: editHomeTeam,
                  away_team: editAwayTeam,
                }
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
      setAdminsLoading(true)
      const res = await fetch(`/api/venue/${venueId}/admins`)
      const data = await res.json()
      setAdmins(Array.isArray(data.admins) ? data.admins : [])
      setPendingInvites(
        Array.isArray(data.pendingInvites) ? data.pendingInvites : []
      )
    } catch (err) {
      console.error('Failed to fetch admins:', err)
    } finally {
      setAdminsLoading(false)
      setAdminsLoaded(true)
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
      }
      fetchAdmins()
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
          marketplaceEnabled,
          priceAmount:
            marketplaceEnabled && marketplacePrice
              ? Number(marketplacePrice)
              : undefined,
          priceCurrency: orgMarketplace?.default_price_currency || 'AED',
          graphicPackageId:
            selectedGraphicPackageId === 'default'
              ? undefined
              : selectedGraphicPackageId === 'none'
                ? null
                : selectedGraphicPackageId,
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
    'bg-zinc-800 border-border text-[var(--timberwolf)] placeholder:text-muted-foreground/40'
  const outlineBtnClass =
    'border-border text-[var(--timberwolf)] hover:bg-muted'
  const primaryBtnClass =
    'bg-[var(--timberwolf)] text-[var(--night)] hover:bg-[var(--ash-grey)]'

  if (loading) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-6xl animate-pulse">
          {/* Header skeleton */}
          <div className="flex items-center justify-between mb-8">
            <div className="space-y-2">
              <div className="bg-muted rounded h-3 w-[140px]" />
              <div className="bg-muted rounded h-8 w-[200px]" />
            </div>
            <div className="bg-muted rounded h-10 w-[110px]" />
          </div>

          {/* Schedule Recording skeleton */}
          <div className="mb-6 rounded-xl border border-border bg-card p-6">
            <div className="flex items-center justify-between">
              <div className="bg-muted rounded h-5 w-[160px]" />
              <div className="bg-muted rounded h-10 w-[140px]" />
            </div>
          </div>

          {/* Live Streaming skeleton */}
          <div className="mb-6 rounded-xl border border-border bg-card p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <div className="bg-muted rounded h-5 w-[130px]" />
                <div className="bg-muted rounded h-3 w-[260px]" />
              </div>
              <div className="bg-muted rounded h-10 w-[130px]" />
            </div>
          </div>

          {/* Billing skeleton */}
          <div className="mb-6 rounded-xl border border-border bg-card">
            <div className="p-5">
              {/* Header row */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div className="space-y-1.5">
                  <div className="bg-muted rounded h-5 w-[60px]" />
                  <div className="bg-muted rounded h-3 w-[100px]" />
                </div>
                <div className="flex items-center gap-4">
                  <div className="bg-muted rounded h-6 w-[80px]" />
                  <div className="bg-muted rounded h-6 w-[70px]" />
                </div>
              </div>
              {/* 4-column financial grid */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-muted">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="bg-[var(--night)] p-3.5 space-y-2">
                    <div className="flex items-center gap-1.5">
                      <div className="h-1.5 w-1.5 rounded-full bg-muted" />
                      <div className="bg-muted rounded h-2.5 w-[60px]" />
                    </div>
                    <div className="bg-muted rounded h-6 w-[90px]" />
                    <div className="bg-muted rounded h-2.5 w-[70px]" />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Recordings skeleton */}
          <div className="rounded-xl border border-border bg-card">
            <div className="p-6 space-y-1">
              <div className="bg-muted rounded h-5 w-[100px]" />
              <div className="bg-muted rounded h-3 w-[120px]" />
            </div>
            <div className="px-6 pb-6 space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="p-4 rounded-lg bg-muted/50 border border-border"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-shrink-0 w-10 h-10 rounded bg-muted" />
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-2">
                        <div className="bg-muted rounded h-4 w-2/5" />
                        <div className="bg-muted rounded h-4 w-16" />
                      </div>
                      <div className="bg-muted rounded h-3 w-3/5" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                    <div className="bg-muted rounded h-3 w-16" />
                    <div className="flex gap-2">
                      <div className="bg-muted rounded h-8 w-24" />
                      <div className="bg-muted rounded h-8 w-28" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Venue Admins skeleton */}
          <div className="mt-6 rounded-xl border border-border bg-card p-6">
            <div className="flex items-center justify-between mb-1">
              <div className="bg-muted rounded h-5 w-[120px]" />
              <div className="bg-muted rounded h-10 w-[130px]" />
            </div>
            <div className="bg-muted rounded h-3 w-[300px]" />
          </div>
        </div>
      </div>
    )
  }

  if (error && !venue) {
    return (
      <div className="min-h-screen bg-[var(--night)]">
        <div className="container mx-auto px-5 py-16 max-w-6xl">
          <div className="rounded-xl border border-border bg-card p-6">
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
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-8">
          <div>
            <p className="text-muted-foreground text-xs font-semibold tracking-[0.25em] uppercase mb-2">
              {venue?.type === 'group' ? 'Group Overview' : 'Venue Management'}
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

        {/* Group Dashboard — shown for group-type orgs */}
        {venue?.type === 'group' && (
          <>
            {groupLoading ? (
              <div className="mb-6 rounded-xl border border-border bg-card animate-pulse p-6">
                <div className="space-y-4">
                  <div className="bg-muted rounded h-5 w-[200px]" />
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-muted">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="bg-[var(--night)] p-3.5 space-y-2"
                      >
                        <div className="bg-muted rounded h-2.5 w-[60px]" />
                        <div className="bg-muted rounded h-6 w-[90px]" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              groupData && (
                <div className="space-y-6 mb-6">
                  {/* Aggregated totals */}
                  <div className="rounded-xl border border-border bg-card">
                    <div className="p-5">
                      <h2 className="text-base font-semibold text-[var(--timberwolf)] mb-4">
                        Portfolio Overview
                      </h2>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-muted">
                        {[
                          {
                            label: 'Total Recordings',
                            value: String(groupData.totals.totalRecordings),
                            sub: `${groupData.totals.publishedRecordings} published`,
                          },
                          {
                            label: 'This Month',
                            value: String(groupData.totals.monthRecordings),
                            sub: 'recordings',
                          },
                          {
                            label: 'Monthly Revenue',
                            value:
                              groupData.childVenues.length > 0
                                ? new Intl.NumberFormat('en-GB', {
                                    style: 'currency',
                                    currency:
                                      groupData.childVenues[0]?.currency ||
                                      'KWD',
                                    minimumFractionDigits: 0,
                                    maximumFractionDigits: 3,
                                  }).format(groupData.totals.monthRevenue)
                                : '0',
                            sub: 'billable',
                          },
                          {
                            label: 'Today',
                            value: String(groupData.totals.todayCount),
                            sub: 'recordings',
                          },
                        ].map((card) => (
                          <div
                            key={card.label}
                            className="bg-[var(--night)] p-3.5"
                          >
                            <p className="text-xs text-muted-foreground mb-1">
                              {card.label}
                            </p>
                            <p className="text-lg font-semibold text-[var(--timberwolf)]">
                              {card.value}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {card.sub}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Daily performance chart */}
                  {groupData.dailyChart.length > 0 && (
                    <div className="rounded-xl border border-border bg-card">
                      <div className="p-5">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                          <div>
                            <h2 className="text-base font-semibold text-[var(--timberwolf)]">
                              Daily Performance
                            </h2>
                            <p className="text-xs text-muted-foreground">
                              Avg {groupData.averagePerDay}/day
                              {groupData.totalDailyTarget > 0 &&
                                ` · Target: ${groupData.totalDailyTarget}/day`}
                            </p>
                          </div>
                        </div>
                        <ChartContainer
                          config={
                            Object.fromEntries(
                              groupData.venueNames.map((name, i) => [
                                name,
                                {
                                  label: name,
                                  color: [
                                    'hsl(142, 71%, 45%)',
                                    'hsl(217, 91%, 60%)',
                                    'hsl(47, 96%, 53%)',
                                    'hsl(280, 65%, 60%)',
                                    'hsl(15, 90%, 55%)',
                                  ][i % 5],
                                },
                              ])
                            ) as ChartConfig
                          }
                          className="h-[220px] w-full"
                        >
                          <AreaChart data={groupData.dailyChart}>
                            <CartesianGrid
                              strokeDasharray="3 3"
                              stroke="hsl(var(--border))"
                            />
                            <XAxis
                              dataKey="date"
                              tickFormatter={(d: string) => {
                                const day = parseInt(d.split('-')[2], 10)
                                return day % 5 === 1 || day === 1
                                  ? String(day)
                                  : ''
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
                            {groupData.totalDailyTarget > 0 && (
                              <ReferenceLine
                                y={groupData.totalDailyTarget}
                                stroke="hsl(var(--muted-foreground))"
                                strokeDasharray="6 4"
                                strokeOpacity={0.5}
                              />
                            )}
                            {groupData.venueNames.map((name, i) => (
                              <Area
                                key={name}
                                type="monotone"
                                dataKey={name}
                                stackId="1"
                                fill={
                                  [
                                    'hsl(142, 71%, 45%)',
                                    'hsl(217, 91%, 60%)',
                                    'hsl(47, 96%, 53%)',
                                    'hsl(280, 65%, 60%)',
                                    'hsl(15, 90%, 55%)',
                                  ][i % 5]
                                }
                                fillOpacity={0.4}
                                stroke={
                                  [
                                    'hsl(142, 71%, 45%)',
                                    'hsl(217, 91%, 60%)',
                                    'hsl(47, 96%, 53%)',
                                    'hsl(280, 65%, 60%)',
                                    'hsl(15, 90%, 55%)',
                                  ][i % 5]
                                }
                                strokeWidth={1.5}
                              />
                            ))}
                          </AreaChart>
                        </ChartContainer>
                      </div>
                    </div>
                  )}

                  {/* Per-venue breakdown */}
                  <div className="rounded-xl border border-border bg-card">
                    <div className="p-5">
                      <h2 className="text-base font-semibold text-[var(--timberwolf)] mb-4">
                        Venues ({groupData.childVenues.length})
                      </h2>
                      <div className="space-y-3">
                        {groupData.childVenues.map((child) => (
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
                                    Today: {child.todayCount}/
                                    {child.dailyTarget}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0">
                              {child.monthRevenue > 0 && (
                                <span className="text-sm font-semibold text-[var(--timberwolf)]">
                                  {new Intl.NumberFormat('en-GB', {
                                    style: 'currency',
                                    currency: child.currency,
                                    minimumFractionDigits: 0,
                                    maximumFractionDigits: 3,
                                  }).format(child.monthRevenue)}
                                </span>
                              )}
                              <Button
                                variant="outline"
                                size="sm"
                                className={outlineBtnClass}
                                onClick={() =>
                                  router.push(`/venue/${child.id}`)
                                }
                              >
                                Manage
                              </Button>
                            </div>
                          </div>
                        ))}
                        {groupData.childVenues.length === 0 && (
                          <p className="text-muted-foreground text-center py-4">
                            No child venues yet. Add venues from the admin
                            dashboard.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )
            )}
          </>
        )}

        {/* Billing, Scheduling, Streaming, Marketplace — hidden for group orgs */}
        {venue?.type !== 'group' && (
          <>
            {billingLoading ? (
              <div className="mb-6 rounded-xl border border-border bg-card animate-pulse">
                <div className="p-5">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                    <div className="space-y-1.5">
                      <div className="bg-muted rounded h-5 w-[60px]" />
                      <div className="bg-muted rounded h-3 w-[100px]" />
                    </div>
                    <div className="flex items-center gap-4">
                      <div className="bg-muted rounded h-6 w-[80px]" />
                      <div className="bg-muted rounded h-6 w-[70px]" />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-muted">
                    {[0, 1, 2, 3].map((i) => (
                      <div
                        key={i}
                        className="bg-[var(--night)] p-3.5 space-y-2"
                      >
                        <div className="flex items-center gap-1.5">
                          <div className="h-1.5 w-1.5 rounded-full bg-muted" />
                          <div className="bg-muted rounded h-2.5 w-[60px]" />
                        </div>
                        <div className="bg-muted rounded h-6 w-[90px]" />
                        <div className="bg-muted rounded h-2.5 w-[70px]" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              billingConfig?.is_active && (
                <div className="mb-6 rounded-xl border border-[var(--ash-grey)]/8 bg-card">
                  <div className="p-5">
                    {/* Header row */}
                    <div className="relative flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 mb-4">
                      <h2 className="text-base font-semibold text-[var(--timberwolf)]">
                        Billing
                      </h2>
                      <div className="flex items-center gap-3 order-last sm:order-none ml-auto sm:ml-0 sm:absolute sm:left-1/2 sm:-translate-x-1/2">
                        <button
                          onClick={() => {
                            const prev =
                              billingMonth === 1
                                ? { m: 12, y: billingYear - 1 }
                                : { m: billingMonth - 1, y: billingYear }
                            setBillingMonth(prev.m)
                            setBillingYear(prev.y)
                            fetchBillingData(prev.m, prev.y)
                          }}
                          className="text-muted-foreground/70 hover:text-[var(--timberwolf)] text-base px-1.5 py-0.5"
                        >
                          ‹
                        </button>
                        <p className="text-sm text-muted-foreground font-medium min-w-[120px] text-center">
                          {new Date(
                            billingYear,
                            billingMonth - 1
                          ).toLocaleDateString('en-GB', {
                            month: 'long',
                            year: 'numeric',
                          })}
                        </p>
                        <button
                          onClick={() => {
                            if (isCurrentBillingMonth) return
                            const next =
                              billingMonth === 12
                                ? { m: 1, y: billingYear + 1 }
                                : { m: billingMonth + 1, y: billingYear }
                            setBillingMonth(next.m)
                            setBillingYear(next.y)
                            fetchBillingData(next.m, next.y)
                          }}
                          disabled={isCurrentBillingMonth}
                          className={`text-base px-1.5 py-0.5 ${isCurrentBillingMonth ? 'text-muted-foreground/20 cursor-not-allowed' : 'text-muted-foreground/70 hover:text-[var(--timberwolf)]'}`}
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
                            <span className="text-muted-foreground/60 ml-1 text-xs">
                              {billingSummary.currency}
                            </span>
                          </div>
                          <div className="border-l border-border pl-3 sm:pl-4">
                            <span
                              className="text-[var(--timberwolf)] font-medium"
                              style={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                              {billingSummary.count}
                            </span>
                            <span className="text-muted-foreground/60 ml-1 text-xs">
                              recordings
                            </span>
                          </div>
                          {billingSummary.dailyTarget > 0 &&
                            isCurrentBillingMonth && (
                              <div className="border-l border-border pl-3 sm:pl-4">
                                <span
                                  className="text-[var(--timberwolf)] font-medium"
                                  style={{ fontVariantNumeric: 'tabular-nums' }}
                                >
                                  {billingSummary.todayCount}
                                </span>
                                <span className="text-muted-foreground/60 text-xs">
                                  /{billingSummary.dailyTarget} today
                                </span>
                              </div>
                            )}
                        </div>
                      )}
                    </div>

                    {/* Financial summary — 3 columns with 1px gap borders */}
                    {billingSummary && (
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-muted mb-4">
                        {/* Venue-collected revenue */}
                        <div className="bg-[var(--night)] p-3.5">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-amber-400/60" />
                            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                              At venue
                            </p>
                          </div>
                          <p
                            className="text-lg font-semibold text-[var(--timberwolf)]"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {billingSummary.venueCollectedRevenue.toFixed(3)}
                            <span className="text-[10px] font-normal text-muted-foreground/50 ml-1">
                              {billingSummary.currency}
                            </span>
                          </p>
                          <p className="text-[10px] text-muted-foreground/40 mt-1">
                            {billingSummary.venueCollectedCount} recording
                            {billingSummary.venueCollectedCount === 1
                              ? ''
                              : 's'}
                          </p>
                        </div>
                        {/* QR Code-collected revenue */}
                        <div className="bg-[var(--night)] p-3.5">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-indigo-400/60" />
                            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                              QR Code
                            </p>
                          </div>
                          <p
                            className="text-lg font-semibold text-[var(--timberwolf)]"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {billingSummary.playhubCollectedRevenue.toFixed(3)}
                            <span className="text-[10px] font-normal text-muted-foreground/50 ml-1">
                              {billingSummary.currency}
                            </span>
                          </p>
                          <p className="text-[10px] text-muted-foreground/40 mt-1">
                            {billingSummary.playhubCollectedCount} recording
                            {billingSummary.playhubCollectedCount === 1
                              ? ''
                              : 's'}
                          </p>
                        </div>
                        {/* Venue profit share */}
                        <div className="bg-[var(--night)] p-3.5">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-emerald-400/60" />
                            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                              Your profit
                            </p>
                          </div>
                          <p
                            className="text-lg font-semibold text-emerald-400"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {billingSummary.venueTotalProfit.toFixed(3)}
                            <span className="text-[10px] font-normal text-muted-foreground/50 ml-1">
                              {billingSummary.currency}
                            </span>
                          </p>
                          <p className="text-[10px] text-muted-foreground/40 mt-1">
                            {billingSummary.count} recording
                            {billingSummary.count === 1 ? '' : 's'} in{' '}
                            {new Date(
                              billingYear,
                              billingMonth - 1
                            ).toLocaleDateString('en-GB', { month: 'long' })}
                          </p>
                        </div>
                        {/* Net settlement */}
                        <div className="bg-[var(--night)] p-3.5">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <div
                              className={`h-1.5 w-1.5 rounded-full ${billingSummary.netBalance > 0 ? 'bg-amber-400/60' : billingSummary.netBalance < 0 ? 'bg-emerald-400/60' : 'bg-[var(--ash-grey)]/40'}`}
                            />
                            <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                              Net settlement
                            </p>
                          </div>
                          <p
                            className="text-lg font-semibold text-[var(--timberwolf)]"
                            style={{ fontVariantNumeric: 'tabular-nums' }}
                          >
                            {Math.abs(billingSummary.netBalance).toFixed(3)}
                            <span className="text-[10px] font-normal text-muted-foreground/50 ml-1">
                              {billingSummary.currency}
                            </span>
                          </p>
                          <p className="text-[10px] text-muted-foreground/40 mt-1">
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
                          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                            Daily activity
                          </p>
                          {dailyStats.scenes.length > 1 && (
                            <div className="flex items-center gap-3">
                              {dailyStats.scenes.map((scene, i) => (
                                <div
                                  key={scene}
                                  className="flex items-center gap-1 text-[10px] text-muted-foreground/50"
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
                            data={dailyStats.days
                              .filter(
                                (d) =>
                                  d.date <=
                                  new Date().toISOString().slice(0, 10)
                              )
                              .map((d) => ({
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
                              tick={{
                                fill: 'rgba(185,186,163,0.4)',
                                fontSize: 9,
                              }}
                              axisLine={false}
                              tickLine={false}
                              interval="preserveStartEnd"
                            />
                            <YAxis
                              allowDecimals={false}
                              tick={{
                                fill: 'rgba(185,186,163,0.4)',
                                fontSize: 9,
                              }}
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
                      className="text-[11px] text-muted-foreground/40 hover:text-muted-foreground transition-colors"
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
                        <p className="text-xs text-muted-foreground/50">
                          No invoices yet
                        </p>
                      ) : (
                        invoices.map((inv) => {
                          const net = Number(inv.net_amount)
                          const totalRecordings =
                            inv.venue_collected_count +
                            inv.playhub_collected_count
                          return (
                            <div
                              key={inv.id}
                              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-card rounded-lg border border-[var(--ash-grey)]/[0.06]"
                            >
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-[var(--timberwolf)]">
                                  {new Date(
                                    inv.period_start
                                  ).toLocaleDateString('en-GB', {
                                    month: 'long',
                                    year: 'numeric',
                                  })}
                                </p>
                                <p className="text-[11px] text-muted-foreground/50">
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
                                <span className="text-[10px] text-muted-foreground/40">
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
              )
            )}

            {/* Schedule Recording */}
            {venue?.feature_recordings !== false &&
              (scenesLoading ? (
                <div className="mb-6 rounded-xl border border-border bg-card p-6 animate-pulse">
                  <div className="flex items-center justify-between">
                    <div className="bg-muted rounded h-5 w-[160px]" />
                    <div className="bg-muted rounded h-10 w-[140px]" />
                  </div>
                </div>
              ) : (
                scenes.length > 0 && (
                  <div className="mb-6 rounded-xl border border-border bg-card">
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
                              <Select
                                value={sceneId}
                                onValueChange={setSceneId}
                                disabled={scenes.length <= 1}
                              >
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
                            <p className="text-xs text-muted-foreground">
                              These users will have access immediately (even
                              before recording is ready)
                            </p>
                          </div>

                          {/* Paid recording */}
                          {billingConfig?.is_active && (
                            <div className="space-y-2">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={isBillable}
                                  onChange={(e) =>
                                    setIsBillable(e.target.checked)
                                  }
                                  className="w-4 h-4 rounded border-border bg-white/5 accent-[var(--timberwolf)]"
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
                                      billingConfig.default_billable_amount ||
                                        '5.000'
                                    )}
                                    className={`w-32 ${inputClass}`}
                                  />
                                  <span className="text-sm text-muted-foreground">
                                    {billingConfig.currency || 'KWD'}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          {/* List on marketplace */}
                          {orgMarketplace?.marketplace_enabled && (
                            <div className="space-y-2">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={marketplaceEnabled}
                                  onChange={(e) =>
                                    setMarketplaceEnabled(e.target.checked)
                                  }
                                  className="w-4 h-4 rounded border-border bg-white/5 accent-[var(--timberwolf)]"
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
                                    onChange={(e) =>
                                      setMarketplacePrice(e.target.value)
                                    }
                                    placeholder={String(
                                      orgMarketplace.default_price_amount ||
                                        '25.00'
                                    )}
                                    className={`w-32 ${inputClass}`}
                                  />
                                  <span className="text-sm text-muted-foreground">
                                    {orgMarketplace.default_price_currency ||
                                      'AED'}
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
                              <Select
                                value={selectedGraphicPackageId}
                                onValueChange={setSelectedGraphicPackageId}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="default">
                                    Use Default
                                  </SelectItem>
                                  <SelectItem value="none">None</SelectItem>
                                  {scheduleGraphicPackages.map((pkg) => (
                                    <SelectItem key={pkg.id} value={pkg.id}>
                                      {pkg.name}
                                      {pkg.is_default ? ' (default)' : ''}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <p className="text-xs text-muted-foreground">
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
                              {submitting
                                ? 'Scheduling...'
                                : 'Schedule Recording'}
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
                )
              ))}

            {/* Live Streaming Section */}
            {venue?.feature_streaming !== false && (
              <div className="mb-6 rounded-xl border border-border bg-card">
                <div className="p-6">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                    <div>
                      <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                        Live Streaming
                      </h2>
                      <p className="text-sm text-muted-foreground">
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
                    <div className="p-4 bg-muted/50 rounded-lg border border-border">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                        <div>
                          <h4 className="font-medium text-[var(--timberwolf)]">
                            Schedule Live Stream
                          </h4>
                          <p className="text-sm text-muted-foreground">
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
                              <label className="text-sm text-muted-foreground">
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
                              <label className="text-sm text-muted-foreground">
                                Camera/Pitch *
                              </label>
                              <Select
                                value={streamSceneId}
                                onValueChange={setStreamSceneId}
                              >
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
                              <label className="text-sm text-muted-foreground">
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
                              <label className="text-sm text-muted-foreground">
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
                              className="text-[var(--timberwolf)] hover:bg-muted"
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
                      <p className="text-sm text-muted-foreground">
                        Loading channels...
                      </p>
                    ) : channels.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        No streaming channels yet. Create one to get started.
                      </p>
                    ) : (
                      <div className="space-y-4">
                        {channels.map((channel) => (
                          <div
                            key={channel.id}
                            className="p-4 bg-muted/50 rounded-lg border border-border space-y-3"
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
                                    onClick={() =>
                                      handleStartChannel(channel.id)
                                    }
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
                                    onClick={() =>
                                      handleStopChannel(channel.id)
                                    }
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
                                    onClick={() =>
                                      handleDeleteChannel(channel.id)
                                    }
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
                                  <span className="text-muted-foreground text-xs block mb-1">
                                    RTMP URL
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <code className="flex-1 min-w-0 bg-black/30 px-2 py-1 rounded text-xs truncate text-[var(--timberwolf)]">
                                      {channel.rtmp.url}
                                    </code>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="flex-shrink-0 text-[var(--timberwolf)] hover:bg-muted"
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
                                  <span className="text-muted-foreground text-xs block mb-1">
                                    Stream Key
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <code className="flex-1 min-w-0 bg-black/30 px-2 py-1 rounded text-xs truncate text-[var(--timberwolf)]">
                                      {channel.rtmp.streamKey}
                                    </code>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="flex-shrink-0 text-[var(--timberwolf)] hover:bg-muted"
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
                                    <span className="text-muted-foreground text-xs block mb-1">
                                      Playback
                                    </span>
                                    <div className="flex items-center gap-2">
                                      <code className="flex-1 min-w-0 bg-black/30 px-2 py-1 rounded text-xs truncate text-[var(--timberwolf)]">
                                        {channel.playbackUrl}
                                      </code>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="flex-shrink-0 text-[var(--timberwolf)] hover:bg-muted"
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
                            {channel.state === 'RUNNING' &&
                              channel.playbackUrl && (
                                <div className="mt-3">
                                  <p className="text-xs text-muted-foreground mb-2">
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
                                Channel is being created. This may take a
                                minute...
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
            )}

            {/* Marketplace Revenue */}
            {marketplaceLoading ? (
              <div className="mb-6 rounded-xl border border-border bg-card p-6 animate-pulse">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                  <div className="space-y-2">
                    <div className="bg-muted rounded h-5 w-[180px]" />
                    <div className="bg-muted rounded h-3 w-[280px]" />
                  </div>
                  <div className="bg-muted rounded h-10 w-[120px]" />
                </div>
              </div>
            ) : (
              orgMarketplace?.marketplace_enabled && (
                <MarketplaceRevenue
                  venueId={venueId}
                  outlineBtnClass={outlineBtnClass}
                />
              )
            )}
          </>
        )}

        {/* Recordings List */}
        <div className="rounded-xl border border-border bg-card">
          <div className="p-6">
            <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
              Recordings
            </h2>
            <p className="text-sm text-muted-foreground">
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
              <Select
                value={statusFilter || 'all'}
                onValueChange={(v) => {
                  setStatusFilter(v === 'all' ? '' : v)
                  setCurrentPage(1)
                }}
              >
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
              <Select
                value={billableFilter || 'all'}
                onValueChange={(v) => {
                  setBillableFilter(v === 'all' ? '' : v)
                  setCurrentPage(1)
                }}
              >
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
              <p className="text-muted-foreground text-center py-8">
                {debouncedSearch || statusFilter || billableFilter
                  ? 'No recordings match your filters.'
                  : 'No recordings yet. Schedule a recording to get started.'}
              </p>
            ) : (
              <div className="space-y-3">
                {recordings.map((recording) => (
                  <div
                    key={recording.id}
                    className="p-4 rounded-lg bg-muted/50 border border-border"
                  >
                    {/* Top row: Play button + Info + Status */}
                    <div className="flex items-start gap-3">
                      {/* Play Button — links to recording detail page */}
                      {recording.s3_key && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() =>
                            router.push(`/recordings/${recording.id}`)
                          }
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
                          {recording.ownerOrgName && (
                            <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 flex-shrink-0">
                              {recording.ownerOrgName}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">
                          {recording.pitch_name && `${recording.pitch_name} | `}
                          {formatTime(recording.match_date)}
                        </p>
                      </div>
                    </div>

                    {/* Bottom row: Access count & Actions */}
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between mt-3 pt-3 border-t border-border gap-2">
                      <div className="flex items-center gap-3">
                        <span className="text-sm text-muted-foreground">
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
                        {recording.is_billable !== false &&
                          (editingAmountId === recording.id ? (
                            <input
                              type="number"
                              step="0.001"
                              min="0"
                              autoFocus
                              className="w-24 text-xs px-2 py-0.5 rounded bg-zinc-800 text-[var(--timberwolf)] border border-[var(--ash-grey)]/30 outline-none"
                              value={editingAmountValue}
                              onChange={(e) =>
                                setEditingAmountValue(e.target.value)
                              }
                              onBlur={() => saveBillableAmount(recording)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter')
                                  saveBillableAmount(recording)
                                if (e.key === 'Escape') setEditingAmountId(null)
                              }}
                            />
                          ) : (
                            <span
                              className={`text-xs px-2 py-0.5 rounded ${
                                recording.collected_by !== 'playhub'
                                  ? 'cursor-pointer hover:bg-zinc-700/50'
                                  : ''
                              } text-muted-foreground`}
                              title={
                                recording.collected_by === 'playhub'
                                  ? 'Amount locked (verified transaction)'
                                  : 'Click to edit amount'
                              }
                              onClick={() => {
                                if (recording.collected_by !== 'playhub') {
                                  setEditingAmountId(recording.id)
                                  setEditingAmountValue(
                                    String(
                                      recording.billable_amount ??
                                        billingConfig?.default_billable_amount ??
                                        ''
                                    )
                                  )
                                }
                              }}
                            >
                              {(
                                recording.billable_amount ??
                                billingConfig?.default_billable_amount ??
                                0
                              ).toFixed(3)}{' '}
                              {billingConfig?.currency || 'KWD'}
                            </span>
                          ))}
                        {recording.graphicPackageName && (
                          <span
                            className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400"
                            title="Graphic Package"
                          >
                            {recording.graphicPackageName}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 sm:flex sm:items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className={outlineBtnClass}
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
                          className={outlineBtnClass}
                          onClick={() => openAccessModal(recording)}
                        >
                          Manage Access
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className={outlineBtnClass}
                          onClick={() => openEditModal(recording)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                          onClick={() => promptDeleteRecording(recording)}
                          disabled={deletingRecording === recording.id}
                        >
                          {deletingRecording === recording.id
                            ? '...'
                            : 'Delete'}
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Pagination controls */}
                {totalRecordings > pageSize && (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 pt-4 border-t border-border">
                    <p className="text-sm text-muted-foreground text-right sm:text-left">
                      {(currentPage - 1) * pageSize + 1}–
                      {Math.min(currentPage * pageSize, totalRecordings)} of{' '}
                      {totalRecordings}
                    </p>
                    <div className="flex items-center justify-center sm:justify-start gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className={outlineBtnClass}
                        disabled={currentPage <= 1}
                        onClick={() => setCurrentPage((p) => p - 1)}
                      >
                        Previous
                      </Button>
                      <span className="text-sm text-muted-foreground px-2 whitespace-nowrap">
                        Page {currentPage} of{' '}
                        {Math.ceil(totalRecordings / pageSize)}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className={outlineBtnClass}
                        disabled={
                          currentPage >= Math.ceil(totalRecordings / pageSize)
                        }
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

        {/* Venue Admins — hidden for group orgs */}
        {venue?.type !== 'group' && (
          <>
            {/* Venue Admins Section */}
            <div className="mt-6 rounded-xl border border-border bg-card">
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
                      if (!showAdminSection && !adminsLoaded) {
                        fetchAdmins()
                      }
                    }}
                  >
                    {showAdminSection ? 'Hide' : 'Manage Admins'}
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
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
                    {adminsLoading && !adminsLoaded ? (
                      <p className="text-sm text-muted-foreground">
                        Loading admins...
                      </p>
                    ) : admins.length === 0 && pendingInvites.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No admins yet. Add one above to get started.
                      </p>
                    ) : (
                      <>
                        {admins.map((admin) => (
                          <div
                            key={admin.id}
                            className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-muted/50 rounded-lg border border-border"
                          >
                            <div className="min-w-0">
                              <p className="font-medium truncate text-[var(--timberwolf)]">
                                {admin.fullName || admin.email || 'Unknown'}
                                {admin.isCurrentUser && (
                                  <span className="ml-2 text-xs text-muted-foreground">
                                    (you)
                                  </span>
                                )}
                              </p>
                              <p className="text-sm text-muted-foreground truncate">
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
                        ))}

                        {pendingInvites.length > 0 && (
                          <div className="pt-2">
                            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase mb-2">
                              Pending invites
                            </p>
                            <div className="space-y-2">
                              {pendingInvites.map((invite) => (
                                <div
                                  key={invite.id}
                                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 bg-muted/30 rounded-lg border border-dashed border-border"
                                >
                                  <div className="min-w-0">
                                    <p className="font-medium truncate text-[var(--timberwolf)]">
                                      {invite.email}
                                    </p>
                                    <p className="text-sm text-muted-foreground">
                                      Invited{' '}
                                      {new Date(
                                        invite.invitedAt
                                      ).toLocaleDateString()}{' '}
                                      — waiting for account creation
                                    </p>
                                  </div>
                                  <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 flex-shrink-0 w-fit">
                                    {invite.role.replace('_', ' ')}
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Access Modal */}
        {showAccessModal && selectedRecording && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="w-full max-w-lg m-4 rounded-xl border border-border bg-[var(--night)]">
              <div className="p-6">
                <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                  Manage Access
                </h2>
                <p className="text-sm text-muted-foreground">
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
                    <p className="text-sm text-muted-foreground">
                      No one has access yet
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {accessList.map((access) => (
                        <div
                          key={access.id}
                          className="flex items-center justify-between p-2 bg-muted/50 rounded border border-border"
                        >
                          <div>
                            <p className="text-sm text-[var(--timberwolf)]">
                              {access.invitedEmail ||
                                access.userEmail ||
                                access.userId?.slice(0, 8) + '...'}
                            </p>
                            {access.expiresAt && (
                              <p className="text-xs text-muted-foreground">
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
                            <span className="text-xs text-muted-foreground">
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
            <div className="w-full max-w-lg m-4 rounded-xl border border-border bg-[var(--night)]">
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
                <p className="text-sm text-muted-foreground mt-2">
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
