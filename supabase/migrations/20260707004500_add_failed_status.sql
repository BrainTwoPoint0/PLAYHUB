-- The sync-recordings Lambda marks orphaned Spiideo games (game deleted on
-- Spiideo but never synced) as status 'failed' so the sync queue excludes
-- them permanently. The constraint predates that status and rejects the
-- write, so orphan persistence errors on every run.
ALTER TABLE playhub_match_recordings DROP CONSTRAINT IF EXISTS valid_status;
ALTER TABLE playhub_match_recordings
  ADD CONSTRAINT valid_status
  CHECK (status IN ('draft', 'scheduled', 'recording', 'processing', 'published', 'archived', 'failed'));
