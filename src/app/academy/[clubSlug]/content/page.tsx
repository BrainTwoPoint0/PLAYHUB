'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Play,
  Scissors,
  Search,
  Clock,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  AlertTriangle,
  Film,
  BarChart3,
  X,
} from 'lucide-react'
import { DatePicker } from '@braintwopoint0/playback-commons/ui'

// ============================================================================
// Types
// ============================================================================

interface VeoRecording {
  slug: string
  title: string
  duration: number
  privacy: string
  thumbnail: string
  uuid?: string
  match_date?: string
  home_team?: string | null
  away_team?: string | null
  home_score?: number | null
  away_score?: number | null
  processing_status?: string
}

interface VeoVideo {
  id: string
  url: string
  type?: string
  width?: number
  height?: number
}

interface VeoHighlight {
  id: string
  start: number
  duration: number
  tags: string[]
  team_association?: string
  thumbnail?: string
  videos?: VeoVideo[]
  is_ai_generated?: boolean
}

interface MatchContent {
  videos: VeoVideo[]
  highlights: VeoHighlight[]
  stats: Record<string, unknown> | null
}

// ============================================================================
// Helpers
// ============================================================================

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return dateStr
  }
}

function teamName(team: unknown): string {
  if (!team) return ''
  if (typeof team === 'string') return team
  if (typeof team === 'object' && team !== null) {
    const obj = team as Record<string, unknown>
    return String(obj.name || obj.title || obj.label || '')
  }
  return String(team)
}

function privacyIcon(privacy: string) {
  switch (privacy) {
    case 'public':
      return <Globe className="h-3 w-3" />
    case 'private':
      return <EyeOff className="h-3 w-3" />
    default:
      return <Eye className="h-3 w-3" />
  }
}

function privacyColor(privacy: string): string {
  switch (privacy) {
    case 'public':
      return 'bg-emerald-500/10 text-emerald-400/80'
    case 'private':
      return 'bg-red-500/10 text-red-400/80'
    default:
      return 'bg-yellow-500/10 text-yellow-400/80'
  }
}

function extractUrl(val: unknown): string | null {
  if (!val) return null
  if (typeof val === 'string') return val
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, unknown>
    if (typeof obj.url === 'string') return obj.url
    if (typeof obj.src === 'string') return obj.src
    if (typeof obj.href === 'string') return obj.href
    // Check for thumbnail_url pattern
    if (typeof obj.thumbnail_url === 'string') return obj.thumbnail_url
  }
  return null
}

function tagToString(tag: unknown): string {
  if (!tag) return 'Highlight'
  if (typeof tag === 'string') return tag
  if (typeof tag === 'object' && tag !== null) {
    const obj = tag as Record<string, unknown>
    return String(obj.name || obj.label || obj.type || obj.title || 'Highlight')
  }
  return String(tag)
}

function highlightTagColor(tag: string): string {
  const t = tag.toLowerCase()
  if (t.includes('goal')) return 'bg-emerald-500/15 text-emerald-400'
  if (t.includes('shot')) return 'bg-amber-500/15 text-amber-400'
  if (t.includes('corner')) return 'bg-blue-500/15 text-blue-400'
  if (t.includes('free') || t.includes('foul'))
    return 'bg-red-500/15 text-red-400'
  return 'bg-white/[0.06] text-muted-foreground'
}

// ============================================================================
// Components
// ============================================================================

function videoLabel(video: VeoVideo): string {
  const render = String((video as any).render_type || '')
  const w = video.width
  const h = video.height
  if (render === 'panorama' && w && h) return `Panorama (${w}x${h})`
  if (render === 'panorama') return 'Panorama'
  if (w && h) return `Standard (${w}x${h})`
  return 'Video'
}

