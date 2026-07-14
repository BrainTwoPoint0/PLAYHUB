-- Player-tracklets lifecycle columns for the spotlight feature: an offline
-- Batch job fetches Spiideo's tracklets + object-detections data streams,
-- solves the per-game metric→ray homography, and publishes
-- panorama-meshes/{game_id}/tracklets.json for the player's click-to-spotlight
-- mode (ring + trail + camera-follow on a selected player).
--
-- Exact mirror of the proven aim_track_* columns (20260713210000): the same
-- atomic idle→pending compare-and-set claims a row exactly once across the
-- sweep and any manual backfill runner, and the same attempts cap bounds
-- retries. Games recorded before a venue's tracklets rollout have no stream —
-- they settle at 'error' after the attempts cap.
--
-- Prod-safe: all additive, nullable, no RLS change (inherit playhub_match_recordings).
--   idle/NULL  → never computed (default; existing rows unaffected)
--   pending    → a tracklets job is in flight (heartbeats tracklets_started_at)
--   ready      → tracklets.json is published next to the mesh
--   error      → last run failed (redacted message in tracklets_error)

set local lock_timeout = '3s';

alter table public.playhub_match_recordings
  add column if not exists tracklets_status text,
  add column if not exists tracklets_started_at timestamptz,
  add column if not exists tracklets_error text,
  add column if not exists tracklets_attempts integer;

comment on column public.playhub_match_recordings.tracklets_status is
  'Player-tracklets lifecycle: NULL/idle | pending | ready | error. Drives the atomic idle→pending compare-and-set that rate-limits the player-tracklets Batch job.';
comment on column public.playhub_match_recordings.tracklets_started_at is
  'When the in-flight tracklets job began; heartbeated every 2 min so a stuck pending state can be expired and retried.';
comment on column public.playhub_match_recordings.tracklets_error is
  'Redacted, truncated last-run error (never carries credentials). "no tracklets stream published for this game" marks pre-rollout games.';
comment on column public.playhub_match_recordings.tracklets_attempts is
  'Bounds retries: the sweep stops re-claiming once this reaches the cap, so pre-rollout games do not resubmit jobs forever.';
