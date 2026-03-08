# Organization Hierarchy & Multi-Tenancy Plan

## Problem

All organizations are treated equally today. In reality, there are different relationship types:

1. **Ownership**: Li3ib owns Nazwa Fields. Li3ib admins should see all Nazwa data. Revenue rolls up.
2. **Tenancy**: DAFL uses The Sevens venue for matches. DAFL's recordings at The Sevens belong to DAFL, not The Sevens. The Sevens can't see DAFL's recordings unless DAFL explicitly grants access.

## Current State

### Organization Types (in DB)
| Org | Type | Parent | Notes |
|-----|------|--------|-------|
| Nazwa | venue | null | Should be child of Li3ib |
| CFA | academy | null | Independent |
| SEFA | academy | null | Independent |
| DAFL | league | null | Uses external venues (The Sevens, Jebel Ali) |

### Key DB Facts
- `organizations.parent_organization_id` **already exists** as a column with self-referencing FK — just unused
- `playhub_match_recordings.organization_id` = the org that owns the recording (currently always the venue)
- `playhub_match_recordings.venue` = free-text venue name (not an FK)
- No concept of "which orgs can record at which venues"
- `isVenueAdmin()` checks `organization_members` for `club_admin`/`league_admin` role
- Recordings on the venue page are filtered by `organization_id = venueId`
- Billing is per-venue (`playhub_venue_billing_config.organization_id`)

## Proposed Model

### Organization Types
| Type | Example | Description |
|------|---------|-------------|
| `group` | Li3ib, Powerleague | Contract holder / parent company |
| `venue` | Nazwa, Powerleague Shoreditch, The Sevens | Physical location with cameras |
| `league` | DAFL | League that uses venues they don't own |
| `academy` | CFA, SEFA | Academy (may or may not own venues) |

### Relationship 1: Ownership (`parent_organization_id`)

```
Li3ib (group)
  └── Nazwa (venue)      -- parent_organization_id = Li3ib.id
  └── Future Venue X     -- parent_organization_id = Li3ib.id

Powerleague (group)
  └── PL Shoreditch (venue)
  └── PL Wandsworth (venue)
```

**Rules:**
- Parent org admins automatically have admin access to all child orgs
- Revenue from child orgs rolls up to parent dashboard
- Feature flags on the parent cascade to children (unless overridden)
- Child orgs still have their own admins who can manage day-to-day ops
- Recordings created at a child venue belong to the child venue

### Relationship 2: Tenancy (`organization_venue_access`)

New table for "org X can use venue Y":

```sql
CREATE TABLE organization_venue_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  venue_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Permissions
  can_record BOOLEAN DEFAULT true,
  can_stream BOOLEAN DEFAULT false,

  -- Defaults for recordings made by this org at this venue
  default_graphic_package_id UUID REFERENCES playhub_graphic_packages(id),

  -- Metadata
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE(organization_id, venue_organization_id)
);

CREATE INDEX idx_org_venue_access_org ON organization_venue_access(organization_id);
CREATE INDEX idx_org_venue_access_venue ON organization_venue_access(venue_organization_id);
```

**Example data:**
| organization_id | venue_organization_id | can_record | can_stream | default_graphic_package_id |
|---|---|---|---|---|
| DAFL | The Sevens | true | false | DAFL's graphics package |
| DAFL | Jebel Ali | true | true | DAFL's graphics package |

**Rules:**
- DAFL admins can start recordings at The Sevens
- Those recordings have `organization_id = DAFL` (belong to DAFL)
- Those recordings have `venue_organization_id = The Sevens` (location metadata)
- The Sevens admins CANNOT see DAFL's recordings
- DAFL can grant access to specific Sevens admins via existing `playhub_access_rights`
- DAFL's graphic package is auto-applied to recordings at these venues

### Recording Ownership Change

Currently `playhub_match_recordings` has:
- `organization_id` = the venue (owner)
- `venue` = free text

**New model:**
- `organization_id` = the org that OWNS/INITIATED the recording (could be DAFL, could be Nazwa)
- Add `venue_organization_id` = the physical venue where it was recorded (FK to organizations)

```sql
ALTER TABLE playhub_match_recordings
  ADD COLUMN venue_organization_id UUID REFERENCES organizations(id);

-- Backfill: for existing recordings, venue_organization_id = organization_id
UPDATE playhub_match_recordings
  SET venue_organization_id = organization_id
  WHERE venue_organization_id IS NULL;
```

