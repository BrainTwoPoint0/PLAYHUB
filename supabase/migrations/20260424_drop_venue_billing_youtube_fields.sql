-- Drop unused YouTube broadcast fields from venue billing config.
--
-- Context: these columns backed a crude single-RTMP-per-venue passthrough on
-- the "Venue Settings" section of the venue management page. The feature was
-- never configured by any venue (0/N rows had values set), and a proper
-- streaming system now lives under /api/streaming/channels/* (AWS MediaLive),
-- so this passthrough is dead code. Removing columns + the UI + the
-- scheduleRecording branch that read them.
--
-- Idempotent: IF EXISTS on each column.

ALTER TABLE public.playhub_venue_billing_config
  DROP COLUMN IF EXISTS youtube_rtmp_url,
  DROP COLUMN IF EXISTS youtube_stream_key;
