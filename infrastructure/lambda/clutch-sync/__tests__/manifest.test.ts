import { describe, it, expect, vi } from 'vitest'
import {
  planHighlightMirror,
  planPlayerCropMirror,
  runTasks,
  type MirrorTask,
} from '../manifest'

const PREFIX = 'recordings/2026-06-13/clutch/vid-1'
const NOW = '2026-06-13T10:00:00.000Z'

const fullHighlightManifest = {
  highlight_video_urls: {
    match_wo_breaks: 'https://cdn.clutch/match-wo-breaks.mp4',
    clutch_autopan: 'https://cdn.clutch/autopan.mp4',
    clutch_landscape: 'https://cdn.clutch/landscape.mp4',
  },
  highlight_thumbnail_urls: {
    match_wo_breaks: 'https://cdn.clutch/match-wo-breaks.jpg',
    clutch_autopan: 'https://cdn.clutch/autopan.jpg',
    clutch_landscape: 'https://cdn.clutch/landscape.jpg',
  },
  autopan_urls_per_selector: {
    longest_rally: [
      {
        clip_path: 'https://cdn.clutch/ap-lr-1.mp4',
        thumbnail_path: 'https://cdn.clutch/ap-lr-1.jpg',
      },
      {
        clip_path: 'https://cdn.clutch/ap-lr-2.mp4',
        thumbnail_path: 'https://cdn.clutch/ap-lr-2.jpg',
      },
    ],
    rating_based: [
      {
        clip_path: 'https://cdn.clutch/ap-rb-1.mp4',
        thumbnail_path: 'https://cdn.clutch/ap-rb-1.jpg',
      },
    ],
    pose_based: [],
  },
  landscape_urls_per_selector: {
    longest_rally: [
      {
        clip_path: 'https://cdn.clutch/ls-lr-1.mp4',
        thumbnail_path: 'https://cdn.clutch/ls-lr-1.jpg',
      },
    ],
  },
}

function allSucceeded(tasks: Array<{ s3Key: string }>) {
  return new Set(tasks.map((t) => t.s3Key))
}

describe('planHighlightMirror', () => {
  it('plans deterministic keys for every clip and thumbnail', () => {
    const { tasks } = planHighlightMirror(fullHighlightManifest, PREFIX, NOW)
    const keys = tasks.map((t) => t.s3Key)

    expect(keys).toContain(`${PREFIX}/clips/match_wo_breaks.mp4`)
    expect(keys).toContain(`${PREFIX}/clips/match_wo_breaks.jpg`)
    expect(keys).toContain(`${PREFIX}/clips/clutch_autopan.mp4`)
    expect(keys).toContain(`${PREFIX}/clips/autopan/longest_rally_1.mp4`)
    expect(keys).toContain(`${PREFIX}/clips/autopan/longest_rally_2.jpg`)
    expect(keys).toContain(`${PREFIX}/clips/autopan/rating_based_1.mp4`)
    expect(keys).toContain(`${PREFIX}/clips/landscape/longest_rally_1.mp4`)

    // mp4s are video, jpgs are image
    for (const t of tasks) {
      expect(t.contentType).toBe(
        t.s3Key.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg'
      )
      expect(t.url.startsWith('https://')).toBe(true)
    }
  })

  it('builds an index containing only succeeded keys', () => {
    const { tasks, buildIndex } = planHighlightMirror(
      fullHighlightManifest,
      PREFIX,
      NOW
    )
    const index = buildIndex(allSucceeded(tasks))

    expect(index.version).toBe(1)
    expect(index.generatedAt).toBe(NOW)
    expect(index.full.match_wo_breaks).toEqual({
      clip: `${PREFIX}/clips/match_wo_breaks.mp4`,
      thumb: `${PREFIX}/clips/match_wo_breaks.jpg`,
    })
    expect(index.selectors.autopan.longest_rally).toHaveLength(2)
    expect(index.selectors.autopan.pose_based).toHaveLength(0)
    expect(index.selectors.landscape.longest_rally).toHaveLength(1)
  })

  it('drops clips that failed and nulls thumbs that failed', () => {
    const { tasks, buildIndex } = planHighlightMirror(
      fullHighlightManifest,
      PREFIX,
      NOW
    )
    const succeeded = allSucceeded(tasks)
    // clip failed entirely
    succeeded.delete(`${PREFIX}/clips/autopan/longest_rally_1.mp4`)
    // only the thumb failed
    succeeded.delete(`${PREFIX}/clips/autopan/rating_based_1.jpg`)

    const index = buildIndex(succeeded)
    expect(
      index.selectors.autopan.longest_rally.map((c) => c.clip)
    ).not.toContain(`${PREFIX}/clips/autopan/longest_rally_1.mp4`)
    expect(index.selectors.autopan.longest_rally).toHaveLength(1)
    expect(index.selectors.autopan.rating_based[0]).toEqual({
      clip: `${PREFIX}/clips/autopan/rating_based_1.mp4`,
      thumb: null,
    })
  })

  it('tolerates missing sections and unknown selectors without throwing', () => {
    const sparse = {
      highlight_video_urls: { clutch_autopan: 'https://cdn.clutch/a.mp4' },
      autopan_urls_per_selector: {
        some_future_selector: [
          { clip_path: 'https://cdn.clutch/x.mp4', thumbnail_path: null },
        ],
      },
    }
    const { tasks, buildIndex } = planHighlightMirror(sparse, PREFIX, NOW)
    const index = buildIndex(allSucceeded(tasks))

    expect(index.full.clutch_autopan).toEqual({
      clip: `${PREFIX}/clips/clutch_autopan.mp4`,
      thumb: null,
    })
    expect(index.full.match_wo_breaks).toBeUndefined()
    // unknown selectors skipped
    expect(Object.keys(index.selectors.autopan)).not.toContain(
      'some_future_selector'
    )
  })

  it('returns an empty valid plan for malformed manifests', () => {
    for (const bad of [null, undefined, 'string', 42, [], {}]) {
      const { tasks, buildIndex } = planHighlightMirror(bad, PREFIX, NOW)
      expect(tasks).toEqual([])
      const index = buildIndex(new Set())
      expect(index.version).toBe(1)
      expect(index.full).toEqual({})
    }
  })

  it('skips non-https urls', () => {
    const sketchy = {
      highlight_video_urls: {
        clutch_autopan: 'http://insecure.example/a.mp4',
      },
    }
    const { tasks } = planHighlightMirror(sketchy, PREFIX, NOW)
    expect(tasks).toEqual([])
  })
})

