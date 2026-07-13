'use client'

import { useState, useEffect, useCallback, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@braintwopoint0/playback-commons/ui'
import type { ChartConfig } from '@braintwopoint0/playback-commons/ui'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import { LoadingSpinner } from '@/components/ui/loading'
import { cn } from '@braintwopoint0/playback-commons/utils'
import {
  Music2,
  Users,
  Heart,
  Film,
  UserPlus,
  ExternalLink,
  Loader2,
  AlertTriangle,
  Play,
} from 'lucide-react'

interface TikTokProfile {
  openId: string
  avatarUrl: string | null
  displayName: string | null
  followerCount: number
  followingCount: number
  likesCount: number
  videoCount: number
}

interface TikTokVideo {
  id: string
  title: string
  coverImageUrl: string | null
  shareUrl: string | null
  viewCount: number
  likeCount: number
  commentCount: number
  shareCount: number
  createTime: number
}

type Tab = 'overview' | 'videos'

function compact(n: number): string {
  return Intl.NumberFormat('en', { notation: 'compact' }).format(n)
}

function TikTokDashboard() {
  const searchParams = useSearchParams()
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [connected, setConnected] = useState(false)
  const [needsReconnect, setNeedsReconnect] = useState(false)
  const [connecting, setConnecting] = useState(false)

  const [profile, setProfile] = useState<TikTokProfile | null>(null)
  const [videos, setVideos] = useState<TikTokVideo[]>([])
  const [dataError, setDataError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')

  // Surface the OAuth callback result from the redirect.
  const callbackError = searchParams.get('tiktok_error')

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true)
    try {
      const res = await fetch('/api/auth/tiktok?action=status')
      const data = (await res.json()) as {
        connected?: boolean
        needsReconnect?: boolean
      }
      setConnected(!!data.connected)
      setNeedsReconnect(!!data.needsReconnect)
    } catch {
      setConnected(false)
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  const loadData = useCallback(async () => {
    setDataError(null)
    try {
      const [pRes, vRes] = await Promise.all([
        fetch('/api/tiktok/profile'),
        fetch('/api/tiktok/videos'),
      ])
      if (pRes.status === 409 || vRes.status === 409) {
        setNeedsReconnect(true)
        setConnected(false)
        return
      }
      if (!pRes.ok) throw new Error('Could not load your TikTok profile')
      const { profile } = (await pRes.json()) as { profile: TikTokProfile }
      setProfile(profile)
      if (vRes.ok) {
        const { videos } = (await vRes.json()) as { videos: TikTokVideo[] }
        setVideos(videos)
      }
    } catch (err) {
      setDataError(
        err instanceof Error ? err.message : 'Could not load your TikTok data'
      )
    }
  }, [])

  useEffect(() => {
    loadStatus()
  }, [loadStatus])

  useEffect(() => {
    if (connected) loadData()
  }, [connected, loadData])

  const handleConnect = useCallback(async () => {
    setConnecting(true)
    try {
      const res = await fetch('/api/auth/tiktok?action=connect')
      const { url } = (await res.json()) as { url?: string }
      if (url) window.location.href = url
      else setConnecting(false)
    } catch {
      setConnecting(false)
    }
  }, [])

  const handleDisconnect = useCallback(async () => {
    await fetch('/api/auth/tiktok', { method: 'POST' })
    setProfile(null)
    setVideos([])
    setConnected(false)
    setNeedsReconnect(false)
  }, [])

  const chartConfig: ChartConfig = {
    views: { label: 'Views', color: 'var(--timberwolf)' },
  }
  const chartData = videos
    .slice(0, 8)
    .map((v, i) => ({ name: `#${i + 1}`, views: v.viewCount }))

  return (
    <div className="mx-auto max-w-screen-lg px-4 py-10 md:py-14">
      {/* Header */}
      <div className="mb-8 flex items-start gap-3">
        <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--timberwolf)]/15 bg-card">
          <Music2 className="h-5 w-5 text-[var(--timberwolf)]" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold leading-none tracking-tight text-[var(--timberwolf)]">
            TikTok
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Connect your account to publish highlights and track how they
            perform.
          </p>
        </div>
      </div>

      {callbackError && (
        <div className="mb-6 flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-400">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>{callbackError}</span>
        </div>
      )}

      {loadingStatus ? (
        <div className="flex justify-center py-20">
          <LoadingSpinner />
        </div>
      ) : !connected ? (
        <ConnectCard
          needsReconnect={needsReconnect}
          connecting={connecting}
          onConnect={handleConnect}
        />
      ) : (
        <div className="space-y-6">
          <ProfileHeader profile={profile} onDisconnect={handleDisconnect} />

          {dataError && (
            <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-400">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>{dataError}</span>
            </div>
          )}

          {/* Tabs */}
          <div className="flex gap-1 border-b border-[var(--timberwolf)]/10">
            {(['overview', 'videos'] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  'relative px-4 py-2.5 text-sm font-medium capitalize transition-colors',
                  tab === t
                    ? 'text-[var(--timberwolf)]'
                    : 'text-muted-foreground hover:text-[var(--timberwolf)]'
                )}
              >
                {t}
                {tab === t && (
                  <span className="absolute inset-x-0 -bottom-px h-0.5 bg-[var(--timberwolf)]" />
                )}
              </button>
            ))}
          </div>

          {tab === 'overview' ? (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard
                  icon={<Users className="h-4 w-4" />}
                  label="Followers"
                  value={profile ? compact(profile.followerCount) : '—'}
                />
                <StatCard
                  icon={<Heart className="h-4 w-4" />}
                  label="Likes"
                  value={profile ? compact(profile.likesCount) : '—'}
                />
                <StatCard
                  icon={<Film className="h-4 w-4" />}
                  label="Videos"
                  value={profile ? compact(profile.videoCount) : '—'}
                />
                <StatCard
                  icon={<UserPlus className="h-4 w-4" />}
                  label="Following"
                  value={profile ? compact(profile.followingCount) : '—'}
                />
              </div>

              {chartData.length > 0 && (
                <div className="rounded-xl border border-border bg-card p-5">
                  <h2 className="mb-4 text-sm font-medium text-[var(--timberwolf)]">
                    Views — recent videos
                  </h2>
                  <ChartContainer
                    config={chartConfig}
                    className="h-[220px] w-full"
                  >
                    <BarChart data={chartData}>
                      <CartesianGrid
                        vertical={false}
                        stroke="hsl(var(--border))"
                      />
                      <XAxis
                        dataKey="name"
                        stroke="hsl(var(--muted-foreground))"
                        tickLine={false}
                        axisLine={false}
                        fontSize={12}
                      />
                      <YAxis
                        stroke="hsl(var(--muted-foreground))"
                        tickLine={false}
                        axisLine={false}
                        allowDecimals={false}
                        fontSize={12}
                        tickFormatter={(v) => compact(Number(v))}
                      />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar
                        dataKey="views"
                        fill="var(--timberwolf)"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ChartContainer>
                </div>
              )}
            </div>
          ) : (
            <VideoGrid videos={videos} />
          )}
        </div>
      )}
    </div>
  )
}

