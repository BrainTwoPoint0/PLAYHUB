// Pure planners for mirroring Clutch highlight clips and player crops.
// Clutch's manifests contain 12h-signed URLs; we mirror every asset to our
// S3 and write rewritten index documents containing S3 KEYS, which the app
// signs on demand. These functions only PLAN the work (tasks + index
// builders) — the handler executes the downloads.
//
// Tolerance contract: malformed or partial manifests produce a smaller plan,
// never a throw. Index entries exist only for keys the handler reports as
// successfully mirrored — the app never signs a key that 404s.
//
// Positional clip keys ({selector}_{i}) assume Clutch manifests are stable
// once video status is OK — delayed reprocessing happens BEFORE OK per
// their docs, so a publish retry sees the same clip list (re-signed URLs,
// same content/order). If Clutch ever regenerates manifests post-OK, switch
// keys to a content-derived hash of the URL pathname.

export interface MirrorTask {
  url: string
  s3Key: string
  contentType: string
}

/**
 * Runs mirror tasks with bounded concurrency; per-task failures are recorded
 * in assetErrors and never abort the batch. Returns the set of keys that
 * exist in S3 afterwards — the input to buildIndex.
 */
export async function runTasks(
  tasks: MirrorTask[],
  mirror: (url: string, s3Key: string, contentType: string) => Promise<unknown>,
  assetErrors: string[],
  concurrency = 4
): Promise<Set<string>> {
  const succeeded = new Set<string>()
  const queue = [...tasks]

  const worker = async () => {
    for (let task = queue.shift(); task; task = queue.shift()) {
      try {
        await mirror(task.url, task.s3Key, task.contentType)
        succeeded.add(task.s3Key)
      } catch (err) {
        const message = `${task.s3Key}: ${err instanceof Error ? err.message : err}`
        console.error(`Clip mirror failed — ${message}`)
        assetErrors.push(message)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker)
  )
  return succeeded
}

export type Selector = 'longest_rally' | 'rating_based' | 'pose_based'
const SELECTORS: Selector[] = ['longest_rally', 'rating_based', 'pose_based']

const FULL_VARIANTS = [
  'match_wo_breaks',
  'clutch_autopan',
  'clutch_landscape',
] as const
type FullVariant = (typeof FULL_VARIANTS)[number]

export interface ClipEntry {
  clip: string
  thumb: string | null
}

export interface HighlightsIndex {
  version: 1
  generatedAt: string
  full: Partial<Record<FullVariant, ClipEntry>>
  selectors: {
    autopan: Record<Selector, ClipEntry[]>
    landscape: Record<Selector, ClipEntry[]>
  }
}

export interface PlayersIndex {
  version: 1
  generatedAt: string
  players: Array<{
    playerId: string
    isGroundTruth: boolean
    cropKey: string | null
  }>
}

const PLAYER_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function emptySelectorMap(): Record<Selector, ClipEntry[]> {
  return { longest_rally: [], rating_based: [], pose_based: [] }
}

interface PlannedClip {
  clipUrl: string
  clipKey: string
  thumbUrl: string | null
  thumbKey: string
}

function planClip(
  clipUrlRaw: unknown,
  thumbUrlRaw: unknown,
  baseKey: string
): PlannedClip | null {
  const clipUrl = httpsUrl(clipUrlRaw)
  if (!clipUrl) return null
  return {
    clipUrl,
    clipKey: `${baseKey}.mp4`,
    thumbUrl: httpsUrl(thumbUrlRaw),
    thumbKey: `${baseKey}.jpg`,
  }
}

function clipTasks(planned: PlannedClip): MirrorTask[] {
  const tasks: MirrorTask[] = [
    { url: planned.clipUrl, s3Key: planned.clipKey, contentType: 'video/mp4' },
  ]
  if (planned.thumbUrl) {
    tasks.push({
      url: planned.thumbUrl,
      s3Key: planned.thumbKey,
      contentType: 'image/jpeg',
    })
  }
  return tasks
}

// Materializes an entry only when the clip itself mirrored; a failed thumb
// degrades to null rather than dropping the clip.
function entryFor(
  planned: PlannedClip,
  succeeded: Set<string>
): ClipEntry | null {
  if (!succeeded.has(planned.clipKey)) return null
  return {
    clip: planned.clipKey,
    thumb:
      planned.thumbUrl && succeeded.has(planned.thumbKey)
        ? planned.thumbKey
        : null,
  }
}

export function planHighlightMirror(
  manifest: unknown,
  prefix: string,
  nowIso: string
): {
  tasks: MirrorTask[]
  buildIndex: (succeededKeys: Set<string>) => HighlightsIndex
} {
  const m = (manifest ?? {}) as Record<string, any>
  const videos =
    typeof m.highlight_video_urls === 'object' && m.highlight_video_urls
      ? m.highlight_video_urls
      : {}
  const thumbs =
    typeof m.highlight_thumbnail_urls === 'object' && m.highlight_thumbnail_urls
      ? m.highlight_thumbnail_urls
      : {}

  const fullPlans: Partial<Record<FullVariant, PlannedClip>> = {}
  for (const variant of FULL_VARIANTS) {
    const planned = planClip(
      videos[variant],
      thumbs[variant],
      `${prefix}/clips/${variant}`
    )
    if (planned) fullPlans[variant] = planned
  }

  const surfacePlans: Record<
    'autopan' | 'landscape',
    Record<Selector, PlannedClip[]>
  > = {
    autopan: { longest_rally: [], rating_based: [], pose_based: [] },
    landscape: { longest_rally: [], rating_based: [], pose_based: [] },
  }
  const surfaceSources: Array<['autopan' | 'landscape', unknown]> = [
    ['autopan', m.autopan_urls_per_selector],
    ['landscape', m.landscape_urls_per_selector],
  ]
  for (const [surface, source] of surfaceSources) {
    if (typeof source !== 'object' || !source) continue
    for (const selector of SELECTORS) {
      const clips = (source as Record<string, unknown>)[selector]
      if (!Array.isArray(clips)) continue
      clips.forEach((c: any, i: number) => {
        const planned = planClip(
          c?.clip_path,
          c?.thumbnail_path,
          `${prefix}/clips/${surface}/${selector}_${i + 1}`
        )
        if (planned) surfacePlans[surface][selector].push(planned)
      })
    }
  }

  const allPlans = [
    ...Object.values(fullPlans),
    ...Object.values(surfacePlans).flatMap((bySelector) =>
      Object.values(bySelector).flat()
    ),
  ]

  return {
    tasks: allPlans.flatMap(clipTasks),
    buildIndex: (succeeded) => {
      const full: HighlightsIndex['full'] = {}
      for (const variant of FULL_VARIANTS) {
        const planned = fullPlans[variant]
        const entry = planned && entryFor(planned, succeeded)
        if (entry) full[variant] = entry
      }
      const selectors: HighlightsIndex['selectors'] = {
        autopan: emptySelectorMap(),
        landscape: emptySelectorMap(),
      }
      for (const surface of ['autopan', 'landscape'] as const) {
        for (const selector of SELECTORS) {
          selectors[surface][selector] = surfacePlans[surface][selector]
            .map((p) => entryFor(p, succeeded))
            .filter((e): e is ClipEntry => e !== null)
        }
      }
      return { version: 1, generatedAt: nowIso, full, selectors }
    },
  }
}

export function planPlayerCropMirror(
  manifest: unknown,
  prefix: string,
  nowIso: string
): {
  tasks: MirrorTask[]
  buildIndex: (succeededKeys: Set<string>) => PlayersIndex
} {
  const m = (manifest ?? {}) as Record<string, any>
  const entries = Array.isArray(m.player_crop_urls) ? m.player_crop_urls : []

  const seen = new Set<string>()
  const players: Array<{
    playerId: string
    isGroundTruth: boolean
    cropUrl: string | null
    cropKey: string
  }> = []

  for (const entry of entries) {
    const playerId = entry?.player_id
    if (typeof playerId !== 'string' || !PLAYER_ID_RE.test(playerId)) continue
    if (seen.has(playerId)) continue
    seen.add(playerId)
    players.push({
      playerId,
      isGroundTruth: entry?.is_ground_truth === true,
      cropUrl: httpsUrl(entry?.crop_url),
      cropKey: `${prefix}/crops/${playerId}.png`,
    })
  }

  return {
    tasks: players
      .filter((p) => p.cropUrl)
      .map((p) => ({
        url: p.cropUrl!,
        s3Key: p.cropKey,
        contentType: 'image/png',
      })),
    buildIndex: (succeeded) => ({
      version: 1,
      generatedAt: nowIso,
      players: players.map((p) => ({
        playerId: p.playerId,
        isGroundTruth: p.isGroundTruth,
        cropKey: succeeded.has(p.cropKey) ? p.cropKey : null,
      })),
    }),
  }
}
