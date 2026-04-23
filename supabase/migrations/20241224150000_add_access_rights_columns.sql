-- Add missing columns to playhub_access_rights for email-based access

ALTER TABLE playhub_access_rights
  ADD COLUMN IF NOT EXISTS invited_email TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- Create index for email lookups
CREATE INDEX IF NOT EXISTS idx_access_rights_email
  ON playhub_access_rights(invited_email)
  WHERE invited_email IS NOT NULL;

-- Create unique constraint for email-based access (one grant per email per recording)
-- Only if not already exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'playhub_access_rights_email_recording_unique'
  ) THEN
    ALTER TABLE playhub_access_rights
      ADD CONSTRAINT playhub_access_rights_email_recording_unique
      UNIQUE (invited_email, match_recording_id);
  END IF;
END $$;
