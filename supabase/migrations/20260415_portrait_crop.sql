-- Portrait Crop — Assisted Editor Phase 3
-- Persists AI-generated keyframes, user corrections, and optional Modal renders
-- so the editor can reopen state and so corrections become training signal.
--
-- Visibility model (Phase 3):
--   Jobs + keyframes : own OR same-org-recording (read-collab within an org)
--   Feedback        : creator-only (edit-history is private training signal)
--   Edit rights     : creator-only across the board (no collab editing)
--
-- Tables
--   playhub_feature_flags          — global kill switches (portrait_crop_enabled)
--   playhub_crop_jobs              — one row per editor session
--   playhub_crop_keyframes         — per-job keyframe list
--   playhub_crop_feedback          — per-user edit audit trail (training signal)

-- ───────────────────────────── feature flags ─────────────────────────────
CREATE TABLE IF NOT EXISTS playhub_feature_flags (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE playhub_feature_flags ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read flags (client needs them to gate UI).
CREATE POLICY "Authenticated users can read feature flags"
  ON playhub_feature_flags FOR SELECT TO authenticated
  USING (true);

-- Mutations via service_role only — kept out of the authenticated policy graph.
GRANT SELECT ON TABLE playhub_feature_flags TO authenticated;
GRANT ALL ON TABLE playhub_feature_flags TO service_role;

-- Seed: default OFF. Explicitly flip via `UPDATE` to enable.
INSERT INTO playhub_feature_flags (key, enabled, notes)
VALUES ('portrait_crop_enabled', false, 'Global kill switch for the portrait-crop assisted editor')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────── jobs ────────────────────────────────────
CREATE TABLE IF NOT EXISTS playhub_crop_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- recording-linked ⇒ org-scoped read-visibility; ad-hoc ⇒ strictly user-scoped.
  -- CASCADE on recording delete: a crop without its source recording is dead weight.
  recording_id UUID REFERENCES playhub_match_recordings(id) ON DELETE CASCADE,
  video_url TEXT,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  -- Captured via ffprobe on detection. Schema: {codec, width, height, fps, bitrate, color_space}.
  codec_fingerprint JSONB,
  modal_inference_ms INTEGER,
  modal_app_version TEXT,
  scene_changes NUMERIC(10,3)[] NOT NULL DEFAULT ARRAY[]::NUMERIC(10,3)[],
  -- Populated after a Modal render. Path inside the 'portrait-crops' Storage bucket.
  output_storage_path TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_status CHECK (status IN (
    'pending',     -- created, detection not yet run
    'detected',    -- AI keyframes ready for user editing
    'edited',      -- user has touched at least one keyframe
    'rendered',    -- MP4 exported via Modal render endpoint
    'failed'       -- detection or render errored
  )),
  -- Exactly one source is authoritative: either a recording link or a raw URL.
  -- video_url is only valid when recording_id is null; prevents confusion on which
  -- identifier drives playback + closes an SSRF ambiguity in the API layer.
  CONSTRAINT source_exclusive CHECK (
    (recording_id IS NOT NULL AND video_url IS NULL)
    OR (recording_id IS NULL AND video_url IS NOT NULL)
  )
);

CREATE INDEX idx_crop_jobs_user ON playhub_crop_jobs(user_id);
CREATE INDEX idx_crop_jobs_recording ON playhub_crop_jobs(recording_id) WHERE recording_id IS NOT NULL;
-- At most one non-terminal job per (user, recording) so reopening the editor continues
-- the previous job rather than spawning a new one.
CREATE UNIQUE INDEX idx_crop_jobs_user_recording_active
  ON playhub_crop_jobs(user_id, recording_id)
  WHERE recording_id IS NOT NULL AND status IN ('pending', 'detected', 'edited');

ALTER TABLE playhub_crop_jobs ENABLE ROW LEVEL SECURITY;

-- SELECT: own, OR recording-linked to an org the user is an active member of.
-- auth.uid() wrapped in (SELECT …) so Postgres evaluates it once per statement
-- instead of per-row (Supabase RLS perf pattern).
CREATE POLICY "Users view own or org-recording crop jobs"
  ON playhub_crop_jobs FOR SELECT TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (
      recording_id IS NOT NULL
      AND recording_id IN (
        SELECT mr.id
        FROM playhub_match_recordings mr
        WHERE mr.organization_id IN (
          SELECT om.organization_id
          FROM organization_members om
          JOIN profiles p ON om.profile_id = p.id
          WHERE p.user_id = (SELECT auth.uid()) AND om.is_active = true
        )
      )
    )
  );

-- INSERT: user must own the row they're creating AND have access to the linked
-- recording (closes the cross-tenant shadow-job vector).
CREATE POLICY "Users create own crop jobs"
  ON playhub_crop_jobs FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND (
      recording_id IS NULL
      OR recording_id IN (
        SELECT mr.id
        FROM playhub_match_recordings mr
        WHERE mr.organization_id IN (
          SELECT om.organization_id
          FROM organization_members om
          JOIN profiles p ON om.profile_id = p.id
          WHERE p.user_id = (SELECT auth.uid()) AND om.is_active = true
        )
      )
    )
  );

