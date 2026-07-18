-- Jersey-labels lifecycle columns (Tier-3 identity): a downstream Batch job
-- reads jersey numbers off the banked raw panorama for allowlisted
-- organized-kit venues, assembles (number, kit) identity slots, and
-- republishes panorama-meshes/{game_id}/tracklets.json enriched with
-- `jersey` + `slot` per labelled object (one slot = one dot; the spotlight
-- follow rides the slot across fragment gaps).
--
-- Exact mirror of the proven tracklets_* columns (20260714210000): the same
-- atomic idle→pending compare-and-set claims a row exactly once across the
-- sweep and any manual backfill runner, and the same attempts cap bounds
-- retries. The player-tracklets job resets jersey_status/jersey_attempts on
-- its own success, so a tracklets re-run automatically queues re-enrichment.
--
-- Prod-safe: all additive, nullable, no RLS change (inherit playhub_match_recordings).
--   idle/NULL  → never computed (default; existing rows unaffected)
--   pending    → a jersey-labels job is in flight (heartbeats jersey_started_at)
--   ready      → the enriched tracklets.json is published
--   error      → last run failed (redacted message in jersey_error)

set local lock_timeout = '3s';

alter table public.playhub_match_recordings
  add column if not exists jersey_status text,
  add column if not exists jersey_started_at timestamptz,
  add column if not exists jersey_error text,
  add column if not exists jersey_attempts integer;

comment on column public.playhub_match_recordings.jersey_status is
  'Jersey-labels lifecycle: NULL/idle | pending | ready | error. Drives the atomic idle→pending compare-and-set that rate-limits the jersey-labels Batch job. Reset to NULL by a successful tracklets re-run (re-enrichment).';
comment on column public.playhub_match_recordings.jersey_started_at is
  'When the in-flight jersey-labels job began; heartbeated every 2 min so a stuck pending state can be expired and retried.';
comment on column public.playhub_match_recordings.jersey_error is
  'Redacted, truncated last-run error (never carries credentials). "stale — tracklets re-ran" marks a superseded computation; the sweep retries it.';
comment on column public.playhub_match_recordings.jersey_attempts is
  'Bounds retries: the sweep stops re-claiming once this reaches the cap.';
