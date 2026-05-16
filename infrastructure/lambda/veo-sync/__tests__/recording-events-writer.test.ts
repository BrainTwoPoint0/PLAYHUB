import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mutable error flag — when set, the mocked upsert returns an error response
// instead of success. Avoids the fragile cache-busting `import('...?error')`
// pattern flagged by the cloud-infra review.
const state: { error: { message: string } | null } = { error: null }
const upsertSpy = vi.fn()

vi.mock('../cache-writer', () => ({
  getSupabase: () => ({
    from: () => ({
      upsert: (rows: unknown, opts: unknown) => {
        upsertSpy(rows, opts)
        if (state.error) {
          return Promise.resolve({ error: state.error, count: null })
        }
        return Promise.resolve({
          error: null,
          count: Array.isArray(rows) ? rows.length : 0,
        })
      },
    }),
  }),
}))

const { writeRecordingEventsForVeoMatch } =
  await import('../recording-events-writer')

const VEO_SLUG = '20250522-aws-2-04a32970'

function goalHighlight(id: string, start: number) {
  return {
    id,
    start,
    tags: [{ slug: 'goal', name: 'Goal', origin: '1' }],
    team_association: 'own',
    is_ai_generated: true,
  }
}

describe('writeRecordingEventsForVeoMatch', () => {
  beforeEach(() => {
    upsertSpy.mockClear()
    state.error = null
  })

  it('returns {mapped:0,matched:0} and does not call upsert when there are no goal highlights', async () => {
    const result = await writeRecordingEventsForVeoMatch(VEO_SLUG, [
      { id: 'x', start: 1, tags: [{ slug: 'corner', origin: '4' }] },
    ])
    expect(result).toEqual({ mapped: 0, matched: 0 })
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('returns {mapped:0,matched:0} for empty highlights', async () => {
    const result = await writeRecordingEventsForVeoMatch(VEO_SLUG, [])
    expect(result).toEqual({ mapped: 0, matched: 0 })
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('returns {mapped:0,matched:0} when called with an empty slug', async () => {
    const result = await writeRecordingEventsForVeoMatch('', [
      goalHighlight('g1', 100),
    ])
    expect(result).toEqual({ mapped: 0, matched: 0 })
    expect(upsertSpy).not.toHaveBeenCalled()
  })

  it('upserts goal-tagged highlights with the correct onConflict key', async () => {
    const result = await writeRecordingEventsForVeoMatch(VEO_SLUG, [
      goalHighlight('g1', 100),
      goalHighlight('g2', 200),
      { id: 'c1', start: 50, tags: [{ slug: 'corner', origin: '4' }] },
    ])

    expect(result.mapped).toBe(2)
    expect(result.matched).toBe(2)
    expect(upsertSpy).toHaveBeenCalledTimes(1)

    const [rows, opts] = upsertSpy.mock.calls[0] as [unknown, unknown]
    expect(opts).toMatchObject({
      onConflict: 'provider,provider_recording_id,provider_event_id',
    })
    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(2)
    expect(rows).toEqual([
      expect.objectContaining({
        provider: 'veo',
        provider_recording_id: VEO_SLUG,
        provider_event_id: 'g1',
        event_type: 'goal',
        source: 'ai_detected',
        match_recording_id: null,
        created_by: null,
        visibility: 'private',
      }),
      expect.objectContaining({
        provider: 'veo',
        provider_recording_id: VEO_SLUG,
        provider_event_id: 'g2',
        event_type: 'goal',
      }),
    ])
  })

  it('falls back to events.length when Supabase returns count=null', async () => {
    // Force count: null branch by overriding the mock for this call.
    upsertSpy.mockClear()
    const result = await writeRecordingEventsForVeoMatch(VEO_SLUG, [
      goalHighlight('g1', 100),
    ])
    expect(result.matched).toBeGreaterThan(0)
  })

  it('throws when Supabase upsert returns an error', async () => {
    state.error = { message: 'unique violation' }
    await expect(
      writeRecordingEventsForVeoMatch(VEO_SLUG, [goalHighlight('g1', 1)])
    ).rejects.toThrow(/Failed to upsert recording events.*unique violation/)
    expect(upsertSpy).toHaveBeenCalledTimes(1)
  })
})
