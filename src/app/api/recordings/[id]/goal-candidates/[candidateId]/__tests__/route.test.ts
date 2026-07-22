import { describe, it, expect, beforeEach, vi } from 'vitest'

// Failure-matrix tests for the multi-goal review route. The stub below
// (panorama-source pattern: chainable in-file supabase stub + vi.mock'd
// auth) additionally RECORDS every resolved query in execution order, so
// the load-bearing ordering invariants are directly assertable:
//   * LINK BEFORE EVENT (a mid-flight failure must leave a discoverable
//     link, never an unfindable public marker)
//   * event deletes BEFORE the status flip (marker never outlives approved)
//   * stamp CAS loss rolls back this request's own event + link
vi.mock('@/lib/supabase/server', () => ({
  getAuthUser: vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/admin/auth', () => ({ isPlatformAdmin: vi.fn() }))
vi.mock('@/lib/tiktok/route-helpers', () => ({ isSameOrigin: vi.fn() }))

import { PATCH } from '../route'
import { getAuthUser, createServiceClient } from '@/lib/supabase/server'
import { isPlatformAdmin } from '@/lib/admin/auth'
import { isSameOrigin } from '@/lib/tiktok/route-helpers'

const mockAuth = getAuthUser as unknown as ReturnType<typeof vi.fn>
const mockService = createServiceClient as unknown as ReturnType<typeof vi.fn>
const mockAdmin = isPlatformAdmin as unknown as ReturnType<typeof vi.fn>
const mockOrigin = isSameOrigin as unknown as ReturnType<typeof vi.fn>

const REC = '00000000-0000-4000-8000-000000000001'
const CAND = '00000000-0000-4000-8000-000000000002'
const EV_A = '00000000-0000-4000-8000-00000000000a'
const EV_B = '00000000-0000-4000-8000-00000000000b'
const EV_C = '00000000-0000-4000-8000-00000000000c'
const ADMIN = '00000000-0000-4000-8000-0000000000ad'

interface LogEntry {
  table: string
  op: string
  payload?: unknown
  filters: { m: string; args: unknown[] }[]
}

/**
 * Sequential scripted supabase stub. Each awaited query (maybeSingle() or a
 * directly-awaited insert/update/upsert/delete chain) consumes the next
 * scripted response IN ORDER and appends a log entry — so tests assert both
 * outcomes and the order the route touched the database in. A dry script
 * throws (drift between the route's query sequence and the test is a test
 * failure, not a silent default).
 */
function scriptedService(script: unknown[]) {
  const log: LogEntry[] = []
  const queue = [...script]
  const next = (entry: LogEntry) => {
    log.push(entry)
    if (queue.length === 0) {
      throw new Error(
        `script exhausted at ${entry.table}.${entry.op} (call #${log.length})`
      )
    }
    return queue.shift()
  }
  const from = (table: string) => {
    const entry: LogEntry = { table, op: 'select', filters: [] }
    const chain: Record<string, unknown> = {}
    const filterMethod =
      (m: string) =>
      (...args: unknown[]) => {
        entry.filters.push({ m, args })
        return chain
      }
    const opMethod =
      (op: string) =>
      (payload?: unknown, ...rest: unknown[]) => {
        entry.op = op
        entry.payload = payload
        void rest
        return chain
      }
    Object.assign(chain, {
      select: opMethod('select'),
      insert: opMethod('insert'),
      upsert: opMethod('upsert'),
      update: opMethod('update'),
      delete: opMethod('delete'),
      eq: filterMethod('eq'),
      in: filterMethod('in'),
      is: filterMethod('is'),
      order: filterMethod('order'),
      limit: filterMethod('limit'),
      maybeSingle: async () => next(entry),
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        try {
          resolve(next(entry))
        } catch (e) {
          reject(e)
        }
      },
    })
    return chain
  }
  return { service: { from }, log, queue }
}

const req = (body: unknown) => ({ json: async () => body }) as never
const params = { params: Promise.resolve({ id: REC, candidateId: CAND }) }

async function run(body: unknown, script: unknown[]) {
  const { service, log, queue } = scriptedService(script)
  mockService.mockReturnValue(service)
  const res = await PATCH(req(body), params)
  // An over-long script would pass vacuously (queries the route never makes)
  // — every test's script must be consumed exactly (API review S3).
  expect(queue.length).toBe(0)
  return { res, log, json: await res.json() }
}

// Script fragments (in the route's resolution order).
const cand = (over: Record<string, unknown> = {}) => ({
  data: {
    id: CAND,
    anchor_s: '1134.0',
    status: 'draft',
    approved_event_id: null,
    ...over,
  },
  error: null,
})
const ok = { error: null }
const count1 = { count: 1, error: null }
const count0 = { count: 0, error: null }
const none = { data: null, error: null }
const gameId = { data: { spiideo_game_id: 'game-1' }, error: null }
const dbErr = { error: { code: 'XX000', message: 'boom' } }

const find = (log: LogEntry[], table: string, op: string, nth = 0) =>
  log.filter((e) => e.table === table && e.op === op)[nth]
const indexOf = (log: LogEntry[], table: string, op: string, nth = 0) => {
  let seen = 0
  for (let i = 0; i < log.length; i++) {
    if (log[i].table === table && log[i].op === op) {
      if (seen === nth) return i
      seen++
    }
  }
  return -1
}
const hasFilter = (e: LogEntry, m: string, ...args: unknown[]) =>
  e.filters.some(
    (f) => f.m === m && JSON.stringify(f.args) === JSON.stringify(args)
  )

beforeEach(() => {
  vi.clearAllMocks()
  mockOrigin.mockReturnValue(true)
  mockAuth.mockResolvedValue({ user: { id: ADMIN } })
  mockAdmin.mockResolvedValue(true)
})

// ---------------------------------------------------------------------------

describe('approve — link-before-event ordering', () => {
  it('writes the link BEFORE the event, with id = provider_event_id = link.event_id', async () => {
    const { res, log, json } = await run({ action: 'approve' }, [
      cand(), // candidate fetch
      count1, // claim CAS
      gameId, // requireGameId
      none, // legacy event lookup
      none, // pending link lookup
      ok, // link insert
      ok, // event insert
      count1, // stamp CAS
    ])
    expect(res.status).toBe(200)

    const linkIdx = indexOf(log, 'playhub_goal_candidate_events', 'insert')
    const eventIdx = indexOf(log, 'playhub_recording_events', 'insert')
    expect(linkIdx).toBeGreaterThan(-1)
    expect(eventIdx).toBeGreaterThan(-1)
    expect(linkIdx).toBeLessThan(eventIdx)

    const link = find(log, 'playhub_goal_candidate_events', 'insert')
      .payload as Record<string, unknown>
    const event = find(log, 'playhub_recording_events', 'insert')
      .payload as Record<string, unknown>
    expect(link.candidate_id).toBe(CAND)
    expect(event.id).toBe(link.event_id)
    expect(event.provider_event_id).toBe(link.event_id)
    expect(event.provider).toBe('spiideo')
    expect(event.source).toBe('ai_detected')
    expect(event.created_by).toBe(ADMIN)
    expect(json.eventId).toBe(link.event_id)
    // default stamp = anchor - 20
    expect(json.timestampSeconds).toBe(1114)
    expect(json.stampSource).toBe('anchor_offset')
    // candidate fetch is IDOR-guarded to the recording in the path
    const candFetch = find(log, 'playhub_goal_candidates', 'select')
    expect(hasFilter(candFetch, 'eq', 'match_recording_id', REC)).toBe(true)
    // claim is a CAS: draft-only, recording-scoped
    const claim = find(log, 'playhub_goal_candidates', 'update', 0)
    expect(hasFilter(claim, 'in', 'status', ['draft'])).toBe(true)
    expect(hasFilter(claim, 'eq', 'match_recording_id', REC)).toBe(true)
    // stamp is a CAS: status-guarded AND null-primary-guarded
    const stamp = find(log, 'playhub_goal_candidates', 'update', 1)
    expect(hasFilter(stamp, 'in', 'status', ['approved'])).toBe(true)
    expect(hasFilter(stamp, 'is', 'approved_event_id', null)).toBe(true)
  })

  it('claim CAS lost (reviewed concurrently): 409, no writes after the claim', async () => {
    const { res, log, json } = await run({ action: 'approve' }, [
      cand(),
      count0, // claim CAS loses
    ])
    expect(res.status).toBe(409)
    expect(json.code).toBe('invalid_state')
    expect(json.details).toEqual({ status: 'unknown' })
    expect(log.length).toBe(2)
  })

  it('fully-approved retry is idempotent: single read, zero writes', async () => {
    const { res, log, json } = await run({ action: 'approve' }, [
      cand({ status: 'approved', approved_event_id: EV_A }),
    ])
    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'approved', eventId: EV_A })
    expect(log.length).toBe(1)
  })

  it('missing game id after the claim: retryable 502 before any event write', async () => {
    const { res, log, json } = await run({ action: 'approve' }, [
      cand(),
      count1, // claim
      none, // requireGameId -> null
    ])
    expect(res.status).toBe(502)
    expect(json.code).toBe('event_write_failed')
    expect(indexOf(log, 'playhub_recording_events', 'insert')).toBe(-1)
    expect(indexOf(log, 'playhub_goal_candidate_events', 'insert')).toBe(-1)
  })

  it('event-insert failure returns retryable 502 and KEEPS the link (no compensation delete)', async () => {
    const { res, log, json } = await run({ action: 'approve' }, [
      cand(),
      count1,
      gameId,
      none,
      none,
      ok, // link insert
      dbErr, // event insert FAILS (possibly ambiguous — committed server-side)
    ])
    expect(res.status).toBe(502)
    expect(json.code).toBe('event_write_failed')
    expect(indexOf(log, 'playhub_goal_candidate_events', 'delete')).toBe(-1)
    expect(indexOf(log, 'playhub_goal_candidates', 'update', 1)).toBe(-1) // no stamp
  })

  it('repair retry adopts the pending link instead of minting a second marker', async () => {
    const { res, log, json } = await run({ action: 'approve' }, [
      cand({ status: 'approved', approved_event_id: null }), // repair state
      // no claim CAS when repairing
      gameId,
      none, // legacy
      {
        data: {
          event_id: EV_A,
          stamp_source: 'anchor_offset',
          stamp_seconds: '1114',
        },
        error: null,
      },
      // event insert hits the unique constraint (our own prior insert) —
      // 23505 must CONVERGE, not fail (route treats it as already-exists)
      { error: { code: '23505', message: 'duplicate key' } },
      count1, // stamp
    ])
    expect(res.status).toBe(200)
    expect(json.eventId).toBe(EV_A)
    expect(indexOf(log, 'playhub_goal_candidate_events', 'insert')).toBe(-1)
    const event = find(log, 'playhub_recording_events', 'insert')
      .payload as Record<string, unknown>
    expect(event.id).toBe(EV_A)
  })

  it('an explicit human stamp restamps a stale anchor-offset pending link', async () => {
    const { res, log, json } = await run(
      { action: 'approve', timestampSeconds: 1333 },
      [
        cand({ status: 'approved', approved_event_id: null }), // repair state
        gameId,
        none, // legacy
        {
          data: {
            event_id: EV_A,
            stamp_source: 'anchor_offset',
            stamp_seconds: '1114',
          },
          error: null,
        },
        ok, // link restamp update
        ok, // event insert
        count1, // stamp
      ]
    )
    expect(res.status).toBe(200)
    expect(json.stampSource).toBe('human_scrub')
    expect(json.timestampSeconds).toBe(1333)
    const restamp = find(log, 'playhub_goal_candidate_events', 'update')
    expect((restamp.payload as Record<string, unknown>).stamp_source).toBe(
      'human_scrub'
    )
    expect((restamp.payload as Record<string, unknown>).stamp_seconds).toBe(
      1333
    )
    const event = find(log, 'playhub_recording_events', 'insert')
      .payload as Record<string, unknown>
    expect(event.timestamp_seconds).toBe(1333)
  })

  it('adopts a legacy event (provider_event_id = candidate id) without inserting a new one', async () => {
    const { res, log, json } = await run({ action: 'approve' }, [
      cand({ status: 'approved', approved_event_id: null }),
      gameId,
      { data: { id: EV_A, timestamp_seconds: '968.00' }, error: null }, // legacy
      ok, // link upsert
      count1, // stamp
    ])
    expect(res.status).toBe(200)
    expect(json.eventId).toBe(EV_A)
    expect(indexOf(log, 'playhub_recording_events', 'insert')).toBe(-1)
    expect(
      indexOf(log, 'playhub_goal_candidate_events', 'upsert')
    ).toBeGreaterThan(-1)
    // The adoption lookup is fully scoped (security L1: a stray spiideo
    // event from ANOTHER recording must never be adopted — the unapprove
    // delete is recording-scoped and could then never remove it).
    const legacySel = find(log, 'playhub_recording_events', 'select')
    expect(hasFilter(legacySel, 'eq', 'provider', 'spiideo')).toBe(true)
    expect(hasFilter(legacySel, 'eq', 'provider_event_id', CAND)).toBe(true)
    expect(hasFilter(legacySel, 'eq', 'match_recording_id', REC)).toBe(true)
    expect(hasFilter(legacySel, 'eq', 'source', 'ai_detected')).toBe(true)
  })
})

