-- The keyframe baseline: the exact CropKeyframe[] a draft was rendered with.
--
-- Without this, a correction's "before" is RE-DERIVED from playhub_crop_detections
-- rather than being the thing the admin actually looked at. That cache drifts — it was
-- invalidated and re-run for 167 CFA clips on 2026-07-21 — so a re-derived baseline can
-- already disagree with the rendered draft, which would silently corrupt the diff.
--
-- Columns are added here (not with the Batch writer change) so the feedback route can
-- prefer the fact over the fallback from day one; the writer simply starts filling them.
--
-- Deliberately NOT backfilled: the 1,996 existing rows cannot recover their true
-- baseline, and a re-derived backfill is precisely the lie this column exists to remove.
-- Old rows keep baseline_origin='session_detect'; new renders get the fact.

set local lock_timeout = '3s';

alter table public.playhub_portrait_renders
  add column if not exists keyframes jsonb,
  add column if not exists scene_changes jsonb;

comment on column public.playhub_portrait_renders.keyframes is
  'The exact CropKeyframe[] this draft was rendered with — the FACT that human corrections are diffed against. Null on rows rendered before 2026-07-21 (and on error rows); consumers must fall back and flag baseline_origin=session_detect.';
