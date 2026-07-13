-- Aim-track lifecycle columns for the reg-SIFT auto-follow feature: an offline
-- Batch job registers the produced Play render against the preserved raw
-- panorama to recover Spiideo's exact camera aim, and publishes it as
-- panorama-meshes/{game_id}/aim-track.json for the player's Auto-follow mode.
--
-- Exact mirror of the proven panorama_capture_* columns (20260705120000): the
-- same atomic idle→pending compare-and-set claims a row exactly once across the
-- sweep and any manual backfill runner, and the same attempts cap bounds retries.
--
-- Prod-safe: all additive, nullable, no RLS change (inherit playhub_match_recordings).
--   idle/NULL  → never computed (default; existing rows unaffected)
--   pending    → an aim-track job is in flight (heartbeats aim_track_started_at)
--   ready      → aim-track.json is published next to the mesh
--   error      → last run failed (redacted message in aim_track_error)

set local lock_timeout = '3s';

alter table public.playhub_match_recordings
  add column if not exists aim_track_status text,
  add column if not exists aim_track_started_at timestamptz,
  add column if not exists aim_track_error text,
  add column if not exists aim_track_attempts integer;

comment on column public.playhub_match_recordings.aim_track_status is
  'Reg-SIFT aim-track lifecycle: NULL/idle | pending | ready | error. Drives the atomic idle→pending compare-and-set that rate-limits the aim-track Batch job.';
comment on column public.playhub_match_recordings.aim_track_started_at is
  'When the in-flight aim-track job began; heartbeated every 2 min so a stuck pending state can be expired and retried.';
comment on column public.playhub_match_recordings.aim_track_error is
  'Redacted, truncated last-run error (never carries credentials).';
comment on column public.playhub_match_recordings.aim_track_attempts is
  'Bounds retries: the sweep stops re-claiming once this reaches the cap, so a recording whose registration can never succeed does not resubmit multi-hour Batch jobs forever.';
