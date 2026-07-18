-- 20260717220000_pitch_calibrations.sql
--
-- Venue/scene-level pitch-boundary calibration (operator ground truth).
-- A venue admin marks the 4 pitch corners (+ optional midline endpoints) on a
-- still of the scene's raw panorama, plus the pitch dimensions in metres.
-- Grassroots pitch PAINT is not a reliable calibration target (lines are laid
-- parallel to curving fences, bent up to ~1m at the goals), so operator marks
-- are the ground truth and everything else derives from them.
--
-- Design invariants:
--   * Marks are IMMUTABLE operator input. Recalibration = a NEW row; the old
--     row is superseded, never edited. One ACTIVE row per scene (partial
--     unique index).
--   * mark uv coordinates are pixels in the RAW panorama frame (the same
--     space as the de-warp mesh's texture UVs and the venue fit). World
--     coordinates are DERIVED from the mark name + pitch dims, never stored.
--   * Derived artifacts (homography, field polygon, reprojection error) are
--     ADVISORY: consumers (player-tracklets batch job, watch player) recompute
--     from marks through their own copy of the scene mesh. solver_version tags
--     the producer of the stored derivation.
--   * Spiideo/Clutch scenes only. Veo has no scene concept here: its boundary
--     is derived per match from alignment.veo at capture time and consumed
--     from the capture artifacts.
--
-- Pitch frame orientation convention (the ONE definition; helpers must match):
--   origin = corner_nw, +x runs along the pitch LENGTH toward corner_ne,
--   +y toward corner_sw. midline_n/midline_s sit at x = length/2.
--   pitch_focus 'left_half' = x < length/2, 'right_half' = x >= length/2.

CREATE TABLE IF NOT EXISTS playhub_pitch_calibrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id TEXT NOT NULL REFERENCES playhub_scene_venue_mapping(scene_id),
  venue_organization_id UUID NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL CHECK (provider IN ('spiideo', 'clutch')),
  source TEXT NOT NULL DEFAULT 'operator'
    CHECK (source IN ('operator', 'assist')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'draft')),

  -- immutable operator ground truth
  frame_s3_key TEXT NOT NULL,
  frame_width INTEGER NOT NULL DEFAULT 3840 CHECK (frame_width > 0),
  frame_height INTEGER NOT NULL DEFAULT 2160 CHECK (frame_height > 0),
  mesh_source_game_id TEXT,
  marks JSONB NOT NULL CHECK (jsonb_typeof(marks) = 'array'),
  pitch_length_m NUMERIC NOT NULL CHECK (pitch_length_m BETWEEN 20 AND 130),
  pitch_width_m NUMERIC NOT NULL CHECK (pitch_width_m BETWEEN 15 AND 100),

  -- derived, advisory (recomputed by consumers from marks + their mesh copy)
  solver_version INTEGER,
  homography JSONB,
  field_polygon_rayn JSONB,
  reprojection_error_px NUMERIC,

  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,
  superseded_by UUID REFERENCES playhub_pitch_calibrations(id)
);

-- one ACTIVE calibration per scene
CREATE UNIQUE INDEX IF NOT EXISTS playhub_pitch_calibrations_active_uq
  ON playhub_pitch_calibrations (scene_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_pitch_calibrations_venue
  ON playhub_pitch_calibrations (venue_organization_id);

-- ─── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE playhub_pitch_calibrations ENABLE ROW LEVEL SECURITY;

-- Venue members may read their calibrations (same is_org_member() helper as
-- playhub_group_tier_config). Writes gate on venue-admin in the API route and
-- happen exclusively via the service role (no INSERT/UPDATE/DELETE policy).
CREATE POLICY "Venue members can read pitch calibrations"
  ON playhub_pitch_calibrations FOR SELECT
  USING (is_org_member(venue_organization_id));

-- ─── atomic activate (supersede + insert in one tx) ───────────────────
-- insert-then-supersede violates the partial unique index; supersede-then-
-- insert can strand a scene with no active row if the insert fails. This
-- function does both atomically. SECURITY DEFINER, service-role only.
CREATE OR REPLACE FUNCTION playhub_activate_pitch_calibration(
  p_scene_id TEXT,
  p_venue_organization_id UUID,
  p_provider TEXT,
  p_source TEXT,
  p_frame_s3_key TEXT,
  p_frame_width INTEGER,
  p_frame_height INTEGER,
  p_mesh_source_game_id TEXT,
  p_marks JSONB,
  p_pitch_length_m NUMERIC,
  p_pitch_width_m NUMERIC,
  p_solver_version INTEGER,
  p_homography JSONB,
  p_field_polygon_rayn JSONB,
  p_reprojection_error_px NUMERIC,
  p_created_by UUID
) RETURNS playhub_pitch_calibrations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new playhub_pitch_calibrations;
BEGIN
  -- serialize concurrent activations per scene
  PERFORM pg_advisory_xact_lock(hashtext('pitch_calibration:' || p_scene_id));

  INSERT INTO playhub_pitch_calibrations (
    scene_id, venue_organization_id, provider, source, status,
    frame_s3_key, frame_width, frame_height, mesh_source_game_id,
    marks, pitch_length_m, pitch_width_m,
    solver_version, homography, field_polygon_rayn, reprojection_error_px,
    created_by
  ) VALUES (
    p_scene_id, p_venue_organization_id, p_provider, p_source, 'draft',
    p_frame_s3_key, p_frame_width, p_frame_height, p_mesh_source_game_id,
    p_marks, p_pitch_length_m, p_pitch_width_m,
    p_solver_version, p_homography, p_field_polygon_rayn,
    p_reprojection_error_px, p_created_by
  ) RETURNING * INTO v_new;

  UPDATE playhub_pitch_calibrations
     SET status = 'superseded',
         superseded_at = now(),
         superseded_by = v_new.id
   WHERE scene_id = p_scene_id
     AND status = 'active';

  UPDATE playhub_pitch_calibrations
     SET status = 'active'
   WHERE id = v_new.id
   RETURNING * INTO v_new;

  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION playhub_activate_pitch_calibration(
  TEXT, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT, JSONB,
  NUMERIC, NUMERIC, INTEGER, JSONB, JSONB, NUMERIC, UUID
) FROM anon, authenticated, public;

-- ─── per-recording pitch focus ────────────────────────────────────────
-- Chosen at scheduling against the venue midline; changeable post-hoc.
-- Resolved against the scene's CURRENT active calibration at watch time
-- (never snapshotted into view coordinates on the recording).
SET LOCAL lock_timeout = '3s';
ALTER TABLE playhub_match_recordings
  ADD COLUMN IF NOT EXISTS pitch_focus TEXT NOT NULL DEFAULT 'full'
  CHECK (pitch_focus IN ('full', 'left_half', 'right_half'));

COMMENT ON TABLE playhub_pitch_calibrations IS
  'Operator-marked pitch boundary per camera scene (Spiideo/Clutch). Marks are immutable ground truth in raw-panorama pixels; derived fields are advisory. One active row per scene; recalibration supersedes via playhub_activate_pitch_calibration().';
COMMENT ON COLUMN playhub_match_recordings.pitch_focus IS
  'full | left_half | right_half — half-pitch focus vs the scene midline (origin corner_nw, +x toward corner_ne; left = x < length/2).';