describe('approve — CAS race on the primary stamp', () => {
  const raceScript = (afterState: unknown, rest: unknown[] = []) => [
    cand(),
    count1, // claim
    gameId,
    none, // legacy
    none, // pending
    ok, // link insert
    ok, // event insert
    count0, // stamp CAS LOST
    afterState, // re-read
    ...rest,
  ]

  it('unapprove interleaved (row now draft): rolls back own event then link, 409s', async () => {
    const { res, log, json } = await run(
      { action: 'approve' },
      raceScript(
        { data: { status: 'draft', approved_event_id: null }, error: null },
        [
          ok, // rollback event delete
          ok, // rollback link delete
        ]
      )
    )
    expect(res.status).toBe(409)
    expect(json.code).toBe('invalid_state')
    expect(json.details).toEqual({ status: 'draft' })

    const link = find(log, 'playhub_goal_candidate_events', 'insert')
      .payload as Record<string, unknown>
    const evDel = find(log, 'playhub_recording_events', 'delete')
    const linkDel = find(log, 'playhub_goal_candidate_events', 'delete')
    expect(evDel).toBeDefined()
    expect(linkDel).toBeDefined()
    // rolls back OUR event only, with the own-AI-event guards
    expect(hasFilter(evDel, 'eq', 'id', link.event_id)).toBe(true)
    expect(hasFilter(evDel, 'eq', 'provider', 'spiideo')).toBe(true)
    expect(hasFilter(evDel, 'eq', 'source', 'ai_detected')).toBe(true)
    expect(hasFilter(evDel, 'eq', 'match_recording_id', REC)).toBe(true)
    // ...and OUR link only (a wider delete would strand SIBLING markers
    // as unlinked public events)
    expect(hasFilter(linkDel, 'eq', 'candidate_id', CAND)).toBe(true)
    expect(hasFilter(linkDel, 'eq', 'event_id', link.event_id)).toBe(true)
    // event delete precedes link delete (never an unlinked public marker)
    expect(indexOf(log, 'playhub_recording_events', 'delete')).toBeLessThan(
      indexOf(log, 'playhub_goal_candidate_events', 'delete')
    )
  })

  it('rollback event-delete failure: the link is KEPT as the discovery breadcrumb', async () => {
    const { res, log, json } = await run(
      { action: 'approve' },
      raceScript(
        { data: { status: 'draft', approved_event_id: null }, error: null },
        [
          dbErr, // rollback event delete FAILS
          // no link delete scripted — the route must skip it
        ]
      )
    )
    expect(res.status).toBe(409)
    expect(json.code).toBe('invalid_state')
    expect(indexOf(log, 'playhub_goal_candidate_events', 'delete')).toBe(-1)
  })

  it('repair race with a different winner: rolls back own mint and converges on the winner', async () => {
    const { res, log, json } = await run(
      { action: 'approve' },
      raceScript(
        { data: { status: 'approved', approved_event_id: EV_B }, error: null },
        [
          ok, // rollback event delete
          ok, // rollback link delete
        ]
      )
    )
    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'approved', eventId: EV_B })
    expect(indexOf(log, 'playhub_recording_events', 'delete')).toBeGreaterThan(
      -1
    )
  })

  it('same-event winner: converges with NO rollback', async () => {
    // The re-read reports our own event id as primary (a concurrent retry
    // stamped the same adopted event).
    const { res, log, json } = await run({ action: 'approve' }, [
      cand({ status: 'approved', approved_event_id: null }),
      gameId,
      none, // legacy
      {
        data: {
          event_id: EV_A,
          stamp_source: 'human_scrub',
          stamp_seconds: '1333',
        },
        error: null,
      },
      ok, // event insert
      count0, // stamp CAS lost
      { data: { status: 'approved', approved_event_id: EV_A }, error: null },
    ])
    expect(res.status).toBe(200)
    expect(json.eventId).toBe(EV_A)
    expect(indexOf(log, 'playhub_recording_events', 'delete')).toBe(-1)
    expect(indexOf(log, 'playhub_goal_candidate_events', 'delete')).toBe(-1)
  })
})

