-- Venue Management Migration
-- Adds pitch_name column, venue Spiideo config table, and recording access table

-- 1. Add pitch_name column to playhub_match_recordings
ALTER TABLE playhub_match_recordings
  ADD COLUMN IF NOT EXISTS pitch_name TEXT;

-- 2. Create playhub_venue_spiideo_config table
CREATE TABLE IF NOT EXISTS playhub_venue_spiideo_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,
  spiideo_client_id TEXT NOT NULL,
  spiideo_client_secret TEXT NOT NULL,
  spiideo_account_id TEXT NOT NULL,
  spiideo_user_id TEXT NOT NULL,
  default_scene_id TEXT,
  default_recipe_id TEXT,
  spiideo_type TEXT DEFAULT 'play',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Create playhub_recording_access table (if not exists)
CREATE TABLE IF NOT EXISTS playhub_recording_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recording_id UUID REFERENCES playhub_match_recordings(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  invited_email TEXT,
  granted_by UUID REFERENCES auth.users(id),
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  CONSTRAINT user_or_email CHECK (user_id IS NOT NULL OR invited_email IS NOT NULL)
);

-- 3b. Add invited_email column if table already exists without it
ALTER TABLE playhub_recording_access
  ADD COLUMN IF NOT EXISTS invited_email TEXT;

-- 3c. Add notes column if missing
ALTER TABLE playhub_recording_access
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- 3d. Add expires_at column if missing
ALTER TABLE playhub_recording_access
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- 3e. Add is_active column if missing
ALTER TABLE playhub_recording_access
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- 3f. Add granted_by column if missing
ALTER TABLE playhub_recording_access
  ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES auth.users(id);

-- 4. Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_venue_spiideo_config_org
  ON playhub_venue_spiideo_config(organization_id);

CREATE INDEX IF NOT EXISTS idx_recording_access_recording
  ON playhub_recording_access(recording_id);

CREATE INDEX IF NOT EXISTS idx_recording_access_user
  ON playhub_recording_access(user_id);

CREATE INDEX IF NOT EXISTS idx_recording_access_email
  ON playhub_recording_access(invited_email);

-- 5. Enable RLS on new tables
ALTER TABLE playhub_venue_spiideo_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE playhub_recording_access ENABLE ROW LEVEL SECURITY;

-- 6. RLS Policies for playhub_venue_spiideo_config
-- Venue admins can view their own config
CREATE POLICY "Venue admins can view own config"
  ON playhub_venue_spiideo_config FOR SELECT
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

-- Venue admins can insert their own config
CREATE POLICY "Venue admins can insert own config"
  ON playhub_venue_spiideo_config FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT om.organization_id
      FROM organization_members om
      JOIN profiles p ON om.profile_id = p.id
      WHERE p.user_id = auth.uid()
        AND om.role IN ('club_admin', 'league_admin')
        AND om.is_active = true
    )
  );

-- Venue admins can update their own config
CREATE POLICY "Venue admins can update own config"
  ON playhub_venue_spiideo_config FOR UPDATE
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

-- 7. RLS Policies for playhub_recording_access
-- Users can view their own access grants
CREATE POLICY "Users can view own access"
  ON playhub_recording_access FOR SELECT
  USING (
    user_id = auth.uid()
    OR invited_email IN (
      SELECT email FROM auth.users WHERE id = auth.uid()
    )
  );

-- Venue admins can view access for their org's recordings
CREATE POLICY "Venue admins can view recording access"
  ON playhub_recording_access FOR SELECT
  USING (
    recording_id IN (
      SELECT r.id
      FROM playhub_match_recordings r
      JOIN organization_members om ON r.organization_id = om.organization_id
      JOIN profiles p ON om.profile_id = p.id
      WHERE p.user_id = auth.uid()
        AND om.role IN ('club_admin', 'league_admin')
        AND om.is_active = true
    )
  );

-- Venue admins can grant access for their org's recordings
CREATE POLICY "Venue admins can grant access"
  ON playhub_recording_access FOR INSERT
  WITH CHECK (
    recording_id IN (
      SELECT r.id
      FROM playhub_match_recordings r
      JOIN organization_members om ON r.organization_id = om.organization_id
      JOIN profiles p ON om.profile_id = p.id
      WHERE p.user_id = auth.uid()
        AND om.role IN ('club_admin', 'league_admin')
        AND om.is_active = true
    )
  );

-- Venue admins can revoke access for their org's recordings
CREATE POLICY "Venue admins can revoke access"
  ON playhub_recording_access FOR DELETE
  USING (
    recording_id IN (
      SELECT r.id
      FROM playhub_match_recordings r
      JOIN organization_members om ON r.organization_id = om.organization_id
      JOIN profiles p ON om.profile_id = p.id
      WHERE p.user_id = auth.uid()
        AND om.role IN ('club_admin', 'league_admin')
        AND om.is_active = true
    )
  );

-- Venue admins can update access for their org's recordings
CREATE POLICY "Venue admins can update access"
  ON playhub_recording_access FOR UPDATE
  USING (
    recording_id IN (
      SELECT r.id
      FROM playhub_match_recordings r
      JOIN organization_members om ON r.organization_id = om.organization_id
      JOIN profiles p ON om.profile_id = p.id
      WHERE p.user_id = auth.uid()
        AND om.role IN ('club_admin', 'league_admin')
        AND om.is_active = true
    )
  );