describe('runTasks', () => {
  const tasks: MirrorTask[] = Array.from({ length: 10 }, (_, i) => ({
    url: `https://cdn.clutch/${i}.mp4`,
    s3Key: `${PREFIX}/clips/${i}.mp4`,
    contentType: 'video/mp4',
  }))

  it('returns only succeeded keys and records failures without aborting', async () => {
    const assetErrors: string[] = []
    const mirror = vi.fn(async (url: string) => {
      if (url.includes('/3.mp4') || url.includes('/7.mp4')) {
        throw new Error('download failed')
      }
    })

    const succeeded = await runTasks(tasks, mirror, assetErrors)

    expect(succeeded.size).toBe(8)
    expect(succeeded.has(`${PREFIX}/clips/3.mp4`)).toBe(false)
    expect(succeeded.has(`${PREFIX}/clips/7.mp4`)).toBe(false)
    expect(assetErrors).toHaveLength(2)
    expect(mirror).toHaveBeenCalledTimes(10)
  })

  it('bounds concurrency', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const mirror = async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    }

    await runTasks(tasks, mirror, [], 3)
    expect(maxInFlight).toBeLessThanOrEqual(3)
  })

  it('handles an empty task list', async () => {
    const succeeded = await runTasks([], vi.fn(), [])
    expect(succeeded.size).toBe(0)
  })
})

describe('planPlayerCropMirror', () => {
  const cropManifest = {
    player_crop_urls: [
      {
        player_id: 'player-187',
        is_ground_truth: true,
        crop_url: 'https://cdn.clutch/p187.png',
      },
      {
        player_id: 'player-22',
        is_ground_truth: false,
        crop_url: 'https://cdn.clutch/p22.png',
      },
    ],
  }

  it('plans crop keys and builds the players index', () => {
    const { tasks, buildIndex } = planPlayerCropMirror(
      cropManifest,
      PREFIX,
      NOW
    )
    expect(tasks).toEqual([
      {
        url: 'https://cdn.clutch/p187.png',
        s3Key: `${PREFIX}/crops/player-187.png`,
        contentType: 'image/png',
      },
      {
        url: 'https://cdn.clutch/p22.png',
        s3Key: `${PREFIX}/crops/player-22.png`,
        contentType: 'image/png',
      },
    ])

    const index = buildIndex(allSucceeded(tasks))
    expect(index.players).toEqual([
      {
        playerId: 'player-187',
        isGroundTruth: true,
        cropKey: `${PREFIX}/crops/player-187.png`,
      },
      {
        playerId: 'player-22',
        isGroundTruth: false,
        cropKey: `${PREFIX}/crops/player-22.png`,
      },
    ])
  })

  it('keeps players whose crop failed, with cropKey null', () => {
    const { buildIndex } = planPlayerCropMirror(cropManifest, PREFIX, NOW)
    const index = buildIndex(new Set([`${PREFIX}/crops/player-187.png`]))
    expect(index.players.find((p) => p.playerId === 'player-22')).toEqual({
      playerId: 'player-22',
      isGroundTruth: false,
      cropKey: null,
    })
  })

  it('skips unsafe player ids and dedupes', () => {
    const sketchy = {
      player_crop_urls: [
        {
          player_id: '../escape',
          is_ground_truth: false,
          crop_url: 'https://cdn.clutch/x.png',
        },
        {
          player_id: 'player-1',
          is_ground_truth: true,
          crop_url: 'https://cdn.clutch/a.png',
        },
        {
          player_id: 'player-1',
          is_ground_truth: false,
          crop_url: 'https://cdn.clutch/b.png',
        },
      ],
    }
    const { tasks } = planPlayerCropMirror(sketchy, PREFIX, NOW)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].s3Key).toBe(`${PREFIX}/crops/player-1.png`)
  })

  it('returns an empty valid plan for malformed manifests', () => {
    for (const bad of [null, 'x', {}, { player_crop_urls: 'nope' }]) {
      const { tasks, buildIndex } = planPlayerCropMirror(bad, PREFIX, NOW)
      expect(tasks).toEqual([])
      expect(buildIndex(new Set()).players).toEqual([])
    }
  })
})
