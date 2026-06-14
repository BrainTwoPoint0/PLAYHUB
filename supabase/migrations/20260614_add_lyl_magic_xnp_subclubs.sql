-- Add two LYL subclubs that were missing from the original pilot seed:
--   Magic FC  — surfaced by "Chosen One U11 vs. Magic U11" failing to parse
--   XNP       — surfaced by "ELA U11 vs. XNP U11" failing to parse
--
-- Both recordings landed in `unparseable` because the away club had no row
-- in playhub_academy_subclubs, so the LYL sync threw unknown_subclub and no
-- Veo folder was created. The same missing row also hid each club from the
-- /academy/lyl subscription picker (the picker reads this table).
--
-- Convention mirrors 20260515110000_seed_lyl_pilot.sql:
--   - sort_order continues the +10 spacing after rockslane-chiswick (180).
--   - display_name uses the abbreviation the club brands itself with (same
--     as TAA / RPT / DBX), so the "XNP U11" / "Magic" tokens in Veo titles
--     substring-match. ("Magic" is bridged to "Magic FC" via SUBCLUB_ALIASES
--     in src/lib/lyl-sync/orchestrator.ts.)
--   - veo_club_slug = NULL: Veo is set up in parallel; an UPDATE plugs it in
--     once each club has a Veo club (B1 fail-soft until then).
--   - logo_url = NULL: graphic-package assets uploaded separately later.
--
-- Idempotent: ON CONFLICT DO NOTHING, safe to re-run.

INSERT INTO public.playhub_academy_subclubs (
    club_slug,
    subclub_slug,
    display_name,
    logo_url,
    veo_club_slug,
    sort_order,
    is_active
) VALUES
    ('lyl', 'magic-fc', 'Magic FC', NULL, NULL, 190, true),
    ('lyl', 'xnp',      'XNP',      NULL, NULL, 200, true)
ON CONFLICT (club_slug, subclub_slug) DO NOTHING;
