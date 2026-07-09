// Partner revenue-share tiering for footage sales.
//
// Introduced by the PLAYBACK x Li3ib Post-Pilot Amending Annex
// (ref PLB-LI3IB-2026-POST-ANNEX). Replaces the old cost-recovery model with a
// partner (group) share of GROSS:
//   - Tiered groups (a playhub_group_tier_config row exists) get 15% or 5% of
//     gross depending on that month's utilisation, measured PER SPORT across the
//     whole group portfolio and PER DEPLOYED CAMERA:
//       football (Spiideo): 15% if >=2.3 rec/camera/day AND >=345 KWD/camera/month
//       padel (Clutch):     15% if >=1.5 rec/camera/day AND >=135 KWD/camera/month
//     otherwise 5%.
//   - Non-tiered groups (no config row) get a flat 5% share of gross.
//
// This module is the single source of truth for the split so the invoice
// generator, the live billing-summary route, and the email preview cannot drift.

export const TIER_HIGH_PCT = 15
// Low tier == the flat default applied to non-tiered groups.
export const DEFAULT_SHARE_PCT = 5

// Consumer price basis when a billable recording has no explicit price. An
// explicit 0 is a genuinely free recording and must NOT be coerced to this —
// callers use a null/undefined check, never truthiness.
export const DEFAULT_BILLABLE_AMOUNT = 5

// Gross for a recording: explicit price if set (including 0), else the default.
export function grossForRecording(
  billableAmount: number | null | undefined,
  defaultAmount: number = DEFAULT_BILLABLE_AMOUNT
): number {
  return billableAmount == null ? defaultAmount : Number(billableAmount)
}

// Contract thresholds. Fixed by the annex; both conditions must hold (AND) and
// the comparison is inclusive (>=). Revenue thresholds are in KWD.
export const FOOTBALL_THRESHOLDS = {
  recPerCameraPerDay: 2.3,
  kwdPerCameraPerMonth: 345,
} as const
export const PADEL_THRESHOLDS = {
  recPerCameraPerDay: 1.5,
  kwdPerCameraPerMonth: 135,
} as const

export type Sport = 'football' | 'padel'

interface SportDiscriminator {
  spiideo_game_id?: string | null
  clutch_video_id?: string | null
}

// Derive a recording's sport from its provider id. `sport_id` on
// playhub_match_recordings is a dead column (never written), so the provider
// discriminator is the only reliable signal: Spiideo => football, Clutch => padel.
export function classifyRecordingSport(r: SportDiscriminator): Sport {
  const isFootball = r.spiideo_game_id != null
  const isPadel = r.clutch_video_id != null
  if (isFootball && isPadel) {
    throw new Error(
      'Recording has both spiideo_game_id and clutch_video_id — cannot classify sport'
    )
  }
  if (isFootball) return 'football'
  if (isPadel) return 'padel'
  throw new Error(
    'Recording has no sport discriminator (neither spiideo_game_id nor clutch_video_id)'
  )
}

// Non-throwing variant for the money path: returns null instead of throwing when
// a recording carries no (or an ambiguous) provider discriminator. Such a
// recording (e.g. a billable hosted_video / youtube_embed) is not Spiideo/Clutch
// footage, so it falls back to the flat default share rather than aborting the
// whole invoice. Use this in billing; use classifyRecordingSport where a hard
// guarantee is wanted.
export function sportForBilling(r: SportDiscriminator): Sport | null {
  const isFootball = r.spiideo_game_id != null
  const isPadel = r.clutch_video_id != null
  if (isFootball && isPadel) return null
  if (isFootball) return 'football'
  if (isPadel) return 'padel'
  return null
}

// A billing venue may be a group itself or a child venue of a group. The tier is
// always resolved at the group (portfolio) level.
export async function resolveGroupId(
  supabase: any,
  venueId: string
): Promise<string> {
  const { data } = await supabase
    .from('organizations')
    .select('id, type, parent_organization_id')
    .eq('id', venueId)
    .single()

  if (!data) throw new Error(`Organization ${venueId} not found`)
  if (data.type === 'group') return data.id
  if (!data.parent_organization_id) {
    throw new Error(
      `Venue ${venueId} has no parent group — tiered/share billing requires a group`
    )
  }
  return data.parent_organization_id
}