function ConnectCard({
  needsReconnect,
  connecting,
  onConnect,
}: {
  needsReconnect: boolean
  connecting: boolean
  onConnect: () => void
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-10 text-center">
      <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--timberwolf)]/15">
        <Music2 className="h-6 w-6 text-[var(--timberwolf)]" />
      </div>
      <h2 className="text-lg font-semibold text-[var(--timberwolf)]">
        {needsReconnect
          ? 'Reconnect your TikTok account'
          : 'Connect your TikTok account'}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {needsReconnect
          ? 'Your TikTok session expired. Reconnect to keep publishing highlights and viewing stats.'
          : 'Authorize PLAYHUB to publish your portrait highlights to TikTok and show your profile, stats, and video performance here.'}
      </p>
      <button
        onClick={onConnect}
        disabled={connecting}
        className="mt-6 inline-flex items-center gap-2 rounded-md bg-[var(--timberwolf)] px-5 py-2.5 text-sm font-medium text-[var(--night)] transition-colors hover:bg-white disabled:opacity-50"
      >
        {connecting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Music2 className="h-4 w-4" />
        )}
        {needsReconnect ? 'Reconnect TikTok' : 'Connect TikTok'}
      </button>
    </div>
  )
}

function ProfileHeader({
  profile,
  onDisconnect,
}: {
  profile: TikTokProfile | null
  onDisconnect: () => void
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-5">
      {profile?.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={profile.avatarUrl}
          alt={profile.displayName ?? 'TikTok avatar'}
          className="h-14 w-14 rounded-full object-cover"
        />
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <Music2 className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-semibold text-[var(--timberwolf)]">
          {profile?.displayName ?? 'TikTok account'}
        </p>
        <p className="text-xs text-muted-foreground">Connected</p>
      </div>
      <button
        onClick={onDisconnect}
        className="rounded-md border border-[var(--timberwolf)]/15 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-[var(--timberwolf)]"
      >
        Disconnect
      </button>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="text-[10px] uppercase tracking-[0.14em]">{label}</span>
      </div>
      <p className="text-xl font-semibold text-[var(--timberwolf)]">{value}</p>
    </div>
  )
}

function VideoGrid({ videos }: { videos: TikTokVideo[] }) {
  if (videos.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-10 text-center text-sm text-muted-foreground">
        No videos on this account yet. Publish a highlight to see it here.
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {videos.map((v) => (
        <a
          key={v.id}
          href={v.shareUrl ?? '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="group overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-[var(--timberwolf)]/25"
        >
          <div className="relative aspect-[9/16] bg-muted">
            {v.coverImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={v.coverImageUrl}
                alt={v.title || 'TikTok video'}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full items-center justify-center">
                <Play className="h-6 w-6 text-muted-foreground" />
              </div>
            )}
            <ExternalLink className="absolute right-2 top-2 h-3.5 w-3.5 text-white/70 opacity-0 transition-opacity group-hover:opacity-100" />
          </div>
          <div className="p-3">
            <p className="line-clamp-1 text-xs font-medium text-[var(--timberwolf)]">
              {v.title || 'Untitled'}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Play className="h-3 w-3" />
                {compact(v.viewCount)}
              </span>
              <span className="inline-flex items-center gap-1">
                <Heart className="h-3 w-3" />
                {compact(v.likeCount)}
              </span>
            </div>
          </div>
        </a>
      ))}
    </div>
  )
}

export default function TikTokPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-20">
          <LoadingSpinner />
        </div>
      }
    >
      <TikTokDashboard />
    </Suspense>
  )
}