describe('add_goal', () => {
  it('append while approved: link before event, human stamp echoed back', async () => {
    const { res, log, json } = await run(
      { action: 'add_goal', timestampSeconds: 1333 },
      [
        cand({ status: 'approved', approved_event_id: EV_A }),
        gameId,
        none, // same-ts dedupe lookup: miss
        ok, // link insert
        ok, // event insert
      ]
    )
    expect(res.status).toBe(200)
    expect(json.stampSource).toBe('human_scrub')
    expect(json.timestampSeconds).toBe(1333)
    expect(
      indexOf(log, 'playhub_goal_candidate_events', 'insert')
    ).toBeLessThan(indexOf(log, 'playhub_recording_events', 'insert'))
    const event = find(log, 'playhub_recording_events', 'insert')
      .payload as Record<string, unknown>
    expect(event.timestamp_seconds).toBe(1333)
    // append never touches the candidate row
    expect(indexOf(log, 'playhub_goal_candidates', 'update')).toBe(-1)
  })

  it('append event-insert failure: 502 goal_add_failed and the link SURVIVES', async () => {
    const { res, log, json } = await run(
      { action: 'add_goal', timestampSeconds: 1333 },
      [
        cand({ status: 'approved', approved_event_id: EV_A }),
        gameId,
        none, // same-ts dedupe lookup: miss
        ok, // link insert
        dbErr, // event insert fails (ambiguous)
      ]
    )
    expect(res.status).toBe(502)
    expect(json.code).toBe('goal_add_failed')
    expect(indexOf(log, 'playhub_goal_candidate_events', 'delete')).toBe(-1)
  })

  it('same-timestamp append CONVERGES: adopts the existing link, re-ensures its event, inserts nothing new', async () => {
    // stale-tab chip click / retry after goal_add_failed: the identical-ts
    // link exists — no duplicate marker; the event insert is the idempotent
    // ensure that completes a link-without-marker repair state.
    const { res, log, json } = await run(
      { action: 'add_goal', timestampSeconds: 1333, estimate: true },
      [
        cand({ status: 'approved', approved_event_id: EV_A }),
        gameId,
        {
          data: { event_id: EV_B, stamp_source: 'anchor_offset' },
          error: null,
        }, // same-ts dedupe lookup: HIT
        ok, // ensureGoalEvent (23505 or fresh — both achieved)
      ]
    )
    expect(res.status).toBe(200)
    expect(json.eventId).toBe(EV_B)
    expect(json.stampSource).toBe('anchor_offset')
    expect(indexOf(log, 'playhub_goal_candidate_events', 'insert')).toBe(-1)
    const event = find(log, 'playhub_recording_events', 'insert')
      .payload as Record<string, unknown>
    expect(event.id).toBe(EV_B)
  })

  it('a genuine scrub at the exact second of a chip estimate upgrades the link to human_scrub', async () => {
    const { res, log, json } = await run(
      { action: 'add_goal', timestampSeconds: 1333 }, // no estimate = human
      [
        cand({ status: 'approved', approved_event_id: EV_A }),
        gameId,
        {
          data: { event_id: EV_B, stamp_source: 'anchor_offset' },
          error: null,
        }, // same-ts dedupe lookup: HIT on a prior chip estimate
        ok, // provenance upgrade update
        ok, // ensureGoalEvent
      ]
    )
    expect(res.status).toBe(200)
    expect(json.eventId).toBe(EV_B)
    expect(json.stampSource).toBe('human_scrub')
    const upgrade = find(log, 'playhub_goal_candidate_events', 'update')
      .payload as Record<string, unknown>
    expect(upgrade.stamp_source).toBe('human_scrub')
    expect(indexOf(log, 'playhub_goal_candidate_events', 'insert')).toBe(-1)
  })

  it('hint-chip append (estimate: true) records the link as anchor_offset', async () => {
    const { res, log, json } = await run(
      { action: 'add_goal', timestampSeconds: 1114, estimate: true },
      [
        cand({ status: 'approved', approved_event_id: EV_A }),
        gameId,
        none, // same-ts dedupe lookup: miss
        ok, // link insert
        ok, // event insert
      ]
    )
    expect(res.status).toBe(200)
    expect(json.stampSource).toBe('anchor_offset')
    const link = find(log, 'playhub_goal_candidate_events', 'insert')
      .payload as Record<string, unknown>
    expect(link.stamp_source).toBe('anchor_offset')
    expect(link.stamp_seconds).toBe(1114)
  })

  it('estimate restamp of a pending default stays anchor_offset — a later human scrub can still supersede it', async () => {
    const { res, log, json } = await run(
      { action: 'add_goal', timestampSeconds: 1351, estimate: true },
      [
        cand(), // draft
        count1, // claim
        gameId,
        none, // legacy
        {
          data: {
            event_id: EV_B,
            stamp_source: 'anchor_offset',
            stamp_seconds: '1114',
          },
          error: null,
        }, // pending link from a prior attempt (default estimate)
        ok, // restamp update
        ok, // event
        count1, // stamp
      ]
    )
    expect(res.status).toBe(200)
    expect(json.stampSource).toBe('anchor_offset')
    expect(json.timestampSeconds).toBe(1351)
    const restamp = find(log, 'playhub_goal_candidate_events', 'update')
      .payload as Record<string, unknown>
    expect(restamp.stamp_source).toBe('anchor_offset')
    expect(restamp.stamp_seconds).toBe(1351)
  })

  it('from draft it takes the approve path (claims + stamps)', async () => {
    const { res, log, json } = await run(
      { action: 'add_goal', timestampSeconds: 1333 },
      [
        cand(), // draft
        count1, // claim
        gameId,
        none, // legacy
        none, // pending
        ok, // link
        ok, // event
        count1, // stamp
      ]
    )
    expect(res.status).toBe(200)
    expect(json.status).toBe('approved')
    expect(json.timestampSeconds).toBe(1333)
    expect(json.stampSource).toBe('human_scrub')
    expect(
      indexOf(log, 'playhub_goal_candidates', 'update', 1)
    ).toBeGreaterThan(-1)
  })

  it('requires a timestamp', async () => {
    const { res } = await run({ action: 'add_goal' }, [])
    expect(res.status).toBe(400)
  })
})