function FullMatchVideos({ videos }: { videos: VeoVideo[] }) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null)

  // Filter to playable mp4 videos
  const playable = videos.filter((v) => {
    const url = String(v.url || '')
    return url.endsWith('.mp4') || url.includes('.mp4?')
  })

  const activeVideo = activeIdx !== null ? playable[activeIdx] : null

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Play className="h-3 w-3 text-muted-foreground/30" />
        <span className="text-[11px] text-muted-foreground/50 uppercase tracking-wider">
          Full Match ({playable.length})
        </span>
      </div>

      {/* Video selector buttons */}
      <div className="flex flex-wrap gap-2 mb-3">
        {playable.map((video, i) => (
          <button
            key={String(video.id || i)}
            onClick={() => setActiveIdx(activeIdx === i ? null : i)}
            className={`text-[11px] px-3 py-1.5 rounded-lg border transition-colors ${
              activeIdx === i
                ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400'
                : 'bg-white/[0.04] border-white/[0.06] text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-white/[0.08]'
            }`}
          >
            {videoLabel(video)}
          </button>
        ))}
      </div>

      {/* Inline video player */}
      {activeVideo && (
        <div className="rounded-lg overflow-hidden bg-black">
          <video
            key={String(activeVideo.id || activeIdx)}
            controls
            className="w-full max-h-[500px]"
            src={`/api/veo/proxy?url=${encodeURIComponent(String(activeVideo.url || ''))}`}
          />
        </div>
      )}
    </div>
  )
}

function StatBar({ stats }: { stats: Record<string, unknown> }) {
  // Extract known stat fields
  const entries = Object.entries(stats).filter(
    ([, v]) => typeof v === 'number' || typeof v === 'string'
  )
  if (entries.length === 0) return null

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-white/[0.04] rounded-lg overflow-hidden">
      {entries.slice(0, 8).map(([key, value]) => (
        <div key={key} className="bg-[var(--night)] px-3 py-2.5 text-center">
          <div className="text-base font-semibold text-[var(--timberwolf)] tabular-nums">
            {String(value)}
          </div>
          <div className="text-[10px] text-muted-foreground/50 uppercase tracking-wider mt-0.5">
            {key.replace(/_/g, ' ')}
          </div>
        </div>
      ))}
    </div>
  )
}

function teamAssocLabel(
  assoc: unknown,
  homeTeam: unknown,
  awayTeam: unknown
): string | null {
  const val =
    typeof assoc === 'string'
      ? assoc
      : typeof assoc === 'object' && assoc !== null
        ? String(
            (assoc as Record<string, unknown>).name ||
              (assoc as Record<string, unknown>).slug ||
              ''
          )
        : ''
  if (!val) return null
  const v = val.toLowerCase()
  if (v === 'home') return teamName(homeTeam) || 'Home'
  if (v === 'away') return teamName(awayTeam) || 'Away'
  // May be a team name/slug directly
  return val
}