// A group is revenue-tiered iff it has a playhub_group_tier_config row.
export async function isGroupTiered(
  supabase: any,
  groupId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('playhub_group_tier_config')
    .select('group_organization_id')
    .eq('group_organization_id', groupId)
    .maybeSingle()
  return !!data
}

// Compute the partner share % of gross for one (group, month, sport).
// year is the full year; month is 1-based (matches generateMonthlyInvoice).
export async function computeSharePct(
  supabase: any,
  groupId: string,
  year: number,
  month: number,
  sport: Sport
): Promise<number> {
  // Non-tiered group => flat default share, no utilisation math.
  const { data: tierCfg } = await supabase
    .from('playhub_group_tier_config')
    .select('football_camera_count, padel_camera_count')
    .eq('group_organization_id', groupId)
    .maybeSingle()

  if (!tierCfg) return DEFAULT_SHARE_PCT

  const cameraCount =
    sport === 'football'
      ? Number(tierCfg.football_camera_count ?? 0)
      : Number(tierCfg.padel_camera_count ?? 0)

  // Active child venues of the group. Recordings are keyed by organization_id.
  const { data: children } = await supabase
    .from('organizations')
    .select('id')
    .eq('parent_organization_id', groupId)
    .eq('is_active', true)
  const childIds = (children ?? []).map((c: any) => c.id)
  if (childIds.length === 0) return DEFAULT_SHARE_PCT

  // Month window — MUST match generateMonthlyInvoice's UTC boundaries exactly so
  // the tier and the billed line items are computed over the same recordings.
  const periodStart = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(year, month, 0).getDate()
  const periodEnd = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  const periodStartTs = new Date(`${periodStart}T00:00:00Z`).toISOString()
  const periodEndTs = new Date(`${periodEnd}T23:59:59Z`).toISOString()

  // Portfolio recordings for this sport, same billable+published filter as billing.
  const discriminator =
    sport === 'football' ? 'spiideo_game_id' : 'clutch_video_id'
  const { data: recs } = await supabase
    .from('playhub_match_recordings')
    .select('id, billable_amount')
    .in('organization_id', childIds)
    .eq('is_billable', true)
    .eq('status', 'published')
    .not(discriminator, 'is', null)
    .gte('created_at', periodStartTs)
    .lte('created_at', periodEndTs)

  const rows = recs ?? []

  // Camera count unset/zero. If this sport produced revenue but no cameras are
  // configured, utilisation is undefined — fail loud rather than divide by zero
  // or silently pick a tier (either would misallocate money).
  if (cameraCount <= 0) {
    if (rows.length > 0) {
      throw new Error(
        `No ${sport} camera count configured for group ${groupId} but ${rows.length} ${sport} recording(s) exist in ${periodStart}`
      )
    }
    return DEFAULT_SHARE_PCT
  }

  const totalRecordings = rows.length
  // Null price → default (same fallback the invoice uses to bill it), so the
  // utilisation revenue matches the revenue actually invoiced. Explicit 0 stays 0.
  const totalRevenue = rows.reduce(
    (sum: number, r: any) => sum + grossForRecording(r.billable_amount),
    0
  )

  const recPerCameraPerDay = totalRecordings / cameraCount / lastDay
  const revenuePerCameraPerMonth = totalRevenue / cameraCount

  const thresholds =
    sport === 'football' ? FOOTBALL_THRESHOLDS : PADEL_THRESHOLDS
  const hitsBoth =
    recPerCameraPerDay >= thresholds.recPerCameraPerDay &&
    revenuePerCameraPerMonth >= thresholds.kwdPerCameraPerMonth

  return hitsBoth ? TIER_HIGH_PCT : DEFAULT_SHARE_PCT
}