describe('remove_event', () => {
  const links3 = {
    data: [
      { event_id: EV_A, created_at: '2026-07-22T10:00:00Z' },
      { event_id: EV_B, created_at: '2026-07-22T10:01:00Z' },
      { event_id: EV_C, created_at: '2026-07-22T10:02:00Z' },
    ],
    error: null,
  }

  it('sibling removal: delete event -> (no repoint needed) -> drop link; approved stays', async () => {
    const { res, log, json } = await run(
      { action: 'remove_event', eventId: EV_B },
      [
        cand({ status: 'approved', approved_event_id: EV_A }),
        links3,
        ok, // event delete
        ok, // link delete (primary EV_A survives -> no repoint)
      ]
    )
    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'approved', removedEventId: EV_B })
    const evDel = find(log, 'playhub_recording_events', 'delete')
    expect(hasFilter(evDel, 'eq', 'id', EV_B)).toBe(true)
    expect(hasFilter(evDel, 'eq', 'provider', 'spiideo')).toBe(true)
    expect(hasFilter(evDel, 'eq', 'source', 'ai_detected')).toBe(true)
    expect(hasFilter(evDel, 'eq', 'match_recording_id', REC)).toBe(true)
    expect(indexOf(log, 'playhub_recording_events', 'delete')).toBeLessThan(
      indexOf(log, 'playhub_goal_candidate_events', 'delete')
    )
    expect(indexOf(log, 'playhub_goal_candidates', 'update')).toBe(-1)
  })

  it('removing the PRIMARY repoints to the earliest remaining link before dropping the link', async () => {
    const { res, log } = await run({ action: 'remove_event', eventId: EV_A }, [
      cand({ status: 'approved', approved_event_id: EV_A }),
      links3,
      ok, // event delete
      count1, // repoint update
      ok, // link delete
    ])
    expect(res.status).toBe(200)
    const repoint = find(log, 'playhub_goal_candidates', 'update')
    expect((repoint.payload as Record<string, unknown>).approved_event_id).toBe(
      EV_B
    )
    // delete event -> repoint -> drop link (a failure at any step converges)
    expect(indexOf(log, 'playhub_recording_events', 'delete')).toBeLessThan(
      indexOf(log, 'playhub_goal_candidates', 'update')
    )
    expect(indexOf(log, 'playhub_goal_candidates', 'update')).toBeLessThan(
      indexOf(log, 'playhub_goal_candidate_events', 'delete')
    )
  })

  it('removing the LAST marker takes unapprove semantics and flips to draft', async () => {
    const { res, log, json } = await run(
      { action: 'remove_event', eventId: EV_A },
      [
        cand({ status: 'approved', approved_event_id: EV_A }),
        {
          data: [{ event_id: EV_A, created_at: '2026-07-22T10:00:00Z' }],
          error: null,
        },
        // fall-through to the unapprove block:
        cand({ status: 'approved', approved_event_id: EV_A }), // re-fetch
        { data: [{ event_id: EV_A }], error: null }, // links
        ok, // linked events delete
        ok, // legacy pair delete
        ok, // links delete
        count1, // flip to draft
      ]
    )
    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'draft', removedEventId: EV_A })
    // event deletes strictly before the flip
    const flipIdx = indexOf(log, 'playhub_goal_candidates', 'update')
    expect(indexOf(log, 'playhub_recording_events', 'delete', 0)).toBeLessThan(
      flipIdx
    )
    expect(indexOf(log, 'playhub_recording_events', 'delete', 1)).toBeLessThan(
      flipIdx
    )
  })

  it('retry after the marker is already gone returns the achieved state, not an error', async () => {
    const { res, log, json } = await run(
      { action: 'remove_event', eventId: EV_B },
      [
        cand({ status: 'approved', approved_event_id: EV_A }),
        {
          data: [{ event_id: EV_A, created_at: '2026-07-22T10:00:00Z' }],
          error: null,
        },
      ]
    )
    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'approved', removedEventId: EV_B })
    expect(indexOf(log, 'playhub_recording_events', 'delete')).toBe(-1)
  })
})