function HighlightCard({
  highlight,
  clubSlug,
  homeTeam,
  awayTeam,
}: {
  highlight: VeoHighlight
  clubSlug: string
  homeTeam?: unknown
  awayTeam?: unknown
}) {
  const router = useRouter()
  const videoUrl = highlight.videos?.[0]?.url
  const tag = tagToString(highlight.tags?.[0])
  const team = teamAssocLabel(highlight.team_association, homeTeam, awayTeam)

  function openInEditor() {
    if (!videoUrl) return
    const params = new URLSearchParams({
      videoUrl,
      title: `${tag} — ${formatDuration(highlight.start)}`,
      from: 'academy',
    })
    router.push(`/editor?${params.toString()}`)
  }

  return (
    <div className="group relative rounded-lg overflow-hidden bg-white/[0.02] border border-white/[0.04] hover:border-white/[0.08] transition-colors">
      {/* Thumbnail */}
      <div className="relative aspect-video bg-black/30">
        {extractUrl(highlight.thumbnail) ? (
          <img
            src={`/api/veo/proxy?url=${encodeURIComponent(extractUrl(highlight.thumbnail)!)}`}
            alt={tag}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="flex items-center justify-center h-full">
            <Film className="h-6 w-6 text-muted-foreground/20" />
          </div>
        )}
        {/* Duration overlay */}
        <span className="absolute bottom-1.5 right-1.5 text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-black/70 text-white/80">
          {formatDuration(highlight.duration)}
        </span>
        {/* AI badge */}
        {highlight.is_ai_generated && (
          <span className="absolute top-1.5 left-1.5 text-[9px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 backdrop-blur-sm">
            AI
          </span>
        )}
        {/* Team badge */}
        {team && (
          <span className="absolute top-1.5 right-1.5 text-[9px] px-1.5 py-0.5 rounded bg-black/60 text-white/70 backdrop-blur-sm max-w-[50%] truncate">
            {team}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded-full ${highlightTagColor(tag)}`}
            >
              {tag}
            </span>
            <span className="text-[11px] text-muted-foreground/40 tabular-nums">
              @ {formatDuration(highlight.start)}
            </span>
          </div>
          {videoUrl && (
            <button
              onClick={openInEditor}
              className="flex items-center gap-1 text-[10px] px-2 py-1 rounded-md bg-white/[0.04] text-muted-foreground hover:text-[var(--timberwolf)] hover:bg-white/[0.08] transition-colors sm:opacity-0 sm:group-hover:opacity-100"
            >
              <Scissors className="h-3 w-3" />
              Portrait
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function getHighlightTag(h: VeoHighlight): string {
  return tagToString(h.tags?.[0]).toLowerCase()
}

function ExpandedRecording({
  recording,
  clubSlug,
}: {
  recording: VeoRecording
  clubSlug: string
}) {
  const [content, setContent] = useState<MatchContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set(['goal']))
  const [teamFilter, setTeamFilter] = useState<string>('all') // 'all' | 'home' | 'away'

  useEffect(() => {
    async function fetchContent() {
      try {
        setLoading(true)
        setError(null)
        const res = await fetch(
          `/api/academy/${clubSlug}/content/${recording.slug}`
        )
        const json = await res.json()
        if (json.error) {
          setError(json.error)
          return
        }
        setContent(json)
      } catch {
        setError('Failed to load match content')
      } finally {
        setLoading(false)
      }
    }
    fetchContent()
  }, [clubSlug, recording.slug])

  if (loading) {
    return (
      <div className="px-4 py-6 flex items-center justify-center gap-2 text-muted-foreground/40">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-sm">Loading match content...</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="px-4 py-4">
        <p className="text-sm text-red-400/70">{error}</p>
      </div>
    )
  }

  if (!content) return null

  // Collect unique tag categories from highlights
  const tagCounts = new Map<string, number>()
  for (const h of content.highlights) {
    const tag = getHighlightTag(h)
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
  }
  const allTags = Array.from(tagCounts.keys()).sort()

  // Detect if team_association data exists
  function getTeamAssoc(h: VeoHighlight): string {
    const val = h.team_association
    if (!val) return ''
    if (typeof val === 'string') return val.toLowerCase()
    if (typeof val === 'object' && val !== null) {
      const obj = val as Record<string, unknown>
      return String(obj.name || obj.slug || '').toLowerCase()
    }
    return ''
  }
  const hasTeamData = content.highlights.some((h) => getTeamAssoc(h) !== '')

  // Filter highlights by active tags + team
  const filteredHighlights = content.highlights.filter((h) => {
    if (activeTags.size > 0 && !activeTags.has(getHighlightTag(h))) return false
    if (teamFilter !== 'all' && hasTeamData) {
      const assoc = getTeamAssoc(h)
      if (assoc && assoc !== teamFilter) return false
    }
    return true
  })

  function toggleTag(tag: string) {
    setActiveTags((prev) => {
      const next = new Set(prev)
      if (next.has(tag)) {
        next.delete(tag)
      } else {
        next.add(tag)
      }
      return next
    })
  }

  return (
    <div className="px-3 sm:px-4 py-4 space-y-4">
      {/* Stats */}
      {content.stats && Object.keys(content.stats).length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <BarChart3 className="h-3 w-3 text-muted-foreground/30" />
            <span className="text-[11px] text-muted-foreground/50 uppercase tracking-wider">
              Match Stats
            </span>
          </div>
          <StatBar stats={content.stats} />
        </div>
      )}

      {/* Full match videos */}
      {content.videos.length > 0 && <FullMatchVideos videos={content.videos} />}

      {/* Highlights */}
      {content.highlights.length > 0 ? (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Film className="h-3 w-3 text-muted-foreground/30" />
            <span className="text-[11px] text-muted-foreground/50 uppercase tracking-wider">
              Highlights ({filteredHighlights.length}
              {filteredHighlights.length !== content.highlights.length
                ? ` of ${content.highlights.length}`
                : ''}
              )
            </span>
          </div>

          {/* Tag filter pills */}
          {allTags.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              <button
                onClick={() => setActiveTags(new Set())}
                className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors ${
                  activeTags.size === 0
                    ? 'bg-white/[0.08] border-white/[0.12] text-[var(--timberwolf)]'
                    : 'bg-transparent border-white/[0.06] text-muted-foreground/40 hover:text-muted-foreground/70'
                }`}
              >
                All
              </button>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors capitalize ${
                    activeTags.has(tag)
                      ? `${highlightTagColor(tag)} border-current/20`
                      : 'bg-transparent border-white/[0.06] text-muted-foreground/40 hover:text-muted-foreground/70'
                  }`}
                >
                  {tag} ({tagCounts.get(tag)})
                </button>
              ))}
            </div>
          )}

          {/* Team filter — only show if team_association data exists */}
          {hasTeamData && (
            <div className="flex flex-wrap items-center gap-1.5 mb-3">
              <span className="text-[10px] text-muted-foreground/30 mr-1">
                Team:
              </span>
              {(['all', 'home', 'away'] as const).map((opt) => {
                const label =
                  opt === 'all'
                    ? 'Both'
                    : opt === 'home'
                      ? teamName(recording.home_team) || 'Home'
                      : teamName(recording.away_team) || 'Away'
                return (
                  <button
                    key={opt}
                    onClick={() => setTeamFilter(opt)}
                    className={`text-[10px] px-2.5 py-1 rounded-full border transition-colors ${
                      teamFilter === opt
                        ? 'bg-white/[0.08] border-white/[0.12] text-[var(--timberwolf)]'
                        : 'bg-transparent border-white/[0.06] text-muted-foreground/40 hover:text-muted-foreground/70'
                    }`}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          )}

          {filteredHighlights.length > 0 ? (
            <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
              {filteredHighlights.map((h, i) => (
                <HighlightCard
                  key={String(h.id || i)}
                  highlight={h}
                  clubSlug={clubSlug}
                  homeTeam={recording.home_team}
                  awayTeam={recording.away_team}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground/30">
              No highlights match the selected filters.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground/30">
          No highlights available for this match.
        </p>
      )}
    </div>
  )
}

// ============================================================================
// Page
// ============================================================================

const PAGE_SIZE = 25
const PRIVACY_OPTIONS = ['all', 'public', 'private', 'unlisted'] as const

export default function AcademyContentPage() {
  const params = useParams()
  const clubSlug = params.clubSlug as string

  const [recordings, setRecordings] = useState<VeoRecording[]>([])
  const [clubName, setClubName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null)

  // Filters
  const [search, setSearch] = useState('')
  const [privacyFilter, setPrivacyFilter] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    async function fetchRecordings() {
      try {
        setLoading(true)
        setError(null)
        const res = await fetch(`/api/academy/${clubSlug}/content`)
        const json = await res.json()

        if (json.error) {
          setError(json.error)
          return
        }

        setRecordings(json.recordings || [])
        setClubName(
          typeof json.clubName === 'string' ? json.clubName : clubSlug
        )
      } catch {
        setError('Failed to load recordings')
      } finally {
        setLoading(false)
      }
    }
    fetchRecordings()
  }, [clubSlug])

  // Reset page when filters change
  useEffect(() => {
    setPage(1)
    setExpandedSlug(null)
  }, [search, privacyFilter, dateFrom, dateTo])

  // Filter recordings
  const filtered = recordings.filter((rec) => {
    // Privacy filter
    if (privacyFilter !== 'all' && rec.privacy !== privacyFilter) return false

    // Date range filter
    if (dateFrom || dateTo) {
      const recDate = rec.match_date ? rec.match_date.slice(0, 10) : ''
      if (!recDate) return false
      if (dateFrom && recDate < dateFrom) return false
      if (dateTo && recDate > dateTo) return false
    }

    // Text search — match against title, team names
    if (search) {
      const q = search.toLowerCase()
      const title = String(rec.title || '').toLowerCase()
      const home = teamName(rec.home_team).toLowerCase()
      const away = teamName(rec.away_team).toLowerCase()
      if (!title.includes(q) && !home.includes(q) && !away.includes(q))
        return false
    }

    return true
  })

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageStart = (safePage - 1) * PAGE_SIZE
  const pageRecordings = filtered.slice(pageStart, pageStart + PAGE_SIZE)

  // Loading skeleton
  if (loading) {
    return (
      <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 max-w-5xl animate-pulse">
        <div className="space-y-2 mb-10">
          <div className="bg-white/5 rounded h-3 w-24" />
          <div className="bg-white/5 rounded h-8 w-48" />
        </div>
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl bg-white/[0.02] h-20" />
          ))}
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 max-w-5xl">
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.04] p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto px-4 sm:px-6 py-8 sm:py-12 max-w-5xl">
      {/* Header */}
      <div className="mb-8">
        <p className="text-muted-foreground/70 text-[11px] font-medium tracking-[0.2em] uppercase mb-1.5">
          Content
        </p>
        <h1 className="text-2xl sm:text-3xl font-semibold text-[var(--timberwolf)] tracking-tight">
          {clubName}
        </h1>
      </div>

      {/* Search + Privacy */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/30" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title or team..."
            className="w-full bg-white/[0.03] border border-white/[0.06] rounded-lg pl-9 pr-8 py-2 text-sm text-[var(--timberwolf)] placeholder:text-muted-foreground/25 focus:outline-none focus:border-white/[0.12] transition-colors"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/30 hover:text-muted-foreground/60"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center justify-center sm:justify-start gap-1 bg-white/[0.02] border border-white/[0.04] rounded-lg p-0.5 overflow-x-auto shrink-0">
          {PRIVACY_OPTIONS.map((opt) => (
            <button
              key={opt}
              onClick={() => setPrivacyFilter(opt)}
              className={`flex-1 sm:flex-none text-[11px] px-3 py-1.5 rounded-md capitalize transition-colors whitespace-nowrap text-center ${
                privacyFilter === opt
                  ? 'bg-white/[0.08] text-[var(--timberwolf)]'
                  : 'text-muted-foreground/40 hover:text-muted-foreground/70'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>

      {/* Date range */}
      <div className="flex items-center gap-2 mb-5">
        <div className="flex-1 max-w-[200px]">
          <DatePicker
            value={dateFrom}
            onChange={setDateFrom}
            max={dateTo || undefined}
            placeholder="From date"
            className="h-9 w-full"
          />
        </div>
        <div className="flex-1 max-w-[200px]">
          <DatePicker
            value={dateTo}
            onChange={setDateTo}
            min={dateFrom || undefined}
            placeholder="To date"
            className="h-9 w-full"
          />
        </div>
        {(dateFrom || dateTo) && (
          <button
            onClick={() => {
              setDateFrom('')
              setDateTo('')
            }}
            className="text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Results count */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] text-muted-foreground/40 tabular-nums">
          {filtered.length === recordings.length
            ? `${recordings.length} recordings`
            : `${filtered.length} of ${recordings.length} recordings`}
        </p>
        {totalPages > 1 && (
          <p className="text-[11px] text-muted-foreground/30 tabular-nums">
            Page {safePage} of {totalPages}
          </p>
        )}
      </div>

      {/* Recordings list */}
      {filtered.length === 0 ? (
        <div className="rounded-xl bg-card p-8 text-center">
          <Film className="h-8 w-8 text-muted-foreground/20 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground/50">
            {search || privacyFilter !== 'all' || dateFrom || dateTo
              ? 'No recordings match your filters.'
              : 'No recordings found for this club.'}
          </p>
          {(search || privacyFilter !== 'all' || dateFrom || dateTo) && (
            <button
              onClick={() => {
                setSearch('')
                setPrivacyFilter('all')
                setDateFrom('')
                setDateTo('')
              }}
              className="mt-3 text-[11px] text-muted-foreground/40 hover:text-muted-foreground/70 underline underline-offset-2 transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            {pageRecordings.map((rec) => {
              const isExpanded = expandedSlug === rec.slug
              const hasScore = rec.home_score != null && rec.away_score != null
              const hasTeams =
                teamName(rec.home_team) || teamName(rec.away_team)

              return (
                <div
                  key={rec.slug}
                  className="rounded-xl bg-card overflow-hidden"
                >
                  {/* Recording header */}
                  <button
                    onClick={() =>
                      setExpandedSlug(isExpanded ? null : rec.slug)
                    }
                    className="w-full flex items-center gap-3 px-3 sm:px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                  >
                    {/* Thumbnail */}
                    <div className="w-12 h-8 sm:w-16 sm:h-10 rounded-md overflow-hidden bg-black/30 flex-shrink-0">
                      {extractUrl(rec.thumbnail) ? (
                        <img
                          src={`/api/veo/proxy?url=${encodeURIComponent(extractUrl(rec.thumbnail)!)}`}
                          alt={String(rec.title || '')}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="flex items-center justify-center h-full">
                          <Film className="h-4 w-4 text-muted-foreground/20" />
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <span className="text-[13px] sm:text-sm font-medium text-[var(--timberwolf)] truncate block">
                        {String(rec.title || '')}
                      </span>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                        {rec.match_date && (
                          <span className="text-[11px] text-muted-foreground/40">
                            {formatDate(rec.match_date)}
                          </span>
                        )}
                        {hasTeams && hasScore && (
                          <span className="text-[11px] text-muted-foreground/50 font-medium tabular-nums">
                            {teamName(rec.home_team)}{' '}
                            {String(rec.home_score ?? '')} –{' '}
                            {String(rec.away_score ?? '')}{' '}
                            {teamName(rec.away_team)}
                          </span>
                        )}
                        {!hasScore && hasTeams && (
                          <span className="text-[11px] text-muted-foreground/40">
                            {teamName(rec.home_team)}
                            {rec.away_team
                              ? ` vs ${teamName(rec.away_team)}`
                              : ''}
                          </span>
                        )}
                        {/* Duration + privacy inline on mobile */}
                        <span className="text-[10px] tabular-nums text-muted-foreground/30 flex items-center gap-1 sm:hidden">
                          <Clock className="h-2.5 w-2.5" />
                          {formatDuration(rec.duration)}
                        </span>
                      </div>
                    </div>

                    {/* Badges — hidden on mobile, shown on sm+ */}
                    <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
                      <span className="text-[10px] tabular-nums text-muted-foreground/30 flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatDuration(rec.duration)}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1 ${privacyColor(rec.privacy)}`}
                      >
                        {privacyIcon(rec.privacy)}
                        {String(rec.privacy || '')}
                      </span>
                      {typeof rec.processing_status === 'string' &&
                        rec.processing_status &&
                        rec.processing_status !== 'done' && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-500/10 text-orange-400/80 flex items-center gap-1">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {rec.processing_status}
                          </span>
                        )}
                    </div>

                    <ChevronDown
                      className={`h-3.5 w-3.5 text-muted-foreground/30 flex-shrink-0 transition-transform ${
                        isExpanded ? '' : '-rotate-90'
                      }`}
                    />
                  </button>

                  {/* Expanded content */}
                  {isExpanded && (
                    <div className="border-t border-white/[0.04]">
                      <ExpandedRecording recording={rec} clubSlug={clubSlug} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-1 mt-6">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="p-2 rounded-lg text-muted-foreground/40 hover:text-[var(--timberwolf)] hover:bg-white/[0.04] disabled:opacity-20 disabled:pointer-events-none transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>

              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => {
                  // Show first, last, current, and neighbors
                  if (p === 1 || p === totalPages) return true
                  if (Math.abs(p - safePage) <= 1) return true
                  return false
                })
                .reduce<(number | 'gap')[]>((acc, p, i, arr) => {
                  if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push('gap')
                  acc.push(p)
                  return acc
                }, [])
                .map((item, i) =>
                  item === 'gap' ? (
                    <span
                      key={`gap-${i}`}
                      className="px-1 text-[11px] text-muted-foreground/20"
                    >
                      ...
                    </span>
                  ) : (
                    <button
                      key={item}
                      onClick={() => setPage(item)}
                      className={`min-w-[32px] h-8 rounded-lg text-[12px] tabular-nums transition-colors ${
                        item === safePage
                          ? 'bg-white/[0.08] text-[var(--timberwolf)]'
                          : 'text-muted-foreground/40 hover:text-muted-foreground/70 hover:bg-white/[0.03]'
                      }`}
                    >
                      {item}
                    </button>
                  )
                )}

              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="p-2 rounded-lg text-muted-foreground/40 hover:text-[var(--timberwolf)] hover:bg-white/[0.04] disabled:opacity-20 disabled:pointer-events-none transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
