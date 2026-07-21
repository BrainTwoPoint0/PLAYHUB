import { describe, it, expect, vi } from 'vitest'
import { insertPortraitFeedback } from '../portrait-feedback'
import type { CropKeyframe } from '@/lib/editor/types'

/** The service-client parameter type, without restating the generics. */
type ServiceClient = Parameters<typeof insertPortraitFeedback>[0]

const kf = (time: number, x: number): CropKeyframe => ({
  time,
  x,
  source: 'ai_ball',
  confidence: 0.9,
})

/** Minimal stand-in for the service client: captures the insert payload. */
function fakeClient() {
  const captured: { row?: Record<string, unknown> } = {}
  const client = {
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        captured.row = row
        return {
          select: () => ({
            single: async () => ({ data: { id: 'row-1' }, error: null }),
          }),
        }
      },
    }),
  }
  return {
    client: client as unknown as ServiceClient,
    captured,
  }
}

const base = {
  renderId: 'r1',
  providerEventId: 'e1',
  clubSlug: 'cfa',
  userId: 'u1',
} as const

describe('insertPortraitFeedback', () => {
  it('NEVER fabricates a diff when there is no baseline', async () => {
    // The bug this guards: diffing against an empty baseline would report every
    // keyframe as "added" — a maximal correction indistinguishable from a genuine
    // full manual rewrite, stamped with a provenance that implies a baseline existed.
    const { client, captured } = fakeClient()
    const res = await insertPortraitFeedback(client, {
      ...base,
      action: 'edited',
      keyframesBefore: null,
      keyframesAfter: [kf(0, 10), kf(1, 20)],
      baselineOrigin: 'none',
    })
    expect(res.diff).toBeNull()
    expect(captured.row?.diff).toBeNull()
    expect(captured.row?.baseline_origin).toBe('none')
  })

  it('computes a diff when a real baseline exists', async () => {
    const { client, captured } = fakeClient()
    const res = await insertPortraitFeedback(client, {
      ...base,
      action: 'edited',
      keyframesBefore: [kf(0, 10), kf(1, 20)],
      keyframesAfter: [kf(0, 10)],
      baselineOrigin: 'render_row',
    })
    expect(res.diff?.counts).toMatchObject({ deleted: 1, added: 0 })
    expect(captured.row?.baseline_origin).toBe('render_row')
  })

  it('records no diff for a bare accept label (no "after" to compare)', async () => {
    const { client } = fakeClient()
    const res = await insertPortraitFeedback(client, {
      ...base,
      action: 'accepted',
      keyframesBefore: [kf(0, 10)],
      keyframesAfter: null,
      baselineOrigin: 'render_row',
    })
    expect(res.diff).toBeNull()
    expect(res.ok).toBe(true)
  })

  it('writes only geometry — no client-supplied field can reach the corpus', async () => {
    const { client, captured } = fakeClient()
    await insertPortraitFeedback(client, {
      ...base,
      action: 'edited',
      keyframesBefore: [kf(0, 10)],
      keyframesAfter: [kf(0, 12)],
      baselineOrigin: 'render_row',
    })
    // The exact column set — a new key here should be a deliberate decision, not a leak.
    expect(Object.keys(captured.row ?? {}).sort()).toEqual(
      [
        'action',
        'baseline_origin',
        'club_slug',
        'diff',
        'keyframes_after',
        'keyframes_before',
        'note',
        'provider_event_id',
        'reason',
        'render_id',
        'scene_changes',
        'trim',
        'user_id',
      ].sort()
    )
  })

  it('never throws on a write failure — an admin action must not fail for a lost row', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: { message: 'boom' } }),
          }),
        }),
      }),
    } as unknown as ServiceClient
    const res = await insertPortraitFeedback(client, {
      ...base,
      action: 'accepted',
      baselineOrigin: 'none',
    })
    expect(res.ok).toBe(false)
    expect(res.id).toBeNull()
    spy.mockRestore()
  })
})
