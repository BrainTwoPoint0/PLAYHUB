-- Backfill two LYL subclubs that were added to prod via direct INSERT (no
-- migration) between the original pilot seed (20260515110000_seed_lyl_pilot)
-- and now: `forzaskillz` (sort 170) and `rockslane-chiswick` (sort 180).
--
-- Why this exists: `playhub_academy_subclubs` feeds the LYL parser allowlist
-- and the /academy/lyl subscription picker. With these two rows living only in
-- prod, a database rebuilt purely from migrations would be missing them and
-- the allowlist would be wrong. This migration makes prod state reproducible
-- from source. (Flagged by senior-code-reviewer + database-performance-optimizer.)
--
-- Idempotent: ON CONFLICT DO NOTHING — the rows already exist in prod, so this
-- is a no-op there and only matters for fresh rebuilds. logo_url / veo_club_slug
-- are NULL to match current prod state (assets + Veo set up separately).

INSERT INTO public.playhub_academy_subclubs (
    club_slug,
    subclub_slug,
    display_name,
    logo_url,
    veo_club_slug,
    sort_order,
    is_active
) VALUES
    ('lyl', 'forzaskillz',        'Forzaskillz',        NULL, NULL, 170, true),
    ('lyl', 'rockslane-chiswick', 'Rockslane Chiswick', NULL, NULL, 180, true)
ON CONFLICT (club_slug, subclub_slug) DO NOTHING;
