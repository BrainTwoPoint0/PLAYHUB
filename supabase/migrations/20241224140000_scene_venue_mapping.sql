-- Scene to Venue Mapping
-- Maps Spiideo scenes (cameras) to organizations/venues
-- All venues in Kuwait share one Spiideo account, scenes differentiate venues

-- 1. Create scene → venue mapping table
CREATE TABLE IF NOT EXISTS playhub_scene_venue_mapping (
  scene_id TEXT PRIMARY KEY,
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  scene_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scene_venue_org ON playhub_scene_venue_mapping(organization_id);

-- 2. Enable RLS
ALTER TABLE playhub_scene_venue_mapping ENABLE ROW LEVEL SECURITY;

-- 3. RLS Policies - admins can manage, everyone can read
CREATE POLICY "Anyone can view scene mappings"
  ON playhub_scene_venue_mapping FOR SELECT
  USING (true);

CREATE POLICY "Venue admins can manage scene mappings"
  ON playhub_scene_venue_mapping FOR ALL
  USING (
    organization_id IN (
      SELECT om.organization_id
      FROM organization_members om
      JOIN profiles p ON om.profile_id = p.id
      WHERE p.user_id = auth.uid()
        AND om.role IN ('club_admin', 'league_admin')
        AND om.is_active = true
    )
  );

-- 4. Drop unused tables
DROP TABLE IF EXISTS playhub_venue_spiideo_config CASCADE;
DROP TABLE IF EXISTS playhub_recording_access CASCADE;
