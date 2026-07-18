-- 20260717223000_pitch_calibrations_fk_fix.sql
--
-- Two fixes from DB review of 20260717220000_pitch_calibrations.sql:
--
-- 1. DROP the scene_id FK. playhub_pitch_calibrations is append-only by design
--    (superseded rows are never deleted), while playhub_scene_venue_mapping has
--    a live DELETE path (platform-admin scene unassign in upsertSceneMapping).
--    An FK with no ON DELETE action makes the first saved calibration
--    permanently block scene unassign with a 23503 — the same class of bug as
--    the audit-log append-only FK gotcha (2026-07-07). CASCADE would be worse
--    (an admin misclick destroying immutable operator ground truth), so
--    scene_id becomes a plain provider identifier: the calibration is a
--    historical record keyed by an external ID; the mapping row is operational
--    state.
--
-- 2. Default status to 'draft'. The RPC playhub_activate_pitch_calibration is
--    the only sanctioned writer of ACTIVE rows (advisory lock + supersede). A
--    direct service-role insert that omits status must not mint an active row
--    that races the RPC into confusing 23505-driven 500s.

-- 3. (Security review) The RPC re-checks scene<->venue consistency itself:
--    the function is the durable artifact — a future caller passing a
--    mismatched (scene, venue) pair would write a calibration whose RLS read
--    gate exposes one venue's scene geometry to another venue's members.

ALTER TABLE playhub_pitch_calibrations
  DROP CONSTRAINT IF EXISTS playhub_pitch_calibrations_scene_id_fkey;

ALTER TABLE playhub_pitch_calibrations
  ALTER COLUMN status SET DEFAULT 'draft';

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
  IF NOT EXISTS (
    SELECT 1 FROM playhub_scene_venue_mapping
    WHERE scene_id = p_scene_id AND organization_id = p_venue_organization_id
  ) THEN
    RAISE EXCEPTION 'scene % does not belong to venue %',
      p_scene_id, p_venue_organization_id;
  END IF;

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

-- CREATE OR REPLACE preserves the function ACL, so the original REVOKE from
-- anon/authenticated/public survives. If this function is ever DROPped and
-- recreated, the REVOKE must travel with it.
