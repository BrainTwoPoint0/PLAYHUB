-- Hardening from the 2026-07-22 goal-producer reviews:
--
-- 1. The approve route's duplicate-event backstop was the triple unique
--    (provider, provider_recording_id, provider_event_id) — NULLS DISTINCT,
--    so any path that wrote provider_recording_id NULL would let racing
--    approves insert duplicate PUBLIC goal markers. The route now refuses
--    the NULL write, and this partial unique makes the backstop
--    constraint-level regardless: one event per (provider, provider_event_id)
--    whenever a provider event id exists at all. Manual events
--    (provider_event_id NULL) are untouched. Veo's writer upserts on the
--    triple with all three non-null, so this is compatible (its
--    provider_event_id is unique per recording feed).
--
-- 2. playhub_goal_candidates_recording_idx was column-for-column identical
--    to the table's unique (match_recording_id, anchor_s) index — pure
--    write amplification, dropped.

set local lock_timeout = '3s';

create unique index if not exists playhub_recording_events_provider_event_uq_idx
  on public.playhub_recording_events (provider, provider_event_id)
  where provider_event_id is not null;

drop index if exists public.playhub_goal_candidates_recording_idx;