This means:
- When Nazwa schedules a recording → `organization_id = Nazwa`, `venue_organization_id = Nazwa`
- When DAFL schedules at The Sevens → `organization_id = DAFL`, `venue_organization_id = The Sevens`
- Venue page filters by `venue_organization_id` OR `organization_id` (depending on context)
- Org dashboard filters by `organization_id` (shows recordings they own)

## Access Control Changes

### `isVenueAdmin()` — Update to support parent orgs

```typescript
export async function isVenueAdmin(userId: string, organizationId: string): Promise<boolean> {
  // ... existing profile lookup ...

  // Check direct membership (existing)
  const { data: directMembership } = await supabase
    .from('organization_members')
    .select('role')
    .eq('profile_id', profile.id)
    .eq('organization_id', organizationId)
    .eq('is_active', true)
    .single()

  if (directMembership && ['club_admin', 'league_admin'].includes(directMembership.role)) {
    return true
  }

  // NEW: Check if user is admin of parent org
  const { data: org } = await supabase
    .from('organizations')
    .select('parent_organization_id')
    .eq('id', organizationId)
    .single()

  if (org?.parent_organization_id) {
    const { data: parentMembership } = await supabase
      .from('organization_members')
      .select('role')
      .eq('profile_id', profile.id)
      .eq('organization_id', org.parent_organization_id)
      .eq('is_active', true)
      .single()

    if (parentMembership && ['club_admin', 'league_admin'].includes(parentMembership.role)) {
      return true
    }
  }

  return false
}
```

### Venue page recording visibility