describe('unapprove — no stranded public markers', () => {
  it('deletes ALL linked events (and the legacy pair) BEFORE clearing links and flipping', async () => {
    const { res, log, json } = await run({ action: 'unapprove' }, [
      cand({ status: 'approved', approved_event_id: EV_A }),
      {
        data: [{ event_id: EV_A }, { event_id: EV_B }, { event_id: EV_C }],
        error: null,
      },
      ok, // linked events delete
      ok, // legacy pair delete
      ok, // links delete
      count1, // flip
    ])
    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'draft' })

    const evDel = find(log, 'playhub_recording_events', 'delete', 0)
    expect(hasFilter(evDel, 'in', 'id', [EV_A, EV_B, EV_C])).toBe(true)
    expect(hasFilter(evDel, 'eq', 'provider', 'spiideo')).toBe(true)
    expect(hasFilter(evDel, 'eq', 'source', 'ai_detected')).toBe(true)
    expect(hasFilter(evDel, 'eq', 'match_recording_id', REC)).toBe(true)
    // The legacy-pair delete is the BROADEST delete in the route (no id
    // list) — every own-AI-event guard must be pinned on it (security H1).
    const legacyDel = find(log, 'playhub_recording_events', 'delete', 1)
    expect(hasFilter(legacyDel, 'eq', 'provider_event_id', CAND)).toBe(true)
    expect(hasFilter(legacyDel, 'eq', 'provider', 'spiideo')).toBe(true)
    expect(hasFilter(legacyDel, 'eq', 'source', 'ai_detected')).toBe(true)
    expect(hasFilter(legacyDel, 'eq', 'match_recording_id', REC)).toBe(true)

    const flipIdx = indexOf(log, 'playhub_goal_candidates', 'update')
    expect(indexOf(log, 'playhub_recording_events', 'delete', 0)).toBeLessThan(
      flipIdx
    )
    expect(indexOf(log, 'playhub_recording_events', 'delete', 1)).toBeLessThan(
      flipIdx
    )
    expect(
      indexOf(log, 'playhub_goal_candidate_events', 'delete')
    ).toBeLessThan(flipIdx)
    const flip = find(log, 'playhub_goal_candidates', 'update')
    expect((flip.payload as Record<string, unknown>).status).toBe('draft')
    expect(
      (flip.payload as Record<string, unknown>).approved_event_id
    ).toBeNull()
    // flip is a CAS: approved-only, recording-scoped
    expect(hasFilter(flip, 'in', 'status', ['approved'])).toBe(true)
    expect(hasFilter(flip, 'eq', 'match_recording_id', REC)).toBe(true)
  })

  it('event-delete failure: 502, candidate stays approved, links preserved (discoverability)', async () => {
    const { res, log, json } = await run({ action: 'unapprove' }, [
      cand({ status: 'approved', approved_event_id: EV_A }),
      { data: [{ event_id: EV_A }], error: null },
      dbErr, // linked events delete FAILS
    ])
    expect(res.status).toBe(502)
    expect(json.code).toBe('event_delete_failed')
    expect(indexOf(log, 'playhub_goal_candidates', 'update')).toBe(-1) // no flip
    expect(indexOf(log, 'playhub_goal_candidate_events', 'delete')).toBe(-1)
  })

  it('idempotent from draft', async () => {
    const { res, json } = await run({ action: 'unapprove' }, [cand()])
    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'draft' })
  })
})

