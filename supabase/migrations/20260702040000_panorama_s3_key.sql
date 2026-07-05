-- Additive: a raw, pre-auto-follow panorama copy of a recording, ingested
-- ALONGSIDE the existing auto-follow render, to power the pannable
-- PanoramaPlayer ("look around the pitch") on the watch page.
--
-- Prod-safe by design:
--   * Nullable column — every existing row stays NULL and is unaffected.
--   * `s3_key` (the auto-follow / produced video) is NOT touched; the two
--     sources coexist so the watch page can offer an Auto-follow ⟷ Panorama
--     toggle, defaulting to the current auto-follow behavior.
--   * No RLS/policy change — the column inherits playhub_match_recordings'
--     existing row-level security.

alter table public.playhub_match_recordings
  add column if not exists panorama_s3_key text;

comment on column public.playhub_match_recordings.panorama_s3_key is
  'S3 key of the raw wide panorama (pre-auto-follow) render, ingested alongside s3_key. When present, the watch page offers the pannable PanoramaPlayer via a mode toggle. NULL = no panorama available (default / existing recordings).';
