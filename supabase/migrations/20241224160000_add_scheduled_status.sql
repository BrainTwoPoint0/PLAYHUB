-- Add 'scheduled' to valid status values for match recordings

-- Drop the existing constraint
ALTER TABLE playhub_match_recordings DROP CONSTRAINT IF EXISTS valid_status;

-- Add updated constraint with 'scheduled' status
ALTER TABLE playhub_match_recordings
  ADD CONSTRAINT valid_status
  CHECK (status IN ('draft', 'scheduled', 'recording', 'processing', 'published', 'archived'));
