import { describe, it, expect, vi } from 'vitest'
import { auditRecordingContent } from '../audit'
import type { VeoRecording } from '../orchestrator'
import type { AssignmentRow } from '../db'

const VEO = 'london-youth-league'

function rec(p: Partial<VeoRecording> & { slug: string }): VeoRecording {
  return {
    title: p.slug,
    duration: 2700,
    team: null,
    match_date: null,
    // Metadata always reads "ready" — even for broken copies. The audit must
    // NOT rely on these; it probes real content instead.
    processing_status: {},
    thumbnail: 'https://veo.test/t.jpg',
    ...p,
  }
}

function assignment(
  p: Partial<AssignmentRow> & { recording_slug: string }
): AssignmentRow {
  return {
    id: `id-${p.recording_slug}`,
    league_club_slug: 'lyl',
    recording_uuid: `uuid-${p.recording_slug}`,
    recording_title: p.recording_slug,
    match_date: null,
    duration_seconds: 2700,
    parsed_home_subclub_slug: null,
    parsed_away_subclub_slug: null,
    parsed_home_age_group: null,
    parsed_away_age_group: null,
    parse_method: 'rules',
    parse_confidence: null,
    parse_reasoning: null,
    llm_attempted_at: null,
    home_team_uuid: 'home-uuid',
    home_team_slug: 'home-slug',
    home_assigned_at: '2026-05-17T00:00:00Z',
    away_team_uuid: null,
    away_team_slug: null,
    away_assigned_at: null,
    away_share_key: null,
    away_accepted_recording_uuid: null,
    status: 'home_assigned',
    failure_stage: null,
    last_error: null,
    last_processed_at: null,
    last_sync_run_id: null,
    created_at: '2026-05-17T00:00:00Z',
    updated_at: '2026-05-17T00:00:00Z',
    ...p,
  }
}

/** Content checker keyed by slug; defaults to "has footage" for anything
 *  not listed. */
function contentMap(empty: string[] = []) {
  const set = new Set(empty)
  return vi.fn(async (slug: string) =>
    set.has(slug) ? { videos: 0, periods: 0 } : { videos: 3, periods: 2 }
  )
}

describe('auditRecordingContent', () => {
  it('flags a share-copy with NO footage as empty, tied to its original', async () => {
    const copy = `${VEO}-rec-1-copy`
    const recordings = [rec({ slug: 'rec-1' }), rec({ slug: copy })]
    const assignments = [
      assignment({
        recording_slug: 'rec-1',
        status: 'fully_assigned',
        away_accepted_recording_uuid: copy,
      }),
    ]
    const r = await auditRecordingContent(
      recordings,
      VEO,
      assignments,
      contentMap([copy])
    )
    expect(r.emptyShareCopies).toHaveLength(1)
    expect(r.emptyShareCopies[0]).toMatchObject({
      copySlug: copy,
      originalRecordingSlug: 'rec-1',
      videos: 0,
      periods: 0,
    })
  })

  it('does NOT flag a healthy share-copy (has real footage)', async () => {
    const recordings = [rec({ slug: `${VEO}-healthy-copy` })]
    const r = await auditRecordingContent(recordings, VEO, [], contentMap([]))
    expect(r.emptyShareCopies).toHaveLength(0)
  })

  it('does NOT flag originals (non-prefixed slug) even with no footage', async () => {
    const recordings = [rec({ slug: 'rec-1' })]
    const r = await auditRecordingContent(
      recordings,
      VEO,
      [],
      contentMap(['rec-1'])
    )
    expect(r.emptyShareCopies).toHaveLength(0)
  })

  it('NEVER flags a known ORIGINAL whose slug collides with the club prefix', async () => {
    const slug = `${VEO}-original-1`
    const recordings = [rec({ slug })]
    const assignments = [assignment({ recording_slug: slug })]
    const r = await auditRecordingContent(
      recordings,
      VEO,
      assignments,
      contentMap([slug])
    )
    expect(r.emptyShareCopies).toHaveLength(0)
  })

  it('only probes candidate share-copies (bounded cost), not originals', async () => {
    const copy = `${VEO}-c1`
    const recordings = [rec({ slug: 'orig-1' }), rec({ slug: copy })]
    const getContent = contentMap([])
    await auditRecordingContent(recordings, VEO, [], getContent)
    // Probed only the prefixed copy, not the original.
    expect(getContent).toHaveBeenCalledTimes(1)
    expect(getContent).toHaveBeenCalledWith(copy)
  })

  it('does not probe originals unless opted in (emptyOriginals empty by default)', async () => {
    const recordings = [rec({ slug: 'orig-1' }), rec({ slug: 'orig-2' })]
    const getContent = contentMap(['orig-1', 'orig-2'])
    const r = await auditRecordingContent(recordings, VEO, [], getContent)
    expect(r.emptyOriginals).toEqual([])
    expect(getContent).not.toHaveBeenCalled() // no copies, no original probe
  })

  it('flags empty ORIGINALS when probeOriginals is on (report-only)', async () => {
    const recordings = [
      rec({ slug: 'orig-empty' }),
      rec({ slug: 'orig-ok' }),
      rec({ slug: `${VEO}-copy-ok` }),
    ]
    const getContent = contentMap(['orig-empty'])
    const r = await auditRecordingContent(recordings, VEO, [], getContent, {
      probeOriginals: true,
    })
    expect(r.emptyOriginals.map((o) => o.recordingSlug)).toEqual(['orig-empty'])
    // Originals are never delete targets — they only appear in emptyOriginals.
    expect(r.emptyShareCopies).toHaveLength(0)
  })

  it('reports home_assigned rows without a completed away-share as awayPending', async () => {
    const assignments = [
      assignment({ recording_slug: 'rec-1', status: 'home_assigned' }),
      assignment({
        recording_slug: 'rec-2',
        status: 'home_assigned',
        away_accepted_recording_uuid: `${VEO}-rec-2-copy`,
      }),
      assignment({ recording_slug: 'rec-3', status: 'fully_assigned' }),
    ]
    const r = await auditRecordingContent([], VEO, assignments, contentMap([]))
    expect(r.awayPending.map((a) => a.recordingSlug)).toEqual(['rec-1'])
  })
})
