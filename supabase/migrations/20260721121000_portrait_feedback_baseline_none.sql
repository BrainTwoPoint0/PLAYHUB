-- Allow an honest "no baseline was available" provenance.
--
-- Previously a row with no resolvable baseline was still stamped 'session_detect',
-- which is a FALSE provenance claim: the diff would then count every keyframe as
-- "added", fabricating a maximal-correction signal indistinguishable from a genuine
-- full manual rewrite. Recording 'none' (with diff null) keeps the label honest.
set local lock_timeout = '3s';

alter table public.playhub_portrait_render_feedback
  drop constraint if exists valid_prf_baseline;

alter table public.playhub_portrait_render_feedback
  add constraint valid_prf_baseline
  check (baseline_origin in ('render_row', 'session_detect', 'none'));
