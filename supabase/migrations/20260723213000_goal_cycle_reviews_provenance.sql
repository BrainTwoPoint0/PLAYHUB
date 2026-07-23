-- Provenance stamp for per-cycle verdicts (security review M1): a batch
-- re-detection rewrites a draft candidate's sub_anchors_s/detector_version
-- IN PLACE, leaving verdict rows keyed by old anchors silently attributed
-- to the new detector. Labels are statements about MATCH MOMENTS (still
-- true across detector versions — never deleted), but the refiner corpus
-- needs to know which artifact epoch each label was judged against. The
-- route stamps both from the candidate row at verdict time.

set local lock_timeout = '3s';

alter table public.playhub_goal_cycle_reviews
  add column if not exists detector_version text,
  add column if not exists artifact_digest text;

comment on column public.playhub_goal_cycle_reviews.detector_version is
  'The candidate''s detector_version at verdict time (stamped by the route). A mismatch with the candidate''s current value marks a pre-re-detection label.';
comment on column public.playhub_goal_cycle_reviews.artifact_digest is
  'The candidate''s artifact_digest at verdict time (stamped by the route).';
