import { describe, it, expect } from 'vitest'
import {
  mapVeoHighlightToEvent,
  mapVeoHighlightsToEvents,
  type VeoHighlightForMapping,
} from '../veo-events-mapper'

const VEO_SLUG = '20250522-aws-2-04a32970'

function goalHighlight(
  overrides: Partial<VeoHighlightForMapping> = {}
): VeoHighlightForMapping {
  return {
    id: 'hl-goal-1',
    start: 1234,
    tags: [{ slug: 'goal', name: 'Goal', custom: false, origin: '1' }],
    team_association: 'own',
    is_ai_generated: true,
    ...overrides,
  }
}

describe('mapVeoHighlightToEvent', () => {
  it('maps a goal-tagged highlight to an InsertRecordingEvent keyed by (provider, provider_recording_id)', () => {
    const event = mapVeoHighlightToEvent(goalHighlight(), VEO_SLUG)

    expect(event).toEqual({
      match_recording_id: null,
      provider: 'veo',
      provider_recording_id: VEO_SLUG,
      event_type: 'goal',
      timestamp_seconds: 1234,
      team: null,
      label: null,
      visibility: 'private',
      source: 'ai_detected',
      confidence_score: 1.0,
      created_by: null,
      provider_event_id: 'hl-goal-1',
    })
  })

  it('passes the Veo highlight id through as provider_event_id for dedup', () => {
    const event = mapVeoHighlightToEvent(
      goalHighlight({ id: 'bfcef9b4-3659-4555-bdc1-d079fae4c29e' }),
      VEO_SLUG
    )
    expect(event?.provider_event_id).toBe(
      'bfcef9b4-3659-4555-bdc1-d079fae4c29e'
    )
  })

  it('returns null when tags do not include goal', () => {
    const hl = goalHighlight({
      tags: [{ slug: 'shot-on-goal', name: 'Shot on goal', origin: '9' }],
    })
    expect(mapVeoHighlightToEvent(hl, VEO_SLUG)).toBeNull()
  })

  it('returns null for empty tags', () => {
    expect(
      mapVeoHighlightToEvent(goalHighlight({ tags: [] }), VEO_SLUG)
    ).toBeNull()
  })

  it('accepts a goal tag even when other non-goal tags are present', () => {
    const hl = goalHighlight({
      tags: [
        { slug: 'shot-on-goal', name: 'Shot on goal', origin: '9' },
        { slug: 'goal', name: 'Goal', origin: '1' },
        { slug: 'celebration', name: 'Celebration', custom: true },
      ],
    })
    const event = mapVeoHighlightToEvent(hl, VEO_SLUG)
    expect(event?.event_type).toBe('goal')
  })

  it('stores team=null regardless of team_association — own/opponent does not map to home/away', () => {
    const ownEvent = mapVeoHighlightToEvent(
      goalHighlight({ team_association: 'own' }),
      VEO_SLUG
    )
    const opponentEvent = mapVeoHighlightToEvent(
      goalHighlight({ team_association: 'opponent' }),
      VEO_SLUG
    )
    const nullEvent = mapVeoHighlightToEvent(
      goalHighlight({ team_association: null }),
      VEO_SLUG
    )
    expect(ownEvent?.team).toBeNull()
    expect(opponentEvent?.team).toBeNull()
    expect(nullEvent?.team).toBeNull()
  })

  it('always sets match_recording_id=null (Veo recordings are not in the marketplace table)', () => {
    const event = mapVeoHighlightToEvent(goalHighlight(), VEO_SLUG)
    expect(event?.match_recording_id).toBeNull()
    expect(event?.provider).toBe('veo')
    expect(event?.provider_recording_id).toBe(VEO_SLUG)
  })

  it('returns null for malformed input', () => {
    expect(
      mapVeoHighlightToEvent(
        { id: '', start: 0, tags: [{ slug: 'goal' }] },
        VEO_SLUG
      )
    ).toBeNull()
    expect(
      mapVeoHighlightToEvent(
        // @ts-expect-error -- testing runtime guard
        { id: 'x', tags: [{ slug: 'goal' }] },
        VEO_SLUG
      )
    ).toBeNull()
    expect(
      mapVeoHighlightToEvent(
        // @ts-expect-error -- testing runtime guard
        { id: 'x', start: 0, tags: 'not-an-array' },
        VEO_SLUG
      )
    ).toBeNull()
  })

  it('sets source=ai_detected and visibility=private (secure default — Phase 1b surfaces via access-checked API)', () => {
    const event = mapVeoHighlightToEvent(goalHighlight(), VEO_SLUG)
    expect(event?.source).toBe('ai_detected')
    expect(event?.visibility).toBe('private')
  })

  it('sets created_by to null (provider events have no human author)', () => {
    const event = mapVeoHighlightToEvent(goalHighlight(), VEO_SLUG)
    expect(event?.created_by).toBeNull()
  })

  it('returns null when veoMatchSlug is empty', () => {
    expect(mapVeoHighlightToEvent(goalHighlight(), '')).toBeNull()
  })

  it('preserves a 0-second timestamp', () => {
    const event = mapVeoHighlightToEvent(goalHighlight({ start: 0 }), VEO_SLUG)
    expect(event?.timestamp_seconds).toBe(0)
  })
})

describe('mapVeoHighlightsToEvents', () => {
  it('filters out non-goal highlights and returns only mapped events', () => {
    const highlights: VeoHighlightForMapping[] = [
      goalHighlight({ id: 'g1', start: 100 }),
      {
        id: 'shot-1',
        start: 200,
        tags: [{ slug: 'shot-on-goal', origin: '9' }],
      },
      goalHighlight({ id: 'g2', start: 300 }),
      { id: 'corner-1', start: 400, tags: [{ slug: 'corner', origin: '4' }] },
    ]
    const events = mapVeoHighlightsToEvents(highlights, VEO_SLUG)
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.provider_event_id)).toEqual(['g1', 'g2'])
    expect(events.every((e) => e.provider === 'veo')).toBe(true)
    expect(events.every((e) => e.provider_recording_id === VEO_SLUG)).toBe(true)
  })

  it('returns [] for empty input', () => {
    expect(mapVeoHighlightsToEvents([], VEO_SLUG)).toEqual([])
  })

  it('returns [] for non-array input', () => {
    // @ts-expect-error -- testing runtime guard
    expect(mapVeoHighlightsToEvents(null, VEO_SLUG)).toEqual([])
    // @ts-expect-error -- testing runtime guard
    expect(mapVeoHighlightsToEvents(undefined, VEO_SLUG)).toEqual([])
  })
})
