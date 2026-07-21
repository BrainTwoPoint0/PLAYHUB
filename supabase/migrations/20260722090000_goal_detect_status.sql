-- Goal-detect lifecycle columns: a downstream Batch job runs the frozen
-- goal-detection chain (Veo-freeze-validated 2026-07-21: medium recall90
-- 0.81 / precision 0.31 / ~18 candidates/match) on the tracklets artifact
-- of allowlisted Spiideo recordings, cuts a review clip per candidate from
-- the produced video, and writes review-first rows into
-- playhub_goal_candidates. Nothing auto-publishes.
--
-- Exact mirror of the proven tracklets_*/jersey_* column families: the same
-- atomic idle→pending compare-and-set claims a row exactly once, the same
-- attempts cap bounds retries. The tracklets job deliberately does NOT
-- reset goal_detect_status on its own success — a silent re-detection would
-- orphan reviewed candidates; re-detection is a manual operator step.
--
-- Prod-safe: all additive, nullable, no RLS change.
--   idle/NULL  → never computed (default; existing rows unaffected)
--   pending    → a goal-detect job is in flight (heartbeats goal_detect_started_at)
--   ready      → candidates + review clips written
--   error      → last run failed (self-authored message in goal_detect_error)

set local lock_timeout = '3s';

alter table public.playhub_match_recordings
  add column if not exists goal_detect_status text,
  add column if not exists goal_detect_started_at timestamptz,
  add column if not exists goal_detect_error text,
  add column if not exists goal_detect_attempts integer;

comment on column public.playhub_match_recordings.goal_detect_status is
  'Goal-detect lifecycle: NULL/idle | pending | ready | error. Drives the atomic idle→pending compare-and-set that rate-limits the goal-detect Batch job. NOT reset by tracklets re-runs (re-detection is manual — reviewed candidates must not be orphaned silently).';
comment on column public.playhub_match_recordings.goal_detect_started_at is
  'When the in-flight goal-detect job began; heartbeated every 2 min so a stuck pending state can be expired and retried.';
comment on column public.playhub_match_recordings.goal_detect_error is
  'Self-authored, truncated last-run error (JobError messages only — never raw exceptions).';
comment on column public.playhub_match_recordings.goal_detect_attempts is
  'Bounds retries: the sweep stops re-claiming once this reaches the cap.';
