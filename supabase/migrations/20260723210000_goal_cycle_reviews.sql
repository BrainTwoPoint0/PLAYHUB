-- Per-cycle yes/no review pilot (reviewer-side, AGREED PLAN item 1d):
-- a merged goal-detect episode holds N dead->live cycles (sub_anchors_s);
-- the strip lets the reviewer answer "goal in this cycle?" per cycle while
-- the episode clip seeks to each one. Verdicts are LABELS for the queued
-- goal-moment refiner (negative cycle labels are the scarce class) plus a
-- review-speed timing corpus — they NEVER touch episode review state
-- (playhub_goal_candidates.status is written only by the existing actions).
--
-- Keyed (candidate_id, cycle_anchor_s): cycle identity is the stored
-- sub-anchor value (numeric, 2dp as written by the batch job). Re-verdicts
-- overwrite; clearing deletes the row. candidate FK cascades — a candidate
-- hard-delete takes its cycle labels with it (superseded rows flip to
-- status='error' and KEEP their labels, tied to detector_version there).

set local lock_timeout = '3s';

create table public.playhub_goal_cycle_reviews (
  candidate_id uuid not null
    references public.playhub_goal_candidates(id) on delete cascade,
  cycle_anchor_s numeric not null,
  verdict text not null check (verdict in ('goal', 'no_goal')),
  reviewed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (candidate_id, cycle_anchor_s)
);

alter table public.playhub_goal_cycle_reviews enable row level security;
-- deny-all: no policies. Service-role, platform-admin-gated API routes are
-- the only access path (same posture as playhub_goal_candidates).

comment on table public.playhub_goal_cycle_reviews is
  'Per-cycle goal/no_goal reviewer verdicts on goal-detect candidates (refiner label pilot). Keyed by the stored sub-anchor value. Never drives candidate status. RLS deny-all; service-role routes only.';
comment on column public.playhub_goal_cycle_reviews.cycle_anchor_s is
  'The cycle''s sub-anchor (seconds, 2dp) — must be a member of the candidate''s sub_anchors_s at verdict time (route-validated).';

-- Clip-truncation badge substrate (item 1b): the batch job records the
-- planned encoded clip duration so the strip can tell exactly where the
-- review clip ends vs the episode span. NULL on rows written before this
-- ships — those clips were all cut at the fixed 300s cap, which the client
-- uses as the legacy fallback.
alter table public.playhub_goal_candidates
  add column if not exists clip_span_s numeric;

comment on column public.playhub_goal_candidates.clip_span_s is
  'Encoded review-clip duration in seconds (planned, deterministic from t0/t1 + the producer''s clip constants). NULL = pre-adaptive row (fixed 300s cap).';
