-- Review-first goal candidates for Spiideo recordings, written by the
-- goal-detect Batch job (frozen chain, Veo-freeze-validated 2026-07-21).
-- ~0.31 precision by design: a human (platform admin during the pilot)
-- reviews the clip strip; APPROVE inserts a `goal` row into
-- playhub_recording_events (source='ai_detected',
-- provider_event_id = this candidate's id) and stamps approved_event_id
-- back here. Clips live in the PRIVATE `goal-review-clips` storage bucket
-- (signed URLs only; created as a deploy step — buckets are not migrated).
--
-- Same protection model as playhub_portrait_renders: RLS deny-all (service
-- role only via admin-gated API routes); the batch job's writes CAS on
-- status in (draft, error) so a review decision is never clobbered by a
-- re-run. approved_event_id is a PLAIN uuid, deliberately NOT an FK
-- (2026-07-07 audit-log lesson: FKs into rows with independent lifecycles
-- make deletes fail in surprising places).
--
--   draft    → awaiting review
--   approved → goal event written (approved_event_id set; NULL = the event
--              insert failed mid-flight and a second APPROVE repairs it)
--   rejected → reviewed, not a goal
--   error    → superseded by re-detection (or write failure)

set local lock_timeout = '3s';

create table public.playhub_goal_candidates (
  id uuid primary key default gen_random_uuid(),
  match_recording_id uuid not null
    references public.playhub_match_recordings(id) on delete cascade,
  t0_s numeric not null,
  t1_s numeric not null,
  anchor_s numeric not null,
  pko numeric,
  deadctx numeric,
  p_period numeric,
  clip_path text,
  status text not null default 'draft'
    check (status in ('draft', 'approved', 'rejected', 'error')),
  error text,
  approved_event_id uuid,
  reviewed_by uuid,
  reviewed_at timestamptz,
  detector_version text not null,
  artifact_digest text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- concurrency backstop only: re-run reconciliation matches episodes by
  -- ±45s proximity in the job; two distinct episodes can't share an anchor
  unique (match_recording_id, anchor_s)
);

create index playhub_goal_candidates_recording_idx
  on public.playhub_goal_candidates (match_recording_id, anchor_s);

alter table public.playhub_goal_candidates enable row level security;
-- deny-all: no policies. Service-role, platform-admin-gated API routes are
-- the only access path (portrait-renders model).

comment on table public.playhub_goal_candidates is
  'Review-first goal candidates from the goal-detect Batch job (frozen chain, ~0.31 precision by design). Reviewed via platform-admin API; approve writes a goal event into playhub_recording_events. RLS deny-all.';
comment on column public.playhub_goal_candidates.anchor_s is
  'Detected kickoff instant (s, produced-video clock). The goal itself precedes it — the review clip runs [t0-90s, t1+8s]; the approved event timestamp is anchor-20s (Veo-measured median goal→kickoff latency).';
comment on column public.playhub_goal_candidates.approved_event_id is
  'playhub_recording_events.id written on approve. Plain uuid, NOT an FK. approved+NULL = repair state (event insert failed; approve again to finish).';