When viewing a venue page (e.g., Nazwa):
- Show recordings where `organization_id = venueId` (Nazwa's own recordings)
- Do NOT show recordings where `venue_organization_id = venueId` but `organization_id != venueId` (DAFL's recordings at Nazwa)

When viewing an org dashboard (e.g., DAFL):
- Show recordings where `organization_id = DAFL` (across all venues)

When viewing a parent dashboard (e.g., Li3ib):
- Show recordings where `organization_id IN (Li3ib, Nazwa, other children)`

### Scheduling recordings at a tenant venue

When DAFL wants to schedule a recording at The Sevens:
1. Check `organization_venue_access` for DAFL → The Sevens with `can_record = true`
2. Use The Sevens' Spiideo scenes (camera infrastructure belongs to the venue)
3. Create recording with `organization_id = DAFL`, `venue_organization_id = The Sevens`
4. Auto-apply DAFL's `default_graphic_package_id` from the access row

## Implementation Plan

### Phase 0: DB cleanup (before hierarchy) — COMPLETED 2026-03-08
- [x] Create `is_org_member()` DB function to centralize admin checks across 10+ RLS policies
  - `SECURITY DEFINER STABLE`, grants to `authenticated` and `anon`
  - Default roles: `admin`, `club_admin`, `league_admin`, `manager`
- [x] Fix `playhub_pending_admin_invites` RLS (was wide open with `USING (true)`)
  - Dropped `"Service role full access"` policy
  - Added 3 new policies (SELECT/INSERT/DELETE) using `is_org_member(organization_id)`
  - All app code uses serviceClient (service role), so no breakage
- [x] Fix `profiles` permissive SELECT policy (removed `"Allow public profile viewing"` with `qual = true`)
  - Remaining policies: own profile (`auth.uid() = user_id`), public profiles (`is_public = true`), anon username check
- [x] Drop duplicate indexes: `idx_playhub_access_user`, `idx_pending_invites_email`
- [x] Update `playhub_pending_admin_invites.role` default from `club_admin` to `admin`
- [x] Add `UNIQUE(organization_id, profile_id)` on `organization_members` (0 existing duplicates verified)
- [x] Add CHECK constraint on `organizations.type` — allows: venue, academy, league, group
- [x] Add composite index `organization_members(profile_id, role, is_active)` for RLS perf

### Phase 1: DB & Data (no UI changes) — COMPLETED 2026-03-08
- [x] Add `venue_organization_id` column to `playhub_match_recordings` (FK to organizations)
  - Added as nullable → backfilled → set NOT NULL
  - Index: `idx_recordings_venue_org` on `(venue_organization_id)`
- [x] Backfill `venue_organization_id` from `organization_id` for all 154 existing recordings
- [x] Create `organization_venue_access` table
  - 15 columns: permissions, billing, lifecycle, graphic package default
  - Indexes on both `organization_id` and `venue_organization_id`
  - `updated_at` auto-trigger
  - RLS: SELECT for org admins of either side, explicit deny for INSERT/UPDATE/DELETE (service-role only)
  - CHECK: `billing_responsibility IN ('venue','tenant','none','split')`
  - CHECK: `organization_id != venue_organization_id`
  - UNIQUE: `(organization_id, venue_organization_id)`
- [x] Create Li3ib as a `group` org (id: `129f9bc1`, slug: `li3ib`, verified, all features enabled)
- [x] Set Nazwa's `parent_organization_id` to Li3ib
- [x] Add partial index on `organizations.parent_organization_id` (WHERE NOT NULL)
- [x] Add circular reference prevention trigger (`prevent_circular_org_reference`)
  - Prevents self-reference
  - Prevents reparenting an org that has children (would create 3+ levels)
  - Prevents depth > 2 (proposed parent must not itself have a parent)
- [x] Update recording creation code paths to include `venue_organization_id`:
  - `schedule-recording.ts`: sets `venue_organization_id: venueId`
  - `recordings/sync/route.ts`: upsert now selects `venue_organization_id`
  - `recordings/route.ts`: batch import — documented constraint
- [x] Regenerated Supabase TypeScript types — zero type errors

### Phase 2: Access control updates — COMPLETED 2026-03-08
- [x] Update `isVenueAdmin()` to check parent org membership (one level up only)
  - Queries `organizations.parent_organization_id`, then checks membership on parent
  - Single extra DB query, only when direct membership check fails
- [x] Update `getManagedVenues()` to include child venues of parent orgs user manages
  - Detects `type: 'group'` orgs, queries children via `parent_organization_id`
  - Deduplicates by ID when merging direct + child venues
- [x] Update `checkRecordingAccess()` to check parent org admin status
  - Now fetches `venue_organization_id` alongside `organization_id`
  - Parent check handled by updated `isVenueAdmin()` call
- [x] Venue recordings API stays filtered by `organization_id` (ownership, not location)
  - Confirmed: tenant recordings (e.g. DAFL at The Sevens) do NOT leak to venue admins
  - Security specialist validated: RLS uses `organization_id` (owner), not `venue_organization_id`
- [x] Extracted `ADMIN_ROLES` constant (typed as `Role[]`) — single source of truth
- [x] Zero TypeScript errors

### Phase 3: Admin dashboard — COMPLETED 2026-03-08
- [x] Show org type, parent, and children in admin organizations page
- [x] Allow setting parent org from admin dashboard
- [x] Allow creating `organization_venue_access` entries from admin
- [x] Show org hierarchy (simple parent → children, max 2 levels)

### Phase 4: Venue page updates — COMPLETED 2026-03-08
- [x] When scheduling recording, if user has tenant access to venue, use their org's graphic package
- [x] Show which org a recording belongs to on the venue page
- [x] Parent org users see all child venue recordings in their dashboard

### Phase 5: Group dashboard — COMPLETED 2026-03-08
- [x] Birds-eye view for parent orgs (Li3ib, Powerleague)
- [x] Aggregate revenue across all child venues (query existing invoice data, no new tables)
- [x] Per-venue breakdown with daily targets and monthly stats
- [x] Cross-venue recording management (recordings list aggregated from child venues)

## `organization_venue_access` Table Design

```sql
CREATE TABLE organization_venue_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  venue_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  can_record BOOLEAN DEFAULT true,
  can_stream BOOLEAN DEFAULT false,

  billing_responsibility TEXT DEFAULT 'venue'
    CHECK (billing_responsibility IN ('venue', 'tenant', 'none', 'split')),
  custom_billable_amount NUMERIC(10,2),
  custom_currency TEXT,

  default_graphic_package_id UUID REFERENCES playhub_graphic_packages(id),

  is_active BOOLEAN DEFAULT true,
  starts_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(organization_id, venue_organization_id),
  CHECK (organization_id != venue_organization_id)
);
```

## Key Architecture Decisions (from specialist review)

1. **Max 2 levels deep** — group → venue. No arbitrary depth recursion.
2. **No separate billing table for groups** — aggregate child venue invoices instead.
3. **Feature flag cascading in app code, not DB triggers** — simpler, more visible.
4. **`billing_responsibility`** on venue access — determines who pays when tenant records. Default: venue pays.
5. **Keep old enum values** — can't remove from PostgreSQL enums. Just stop using them.
6. **`is_org_member()` DB function** — single source of truth for RLS role checks.

## Billing Implications

### Per-venue billing (no change needed)
- `playhub_venue_billing_config` is per-venue — stays as-is
- Venue-level billing (fixed cost, ambassador %, profit share) continues to work
- Invoices are generated per venue, not per parent

### Marketplace revenue attribution
- `playhub_purchases.organization_id` follows the recording's `organization_id`
- If DAFL sells a recording → revenue goes to DAFL, not The Sevens
- If Nazwa sells a recording → revenue goes to Nazwa (and rolls up to Li3ib dashboard)

### Parent group dashboard (Phase 5)
- Aggregates `playhub_venue_billing_config` across child venues
- Shows combined revenue, per-venue breakdown, targets
- No new billing tables needed — just query child org IDs

### Tenant billing — two models

**Model A: Venue pays (Nazwa/Li3ib)**
- Standard per-recording billing → monthly invoice → profit sharing
- Venue absorbs infrastructure cost, recoups through walk-in QR sales

**Model B: Free recording / marketplace monetization (DAFL)**
- League records for free (`billing_responsibility: 'none'`)
- No per-recording invoice — infrastructure cost subsidized by PLAYHUB
- League monetizes through:
  1. **Marketplace sales** — sell recordings to players/parents
  2. **Sponsorship** — graphic packages with sponsor logos on every recording
  3. **Season passes** (future)
- League needs its own marketplace config (pricing, revenue split with PLAYHUB)
- Revenue split: PLAYHUB takes a % of marketplace sales (e.g., 20%)

**Implementation:**
- `billing_responsibility` on `organization_venue_access` supports: `'venue'`, `'tenant'`, `'none'`
- Leagues with `'none'` skip per-recording billing entirely
- Leagues need marketplace settings: either reuse `organizations` marketplace fields or a lightweight `playhub_org_marketplace_config` table
- `is_billable` on recordings can be set to `false` when initiated by a league with free recording access

## What Changes for Existing Users

### Nazwa venue page (li3ib user)
- No visible change — recordings still show, same functionality
- Li3ib admins will also be able to access it (once parent is set)

### Existing recordings
- All get `venue_organization_id` backfilled = their current `organization_id`
- No ownership change — Nazwa's recordings stay as Nazwa's

### Existing APIs
- Venue recordings API (`/api/venue/[venueId]/recordings`) — no change, already filters by `organization_id`
- Billing API — no change, billing is per-venue org
- Access control — enhanced (parent admin support), not changed

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing recording queries | Backfill ensures `venue_organization_id = organization_id` for all existing data |
| Performance: extra DB query for parent check | Single additional query in `isVenueAdmin()`, cacheable |
| RLS policies need updating | Current RLS checks `organization_members` — parent check would need to be added or handled app-side |
| Tenant org scheduling at wrong venue | `organization_venue_access` enforces which venues each org can use |

## Questions Resolved
- Recordings belong to whoever initiated them (not the venue)
- Venue admins only see their own org's recordings
- Tenants (DAFL) can grant access to venue admins via existing access rights system
- Parent org (Li3ib) admins automatically have admin access to child venues
- Feature flags: parent org flags cascade unless child overrides

## Review: Phases 0-2 Execution — 2026-03-08

### What Was Done

**Phase 0 — DB cleanup (7 migrations):**
1. Created `is_org_member()` function — centralized admin check for RLS, `SECURITY DEFINER STABLE`
2. Fixed `playhub_pending_admin_invites` RLS — replaced wide-open `USING (true)` with org-admin-scoped policies
3. Fixed `profiles` SELECT policy — dropped blanket `"Allow public profile viewing"` with `USING (true)`
4. Dropped duplicate indexes — `idx_playhub_access_user`, `idx_pending_invites_email`
5. Added `UNIQUE(organization_id, profile_id)` on `organization_members`
6. Added CHECK constraint on `organizations.type` — allows venue, academy, league, group
7. Added composite index `(profile_id, role, is_active)` on `organization_members`

**Phase 1 — DB schema & data (5 migrations):**
1. Created circular reference prevention trigger (`prevent_circular_org_reference`)
   - Prevents self-reference, 3+ level depth, and reparenting orgs with children
2. Added partial index on `organizations.parent_organization_id`
3. Created `organization_venue_access` table (15 columns, indexes, RLS, updated_at trigger)
   - Explicit deny policies for INSERT/UPDATE/DELETE (service-role only writes)
4. Added `venue_organization_id` to `playhub_match_recordings` (nullable → backfill → NOT NULL)
5. Created Li3ib group org, set Nazwa as child

**Phase 2 — Access control updates (code changes):**
1. `isVenueAdmin()` — now checks parent org membership (one level up)
2. `getManagedVenues()` — includes child venues of group-type parent orgs
3. `checkRecordingAccess()` — fetches `venue_organization_id`, parent check via `isVenueAdmin()`
4. Updated 3 recording creation code paths to include `venue_organization_id`
5. Regenerated Supabase TypeScript types
6. Extracted typed `ADMIN_ROLES` constant

### Specialist Agent Validations

- **DB performance specialist**: Validated all SQL, caught circular reference trigger gap (org with children being reparented), recommended dropping composite index in favor of single-column, confirmed column order for RLS performance index
- **Security specialist**: Confirmed tenant isolation (DAFL recordings invisible to The Sevens admins via RLS), recommended explicit deny policies on `organization_venue_access`, advised keeping parent access in app code not RLS, warned about scene mapping access needing service role for tenant scheduling

### Architecture Decisions Made During Execution

1. **Parent org access in app code, NOT RLS** — Adding recursive parent checks to RLS would degrade performance for all queries and silently grant write access to child org resources
2. **`is_org_member()` stays direct-membership-only** — Parent traversal is app-level concern; modifying the function would affect 3+ RLS policies unexpectedly
3. **Explicit deny RLS policies on `organization_venue_access`** — Defense in depth; prevents accidental future permissive policies from opening writes
4. **`venue_organization_id` is NOT NULL** — Every recording happens at a physical location; enforced at DB level

### Current Org Hierarchy State

```
Li3ib (group, id: 129f9bc1) — all features enabled
  └── Nazwa (venue, id: 218da56d) — parent: Li3ib

DAFL (league, id: 74ebf7fc) — independent
CFA (academy, id: ce019dbb) — independent
SEFA (academy, id: 7d12cc1e) — independent
```

### Role Migration Status
- All 6 org members use `admin` role (migrated from `club_admin`/`league_admin`)
- Code reads still recognize old roles for backward compatibility with existing RLS policies
- All code that assigns roles uses `admin` only
- PostgreSQL enum keeps old values (can't remove from enum type)

### Files Changed
- `src/lib/recordings/access-control.ts` — Parent org checks in isVenueAdmin, getManagedVenues, checkRecordingAccess
- `src/lib/spiideo/schedule-recording.ts` — Added `venue_organization_id: venueId`
- `src/app/api/recordings/sync/route.ts` — Upsert now selects `venue_organization_id`
- `src/app/api/recordings/route.ts` — Documented constraint for batch imports
- `src/lib/supabase/types.ts` — Regenerated from DB

## Review: Phases 3-4 Execution — 2026-03-08

### Phase 3 — Admin Dashboard
- Rewritten admin organizations page with hierarchy tree view, type breakdown stats, tabbed interface
- Backend: `getAllOrganizations()` returns hierarchy data, new CRUD functions for venue access and parent org assignment
- API: New actions `setParentOrg`, `upsertVenueAccess`, `deleteVenueAccess` and `venue-access` GET section

### Phase 4 — Venue Page Updates

**1. Child venues in venue list (`/api/venue/route.ts`):**
- Added `type` to org select query
- After fetching direct memberships, detects group-type orgs
- Queries child venues via `parent_organization_id` and merges with direct orgs
- Deduplicates by ID — parent org admins now see child venues in the venue selector

**2. Tenant scheduling (`/api/venue/[venueId]/spiideo/games/route.ts`):**
- Added tenant detection logic: checks direct membership → parent admin → tenant via `organization_venue_access`
- When user is a tenant, finds their org via `organization_venue_access` (requires `can_record = true`)
- Uses tenant's `default_graphic_package_id` from venue access config
- Falls back to org's default graphic package, then venue's default
- Passes `ownerOrgId` to `scheduleRecording()` so recording gets correct `organization_id`

**3. `scheduleRecording()` — new `ownerOrgId` parameter:**
- `organization_id` now uses `input.ownerOrgId || venueId` (tenant org or venue)
- `venue_organization_id` always stays as `venueId` (physical location)

**4. Group org recordings view (`/api/venue/[venueId]/recordings/route.ts`):**
- Detects group-type orgs and includes child venue IDs in the query
- Uses `.in('organization_id', orgIds)` instead of `.eq('organization_id', venueId)`
- Returns `ownerOrgName` field when recording belongs to a child venue (not the group itself)

**5. Venue page UI:**
- Added `ownerOrgName` to Recording interface
- Shows blue org badge next to status when recording belongs to a child venue

### Files Changed (Phase 4)
- `src/app/api/venue/route.ts` — Child venue inclusion for group org admins
- `src/app/api/venue/[venueId]/spiideo/games/route.ts` — Tenant detection and graphic package resolution
- `src/app/api/venue/[venueId]/recordings/route.ts` — Group org aggregated recording view
- `src/lib/spiideo/schedule-recording.ts` — Added `ownerOrgId` parameter
- `src/app/venue/[venueId]/page.tsx` — Owner org badge on recordings

## Review: Phase 5 Execution — 2026-03-08

### Phase 5 — Group Dashboard

**API: `/api/venue/[venueId]/group-dashboard/route.ts`**
- Returns aggregated data for a group org across all child venues
- Per-venue stats: total recordings, published, this month's billable, revenue, today's count, daily target
- Aggregated totals across all child venues
- Uses billing configs from each child venue for revenue calculation
- Access controlled via `isVenueAdmin()` (parent admin check)

**Venue page changes:**
- Added `type` to Venue interface
- Detects `venue.type === 'group'` and renders group dashboard instead of normal venue management
- Group dashboard shows:
  - **Portfolio Overview**: 4 stat cards (total recordings, this month, monthly revenue, today)
  - **Venues list**: Each child venue card with recording stats, revenue, daily target progress, "Manage" button to navigate to child venue
- Venue-specific sections (billing, scheduling, streaming, marketplace, settings, admins) are hidden for group orgs
- Recordings section remains visible (shows aggregated recordings from all child venues via Phase 4)
- Header shows "Group Overview" instead of "Venue Management" for group orgs

### Files Created (Phase 5)
- `src/app/api/venue/[venueId]/group-dashboard/route.ts` — Group dashboard API

### Files Changed (Phase 5)
- `src/app/venue/[venueId]/page.tsx` — Group dashboard UI, conditional section rendering

## Review: Post-Phase Cleanup — 2026-03-08

### 1. Default Role Change
- Changed `playhub_pending_admin_invites.role` default from `'club_admin'` to `'admin'`
- Only affects future INSERTs that don't specify a role

### 2. RLS Policy Migration to `is_org_member()` (2 migrations)
- **Hardened `is_org_member()` function**: Added `SET search_path = public` (SECURITY DEFINER best practice)
- **Migrated 10 RLS policies** from inline `organization_members` subqueries to `is_org_member()`:
  1. `playhub_live_streams` — 4 policies (INSERT, DELETE, UPDATE, SELECT)
  2. `playhub_graphic_packages` — 1 policy (FOR ALL)
  3. `playhub_match_recordings` — 1 policy (FOR ALL, includes `coach` role)
  4. `playhub_products` — 1 policy (FOR ALL, via match_recordings join)
  5. `playhub_scene_venue_mapping` — 1 policy (FOR ALL)
  6. `playhub_venue_billing_config` — 1 policy (SELECT)
  7. `playhub_venue_invoices` — 1 policy (SELECT)
- Added explicit `WITH CHECK` clauses for all write policies (specialist recommendation)
- Verified: 0 policies remain with inline `organization_members` subqueries

### 3. Per-Venue Performance Charts
- Updated group dashboard API to return `dailyChart` data (per-venue breakdown by day)
- Added stacked area chart to group dashboard UI using recharts
- Chart shows daily recordings per child venue with color-coded areas
- Dashed reference line for aggregate daily target
- Shows average recordings per day

### Files Created/Changed
- `src/app/api/venue/[venueId]/group-dashboard/route.ts` — Added dailyChart, venueNames, totalDailyTarget, averagePerDay
- `src/app/venue/[venueId]/page.tsx` — Added stacked area chart to group dashboard view

### All Work Complete
All phases (0-5) plus all deferred items of the organization hierarchy & multi-tenancy migration are complete:
- **Phase 0**: DB cleanup (7 migrations)
- **Phase 1**: DB schema & data (5 migrations)
- **Phase 2**: Access control updates
- **Phase 3**: Admin dashboard
- **Phase 4**: Venue page updates
- **Phase 5**: Group dashboard
- **Post-phase**: Default role change, RLS migration (2 migrations), performance charts
- **Total DB migrations**: 16
