-- Clutch (padel camera) provider support.
-- Provider columns follow the spiideo_game_id house style; the partial unique
-- index doubles as the sync lambda's fast lookup and an idempotency guard.

ALTER TABLE playhub_match_recordings
  ADD COLUMN IF NOT EXISTS clutch_video_id  text,
  ADD COLUMN IF NOT EXISTS clutch_device_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_match_recordings_clutch_video_id
  ON playhub_match_recordings (clutch_video_id)
  WHERE clutch_video_id IS NOT NULL;

-- Queue index for the clutch-sync lambda's poll. Tiny by construction:
-- rows leave it the moment s3_key is set (publish) or status moves on,
-- so it stays at the size of the in-flight set regardless of table growth.
CREATE INDEX IF NOT EXISTS idx_recordings_clutch_pending
  ON playhub_match_recordings (status)
  WHERE clutch_video_id IS NOT NULL AND s3_key IS NULL;

-- Camera→venue mapping gains a provider discriminator so Clutch devices slot
-- into the existing scene resolution. Existing rows are all Spiideo scenes.
ALTER TABLE playhub_scene_venue_mapping
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'spiideo'
  CONSTRAINT scene_venue_mapping_provider_check
  CHECK (provider IN ('spiideo', 'clutch'));
