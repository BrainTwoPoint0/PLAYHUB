-- Add self-service booking config to venue billing
ALTER TABLE playhub_venue_billing_config
  ADD COLUMN IF NOT EXISTS booking_durations INTEGER[] DEFAULT '{60}',
  ADD COLUMN IF NOT EXISTS booking_enabled BOOLEAN DEFAULT false;
