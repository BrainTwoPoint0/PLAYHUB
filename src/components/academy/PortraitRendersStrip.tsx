'use client'

// Review strip for system-generated 9:16 portrait goal renders (CFA pilot).
// Renders nothing when the match has no renders, so non-pilot clubs see no
// change. Draft-first flow: preview inline, Publish → TikTok inbox,
// Reject/Restore, or fix the framing in the editor (which uses the shared
// detection cache, so it opens instantly with the same keyframes).

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Clapperboard, Loader2, Pencil, Send, Undo2, X } from 'lucide-react'
import { cn } from '@braintwopoint0/playback-commons/utils'

interface PortraitRender {
  id: string
  providerEventId: string
  status: 'draft' | 'published' | 'rejected' | 'error'
  quality: { ball_fraction?: number } | null
  error: string | null
  previewUrl: string | null
  publishedAt: string | null
}

interface EditorSource {
  id?: string
  videoUrl?: string
  title?: string
}

interface PortraitRendersStripProps {
  clubSlug: string
  matchSlug: string
  /** provider_event_id → clip source, for the fix-in-editor jump. */
  editorSources: Map<string, EditorSource>
}

const STATUS_STYLES: Record<PortraitRender['status'], string> = {
  draft: 'bg-amber-500/15 text-amber-300',
  published: 'bg-emerald-500/15 text-emerald-300',
  rejected: 'bg-white/[0.06] text-muted-foreground/60',
  error: 'bg-red-500/15 text-red-300',
}

export function PortraitRendersStrip({
  clubSlug,
  matchSlug,
  editorSources,
}: PortraitRendersStripProps) {
  const t = useTranslations('academy.content')
  const router = useRouter()
  const [renders, setRenders] = useState<PortraitRender[] | null>(null)
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/academy/${clubSlug}/portrait-renders?matchSlug=${encodeURIComponent(matchSlug)}`,
          { signal }
        )
        if (!res.ok) return // silent — the strip is an optional surface
        const json = (await res.json()) as { renders?: PortraitRender[] }
        if (!signal?.aborted) setRenders(json.renders ?? [])
      } catch {
        // aborted or network hiccup — leave the current state
      }
    },
    [clubSlug, matchSlug]
  )

  useEffect(() => {
    // Abort on match change so a slow response for the previous match can't
    // land after (and overwrite) the current one's rows.
    const controller = new AbortController()
    setRenders(null)
    setPlayingId(null)
    refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const act = useCallback(
    async (
      render: PortraitRender,
      action: 'publish' | 'reject' | 'restore'
    ) => {
      setBusyId(render.id)
      setNotice(null)
      try {
        const res =
          action === 'publish'
            ? await fetch('/api/tiktok/publish', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ renderId: render.id }),
              })
            : await fetch(
                `/api/academy/${clubSlug}/portrait-renders/${render.id}`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action }),
                }
              )
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            error?: string
          } | null
          setNotice(body?.error ?? t('portrait.actionFailed'))
          return
        }
        if (action === 'publish') setNotice(t('portrait.publishedNotice'))
        await refresh()
      } catch {
        setNotice(t('portrait.actionFailed'))
      } finally {
        setBusyId(null)
      }
    },
    [clubSlug, refresh, t]
  )

  const fixInEditor = useCallback(
    (render: PortraitRender) => {
      const source = editorSources.get(render.providerEventId)
      if (!source?.videoUrl) return
      const params = new URLSearchParams({
        videoUrl: source.videoUrl,
        title: source.title ?? t('portrait.title'),
        from: 'academy',
        autoDetect: '1',
      })
      if (source.id) params.set('highlightId', source.id)
      router.push(`/editor?${params.toString()}`)
    },
    [editorSources, router, t]
  )

  if (!renders || renders.length === 0) return null

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Clapperboard className="h-3 w-3 text-muted-foreground/30" />
        <span className="text-[11px] text-muted-foreground/50 uppercase tracking-wider">
          {t('portrait.title')}
        </span>
        {notice && (
          <span className="text-[11px] text-muted-foreground/60">{notice}</span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {renders.map((render) => {
          const busy = busyId === render.id
          const playable =
            render.previewUrl &&
            (render.status === 'draft' || render.status === 'published')
          return (
            <div
              key={render.id}
              className={cn(
                'group relative rounded-lg overflow-hidden bg-white/[0.02] border border-white/[0.04] transition-colors',
                render.status === 'rejected' && 'opacity-50'
              )}
            >
              <div className="relative aspect-[9/16] bg-black/30">
                {playable && playingId === render.id ? (
                  <video
                    src={render.previewUrl as string}
                    controls
                    autoPlay
                    playsInline
                    className="w-full h-full object-contain bg-black"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => playable && setPlayingId(render.id)}
                    disabled={!playable}
                    aria-label={t('portrait.preview')}
                    className="w-full h-full flex items-center justify-center text-muted-foreground/30 disabled:cursor-default"
                  >
                    {render.status === 'error' ? (
                      <span className="px-2 text-[11px] text-red-300/70">
                        {render.error ?? t('portrait.errorBadge')}
                      </span>
                    ) : (
                      <Clapperboard className="h-6 w-6" />
                    )}
                  </button>
                )}
                <span
                  className={cn(
                    'absolute top-1.5 left-1.5 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide',
                    STATUS_STYLES[render.status]
                  )}
                >
                  {t(`portrait.${render.status}`)}
                </span>
              </div>
              <div className="flex items-center justify-end gap-1 p-1.5">
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground/50" />
                ) : (
                  <>
                    {(render.status === 'draft' ||
                      render.status === 'published') && (
                      <button
                        type="button"
                        onClick={() => act(render, 'publish')}
                        title={t('portrait.publish')}
                        aria-label={t('portrait.publish')}
                        className="p-1.5 rounded text-muted-foreground/60 hover:text-emerald-300 hover:bg-white/[0.06]"
                      >
                        <Send className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {editorSources.has(render.providerEventId) &&
                      render.status !== 'rejected' && (
                        <button
                          type="button"
                          onClick={() => fixInEditor(render)}
                          title={t('portrait.fixInEditor')}
                          aria-label={t('portrait.fixInEditor')}
                          className="p-1.5 rounded text-muted-foreground/60 hover:text-[var(--timberwolf)] hover:bg-white/[0.06]"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                    {(render.status === 'draft' ||
                      render.status === 'error') && (
                      <button
                        type="button"
                        onClick={() => act(render, 'reject')}
                        title={t('portrait.reject')}
                        aria-label={t('portrait.reject')}
                        className="p-1.5 rounded text-muted-foreground/60 hover:text-red-300 hover:bg-white/[0.06]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {render.status === 'rejected' && (
                      <button
                        type="button"
                        onClick={() => act(render, 'restore')}
                        title={t('portrait.restore')}
                        aria-label={t('portrait.restore')}
                        className="p-1.5 rounded text-muted-foreground/60 hover:text-[var(--timberwolf)] hover:bg-white/[0.06]"
                      >
                        <Undo2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