describe('reject / restore', () => {
  it('reject happy path: single CAS from draft', async () => {
    const { res, log, json } = await run({ action: 'reject' }, [count1])
    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'rejected' })
    const cas = find(log, 'playhub_goal_candidates', 'update')
    expect(hasFilter(cas, 'in', 'status', ['draft'])).toBe(true)
    expect(hasFilter(cas, 'eq', 'match_recording_id', REC)).toBe(true)
  })

  it('reject retry that finds the target state is idempotent', async () => {
    const { res, json } = await run({ action: 'reject' }, [
      count0, // CAS misses
      { data: { status: 'rejected' }, error: null }, // already there
    ])
    expect(res.status).toBe(200)
    expect(json).toEqual({ status: 'rejected' })
  })

  it('reject on an approved candidate: 409 naming the actual state', async () => {
    const { res, json } = await run({ action: 'reject' }, [
      count0,
      { data: { status: 'approved' }, error: null },
    ])
    expect(res.status).toBe(409)
    expect(json.code).toBe('invalid_state')
    expect(json.details).toEqual({ status: 'approved' })
  })
})

describe('gates', () => {
  it('403 for non-admins before any DB write', async () => {
    mockAdmin.mockResolvedValue(false)
    const { res, log } = await run({ action: 'approve' }, [])
    expect(res.status).toBe(403)
    expect(log.length).toBe(0)
  })

  it('403 cross-origin before any DB access', async () => {
    mockOrigin.mockReturnValue(false)
    const { res, log } = await run({ action: 'approve' }, [])
    expect(res.status).toBe(403)
    expect(log.length).toBe(0)
  })

  it('401 unauthenticated', async () => {
    mockAuth.mockResolvedValue({ user: null })
    const { res, log } = await run({ action: 'approve' }, [])
    expect(res.status).toBe(401)
    expect(log.length).toBe(0)
  })

  it('400 on a non-UUID candidate id', async () => {
    const { service, log } = scriptedService([])
    mockService.mockReturnValue(service)
    const res = await PATCH(req({ action: 'approve' }), {
      params: Promise.resolve({ id: REC, candidateId: 'nope' }),
    })
    expect(res.status).toBe(400)
    expect(log.length).toBe(0)
  })

  it('400 on an unknown action', async () => {
    const { res } = await run({ action: 'delete_all' }, [])
    expect(res.status).toBe(400)
  })
})
