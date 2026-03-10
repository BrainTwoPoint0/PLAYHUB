# Database Schema Review — March 2026

Full review of PLAYHUB's 40-table Supabase schema before the org hierarchy migration.

## Critical (P0)

### Security: `playhub_pending_admin_invites` RLS is wide open

The policy has `qual = true` on ALL — any authenticated user can read/modify any invite. Must restrict to org admins.

### Security: `profiles` has a permissive SELECT policy

`qual = true` makes all profiles readable by anyone. The other granular policies are redundant. Remove the blanket `true` policy.

### Verify: `organization_members` and `organizations` RLS

These tables show RLS enabled but no SELECT policies in `pg_policies`. All PLAYHUB RLS policies do subqueries against these tables. If they aren't accessible, the subqueries silently return empty and admins lose access. Likely works because we use service role in app code — but needs verification.

## High Priority (P1)

### Duplicate indexes (wasted write I/O)

- `playhub_access_rights.user_id` — two identical indexes (`idx_playhub_access_rights_user` and `idx_playhub_access_user`)
- `playhub_pending_admin_invites.invited_email` — two identical indexes
- `playhub_veo_clubs.club_slug` — redundant with unique constraint index

### NOT NULL enforcement needed

These FKs are nullable but shouldn't be:

- `organization_members.organization_id` and `profile_id`
- `playhub_match_recordings.organization_id`
- `playhub_live_streams.organization_id`

### Create `is_org_member()` DB function

The admin check pattern (join org_members → profiles → check role) is repeated in 10+ RLS policies. Centralize into a function so role changes only need one update:

```sql
CREATE OR REPLACE FUNCTION is_org_member(
  org_id uuid,
  allowed_roles profile_variant_type[] DEFAULT ARRAY['admin','club_admin','league_admin','manager']::profile_variant_type[]
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM organization_members om
    JOIN profiles p ON om.profile_id = p.id
    WHERE om.organization_id = org_id
    AND p.user_id = auth.uid()
    AND om.role = ANY(allowed_roles)
    AND om.is_active = true
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;
```

### Enable RLS on `career_history` and `education`

These will contain personal data when PLAYBACK profiles go live.

### Update `playhub_pending_admin_invites.role` default

Still defaults to `'club_admin'` — should be `'admin'`.

## Medium Priority (P2)

### Redundancies to resolve

- **`marketplace_enabled`** duplicated on both `organizations` and `playhub_venue_billing_config`
- **`default_price_amount`/`currency`** duplicated on both tables
- **`playhub_products`** table has 0 rows — pricing lives inline on recordings. Decide: use it or drop it.
- **`stripe_payment_intent_id`** on `playhub_match_recordings` — belongs on purchases, not recordings

### Missing indexes

- `playhub_match_recordings(organization_id, status)` — composite for common query
- `playhub_purchases(organization_id)` — for revenue reporting
- `playhub_live_streams(organization_id, status)` — for org stream queries
- `organization_members(organization_id, profile_id)` — UNIQUE constraint (prevent duplicate memberships)

### Naming/consistency

- Standardize on `gen_random_uuid()` (modern Postgres) instead of `uuid_generate_v4()` (extension)
- Add CHECK constraint on `organizations.type` for valid values
- Currency defaults inconsistent: GBP on recordings, KWD on billing, AED on orgs

### Add `updated_at` triggers

Many tables have `updated_at` but no auto-trigger — relies on app code.

## Low Priority (P3)

### `playhub_venue_billing_config` is bloated (22 columns)

Mixes billing rates, streaming config (YouTube RTMP), marketplace settings, booking config. Consider splitting.

### `organizations.sport_ids` is a UUID array with no FK enforcement

Should be a junction table `organization_sports(organization_id, sport_id)` for referential integrity.

### `playscanner_collection_log` — 73K rows, no retention policy

Largest table and growing. Add partitioning or cleanup job.

### Orphaned/unused tables

- `playhub_products` (0 rows)
- `playhub_purchases` (0 rows)
- `playhub_view_history` (0 rows)
- `playhub_graphic_packages` (0 rows)
- All PLAYBACK profile tables (0 rows — expected, not yet launched)

## For the Org Hierarchy Migration

### Parent-child (`parent_organization_id`)

- Add circular reference prevention (trigger or CHECK)
- Cap depth at 2-3 levels (group → venue)
- Consider materialized path column for efficient ancestor queries if depth grows
- RLS cascading for parent admins is expensive with recursive queries

### `organization_venue_access` table

- Include `valid_from`/`valid_until` for seasonal access
- Unique constraint on `(organization_id, venue_organization_id)`
- RLS: allow both venue and tenant admins to view

### `venue_organization_id` on recordings

- NOT NULL for new rows, backfill existing
- Add index: `(venue_organization_id)`
- Consider composite: `(venue_organization_id, organization_id, status)`

### Role migration

- Cannot remove old enum values from PostgreSQL without recreating the type
- Keep `club_admin`/`league_admin` in enum but stop using them
- `is_org_member()` function handles backward compat cleanly
