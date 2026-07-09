-- 20260709120000_group_tier_config.sql
--
-- Adds playhub_group_tier_config: admin-set deployed-camera counts per sport,
-- stored at the group (portfolio) level. Introduced by the PLAYBACK x Li3ib
-- Post-Pilot Amending Annex (ref PLB-LI3IB-2026-POST-ANNEX), which sets Li3ib's
-- footage-sales revenue share by monthly utilisation per deployed camera:
--   football (Spiideo): 15% if >=2.3 rec/camera/day AND >=345 KWD/camera/month
--   padel (Clutch):     15% if >=1.5 rec/camera/day AND >=135 KWD/camera/month
--   otherwise 5%.
--
-- The camera count is the utilisation denominator. The database has no reliable
-- deployed-camera count (scenes != physical cameras, no deployment dates), so it
-- is maintained here by an admin and adjusted as cameras are deployed in phases.
--
-- The PRESENCE of a row for a group is the "this group is tiered" flag. Groups
-- with no row default to a flat 5% partner share of gross.

CREATE TABLE IF NOT EXISTS playhub_group_tier_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_organization_id UUID UNIQUE NOT NULL
    REFERENCES organizations(id) ON DELETE CASCADE,

  -- Deployed physical cameras per sport (admin-set). 0 = none deployed.
  football_camera_count INTEGER NOT NULL DEFAULT 0
    CHECK (football_camera_count >= 0),
  padel_camera_count INTEGER NOT NULL DEFAULT 0
    CHECK (padel_camera_count >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE playhub_group_tier_config ENABLE ROW LEVEL SECURITY;

-- Group members may read their own tier config (same is_org_member() helper
-- used by playhub_invoice_line_items). Camera counts directly move money, so
-- there is NO INSERT/UPDATE/DELETE policy — writes happen exclusively via the
-- service role (platform-admin route + invoice generation reads).
CREATE POLICY "Group members can read their tier config"
  ON playhub_group_tier_config FOR SELECT
  USING (is_org_member(group_organization_id));

COMMENT ON TABLE playhub_group_tier_config IS
  'Admin-set deployed-camera counts per sport at the group level. Presence of a row marks a group as revenue-tiered (Li3ib annex); absence => flat 5% partner share.';
