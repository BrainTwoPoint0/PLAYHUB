'use client'

import { useState, useEffect, useRef } from 'react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { useParams } from 'next/navigation'
import { useRouter } from '@/i18n/navigation'
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
import {
  buildDefaultTitle,
  buildDefaultDescription,
} from '@/lib/recordings/defaults'
import { HlsPlayer } from '@/components/streaming/HlsPlayer'
import { AuditHistory } from '@/components/venue/AuditHistory'
import { ClutchVenueStats } from '@/components/venue/ClutchVenueStats'

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
  clutch_video_id?: string | null
  clutch_match_stats?: {
    match_time_minutes?: number
    match_time_in_play_minutes?: number
    avg_rally_shots?: number
    avg_rally_seconds?: number
    longest_rally_shots?: number
    longest_rally_seconds?: number
    players?: number
  } | null
  is_billable?: boolean
  billable_amount?: number
  collected_by?: string
  graphic_package_id?: string
  graphicPackageName?: string
  ownerOrgName?: string
  accessCount?: number
  marketplace_enabled?: boolean
  marketplace_product?: {
    id: string
    price_amount: number
    currency: string
    is_available: boolean
  } | null
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
  provider?: 'spiideo' | 'clutch'
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
  venueProfitSharePct?: number
  ambassadorPct?: number
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
  const t = useTranslations('venue.marketplace')
  const format = useFormatter()
  const pickerLocale = useLocale()
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
    return format.number(amount, {
      numberingSystem: 'latn',
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    })
  }

  return (
    <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
      <div className="p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
              {t('title')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
          </div>
          <Button
            variant="outline"
            className={`w-full md:w-auto ${outlineBtnClass}`}
            onClick={handleToggle}
          >
            {expanded ? t('hide') : t('viewRevenue')}
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="px-6 pb-6">
          {loading ? (
            <LoadingSpinner size="sm" className="text-muted-foreground" />
          ) : !data || data.totalSales === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noSales')}</p>
          ) : (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-white/[0.06]">
                {[
                  { label: t('totalSales'), value: String(data.totalSales) },
                  {
                    label: t('totalRevenue'),
                    value: formatPrice(data.totalRevenue, data.currency),
                  },
                  {
                    label: t('yourShare', { pct: 100 - data.splitPct }),
                    value: formatPrice(data.orgShare, data.currency),
                  },
                  {
                    label: t('playhubShare', { pct: data.splitPct }),
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
                  {t('perRecording')}
                </h3>
                {data.perRecording.map((rec) => (
                  <div
                    key={rec.recordingId}
                    className="flex items-center justify-between p-3 rounded-lg bg-white/[0.02] border border-white/[0.06]"
                  >
                    <div className="min-w-0">
                      <p className="text-sm text-[var(--timberwolf)] truncate">
                        {rec.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('salesCount', { count: rec.sales })}
                      </p>
                    </div>
                    <div className="text-end flex-shrink-0 ms-4">
                      <p className="text-sm font-semibold text-[var(--timberwolf)]">
                        {formatPrice(rec.orgShare, data.currency)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t('ofTotal', {
                          amount: formatPrice(rec.revenue, data.currency),
                        })}
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
  const t = useTranslations('venue')
  const tc = useTranslations('common')
  const format = useFormatter()
  const pickerLocale = useLocale()

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
  // Last auto-generated description — lets start-time changes keep the
  // description in sync without ever overwriting manager-typed text.
  const lastAutoDescriptionRef = useRef('')

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
  const [expandedClutchId, setExpandedClutchId] = useState<string | null>(null)
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
  // Per-month cache so navigating Jan→Feb→Jan doesn't refetch Jan. Keyed
  // by `${year}-${month}`. Refs (not state) because we don't need a
  // re-render when the cache mutates — the visible state still drives
  // re-renders via setBillingSummary / setDailyStats.
  const summaryCacheRef = useRef<Map<string, BillingSummary>>(new Map())
  const dailyStatsCacheRef = useRef<Map<string, DailyStats>>(new Map())
  // Separate "chart is fetching" so we can fade the chart without
  // unmounting the whole billing card during month nav.
  const [chartLoading, setChartLoading] = useState(false)
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

  // Per-recording marketplace listing state (inline editor in the recordings list)
  const [editingListingId, setEditingListingId] = useState<string | null>(null)
  const [listingPrice, setListingPrice] = useState('')
  const [listingSubmitting, setListingSubmitting] = useState<string | null>(
    null
  )

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
    // Fire venue-id-only supplementary fetches in PARALLEL with the venue
    // lookup. They don't need venue.type or venue.slug to begin, so there's
    // no reason to wait for the venue object to be set. Marketplace stays
    // tied to the venue object below since it needs venue.slug.
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
    fetchBillingData().finally(() => setBillingLoading(false))
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

      // Single-venue fetch — the previous /api/venue call returned the FULL
      // venue list just to find one. New endpoint returns only this venue +
      // a count of the user's other venues for the "Switch Venue" CTA.
      const res = await fetch(`/api/venue/${venueId}`)
      const data = await res.json()

      if (data.error) {
        setError(data.error)
        return
      }

      setVenueCount(data.venueCount ?? 1)
      setVenue(data.venue)
    } catch (err) {
      setError(t('feedback.loadVenueFailed'))
    } finally {
      setLoading(false)
    }
  }

  // Once venue resolves, fire the type-dependent fetches: marketplace
  // (needs venue.slug), group dashboard (groups only), and recordings.
  // The venueId-only fetches (scenes + billing) already started in parallel
  // with the venue lookup above.
  useEffect(() => {
    if (!venue) return

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
          // Group orgs don't have venue-specific billing/scenes/marketplace,
          // so resolve those loading states explicitly.
          setBillingLoading(false)
          setScenesLoading(false)
          setMarketplaceLoading(false)
        })
      fetchRecordings()
      return
    }

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
  // Holds the AbortController for the most recent recordings fetch so a
  // rapid second click can cancel the first request before its response
  // can stomp on the user's fresh page state.
  const recordingsFetchRef = useRef<AbortController | null>(null)

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

    // Cancel any in-flight request — without this, rapid Previous/Next
    // clicks accumulate parallel fetches and the LAST response to arrive
    // wins, regardless of which click it corresponds to.
    recordingsFetchRef.current?.abort()
    const controller = new AbortController()
    recordingsFetchRef.current = controller

    setLoadingRecordings(true)
    try {
      const params = new URLSearchParams({
        page: String(p),
        limit: String(pageSize),
      })
      if (s) params.set('search', s)
      if (st) params.set('status', st)
      if (b) params.set('billable', b)

      const res = await fetch(`/api/venue/${venueId}/recordings?${params}`, {
        signal: controller.signal,
      })
      const data = await res.json()
      // Only commit results if this is still the latest fetch. Without
      // this guard, an out-of-order response that survived the abort
      // race could still clobber state.
      if (recordingsFetchRef.current !== controller) return
      setRecordings(data.recordings || [])
      setTotalRecordings(data.total || 0)
      // NOTE: deliberately NOT calling setCurrentPage(data.page) here.
      // The page state is owned by the user's clicks; echoing it back
      // from the response creates a feedback loop where a slow response
      // for an older page can revert the user's fresh navigation.
    } catch (err: any) {
      // Aborted requests are expected — the user just clicked again.
      if (err?.name === 'AbortError') return
      // Other failures are non-critical — list just won't update.
    } finally {
      if (recordingsFetchRef.current === controller) {
        setLoadingRecordings(false)
      }
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
    const cacheKey = `${year}-${month}`

    // Hydrate from cache immediately — gives instant feel on month nav
    // even if a network refresh fires in the background.
    const cachedSummary = summaryCacheRef.current.get(cacheKey)
    const cachedStats = dailyStatsCacheRef.current.get(cacheKey)
    if (cachedSummary) setBillingSummary(cachedSummary)
    if (cachedStats) setDailyStats(cachedStats)

    // Month-invariant fetches: only run on the FIRST call (no config yet).
    // Previously these refetched on every month nav for no reason.
    const fetchInvariants = !billingConfig
    const monthSpecificFetches: Array<Promise<any>> = [
      cachedSummary
        ? Promise.resolve({
            ok: true,
            json: async () => cachedSummary,
            _cached: true,
          })
        : fetch(`/api/venue/${venueId}/billing/summary${monthParams}`),
    ]
    const invariantFetches: Array<Promise<any>> = fetchInvariants
      ? [
          fetch(`/api/venue/${venueId}/billing`),
          fetch(`/api/venue/${venueId}/billing/invoices`),
        ]
      : []

    // Fade the chart only when we don't have cached data to show — if
    // cache hits, the user sees the right shape immediately and any
    // network refresh is invisible.
    const needsNetwork = !cachedSummary || !cachedStats
    if (needsNetwork) setChartLoading(true)

    try {
      const [summaryResRaw, ...invariantResults] = await Promise.all([
        ...monthSpecificFetches,
        ...invariantFetches,
      ])
      // summary
      const summaryRes = summaryResRaw as any
      if (!summaryRes._cached) {
        const summaryData = await summaryRes.json()
        if (!summaryData.error) {
          setBillingSummary(summaryData)
          summaryCacheRef.current.set(cacheKey, summaryData)
        }
      }
      // invariant: config + invoices
      if (fetchInvariants && invariantResults.length === 2) {
        const [configRes, invoicesRes] = invariantResults
        const [configData, invoicesData] = await Promise.all([
          configRes.json(),
          invoicesRes.json(),
        ])
        if (configData.config) {
          setBillingConfig(configData.config)
          setBillableAmount(
            String(configData.config.default_billable_amount || '')
          )
        }
        if (invoicesData.invoices) setInvoices(invoicesData.invoices)
      }
    } catch {
      // Billing data is supplementary — don't block the page
    }

    // Daily stats separately (decoupled from billing summary failure mode).
    if (!cachedStats) {
      try {
        const res = await fetch(
          `/api/venue/${venueId}/billing/daily-stats${monthParams}`
        )
        const data = await res.json()
        if (!data.error) {
          setDailyStats(data)
          dailyStatsCacheRef.current.set(cacheKey, data)
        }
      } catch {
        // Chart is optional
      }
    }

    setChartLoading(false)
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
      setError(t('feedback.grantAccessFailed'))
    } finally {
      setGrantingAccess(false)
    }
  }

  async function handleRevokeAccess(accessId: string) {
    if (!selectedRecording) return

    if (!confirm(t('access.revokeConfirm'))) return

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

  function openListingEditor(recording: Recording) {
    setEditingListingId(recording.id)
    setListingPrice(
      recording.marketplace_product?.price_amount
        ? String(recording.marketplace_product.price_amount)
        : String(orgMarketplace?.default_price_amount || '')
    )
  }

  function cancelListingEditor() {
    setEditingListingId(null)
    setListingPrice('')
  }

  async function submitListing(recording: Recording) {
    const price = Number(listingPrice)
    if (!Number.isFinite(price) || price <= 0) {
      setError(t('feedback.invalidPrice'))
      return
    }
    setListingSubmitting(recording.id)
    try {
      const res = await fetch(`/api/recordings/${recording.id}/marketplace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          price_amount: price,
          currency: orgMarketplace?.default_price_currency || 'AED',
          is_available: true,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || t('feedback.listFailed'))
        return
      }
      setSuccess(
        recording.marketplace_product
          ? t('feedback.listingUpdated')
          : t('feedback.recordingListed')
      )
      cancelListingEditor()
      fetchRecordings()
    } catch (err) {
      console.error('Failed to submit listing:', err)
      setError(t('feedback.listFailed'))
    } finally {
      setListingSubmitting(null)
    }
  }

  async function unlistRecording(recording: Recording) {
    if (!confirm(t('marketplace.unlistConfirm', { title: recording.title })))
      return
    setListingSubmitting(recording.id)
    try {
      const res = await fetch(`/api/recordings/${recording.id}/marketplace`, {
        method: 'DELETE',
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error || t('feedback.unlistFailed'))
        return
      }
      setSuccess(t('feedback.recordingUnlisted'))
      cancelListingEditor()
      fetchRecordings()
    } catch (err) {
      console.error('Failed to unlist:', err)
      setError(t('feedback.unlistFailed'))
    } finally {
      setListingSubmitting(null)
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
          setSuccess(t('feedback.publicLinkCopied'))
          setTimeout(() => setSuccess(null), 3000)
        } catch (clipboardErr) {
          // Clipboard failed (Safari permissions) - show prompt for manual copy
          window.prompt(t('feedback.copyLinkPrompt'), fullUrl)
        }
      } else {
        setError(t('feedback.publicLinkFailed'))
      }
    } catch (err) {
      setError(t('feedback.publicLinkFailed'))
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
        setError(data.error || t('feedback.updateFailed'))
      }
    } catch {
      setError(t('feedback.updateBillableFailed'))
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
        setError(data.error || t('feedback.updateAmountFailed'))
      }
    } catch {
      setError(t('feedback.updateAmountFailed'))
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
        setError(data.error || t('feedback.saveFailed'))
      }
    } catch {
      setError(t('feedback.saveChangesFailed'))
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
        setError(data.error || t('feedback.deleteFailed'))
      }
    } catch {
      setError(t('feedback.deleteRecordingFailed'))
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
        setError(data.error || t('feedback.addAdminFailed'))
        return
      }

      if (data.invited) {
        setSuccess(t('feedback.adminInvited'))
      } else {
        setSuccess(t('feedback.adminAdded'))
      }
      fetchAdmins()
      setNewAdminEmail('')
      setTimeout(() => setSuccess(null), 5000)
    } catch (err) {
      setError(t('feedback.addAdminFailed'))
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
        setError(data.error || t('feedback.removeAdminFailed'))
        return
      }

      setSuccess(t('feedback.adminRemoved'))
      fetchAdmins()
      setTimeout(() => setSuccess(null), 3000)
    } catch (err) {
      setError(t('feedback.removeAdminFailed'))
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
        setError(data.error || t('feedback.createChannelFailed'))
        return
      }

      setNewChannelName('')
      setSuccess(t('feedback.channelCreated'))
      setTimeout(() => setSuccess(null), 5000)
      fetchChannels()
    } catch (err) {
      setError(t('feedback.createChannelFailed'))
    } finally {
      setCreatingChannel(false)
    }
  }

  async function handleStartChannel(channelId: string) {
    if (!confirm(t('streams.startConfirm'))) {
      return
    }

    setStartingChannelId(channelId)
    try {
      const res = await fetch(`/api/streaming/channels/${channelId}/start`, {
        method: 'POST',
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || t('feedback.startChannelFailed'))
        return
      }

      setSuccess(t('feedback.channelStarting'))
      setTimeout(() => setSuccess(null), 5000)
      fetchChannels()
    } catch (err) {
      setError(t('feedback.startChannelFailed'))
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
        setError(data.error || t('feedback.stopChannelFailed'))
        return
      }

      setSuccess(t('feedback.channelStopping'))
      setTimeout(() => setSuccess(null), 5000)
      fetchChannels()
    } catch (err) {
      setError(t('feedback.stopChannelFailed'))
    } finally {
      setStoppingChannelId(null)
    }
  }

  async function handleDeleteChannel(channelId: string) {
    if (!confirm(t('streams.deleteConfirm'))) {
      return
    }

    setDeletingChannelId(channelId)
    try {
      const res = await fetch(`/api/streaming/channels/${channelId}`, {
        method: 'DELETE',
      })
      const data = await res.json()

      if (!res.ok) {
        setError(data.error || t('feedback.deleteChannelFailed'))
        return
      }

      setSuccess(t('feedback.channelDeleted'))
      setTimeout(() => setSuccess(null), 3000)
      fetchChannels()
    } catch (err) {
      setError(t('feedback.deleteChannelFailed'))
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
      window.prompt(t('feedback.copyValuePrompt'), text)
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
      setError(t('feedback.fillRequired'))
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
        throw new Error(data.error || t('feedback.scheduleStreamFailed'))
      }

      setSuccess(
        t('feedback.streamScheduled', { url: data.channel.playbackUrl })
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
        err instanceof Error ? err.message : t('feedback.scheduleStreamFailed')
      )
    } finally {
      setSchedulingStream(false)
    }
  }

  function formatTime(isoString: string): string {
    return format.dateTime(new Date(isoString), 'full')
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
        setSuccess(t('feedback.recordingScheduled'))
        setTitle('')
        setDescription('')
        lastAutoDescriptionRef.current = ''
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
      setError(t('feedback.scheduleRecordingFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  function handleStartTimeChange(value: string) {
    setStartTime(value)
    if (!venue?.name) return
    const next = buildDefaultDescription(venue.name, value)
    if (
      next &&
      (description === '' || description === lastAutoDescriptionRef.current)
    ) {
      setDescription(next)
      lastAutoDescriptionRef.current = next
    }
  }

  function setStartNow() {
    const now = new Date()
    const startDate = new Date(now.getTime() + 1 * 60 * 1000)
    handleStartTimeChange(formatDateTimeLocal(startDate))
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

  // Shared input + button styling — aligned with the watch-surface
  // vocabulary: subtle white/alpha borders + hover transitions on glass-y
  // surfaces, rather than opaque zinc + hard borders.
  const inputClass =
    'bg-white/[0.02] border-white/[0.08] text-[var(--timberwolf)] placeholder:text-muted-foreground/50 hover:border-white/[0.14] focus:border-emerald-400/40 focus:bg-white/[0.04] focus:ring-2 focus:ring-emerald-400/15 transition-colors'
  const outlineBtnClass =
    'border-white/[0.08] bg-white/[0.02] text-[var(--timberwolf)] hover:bg-white/[0.06] hover:border-white/[0.16]'
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
          <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] p-6">
            <div className="flex items-center justify-between">
              <div className="bg-muted rounded h-5 w-[160px]" />
              <div className="bg-muted rounded h-10 w-[140px]" />
            </div>
          </div>

          {/* Live Streaming skeleton */}
          <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] p-6">
            <div className="flex items-center justify-between">
              <div className="space-y-2">
                <div className="bg-muted rounded h-5 w-[130px]" />
                <div className="bg-muted rounded h-3 w-[260px]" />
              </div>
              <div className="bg-muted rounded h-10 w-[130px]" />
            </div>
          </div>

          {/* Billing skeleton */}
          <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
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
              <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-white/[0.06]">
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
          <div className="rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
            <div className="p-6 space-y-1">
              <div className="bg-muted rounded h-5 w-[100px]" />
              <div className="bg-muted rounded h-3 w-[120px]" />
            </div>
            <div className="px-6 pb-6 space-y-3">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="p-4 rounded-lg bg-white/[0.02] border border-white/[0.06]"
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
          <div className="mt-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] p-6">
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
          <div className="rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] p-6">
            <p className="text-red-400">{error}</p>
            <Button
              className={`mt-4 ${outlineBtnClass}`}
              variant="outline"
              onClick={() => router.push('/venue')}
            >
              {t('header.backToVenues')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[var(--night)]">
      <div className="container mx-auto px-5 py-16 max-w-6xl">
        <div className="flex flex-row items-end sm:items-center justify-between gap-3 mb-8">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs font-semibold tracking-[0.25em] uppercase mb-2">
              {venue?.type === 'group'
                ? t('header.groupOverview')
                : t('header.venueManagement')}
            </p>
            <h1 className="text-2xl md:text-3xl font-bold text-[var(--timberwolf)] truncate">
              {venue?.name}
            </h1>
          </div>
          {venueCount > 1 && (
            <Button
              variant="outline"
              size="sm"
              className={`flex-shrink-0 sm:size-default ${outlineBtnClass}`}
              onClick={() => router.push('/venue')}
            >
              {t('header.switchVenue')}
            </Button>
          )}
        </div>

        {/* Group Dashboard — shown for group-type orgs */}
        {venue?.type === 'group' && (
          <>
            {groupLoading ? (
              <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] animate-pulse p-6">
                <div className="space-y-4">
                  <div className="bg-muted rounded h-5 w-[200px]" />
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-white/[0.06]">
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
                  <div className="rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
                    <div className="p-5">
                      <h2 className="text-base font-semibold text-[var(--timberwolf)] mb-4">
                        {t('group.portfolioOverview')}
                      </h2>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-white/[0.06]">
                        {[
                          {
                            label: t('group.totalRecordings'),
                            value: String(groupData.totals.totalRecordings),
                            sub: t('group.publishedCount', {
                              count: groupData.totals.publishedRecordings,
                            }),
                          },
                          {
                            label: t('group.thisMonth'),
                            value: String(groupData.totals.monthRecordings),
                            sub: t('group.recordings'),
                          },
                          {
                            label: t('group.monthlyRevenue'),
                            value:
                              groupData.childVenues.length > 0
                                ? format.number(groupData.totals.monthRevenue, {
                                    numberingSystem: 'latn',
                                    style: 'currency',
                                    currency:
                                      groupData.childVenues[0]?.currency ||
                                      'KWD',
                                    minimumFractionDigits: 0,
                                    maximumFractionDigits: 3,
                                  })
                                : '0',
                            sub: t('group.billable'),
                          },
                          {
                            label: t('group.today'),
                            value: String(groupData.totals.todayCount),
                            sub: t('group.recordings'),
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
                    <div className="rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
                      <div className="p-5">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
                          <div>
                            <h2 className="text-base font-semibold text-[var(--timberwolf)]">
                              {t('group.dailyPerformance')}
                            </h2>
                            <p className="text-xs text-muted-foreground">
                              {t('group.avgPerDay', {
                                avg: groupData.averagePerDay,
                              })}
                              {groupData.totalDailyTarget > 0 &&
                                ` · ${t('group.targetPerDay', {
                                  target: groupData.totalDailyTarget,
                                })}`}
                            </p>
                          </div>
                        </div>
                        <div dir="ltr">
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
                                      return format.dateTime(d, {
                                        numberingSystem: 'latn',
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
                    </div>
                  )}

                  {/* Per-venue breakdown */}
                  <div className="rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
                    <div className="p-5">
                      <h2 className="text-base font-semibold text-[var(--timberwolf)] mb-4">
                        {t('group.venuesCount', {
                          count: groupData.childVenues.length,
                        })}
                      </h2>
                      <div className="space-y-3">
                        {groupData.childVenues.map((child) => (
                          <div
                            key={child.id}
                            className="p-4 rounded-lg bg-white/[0.02] border border-white/[0.06] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
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
                                <span>
                                  {t('group.recordingsCount', {
                                    count: child.totalRecordings,
                                  })}
                                </span>
                                <span>
                                  {t('group.thisMonthCount', {
                                    count: child.monthRecordings,
                                  })}
                                </span>
                                {child.dailyTarget > 0 && (
                                  <span>
                                    {t('group.todayProgress', {
                                      today: child.todayCount,
                                      target: child.dailyTarget,
                                    })}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0">
                              {child.monthRevenue > 0 && (
                                <span className="text-sm font-semibold text-[var(--timberwolf)]">
                                  {format.number(child.monthRevenue, {
                                    numberingSystem: 'latn',
                                    style: 'currency',
                                    currency: child.currency,
                                    minimumFractionDigits: 0,
                                    maximumFractionDigits: 3,
                                  })}
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
                                {t('group.manage')}
                              </Button>
                            </div>
                          </div>
                        ))}
                        {groupData.childVenues.length === 0 && (
                          <p className="text-muted-foreground text-center py-4">
                            {t('group.noChildVenues')}
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
              <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] animate-pulse">
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
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-px rounded-lg overflow-hidden bg-white/[0.06]">
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
                <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
                  <div className="p-5">
                    {/* Header — single row on desktop (title | summary |
                        month nav), two rows on mobile (title + nav, summary
                        underneath centered). flex-wrap + order classes
                        rearrange the three slots responsively. */}
                    <div className="flex flex-wrap items-center gap-3 mb-4">
                      <h2 className="text-base font-semibold text-[var(--timberwolf)]">
                        {t('billing.title')}
                      </h2>

                      {/* Summary stats — centred between title and nav on
                          desktop; wraps to its own full-width centred row
                          on mobile. order-3 + w-full on mobile, order-2 +
                          flex-1 on desktop. */}
                      {billingSummary && (
                        <div className="order-3 w-full sm:order-2 sm:w-auto sm:flex-1 flex flex-wrap items-center justify-center gap-3 sm:gap-4 text-sm">
                          <div>
                            <span dir="ltr" className="inline-block">
                              <span
                                className="text-[var(--timberwolf)] font-semibold text-base sm:text-lg"
                                style={{ fontVariantNumeric: 'tabular-nums' }}
                              >
                                {billingSummary.totalRevenue.toFixed(3)}
                              </span>
                              <span className="text-muted-foreground/60 ms-1 text-xs">
                                {billingSummary.currency}
                              </span>
                            </span>
                          </div>
                          <div className="border-s border-border ps-3 sm:ps-4">
                            <span
                              className="text-[var(--timberwolf)] font-medium"
                              style={{ fontVariantNumeric: 'tabular-nums' }}
                            >
                              {billingSummary.count}
                            </span>
                            <span className="text-muted-foreground/60 ms-1 text-xs">
                              {t('billing.recordingsSuffix')}
                            </span>
                          </div>
                          {/* Daily average: meaningful for every month —
                              past months show the actual full-month average,
                              the current month shows the running average
                              based on days elapsed. */}
                          {(() => {
                            const daysInMonth = new Date(
                              billingYear,
                              billingMonth,
                              0
                            ).getDate()
                            const daysElapsed = isCurrentBillingMonth
                              ? new Date().getDate()
                              : daysInMonth
                            const avg =
                              billingSummary.count / Math.max(1, daysElapsed)
                            return (
                              <div className="border-s border-border ps-3 sm:ps-4">
                                <span
                                  className="text-[var(--timberwolf)] font-medium"
                                  style={{ fontVariantNumeric: 'tabular-nums' }}
                                >
                                  {avg.toFixed(1)}
                                </span>
                                <span className="text-muted-foreground/60 text-xs ms-1">
                                  {t('billing.perDayAvg')}
                                </span>
                              </div>
                            )
                          })()}
                        </div>
                      )}

                      {/* Month nav — appears between title and summary on
                          mobile (right-aligned via ms-auto) and at the far
                          right on desktop (order-3). */}
                      <div className="order-2 ms-auto sm:order-3 sm:ms-0 flex items-center gap-2 sm:gap-3">
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
                        <p className="text-sm text-muted-foreground font-medium min-w-[110px] text-center">
                          {format.dateTime(
                            new Date(billingYear, billingMonth - 1),
                            {
                              numberingSystem: 'latn',
                              month: 'long',
                              year: 'numeric',
                            }
                          )}
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
                    </div>

                    {/* Financial summary — hide profit/settlement cards when no profit-share or ambassador relationship */}
                    {billingSummary &&
                      (() => {
                        const hasProfitShare =
                          (billingSummary.venueProfitSharePct ?? 0) > 0 ||
                          (billingSummary.ambassadorPct ?? 0) > 0
                        const gridCols = hasProfitShare
                          ? 'md:grid-cols-4'
                          : 'md:grid-cols-2'
                        return (
                          <div
                            className={`grid grid-cols-2 ${gridCols} gap-px rounded-lg overflow-hidden bg-muted mb-4`}
                          >
                            {/* Venue-collected revenue */}
                            <div className="bg-[var(--night)] p-3.5">
                              <div className="flex items-center gap-1.5 mb-1.5">
                                <div className="h-1.5 w-1.5 rounded-full bg-amber-400/60" />
                                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                                  {t('billing.atVenue')}
                                </p>
                              </div>
                              <p
                                className="text-lg font-semibold text-[var(--timberwolf)]"
                                style={{ fontVariantNumeric: 'tabular-nums' }}
                              >
                                <span dir="ltr" className="inline-block">
                                  {billingSummary.venueCollectedRevenue.toFixed(
                                    3
                                  )}
                                  <span className="text-[10px] font-normal text-muted-foreground/50 ms-1">
                                    {billingSummary.currency}
                                  </span>
                                </span>
                              </p>
                              <p className="text-[10px] text-muted-foreground/40 mt-1">
                                {t('billing.recordingsCount', {
                                  count: billingSummary.venueCollectedCount,
                                })}
                              </p>
                            </div>
                            {/* QR Code-collected revenue */}
                            <div className="bg-[var(--night)] p-3.5">
                              <div className="flex items-center gap-1.5 mb-1.5">
                                <div className="h-1.5 w-1.5 rounded-full bg-indigo-400/60" />
                                <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                                  {t('billing.qrCode')}
                                </p>
                              </div>
                              <p
                                className="text-lg font-semibold text-[var(--timberwolf)]"
                                style={{ fontVariantNumeric: 'tabular-nums' }}
                              >
                                <span dir="ltr" className="inline-block">
                                  {billingSummary.playhubCollectedRevenue.toFixed(
                                    3
                                  )}
                                  <span className="text-[10px] font-normal text-muted-foreground/50 ms-1">
                                    {billingSummary.currency}
                                  </span>
                                </span>
                              </p>
                              <p className="text-[10px] text-muted-foreground/40 mt-1">
                                {t('billing.recordingsCount', {
                                  count: billingSummary.playhubCollectedCount,
                                })}
                              </p>
                            </div>
                            {hasProfitShare && (
                              <>
                                {/* Venue profit share */}
                                <div className="bg-[var(--night)] p-3.5">
                                  <div className="flex items-center gap-1.5 mb-1.5">
                                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-400/60" />
                                    <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                                      {t('billing.yourProfit')}
                                    </p>
                                  </div>
                                  <p
                                    className="text-lg font-semibold text-emerald-400"
                                    style={{
                                      fontVariantNumeric: 'tabular-nums',
                                    }}
                                  >
                                    <span dir="ltr" className="inline-block">
                                      {billingSummary.venueTotalProfit.toFixed(
                                        3
                                      )}
                                      <span className="text-[10px] font-normal text-muted-foreground/50 ms-1">
                                        {billingSummary.currency}
                                      </span>
                                    </span>
                                  </p>
                                  <p className="text-[10px] text-muted-foreground/40 mt-1">
                                    {t('billing.recordingsInMonth', {
                                      count: billingSummary.count,
                                      month: format.dateTime(
                                        new Date(billingYear, billingMonth - 1),
                                        {
                                          numberingSystem: 'latn',
                                          month: 'long',
                                        }
                                      ),
                                    })}
                                  </p>
                                </div>
                                {/* Net settlement */}
                                <div className="bg-[var(--night)] p-3.5">
                                  <div className="flex items-center gap-1.5 mb-1.5">
                                    <div
                                      className={`h-1.5 w-1.5 rounded-full ${billingSummary.netBalance > 0 ? 'bg-amber-400/60' : billingSummary.netBalance < 0 ? 'bg-emerald-400/60' : 'bg-[var(--ash-grey)]/40'}`}
                                    />
                                    <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest">
                                      {t('billing.netSettlement')}
                                    </p>
                                  </div>
                                  <p
                                    className="text-lg font-semibold text-[var(--timberwolf)]"
                                    style={{
                                      fontVariantNumeric: 'tabular-nums',
                                    }}
                                  >
                                    <span dir="ltr" className="inline-block">
                                      {Math.abs(
                                        billingSummary.netBalance
                                      ).toFixed(3)}
                                      <span className="text-[10px] font-normal text-muted-foreground/50 ms-1">
                                        {billingSummary.currency}
                                      </span>
                                    </span>
                                  </p>
                                  <p className="text-[10px] text-muted-foreground/40 mt-1">
                                    {billingSummary.netBalance > 0
                                      ? t('billing.venueOwesPlayback')
                                      : billingSummary.netBalance < 0
                                        ? t('billing.playbackOwesVenue')
                                        : t('billing.settled')}
                                  </p>
                                </div>
                              </>
                            )}
                          </div>
                        )
                      })()}

                    {/* Daily recordings chart — fade chart while a fresh
                        month loads but DON'T unmount it; cached data shows
                        instantly on month nav and the fade is a barely-
                        visible tell that fresh data is on its way. */}
                    {dailyStats && dailyStats.scenes.length > 0 && (
                      <div
                        className={`transition-opacity duration-200 ${
                          chartLoading ? 'opacity-60' : 'opacity-100'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-[10px] text-muted-foreground/60 uppercase tracking-widest flex items-center gap-2">
                            {t('billing.dailyActivity')}
                            {chartLoading && (
                              <span className="inline-flex h-1 w-1 animate-pulse rounded-full bg-emerald-400/70" />
                            )}
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
                        <div dir="ltr">
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
                                      return `${dayNum} ${format.dateTime(now, 'monthShort')}`
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
                                    value: t('billing.targetPerDay', {
                                      target: dailyStats.dailyTarget,
                                    }),
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
                                    value: t('billing.avgPerDay', {
                                      avg: dailyStats.averagePerDay,
                                    }),
                                    position: 'insideBottomRight',
                                    fill: 'rgba(99,102,241,0.6)',
                                    fontSize: 9,
                                  }}
                                />
                              )}
                            </AreaChart>
                          </ChartContainer>
                        </div>
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
                        ? t('billing.hideInvoices')
                        : t('billing.viewInvoices')}
                    </button>
                  </div>

                  {/* Invoices */}
                  {showBillingSection && (
                    <div className="px-5 pb-5 border-t border-[var(--ash-grey)]/[0.06] pt-4 space-y-2">
                      {invoices.length === 0 ? (
                        <p className="text-xs text-muted-foreground/50">
                          {t('billing.noInvoices')}
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
                                  {format.dateTime(new Date(inv.period_start), {
                                    numberingSystem: 'latn',
                                    month: 'long',
                                    year: 'numeric',
                                  })}
                                </p>
                                <p className="text-[11px] text-muted-foreground/50">
                                  {t('billing.recordingsCount', {
                                    count: totalRecordings,
                                  })}
                                  {inv.venue_collected_count > 0 &&
                                    inv.playhub_collected_count > 0 &&
                                    ` ${t('billing.collectionBreakdown', {
                                      venue: inv.venue_collected_count,
                                      qr: inv.playhub_collected_count,
                                    })}`}
                                </p>
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                <span
                                  dir="ltr"
                                  className={`text-sm font-medium ${net >= 0 ? 'text-[var(--timberwolf)]' : 'text-emerald-400'}`}
                                  style={{ fontVariantNumeric: 'tabular-nums' }}
                                >
                                  {format.number(net, {
                                    numberingSystem: 'latn',
                                    style: 'currency',
                                    currency: inv.currency,
                                    minimumFractionDigits: 3,
                                    maximumFractionDigits: 3,
                                  })}
                                </span>
                                <span className="text-[10px] text-muted-foreground/40">
                                  {net >= 0
                                    ? t('billing.owed')
                                    : t('billing.dueToVenue')}
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
                <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] p-6 animate-pulse">
                  <div className="flex items-center justify-between">
                    <div className="bg-muted rounded h-5 w-[160px]" />
                    <div className="bg-muted rounded h-10 w-[140px]" />
                  </div>
                </div>
              ) : (
                scenes.length > 0 && (
                  <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
                    <div className="p-6">
                      <div className="flex flex-col md:flex-row items-center justify-between gap-2">
                        <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                          {t('schedule.title')}
                        </h2>
                        {!showScheduleForm && (
                          <Button
                            className={`w-full md:w-auto ${primaryBtnClass}`}
                            onClick={() => {
                              if (!title && venue?.name) {
                                setTitle(buildDefaultTitle(venue.name))
                              }
                              setShowScheduleForm(true)
                            }}
                          >
                            {t('schedule.newRecording')}
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
                                {t('schedule.titleLabel')}
                              </label>
                              <Input
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder={t('schedule.titlePlaceholder')}
                                required
                                className={inputClass}
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm font-medium text-[var(--timberwolf)]">
                                {t('schedule.pitchCameraLabel')}
                              </label>
                              <Select
                                value={sceneId}
                                onValueChange={setSceneId}
                                disabled={scenes.length <= 1}
                              >
                                <SelectTrigger>
                                  <SelectValue
                                    placeholder={t('schedule.selectPitch')}
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  {scenes.map((scene) => (
                                    <SelectItem key={scene.id} value={scene.id}>
                                      {scene.provider === 'clutch'
                                        ? t('schedule.scenePadel', {
                                            name: scene.name,
                                          })
                                        : scene.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </div>

                          <div className="space-y-2">
                            <label className="text-sm font-medium text-[var(--timberwolf)]">
                              {t('schedule.description')}
                            </label>
                            <Input
                              value={description}
                              onChange={(e) => setDescription(e.target.value)}
                              placeholder={t('schedule.descriptionPlaceholder')}
                              className={inputClass}
                            />
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <label className="text-sm font-medium text-[var(--timberwolf)]">
                                {t('schedule.homeTeam')}
                              </label>
                              <Input
                                value={homeTeam}
                                onChange={(e) => setHomeTeam(e.target.value)}
                                placeholder={t('schedule.homeTeamPlaceholder')}
                                className={inputClass}
                              />
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm font-medium text-[var(--timberwolf)]">
                                {t('schedule.awayTeam')}
                              </label>
                              <Input
                                value={awayTeam}
                                onChange={(e) => setAwayTeam(e.target.value)}
                                placeholder={t('schedule.awayTeamPlaceholder')}
                                className={inputClass}
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                              <label className="text-sm font-medium text-[var(--timberwolf)]">
                                {t('schedule.startTime')}
                              </label>
                              <DateTimePicker
                                locale={pickerLocale}
                                value={startTime}
                                onChange={handleStartTimeChange}
                                required
                                className={inputClass}
                                placeholder={t('schedule.selectStartTime')}
                              />
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={setStartNow}
                                className={`w-full ${outlineBtnClass}`}
                              >
                                {t('schedule.startNow')}
                              </Button>
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm font-medium text-[var(--timberwolf)]">
                                {t('schedule.endTime')}
                              </label>
                              <DateTimePicker
                                locale={pickerLocale}
                                value={endTime}
                                onChange={setEndTime}
                                required
                                className={inputClass}
                                placeholder={t('schedule.selectEndTime')}
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
                                    {t('schedule.plus1h')}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setDuration(90)}
                                    className={outlineBtnClass}
                                  >
                                    {t('schedule.plus90m')}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setDuration(120)}
                                    className={outlineBtnClass}
                                  >
                                    {t('schedule.plus2h')}
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="space-y-2">
                            <label className="text-sm font-medium text-[var(--timberwolf)]">
                              {t('schedule.grantAccessLabel')}
                            </label>
                            <Input
                              dir="ltr"
                              inputMode="email"
                              autoCapitalize="none"
                              value={accessEmails}
                              onChange={(e) => setAccessEmails(e.target.value)}
                              placeholder={t(
                                'schedule.accessEmailsPlaceholder'
                              )}
                              className={inputClass}
                            />
                            <p className="text-xs text-muted-foreground">
                              {t('schedule.accessHint')}
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
                                  {t('schedule.paidRecording')}
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
                                  {t('schedule.listOnMarketplace')}
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
                                {t('schedule.graphicPackage')}
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
                                    {t('schedule.useDefault')}
                                  </SelectItem>
                                  <SelectItem value="none">
                                    {t('schedule.none')}
                                  </SelectItem>
                                  {scheduleGraphicPackages.map((pkg) => (
                                    <SelectItem key={pkg.id} value={pkg.id}>
                                      {pkg.is_default
                                        ? t('schedule.packageDefault', {
                                            name: pkg.name,
                                          })
                                        : pkg.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <p className="text-xs text-muted-foreground">
                                {t('schedule.graphicPackageHint')}
                              </p>
                            </div>
                          )}

                          {error && (
                            <div
                              dir="auto"
                              className="bg-red-500/10 text-red-400 p-3 rounded-lg"
                            ></div>
                          )}

                          {success && (
                            <div
                              dir="auto"
                              className="bg-green-500/10 text-green-400 p-3 rounded-lg"
                            ></div>
                          )}

                          <div className="flex gap-2">
                            <Button
                              type="submit"
                              disabled={submitting}
                              className={`flex-1 ${primaryBtnClass}`}
                            >
                              {submitting
                                ? t('schedule.scheduling')
                                : t('schedule.title')}
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => setShowScheduleForm(false)}
                              className={outlineBtnClass}
                            >
                              {tc('cancel')}
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
              <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
                <div className="p-6">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                    <div>
                      <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                        {t('streams.title')}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {t('streams.subtitle')}
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
                      {showStreamingSection
                        ? t('streams.hide')
                        : t('streams.manageStreams')}
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
                        placeholder={t('streams.channelNamePlaceholder')}
                        className={`flex-1 ${inputClass}`}
                      />
                      <Button
                        type="submit"
                        className={`w-full sm:w-auto ${primaryBtnClass}`}
                        disabled={creatingChannel || !newChannelName.trim()}
                      >
                        {creatingChannel
                          ? t('streams.creating')
                          : t('streams.createChannel')}
                      </Button>
                    </form>

                    {/* Schedule Live Stream */}
                    <div className="p-4 bg-muted/50 rounded-lg border border-border">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3">
                        <div>
                          <h4 className="font-medium text-[var(--timberwolf)]">
                            {t('streams.scheduleTitle')}
                          </h4>
                          <p className="text-sm text-muted-foreground">
                            {t('streams.scheduleSubtitle')}
                          </p>
                        </div>
                        {!showStreamScheduleForm && (
                          <Button
                            size="sm"
                            className={`w-full sm:w-auto ${primaryBtnClass}`}
                            onClick={() => {
                              setShowStreamScheduleForm(true)
                              // Default to the first streamable scene —
                              // live streaming is Spiideo-only
                              const streamable = scenes.find(
                                (s) => s.provider !== 'clutch'
                              )
                              if (streamable && !streamSceneId) {
                                setStreamSceneId(streamable.id)
                              }
                            }}
                          >
                            {t('streams.scheduleStream')}
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
                                {t('schedule.titleLabel')}
                              </label>
                              <Input
                                value={streamTitle}
                                onChange={(e) => setStreamTitle(e.target.value)}
                                placeholder={t('schedule.titlePlaceholder')}
                                required
                                className={inputClass}
                              />
                            </div>
                            <div>
                              <label className="text-sm text-muted-foreground">
                                {t('streams.cameraPitchLabel')}
                              </label>
                              <Select
                                value={streamSceneId}
                                onValueChange={setStreamSceneId}
                              >
                                <SelectTrigger>
                                  <SelectValue
                                    placeholder={t('schedule.selectPitch')}
                                  />
                                </SelectTrigger>
                                <SelectContent>
                                  {/* Live streaming is Spiideo-only */}
                                  {scenes
                                    .filter((s) => s.provider !== 'clutch')
                                    .map((scene) => (
                                      <SelectItem
                                        key={scene.id}
                                        value={scene.id}
                                      >
                                        {scene.name}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div>
                              <label className="text-sm text-muted-foreground">
                                {t('schedule.startTime')}
                              </label>
                              <DateTimePicker
                                locale={pickerLocale}
                                value={streamStartTime}
                                onChange={setStreamStartTime}
                                required
                                className={inputClass}
                                placeholder={t('schedule.selectStartTime')}
                              />
                            </div>
                            <div>
                              <label className="text-sm text-muted-foreground">
                                {t('schedule.endTime')}
                              </label>
                              <DateTimePicker
                                locale={pickerLocale}
                                value={streamEndTime}
                                onChange={setStreamEndTime}
                                required
                                className={inputClass}
                                placeholder={t('schedule.selectEndTime')}
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
                              {tc('cancel')}
                            </Button>
                            <Button
                              type="submit"
                              disabled={schedulingStream}
                              className={primaryBtnClass}
                            >
                              {schedulingStream
                                ? t('streams.settingUp')
                                : t('streams.createAndStart')}
                            </Button>
                          </div>
                        </form>
                      )}
                    </div>

                    {/* Channels list */}
                    {loadingChannels ? (
                      <p className="text-sm text-muted-foreground">
                        {t('streams.loadingChannels')}
                      </p>
                    ) : channels.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">
                        {t('streams.noChannels')}
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
                                      ? t('streams.starting')
                                      : t('streams.start')}
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
                                      ? t('streams.stopping')
                                      : t('streams.stop')}
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
                                      ? t('streams.deleting')
                                      : tc('delete')}
                                  </Button>
                                )}
                              </div>
                            </div>

                            {/* RTMP credentials (show when not CREATING) */}
                            {channel.state !== 'CREATING' && channel.rtmp && (
                              <div className="space-y-2 text-sm">
                                <div>
                                  <span className="text-muted-foreground text-xs block mb-1">
                                    {t('streams.rtmpUrl')}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <code
                                      dir="ltr"
                                      className="flex-1 min-w-0 bg-black/30 px-2 py-1 rounded text-xs truncate text-[var(--timberwolf)]"
                                    >
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
                                        ? t('streams.copied')
                                        : t('streams.copy')}
                                    </Button>
                                  </div>
                                </div>
                                <div>
                                  <span className="text-muted-foreground text-xs block mb-1">
                                    {t('streams.streamKey')}
                                  </span>
                                  <div className="flex items-center gap-2">
                                    <code
                                      dir="ltr"
                                      className="flex-1 min-w-0 bg-black/30 px-2 py-1 rounded text-xs truncate text-[var(--timberwolf)]"
                                    >
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
                                        ? t('streams.copied')
                                        : t('streams.copy')}
                                    </Button>
                                  </div>
                                </div>
                                {channel.playbackUrl && (
                                  <div>
                                    <span className="text-muted-foreground text-xs block mb-1">
                                      {t('streams.playback')}
                                    </span>
                                    <div className="flex items-center gap-2">
                                      <code
                                        dir="ltr"
                                        className="flex-1 min-w-0 bg-black/30 px-2 py-1 rounded text-xs truncate text-[var(--timberwolf)]"
                                      >
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
                                          ? t('streams.copied')
                                          : t('streams.copy')}
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
                                    {t('streams.livePreview')}
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
                                {t('streams.stateCreating')}
                              </p>
                            )}
                            {channel.state === 'STARTING' && (
                              <p className="text-xs text-yellow-500">
                                {t('streams.stateStarting')}
                              </p>
                            )}
                            {channel.state === 'STOPPING' && (
                              <p className="text-xs text-yellow-500">
                                {t('streams.stateStopping')}
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
              <div className="mb-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)] p-6 animate-pulse">
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

        {/* Padel analytics (Clutch venues only — self-hiding) */}
        <ClutchVenueStats venueId={venueId} />

        {/* Recordings List */}
        <div className="rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
          <div className="p-6">
            <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
              {t('recordings.title')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('recordings.count', { count: totalRecordings })}
            </p>

            {/* Search + Filters */}
            <div className="mt-4 flex flex-col sm:flex-row gap-3">
              <Input
                placeholder={t('recordings.searchPlaceholder')}
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
                  <SelectItem value="all">
                    {t('recordings.allStatuses')}
                  </SelectItem>
                  <SelectItem value="published">
                    {t('recordings.published')}
                  </SelectItem>
                  <SelectItem value="draft">{t('recordings.draft')}</SelectItem>
                  <SelectItem value="scheduled">
                    {t('recordings.scheduled')}
                  </SelectItem>
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
                  <SelectItem value="all">{t('recordings.all')}</SelectItem>
                  <SelectItem value="true">
                    {t('recordings.billable')}
                  </SelectItem>
                  <SelectItem value="false">
                    {t('recordings.notBillable')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="px-6 pb-6">
            {recordings.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">
                {debouncedSearch || statusFilter || billableFilter
                  ? t('recordings.noMatch')
                  : t('recordings.empty')}
              </p>
            ) : (
              <div className="space-y-3">
                {recordings.map((recording) => (
                  <div
                    key={recording.id}
                    className="p-4 rounded-lg bg-white/[0.02] border border-white/[0.06]"
                  >
                    {/* Top row: Play button + Info + Status */}
                    <div className="flex items-start gap-3">
                      {/* Play Button — canonical watch surface. Earlier
                          version pointed at the legacy /recordings/[id]
                          admin editor; the watch unification consolidated
                          all playback on /watch/[id]. */}
                      {recording.s3_key && (
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() =>
                            router.push(
                              `/watch/${recording.id}?from=venue:${venueId}`
                            )
                          }
                          className={`flex-shrink-0 ${outlineBtnClass}`}
                        >
                          <svg
                            className="w-4 h-4 ms-0.5"
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
                          {recording.clutch_video_id && (
                            <span className="text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400 flex-shrink-0">
                              {t('recordings.padel')}
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
                          {t('recordings.userCount', {
                            count: recording.accessCount || 0,
                          })}
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
                              ? t('recordings.billable')
                              : t('recordings.notBillable')}
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
                                  ? t('recordings.amountLocked')
                                  : t('recordings.clickToEdit')
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
                            title={t('schedule.graphicPackage')}
                          >
                            {recording.graphicPackageName}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 sm:flex sm:items-center gap-2">
                        {recording.clutch_match_stats && (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-expanded={expandedClutchId === recording.id}
                            className={
                              expandedClutchId === recording.id
                                ? 'border-emerald-400/40 text-emerald-300'
                                : outlineBtnClass
                            }
                            onClick={() =>
                              setExpandedClutchId(
                                expandedClutchId === recording.id
                                  ? null
                                  : recording.id
                              )
                            }
                          >
                            {t('recordings.stats')}{' '}
                            <span aria-hidden="true">
                              {expandedClutchId === recording.id ? '▴' : '▾'}
                            </span>
                          </Button>
                        )}
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
                            ? t('recordings.copying')
                            : t('recordings.publicLink')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className={outlineBtnClass}
                          onClick={() => openAccessModal(recording)}
                        >
                          {t('access.title')}
                        </Button>
                        {orgMarketplace?.marketplace_enabled &&
                          recording.status === 'published' && (
                            <Button
                              variant="outline"
                              size="sm"
                              className={outlineBtnClass}
                              onClick={() => openListingEditor(recording)}
                              disabled={listingSubmitting === recording.id}
                            >
                              {recording.marketplace_product?.is_available
                                ? t('recordings.manageListing')
                                : t('recordings.listForSale')}
                            </Button>
                          )}
                        <Button
                          variant="outline"
                          size="sm"
                          className={outlineBtnClass}
                          onClick={() => openEditModal(recording)}
                        >
                          {t('recordings.edit')}
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
                            : tc('delete')}
                        </Button>
                      </div>
                    </div>
                    {/* Clutch padel stats drill-in */}
                    {expandedClutchId === recording.id &&
                      recording.clutch_match_stats && (
                        <div className="mt-3 pt-3 border-t border-border space-y-3">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                            <div className="p-3 bg-muted rounded-lg">
                              <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                                {t('recordings.matchTime')}
                              </p>
                              <p className="text-[var(--timberwolf)] font-medium">
                                {recording.clutch_match_stats
                                  .match_time_minutes != null
                                  ? t('recordings.minutes', {
                                      minutes: Math.round(
                                        recording.clutch_match_stats
                                          .match_time_minutes
                                      ),
                                    })
                                  : '—'}
                              </p>
                            </div>
                            <div className="p-3 bg-muted rounded-lg">
                              <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                                {t('recordings.inPlay')}
                              </p>
                              <p className="text-[var(--timberwolf)] font-medium">
                                {recording.clutch_match_stats
                                  .match_time_in_play_minutes != null
                                  ? t('recordings.minutes', {
                                      minutes: Math.round(
                                        recording.clutch_match_stats
                                          .match_time_in_play_minutes
                                      ),
                                    })
                                  : '—'}
                              </p>
                            </div>
                            <div className="p-3 bg-muted rounded-lg">
                              <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                                {t('recordings.avgRally')}
                              </p>
                              <p className="text-[var(--timberwolf)] font-medium">
                                {recording.clutch_match_stats.avg_rally_shots !=
                                null
                                  ? t('recordings.shots', {
                                      count:
                                        recording.clutch_match_stats
                                          .avg_rally_shots,
                                    })
                                  : '—'}
                                {recording.clutch_match_stats
                                  .avg_rally_seconds != null && (
                                  <span className="text-muted-foreground">
                                    {' '}
                                    ·{' '}
                                    {t('recordings.seconds', {
                                      seconds: Math.round(
                                        recording.clutch_match_stats
                                          .avg_rally_seconds
                                      ),
                                    })}
                                  </span>
                                )}
                              </p>
                            </div>
                            <div className="p-3 bg-muted rounded-lg">
                              <p className="text-muted-foreground mb-1 text-[10px] uppercase tracking-[0.14em]">
                                {t('recordings.longestRally')}
                              </p>
                              <p className="text-[var(--timberwolf)] font-medium">
                                {recording.clutch_match_stats
                                  .longest_rally_shots != null
                                  ? t('recordings.shots', {
                                      count:
                                        recording.clutch_match_stats
                                          .longest_rally_shots,
                                    })
                                  : '—'}
                                {recording.clutch_match_stats
                                  .longest_rally_seconds != null && (
                                  <span className="text-muted-foreground">
                                    {' '}
                                    ·{' '}
                                    {t('recordings.seconds', {
                                      seconds: Math.round(
                                        recording.clutch_match_stats
                                          .longest_rally_seconds
                                      ),
                                    })}
                                  </span>
                                )}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className={outlineBtnClass}
                            onClick={() =>
                              router.push(
                                `/watch/${recording.id}?from=venue:${venueId}`
                              )
                            }
                          >
                            {t('recordings.watchFullStats')}
                          </Button>
                        </div>
                      )}
                    {editingListingId === recording.id && (
                      <div className="mt-3 pt-3 border-t border-border flex flex-col sm:flex-row sm:items-center gap-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            value={listingPrice}
                            onChange={(e) => setListingPrice(e.target.value)}
                            placeholder={String(
                              orgMarketplace?.default_price_amount || '200'
                            )}
                            className={`w-32 ${inputClass}`}
                          />
                          <span className="text-sm text-muted-foreground">
                            {orgMarketplace?.default_price_currency || 'AED'} ·{' '}
                            {t('recordings.listedPublicly')}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 sm:ms-auto flex-wrap">
                          <Button
                            size="sm"
                            onClick={() => submitListing(recording)}
                            disabled={listingSubmitting === recording.id}
                          >
                            {listingSubmitting === recording.id
                              ? t('recordings.saving')
                              : recording.marketplace_product
                                ? t('recordings.update')
                                : t('recordings.list')}
                          </Button>
                          {recording.marketplace_product?.is_available && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                              onClick={() => unlistRecording(recording)}
                              disabled={listingSubmitting === recording.id}
                            >
                              {t('recordings.unlist')}
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            className={outlineBtnClass}
                            onClick={cancelListingEditor}
                            disabled={listingSubmitting === recording.id}
                          >
                            {tc('cancel')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Pagination controls */}
                {totalRecordings > pageSize && (
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-4 pt-4 border-t border-border">
                    <p className="text-sm text-muted-foreground text-center sm:text-start">
                      {t('recordings.pageRange', {
                        from: (currentPage - 1) * pageSize + 1,
                        to: Math.min(currentPage * pageSize, totalRecordings),
                        total: totalRecordings,
                      })}
                    </p>
                    <div className="flex items-center justify-center sm:justify-start gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className={outlineBtnClass}
                        // Disable while a fetch is in flight too — the
                        // AbortController + race-guard handle correctness,
                        // but disabling stops the visual flicker from
                        // queued clicks against a still-rendering page.
                        disabled={currentPage <= 1 || loadingRecordings}
                        onClick={() => setCurrentPage((p) => p - 1)}
                      >
                        {t('recordings.previous')}
                      </Button>
                      <span className="text-sm text-muted-foreground px-2 whitespace-nowrap">
                        {t('recordings.pageOf', {
                          page: currentPage,
                          total: Math.ceil(totalRecordings / pageSize),
                        })}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className={outlineBtnClass}
                        disabled={
                          currentPage >=
                            Math.ceil(totalRecordings / pageSize) ||
                          loadingRecordings
                        }
                        onClick={() => setCurrentPage((p) => p + 1)}
                      >
                        {t('recordings.next')}
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
            <div className="mt-6 rounded-2xl border border-white/[0.06] bg-[rgba(15,21,18,0.4)] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.03)]">
              <div className="p-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                    {t('access.venueAdmins')}
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
                    {showAdminSection
                      ? t('access.hide')
                      : t('access.manageAdmins')}
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">
                  {t('access.adminsSubtitle')}
                </p>
              </div>
              {showAdminSection && (
                <div className="px-6 pb-6 space-y-4">
                  {/* Success/Error messages */}
                  {success && (
                    <div
                      dir="auto"
                      className="bg-green-500/10 text-green-400 p-3 rounded-lg text-sm"
                    ></div>
                  )}
                  {error && (
                    <div
                      dir="auto"
                      className="bg-red-500/10 text-red-400 p-3 rounded-lg text-sm"
                    ></div>
                  )}

                  {/* Add new admin */}
                  <form
                    onSubmit={handleAddAdmin}
                    className="flex flex-col sm:flex-row gap-2"
                  >
                    <Input
                      type="email"
                      dir="ltr"
                      value={newAdminEmail}
                      onChange={(e) => setNewAdminEmail(e.target.value)}
                      placeholder={t('access.adminEmailPlaceholder')}
                      className={`flex-1 ${inputClass}`}
                    />
                    <Button
                      type="submit"
                      className={`w-full sm:w-auto ${primaryBtnClass}`}
                      disabled={addingAdmin || !newAdminEmail}
                    >
                      {addingAdmin ? t('access.adding') : t('access.addAdmin')}
                    </Button>
                  </form>

                  {/* Admin list */}
                  <div className="space-y-2">
                    {adminsLoading && !adminsLoaded ? (
                      <p className="text-sm text-muted-foreground">
                        {t('access.loadingAdmins')}
                      </p>
                    ) : admins.length === 0 && pendingInvites.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t('access.noAdmins')}
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
                                {admin.fullName ||
                                  admin.email ||
                                  t('access.unknown')}
                                {admin.isCurrentUser && (
                                  <span className="ms-2 text-xs text-muted-foreground">
                                    {t('access.you')}
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
                                    ? t('access.removing')
                                    : t('access.remove')}
                                </Button>
                              )}
                            </div>
                          </div>
                        ))}

                        {pendingInvites.length > 0 && (
                          <div className="pt-2">
                            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase mb-2">
                              {t('access.pendingInvites')}
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
                                      {t('access.invitedWaiting', {
                                        date: format.dateTime(
                                          new Date(invite.invitedAt),
                                          'short'
                                        ),
                                      })}
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

        {/* Audit history — admin-override actions on tags etc. Hidden for
            group orgs since they don't admin specific recordings. */}
        {venue?.type !== 'group' && (
          <div className="mt-6">
            <AuditHistory venueId={venueId} />
          </div>
        )}

        {/* Access Modal */}
        {showAccessModal && selectedRecording && (
          <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
            <div className="w-full max-w-lg m-4 rounded-xl border border-border bg-[var(--night)]">
              <div className="p-6">
                <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
                  {t('access.title')}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {selectedRecording.title}
                </p>
              </div>
              <div className="px-6 pb-6 space-y-4">
                {/* Add new access */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--timberwolf)]">
                    {t('access.grantLabel')}
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      value={newEmails}
                      onChange={(e) => setNewEmails(e.target.value)}
                      placeholder={t('access.emailPlaceholder')}
                      className={`flex-1 ${inputClass}`}
                    />
                    <Button
                      className={`w-full sm:w-auto ${primaryBtnClass}`}
                      onClick={handleGrantAccess}
                      disabled={grantingAccess || !newEmails}
                    >
                      {grantingAccess ? t('access.adding') : t('access.add')}
                    </Button>
                  </div>
                </div>

                {/* Access list */}
                <div className="space-y-2">
                  <p className="text-sm font-medium text-[var(--timberwolf)]">
                    {t('access.currentAccess')}
                  </p>
                  {accessList.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t('access.noAccess')}
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
                                {t('access.expires', {
                                  date: formatTime(access.expiresAt),
                                })}
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
                              {t('access.revoke')}
                            </Button>
                          )}
                          {!access.isActive && (
                            <span className="text-xs text-muted-foreground">
                              {t('access.revoked')}
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
                  {tc('close')}
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
                  {t('recordings.editRecording')}
                </h2>
              </div>
              <div className="px-6 pb-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--timberwolf)]">
                    {t('recordings.titleLabel')}
                  </label>
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--timberwolf)]">
                    {t('schedule.homeTeam')}
                  </label>
                  <Input
                    value={editHomeTeam}
                    onChange={(e) => setEditHomeTeam(e.target.value)}
                    className={inputClass}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--timberwolf)]">
                    {t('schedule.awayTeam')}
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
                    {savingEdit ? t('recordings.saving') : tc('save')}
                  </Button>
                  <Button
                    variant="outline"
                    className={`flex-1 ${outlineBtnClass}`}
                    onClick={() => setEditingRecording(null)}
                  >
                    {tc('cancel')}
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
                  {t('recordings.deleteRecording')}
                </h2>
                <p className="text-sm text-muted-foreground mt-2">
                  {t.rich('recordings.deleteWarning', {
                    title: deleteConfirmRecording.title,
                    name: (chunks) => (
                      <span className="text-[var(--timberwolf)] font-medium">
                        {chunks}
                      </span>
                    ),
                  })}
                </p>
              </div>
              <div className="px-6 pb-6 space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-[var(--timberwolf)]">
                    {t('recordings.typeDeleteToConfirm')}
                  </label>
                  <Input
                    value={deleteConfirmText}
                    onChange={(e) => setDeleteConfirmText(e.target.value)}
                    placeholder={t('recordings.deletePlaceholder')}
                    className={inputClass}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1 bg-red-600 hover:bg-red-700 text-white border-0"
                    onClick={confirmDeleteRecording}
                    disabled={
                      // Arabic keyboards make the Latin token disproportionate
                      // friction — the localized equivalent also passes.
                      (deleteConfirmText !== 'DELETE' &&
                        deleteConfirmText !== 'حذف' &&
                        deleteConfirmText.toUpperCase() !== 'ELIMINAR') ||
                      deletingRecording === deleteConfirmRecording.id
                    }
                  >
                    {deletingRecording === deleteConfirmRecording.id
                      ? t('recordings.deleting')
                      : t('recordings.deleteForever')}
                  </Button>
                  <Button
                    variant="outline"
                    className={`flex-1 ${outlineBtnClass}`}
                    onClick={() => setDeleteConfirmRecording(null)}
                  >
                    {tc('cancel')}
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
