-- Sub-anchors on goal candidates (hybrid adopted from the episode-split
-- measurement, RESULTS.md §"EPISODE SPLIT MEASURED"): one entry per
-- dead->live cycle inside the merged episode — the first peak of each cycle.
-- Review HINTS only: the strip offers a one-click stamp at sub_anchor - 20s
-- through the existing multi-goal add_goal path; nothing auto-approves.
-- Nullable: rows written before the port stay NULL and render no hints.
alter table public.playhub_goal_candidates
  add column if not exists sub_anchors_s numeric[];

comment on column public.playhub_goal_candidates.sub_anchors_s is
  'First kickoff peak of each dead->live cycle within the episode (seconds, '
  'ascending; [0] = anchor_s). Reviewer hint chips stamp at value - 20s via '
  'add_goal. NULL on pre-hybrid rows.';
