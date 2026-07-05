-- Capture-status columns for the on-demand raw-VP pre-capture (Design B, per the
-- A2 security review). These back an ATOMIC compare-and-set so the expensive
-- "materialize the raw VP + remux to S3" Lambda is triggered at most once per
-- recording across all serverless instances — an in-memory Map is insufficient
-- because the panorama-source route is reachable by every access-holder (not just
-- platform admins like scene-health).
--
-- Prod-safe: all additive, nullable, no RLS change (inherit playhub_match_recordings).
--   idle/NULL  → never captured (default; existing rows unaffected)
--   pending    → a capture is in flight (set atomically; gates re-triggering)
--   ready      → panorama_s3_key is populated + servable
--   error      → last capture failed (redacted message in panorama_capture_error)

-- Fail fast rather than queue behind a long txn on this hot table (the adds are
-- metadata-only in PG11+, but the brief ACCESS EXCLUSIVE catalog lock still queues).
set local lock_timeout = '3s';

alter table public.playhub_match_recordings
  add column if not exists panorama_capture_status text,
  add column if not exists panorama_capture_started_at timestamptz,
  add column if not exists panorama_capture_error text,
  -- Bounds error retries: the poll re-claims an 'error' row, so without a cap a
  -- recording whose VP can never materialize would re-submit a multi-GB Batch job
  -- forever. The route stops re-claiming once this exceeds a small max.
  add column if not exists panorama_capture_attempts integer;

comment on column public.playhub_match_recordings.panorama_capture_status is
  'Raw-VP pre-capture lifecycle: NULL/idle | pending | ready | error. Drives the atomic idle→pending compare-and-set that rate-limits the capture Lambda across serverless instances.';
comment on column public.playhub_match_recordings.panorama_capture_started_at is
  'When the in-flight capture began; used to expire a stuck pending state so a failed capture can be retried after a cooldown.';
comment on column public.playhub_match_recordings.panorama_capture_error is
  'Redacted, truncated last-capture error surfaced to the polling client (never carries the Spiideo bearer JWT).';
