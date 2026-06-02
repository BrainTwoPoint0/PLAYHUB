import { describe, it, expect, vi } from 'vitest'
import { runContentCleanup } from '../cleanup'
import type { VeoRecording } from '../orchestrator'

const VEO = 'london-youth-league'

// Minimal supabase fake: listAssignments reads, resetAwayAssignment writes.
// failReset=true makes the reset UPDATE return an error (simulates a reset
// failing AFTER a successful delete — the stranded-row hazard).
function makeSupabase(assignmentRows: any[], failReset = false) {
  const resets: Array<{ league: string; slug: string }> = []
  const supabase: any = {
    from: (table: string) => {
      if (table !== 'playhub_recording_assignments')
        throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (_c: string, v: string) => ({
            then: (resolve: any) =>
              resolve({
                data: assignmentRows.filter((r) => r.league_club_slug === v),
                error: null,
              }),
          }),
        }),
        update: (_patch: any) => ({
          eq: (_c1: string, v1: string) => ({
            eq: async (_c2: string, v2: string) => {
              if (failReset) return { error: { message: 'db blip' } }
              resets.push({ league: v1, slug: v2 })
              return { error: null }
            },
          }),
        }),
      }
    },
  }
  return { supabase, resets }
}

function rec(p: Partial<VeoRecording> & { slug: string }): VeoRecording {
  return {
    title: p.slug,
    duration: 2700,
    team: null,
    match_date: null,
    processing_status: {},
    thumbnail: 'https://veo.test/t.jpg',
    ...p,
  }
}

/** Content checker for the cleanup veo mock: the listed slugs have NO footage
 *  (broken), everything else is healthy. */
function makeGetContent(emptySlugs: string[] = []) {
  const set = new Set(emptySlugs)
  return async (slug: string) =>
    set.has(slug) ? { videos: 0, periods: 0 } : { videos: 3, periods: 2 }
}

