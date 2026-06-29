-- Portrait Crop — content-keyed detection cache (editor auto-crop latency)
--
-- Ball detection depends ONLY on the source video, not the user — so the result
-- is cached per Veo highlight and SHARED across all users: the first viewer of a
-- highlight warms the cache (one ~27s Modal run) and every viewer after gets the
-- crop instantly. Distinct from playhub_crop_jobs (per-user editor sessions and
-- corrections); this is a global, content-addressed cache of the raw detection.

CREATE TABLE IF NOT EXISTS playhub_crop_detections (
  veo_highlight_id   TEXT PRIMARY KEY
    CONSTRAINT veo_highlight_id_sane CHECK (length(veo_highlight_id) BETWEEN 1 AND 200),
  detection          JSONB NOT NULL,          -- { positions, scene_changes, codec_fingerprint, ... }
  modal_inference_ms INTEGER,
  modal_app_version  TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE playhub_crop_detections IS
  'Content-keyed cache of portrait-crop ball detections, keyed by Veo highlight id. Detection is video-deterministic, so the cache is shared across users — the first open warms it for everyone. Separate from playhub_crop_jobs (per-user edit state). Writes are service-role only (seeded by /api/editor/process); modal_app_version supports cache invalidation (TRUNCATE) on detector change.';

ALTER TABLE playhub_crop_detections ENABLE ROW LEVEL SECURITY;

-- READ: any authenticated user may read the shared cache. The value is
-- non-sensitive (ball-position floats) and video-deterministic.
CREATE POLICY "Authenticated users read crop detection cache"
  ON playhub_crop_detections FOR SELECT
  TO authenticated
  USING (true);

-- WRITE: service-role only. The cache is seeded exclusively by the server-side
-- /api/editor/process route (after auth + feature gate) via a service-role client.
-- Deliberately NO authenticated INSERT/UPDATE policy — clients cannot write the
-- shared table directly, which closes the cross-tenant cache-poisoning vector a
-- broad `WITH CHECK (true)` write policy would open.
GRANT SELECT ON TABLE playhub_crop_detections TO authenticated;
GRANT ALL ON TABLE playhub_crop_detections TO service_role;

-- Bound dead-tuple bloat from repeated upserts on a hot key: vacuum on a flat
-- threshold rather than the default 20%-of-table scale (which a low-row-count
-- table rarely trips), so the TOASTed JSONB blob's dead tuples get reclaimed.
ALTER TABLE playhub_crop_detections SET (
  autovacuum_vacuum_scale_factor = 0.0,
  autovacuum_vacuum_threshold = 200
);

-- updated_at trigger (reuses the touch function defined in 20260415_portrait_crop.sql)
CREATE TRIGGER trg_crop_detections_updated_at
  BEFORE UPDATE ON playhub_crop_detections
  FOR EACH ROW EXECUTE FUNCTION playhub_touch_updated_at();