-- UPDATE/DELETE: creator only. Org members see each other's jobs (read-collab)
-- but cannot overwrite or delete them.
CREATE POLICY "Users mutate own crop jobs"
  ON playhub_crop_jobs FOR UPDATE TO authenticated
  USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users delete own crop jobs"
  ON playhub_crop_jobs FOR DELETE TO authenticated
  USING (user_id = (SELECT auth.uid()));

GRANT ALL ON TABLE playhub_crop_jobs TO authenticated;
GRANT ALL ON TABLE playhub_crop_jobs TO service_role;

-- ──────────────────────────── keyframes ──────────────────────────────────
CREATE TABLE IF NOT EXISTS playhub_crop_keyframes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES playhub_crop_jobs(id) ON DELETE CASCADE,
  time_seconds NUMERIC(10,3) NOT NULL,
  -- Hardcoded to 1920px source width. If/when 4K (3840) becomes a shipping target,
  -- lift this bound and add a `source_width` column on jobs for validation.
  x_pixels INTEGER NOT NULL,
  source TEXT NOT NULL,
  confidence NUMERIC(3,2) NOT NULL DEFAULT 0.5,
  edited_by_user BOOLEAN NOT NULL DEFAULT false,
  edited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_keyframe_source CHECK (source IN ('ai_ball', 'ai_tracked', 'ai_cluster', 'user')),
  CONSTRAINT valid_x CHECK (x_pixels >= 0 AND x_pixels <= 1920),
  CONSTRAINT valid_time CHECK (time_seconds >= 0),
  CONSTRAINT valid_confidence CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX idx_crop_keyframes_job_time ON playhub_crop_keyframes(job_id, time_seconds);

ALTER TABLE playhub_crop_keyframes ENABLE ROW LEVEL SECURITY;

-- SELECT: inherits job visibility (own + org-recording reads).
CREATE POLICY "Keyframes inherit job read visibility"
  ON playhub_crop_keyframes FOR SELECT TO authenticated
  USING (
    job_id IN (
      SELECT id FROM playhub_crop_jobs
      -- The subselect re-applies the jobs SELECT policy automatically.
    )
  );

-- INSERT/UPDATE/DELETE: only on jobs owned by the caller. Tightens the inherit
-- pattern so org visibility doesn't widen write access.
CREATE POLICY "Keyframes mutate requires job ownership"
  ON playhub_crop_keyframes FOR ALL TO authenticated
  USING (
    job_id IN (
      SELECT id FROM playhub_crop_jobs WHERE user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    job_id IN (
      SELECT id FROM playhub_crop_jobs WHERE user_id = (SELECT auth.uid())
    )
  );

GRANT ALL ON TABLE playhub_crop_keyframes TO authenticated;
GRANT ALL ON TABLE playhub_crop_keyframes TO service_role;

-- ──────────────────────────── feedback ───────────────────────────────────
CREATE TABLE IF NOT EXISTS playhub_crop_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES playhub_crop_jobs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  note TEXT,
  -- Snapshots let us reconstruct exactly what the user saw vs what they kept,
  -- which is the core training signal for the improvement loop.
  keyframes_before JSONB,
  keyframes_after JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT valid_feedback_action CHECK (action IN ('accepted', 'rejected', 'edited', 'exported'))
);

CREATE INDEX idx_crop_feedback_job_created ON playhub_crop_feedback(job_id, created_at DESC);
CREATE INDEX idx_crop_feedback_action_time ON playhub_crop_feedback(action, created_at DESC);

ALTER TABLE playhub_crop_feedback ENABLE ROW LEVEL SECURITY;

-- SELECT: creator-only. Feedback contains edit history + intent; not shared with
-- org teammates even when the underlying job is read-collab-visible.
CREATE POLICY "Users view own feedback"
  ON playhub_crop_feedback FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- INSERT: own user_id AND feedback target must be a job the user owns.
-- Closes the training-data poisoning vector (attacker writing feedback
-- against someone else's job).
CREATE POLICY "Users create own feedback on own jobs"
  ON playhub_crop_feedback FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND job_id IN (
      SELECT id FROM playhub_crop_jobs WHERE user_id = (SELECT auth.uid())
    )
  );

-- No UPDATE/DELETE policies — append-only audit log by design.
-- GDPR right-to-be-forgotten handled via ON DELETE CASCADE on user_id.

GRANT SELECT, INSERT ON TABLE playhub_crop_feedback TO authenticated;
GRANT ALL ON TABLE playhub_crop_feedback TO service_role;

-- ──────────────────────── updated_at triggers ────────────────────────────
CREATE OR REPLACE FUNCTION playhub_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_crop_jobs_updated_at
  BEFORE UPDATE ON playhub_crop_jobs
  FOR EACH ROW EXECUTE FUNCTION playhub_touch_updated_at();

CREATE TRIGGER trg_feature_flags_updated_at
  BEFORE UPDATE ON playhub_feature_flags
  FOR EACH ROW EXECUTE FUNCTION playhub_touch_updated_at();