describe('runContentCleanup', () => {
  it('dry-run (apply=false): reports empty copies but deletes nothing', async () => {
    const recordings = [
      rec({ slug: `${VEO}-copy-1`, thumbnail: '' }), // broken copy
    ]
    const { supabase } = makeSupabase([])
    const deleteRecording = vi.fn(async () => {})
    const r = await runContentCleanup(
      { leagueClubSlug: 'lyl', veoClubSlug: VEO, apply: false },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording,
          getRecordingContent: makeGetContent(recordings.map((r) => r.slug)),
          getRecordingCamera: async () => null,
        },
      }
    )
    expect(r.applied).toBe(false)
    expect(r.audit.emptyShareCopies).toHaveLength(1)
    expect(deleteRecording).not.toHaveBeenCalled()
    expect(r.cleaned).toHaveLength(0)
  })

  it('apply: deletes an eligible (aged) empty copy and resets the originating assignment', async () => {
    const recordings = [rec({ slug: `${VEO}-copy-1`, thumbnail: '' })]
    const assignments = [
      {
        league_club_slug: 'lyl',
        recording_slug: 'rec-1',
        away_accepted_recording_uuid: `${VEO}-copy-1`,
        away_assigned_at: '2026-05-17T00:00:00Z', // old → past grace window
        status: 'fully_assigned',
      },
    ]
    const { supabase, resets } = makeSupabase(assignments)
    const deleteRecording = vi.fn(async () => {})
    const r = await runContentCleanup(
      {
        leagueClubSlug: 'lyl',
        veoClubSlug: VEO,
        apply: true,
        now: () => Date.parse('2026-05-31T00:00:00Z'),
      },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording,
          getRecordingContent: makeGetContent(recordings.map((r) => r.slug)),
          getRecordingCamera: async () => null,
        },
      }
    )
    expect(deleteRecording).toHaveBeenCalledWith(`${VEO}-copy-1`)
    expect(r.cleaned).toHaveLength(1)
    expect(resets).toEqual([{ league: 'lyl', slug: 'rec-1' }])
  })

  it('grace window: skips a freshly-created empty copy (within minAgeMs)', async () => {
    const recordings = [rec({ slug: `${VEO}-copy-1`, thumbnail: '' })]
    const assignments = [
      {
        league_club_slug: 'lyl',
        recording_slug: 'rec-1',
        away_accepted_recording_uuid: `${VEO}-copy-1`,
        away_assigned_at: '2026-05-31T00:00:00Z', // just now
        status: 'fully_assigned',
      },
    ]
    const { supabase } = makeSupabase(assignments)
    const deleteRecording = vi.fn(async () => {})
    const r = await runContentCleanup(
      {
        leagueClubSlug: 'lyl',
        veoClubSlug: VEO,
        apply: true,
        minAgeMs: 2 * 60 * 60 * 1000,
        now: () => Date.parse('2026-05-31T00:30:00Z'), // 30min later < 2h
      },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording,
          getRecordingContent: makeGetContent(recordings.map((r) => r.slug)),
          getRecordingCamera: async () => null,
        },
      }
    )
    expect(deleteRecording).not.toHaveBeenCalled()
    expect(r.cleaned).toHaveLength(0)
    expect(r.skippedNotEligible).toHaveLength(1)
    expect(r.skippedNotEligible[0].copySlug).toBe(`${VEO}-copy-1`)
  })

  it('orphan copy: skipped under default grace, deletable with minAgeMs=0 override', async () => {
    const recordings = [rec({ slug: `${VEO}-orphan`, thumbnail: '' })]
    const { supabase } = makeSupabase([]) // no assignment → orphan
    const del = vi.fn(async () => {})
    const guarded = await runContentCleanup(
      { leagueClubSlug: 'lyl', veoClubSlug: VEO, apply: true },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording: del,
          getRecordingContent: makeGetContent(recordings.map((r) => r.slug)),
          getRecordingCamera: async () => null,
        },
      }
    )
    expect(del).not.toHaveBeenCalled()
    expect(guarded.skippedNotEligible).toHaveLength(1)

    const override = await runContentCleanup(
      { leagueClubSlug: 'lyl', veoClubSlug: VEO, apply: true, minAgeMs: 0 },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording: del,
          getRecordingContent: makeGetContent(recordings.map((r) => r.slug)),
          getRecordingCamera: async () => null,
        },
      }
    )
    expect(del).toHaveBeenCalledWith(`${VEO}-orphan`)
    expect(override.cleaned).toHaveLength(1)
  })

  it('circuit breaker: aborts the whole sweep when empty copies exceed maxDeletes', async () => {
    const recordings = Array.from({ length: 5 }, (_, i) =>
      rec({ slug: `${VEO}-c${i}`, thumbnail: '' })
    )
    const { supabase } = makeSupabase([])
    const deleteRecording = vi.fn(async () => {})
    const r = await runContentCleanup(
      {
        leagueClubSlug: 'lyl',
        veoClubSlug: VEO,
        apply: true,
        maxDeletes: 3,
        minAgeMs: 0,
      },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording,
          getRecordingContent: makeGetContent(recordings.map((r) => r.slug)),
          getRecordingCamera: async () => null,
        },
      }
    )
    expect(r.abortedTooMany).toBe(true)
    expect(deleteRecording).not.toHaveBeenCalled()
    expect(r.cleaned).toHaveLength(0)
  })

  it('isolates a failed delete: one error does not abort the sweep', async () => {
    const recordings = [
      rec({ slug: `${VEO}-bad`, thumbnail: '' }),
      rec({ slug: `${VEO}-good`, thumbnail: '' }),
    ]
    const { supabase } = makeSupabase([])
    const deleteRecording = vi.fn(async (slug: string) => {
      if (slug === `${VEO}-bad`) throw new Error('Veo 403')
    })
    const r = await runContentCleanup(
      { leagueClubSlug: 'lyl', veoClubSlug: VEO, apply: true, minAgeMs: 0 },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording,
          getRecordingContent: makeGetContent(recordings.map((r) => r.slug)),
          getRecordingCamera: async () => null,
        },
      }
    )
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].copySlug).toBe(`${VEO}-bad`)
    expect(r.cleaned).toHaveLength(1)
    expect(r.cleaned[0].copySlug).toBe(`${VEO}-good`)
  })

  it('respects the wall-clock deadline: stops issuing deletes once exceeded', async () => {
    const recordings = [
      rec({ slug: `${VEO}-1`, thumbnail: '' }),
      rec({ slug: `${VEO}-2`, thumbnail: '' }),
    ]
    const { supabase } = makeSupabase([])
    const deleteRecording = vi.fn(async () => {})
    // Clock jumps past the deadline after the first now() read.
    let t = 0
    const now = () => {
      const v = t
      t += 100 // each call advances 100ms
      return v
    }
    const r = await runContentCleanup(
      {
        leagueClubSlug: 'lyl',
        veoClubSlug: VEO,
        apply: true,
        deadlineMs: 50,
        now,
      },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording,
          getRecordingContent: makeGetContent(recordings.map((r) => r.slug)),
          getRecordingCamera: async () => null,
        },
      }
    )
    // start=0; first iter now()=100 > 50 → both skipped.
    expect(r.skippedDueToDeadline.length).toBeGreaterThan(0)
  })

  it('delete succeeds but reset fails → deletedButNotReset (not failed), not re-armed', async () => {
    const recordings = [rec({ slug: `${VEO}-copy-1`, thumbnail: '' })]
    const assignments = [
      {
        league_club_slug: 'lyl',
        recording_slug: 'rec-1',
        away_accepted_recording_uuid: `${VEO}-copy-1`,
        away_assigned_at: '2026-05-17T00:00:00Z',
        status: 'fully_assigned',
      },
    ]
    const { supabase, resets } = makeSupabase(assignments, /* failReset */ true)
    const deleteRecording = vi.fn(async () => {})
    const r = await runContentCleanup(
      { leagueClubSlug: 'lyl', veoClubSlug: VEO, apply: true, minAgeMs: 0 },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording,
          getRecordingContent: makeGetContent([`${VEO}-copy-1`]),
          getRecordingCamera: async () => null,
        },
      }
    )
    expect(deleteRecording).toHaveBeenCalledTimes(1) // delete DID happen
    expect(r.cleaned).toHaveLength(0)
    expect(r.failed).toHaveLength(0) // NOT lumped into retry-safe failures
    expect(r.deletedButNotReset).toHaveLength(1)
    expect(r.deletedButNotReset[0]).toMatchObject({
      copySlug: `${VEO}-copy-1`,
      originalRecordingSlug: 'rec-1',
    })
    expect(resets).toHaveLength(0) // reset never recorded (it threw)
  })

  it('SAFETY: refuses to delete a slug that reports a camera at the live check', async () => {
    // Even if a content-empty copy slipped through to the delete loop, the
    // live camera guard must stop it — never delete a recording with a camera.
    const recordings = [rec({ slug: `${VEO}-copy-1`, thumbnail: '' })]
    const { supabase } = makeSupabase([])
    const deleteRecording = vi.fn(async () => {})
    const r = await runContentCleanup(
      { leagueClubSlug: 'lyl', veoClubSlug: VEO, apply: true, minAgeMs: 0 },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording,
          getRecordingContent: makeGetContent([`${VEO}-copy-1`]),
          // Live check says this has a camera → it's an original → REFUSE.
          getRecordingCamera: async () => 'cam-uuid-123',
        },
      }
    )
    expect(deleteRecording).not.toHaveBeenCalled()
    expect(r.refusedHasCamera).toEqual([`${VEO}-copy-1`])
    expect(r.cleaned).toHaveLength(0)
  })

  it('SAFETY: refuses to delete when the live camera check ERRORS (fail safe)', async () => {
    const recordings = [rec({ slug: `${VEO}-copy-1`, thumbnail: '' })]
    const { supabase } = makeSupabase([])
    const deleteRecording = vi.fn(async () => {})
    const r = await runContentCleanup(
      { leagueClubSlug: 'lyl', veoClubSlug: VEO, apply: true, minAgeMs: 0 },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording,
          getRecordingContent: makeGetContent([`${VEO}-copy-1`]),
          getRecordingCamera: async () => {
            throw new Error('detail probe 503')
          },
        },
      }
    )
    expect(deleteRecording).not.toHaveBeenCalled()
    expect(r.refusedHasCamera).toEqual([`${VEO}-copy-1`])
  })

  it('fail-safe: a copy whose content probe THROWS is never flagged/deleted', async () => {
    const recordings = [rec({ slug: `${VEO}-flaky`, thumbnail: '' })]
    const { supabase } = makeSupabase([])
    const deleteRecording = vi.fn(async () => {})
    const r = await runContentCleanup(
      { leagueClubSlug: 'lyl', veoClubSlug: VEO, apply: true, minAgeMs: 0 },
      {
        supabase,
        veo: {
          listRecordings: async () => recordings,
          deleteRecording,
          getRecordingCamera: async () => null,
          // Transient Veo error on the probe — must NOT become a delete target.
          getRecordingContent: async () => {
            throw new Error('content probe non-200: videos=503 periods=503')
          },
        },
      }
    )
    expect(r.audit.emptyShareCopies).toHaveLength(0)
    expect(deleteRecording).not.toHaveBeenCalled()
    expect(r.cleaned).toHaveLength(0)
  })
})
