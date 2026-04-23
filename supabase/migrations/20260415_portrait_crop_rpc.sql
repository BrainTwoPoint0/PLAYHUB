-- Atomic save for portrait-crop jobs.
--
-- Problem this fixes: the API route version of save_crop_job did a Supabase
-- delete-then-insert across two separate PostgREST calls. A failed insert (or
-- a concurrent double-submit) could leave the job with zero keyframes — the
-- user loses their work. Wrapping it in a plpgsql function forces a single
-- transaction boundary so either everything commits or everything rolls back.
--
-- Runs as SECURITY INVOKER so RLS applies normally. The caller's auth.uid()
-- drives the INSERT/UPDATE/DELETE policies on the underlying tables.

CREATE OR REPLACE FUNCTION save_crop_job(
  p_job_id UUID,
  p_recording_id UUID,
  p_video_url TEXT,
  p_status TEXT,
  p_scene_changes NUMERIC(10,3)[],
  p_codec_fingerprint JSONB,
  p_modal_inference_ms INTEGER,
  p_modal_app_version TEXT,
  p_keyframes JSONB,
  p_feedback JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_job_id UUID;
  v_status TEXT;
  v_updated_at TIMESTAMPTZ;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Server-side guards — cannot rely on the route-layer validator because the
  -- RPC is granted EXECUTE to `authenticated` and is callable directly from
  -- the browser via `supabase.rpc('save_crop_job', ...)`.
  IF p_status NOT IN ('pending', 'detected', 'edited', 'rendered', 'failed') THEN
    RAISE EXCEPTION 'invalid status: %', p_status USING ERRCODE = '22023';
  END IF;
  IF p_keyframes IS NOT NULL AND jsonb_array_length(p_keyframes) > 500 THEN
    RAISE EXCEPTION 'too many keyframes (max 500)' USING ERRCODE = '22023';
  END IF;
  IF p_feedback IS NOT NULL AND pg_column_size(p_feedback) > 131072 THEN
    RAISE EXCEPTION 'feedback payload too large' USING ERRCODE = '22023';
  END IF;

  -- 1. Resolve or create the job row.
  IF p_job_id IS NOT NULL THEN
    v_job_id := p_job_id;
  ELSIF p_recording_id IS NOT NULL THEN
    SELECT id INTO v_job_id
    FROM playhub_crop_jobs
    WHERE user_id = v_uid
      AND recording_id = p_recording_id
      AND status IN ('pending', 'detected', 'edited')
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF v_job_id IS NULL THEN
    INSERT INTO playhub_crop_jobs (
      recording_id, video_url, user_id, status,
      scene_changes, codec_fingerprint,
      modal_inference_ms, modal_app_version
    ) VALUES (
      p_recording_id, p_video_url, v_uid, p_status,
      COALESCE(p_scene_changes, ARRAY[]::NUMERIC(10,3)[]),
      p_codec_fingerprint,
      p_modal_inference_ms, p_modal_app_version
    )
    RETURNING id INTO v_job_id;
  ELSE
    -- Explicit `user_id = v_uid` as defense-in-depth. RLS is the primary gate
    -- but this keeps ownership enforcement local to the function so future
    -- RLS relaxations (e.g. collaboration) can't silently widen writes here.
    UPDATE playhub_crop_jobs SET
      status = p_status,
      scene_changes = COALESCE(p_scene_changes, scene_changes),
      codec_fingerprint = COALESCE(p_codec_fingerprint, codec_fingerprint),
      modal_inference_ms = COALESCE(p_modal_inference_ms, modal_inference_ms),
      modal_app_version = COALESCE(p_modal_app_version, modal_app_version)
    WHERE id = v_job_id AND user_id = v_uid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'job not found or not owned' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 2. Atomic full-replace of keyframes. RLS on INSERT requires the new rows'
  -- job_id to belong to the caller, which we just guaranteed above.
  DELETE FROM playhub_crop_keyframes WHERE job_id = v_job_id;

  IF p_keyframes IS NOT NULL AND jsonb_array_length(p_keyframes) > 0 THEN
    INSERT INTO playhub_crop_keyframes (
      job_id, time_seconds, x_pixels, source,
      confidence, edited_by_user, edited_at
    )
    SELECT
      v_job_id,
      (kf->>'time_seconds')::NUMERIC(10,3),
      (kf->>'x_pixels')::INTEGER,
      kf->>'source',
      COALESCE((kf->>'confidence')::NUMERIC(3,2), 0.5),
      COALESCE((kf->>'edited_by_user')::BOOLEAN, false),
      NULLIF(kf->>'edited_at', '')::TIMESTAMPTZ
    FROM jsonb_array_elements(p_keyframes) AS kf;
  END IF;

  -- 3. Optional feedback append. Part of the same transaction — if this fails
  -- (e.g. CHECK violation), the keyframe write also rolls back.
  IF p_feedback IS NOT NULL THEN
    INSERT INTO playhub_crop_feedback (
      job_id, user_id, action, note,
      keyframes_before, keyframes_after
    ) VALUES (
      v_job_id, v_uid,
      p_feedback->>'action',
      p_feedback->>'note',
      p_feedback->'keyframes_before',
      p_feedback->'keyframes_after'
    );
  END IF;

  -- 4. Return result.
  SELECT status, updated_at INTO v_status, v_updated_at
  FROM playhub_crop_jobs WHERE id = v_job_id;

  RETURN jsonb_build_object(
    'jobId', v_job_id,
    'status', v_status,
    'updatedAt', v_updated_at
  );
END;
$$;

GRANT EXECUTE ON FUNCTION save_crop_job(
  UUID, UUID, TEXT, TEXT, NUMERIC(10,3)[], JSONB, INTEGER, TEXT, JSONB, JSONB
) TO authenticated;

COMMENT ON FUNCTION save_crop_job IS
  'Atomic upsert of a portrait-crop job + full-replace of its keyframes + optional feedback append. Runs SECURITY INVOKER so RLS applies per-caller.';
