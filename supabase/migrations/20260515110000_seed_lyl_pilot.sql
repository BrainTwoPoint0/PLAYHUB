-- Seed: London Youth League (LYL) pilot — Checkpoint E.2 go-live data.
--
-- 1× academy_config row for the LYL umbrella + 16× subclub rows for the
-- member clubs the user confirmed via the picker. No age-group teams yet
-- — those land once Veo has finished setting up each subclub's Veo club
-- (today every subclub row carries veo_club_slug = NULL; provisioning is
-- gated on this field per provision.ts → fail-soft as `config_no_veo_club`).
--
-- Stripe: one shared product + price for the pilot
--   Product: prod_UWTKVA9puNn4E9 (LYL Academy Subscription)
--   Price  : price_1TXQNhGeCTeSkDl9tDyPzGJy (£15/month, recurring)
-- The checkout flow picks the first active recurring price on the product,
-- so editing the price in the Stripe dashboard requires no code change.
--
-- All logo URLs point at the public `graphic-packages` bucket and are
-- already on PLAYBACK's next.config.mjs `images.remotePatterns` allowlist
-- via the existing `zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/**`
-- entry — no Next config change required.
--
-- Idempotent: ON CONFLICT clauses on both tables let this migration re-run
-- safely (e.g. after rollback). Uses ON CONFLICT (club_slug) DO NOTHING for
-- the config row and ON CONFLICT (club_slug, subclub_slug) DO NOTHING for
-- subclubs — never overwrites operator edits made via the dashboard.

-- ============================================================================
-- 1. LYL umbrella config
-- ============================================================================
-- veo_club_slug = NULL: the league has no single Veo club; each subclub has
-- its own. provision.ts honours this — it ONLY consults the config-level
-- veoClubSlug for flat configs (CFA, SEFA), and consults the subclub row's
-- veo_club_slug when registration_subclub is set on the subscription row.

INSERT INTO public.playhub_academy_config (
    club_slug,
    name,
    stripe_product_id,
    veo_club_slug,
    logo_url,
    display_price,
    is_active
) VALUES (
    'lyl',
    'London Youth League',
    'prod_UWTKVA9puNn4E9',
    NULL,
    'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-league.jpg',
    '£15/month',
    true
)
ON CONFLICT (club_slug) DO NOTHING;

-- ============================================================================
-- 2. 16 LYL subclubs
-- ============================================================================
-- sort_order spaced by 10 so future inserts can squeeze between without
-- renumbering. Display names use the canonical spellings the user
-- confirmed in the picker session (N.S.F.C with the dots; Project 1v1
-- without spaces around the v; ELA / DBX / RPT all caps because that's
-- how each club brands itself).
--
-- veo_club_slug = NULL on every row: Veo is being set up in parallel.
-- Once each subclub has a Veo club, an UPDATE will plug it in, and the
-- next provisioning attempt will succeed (B1 fail-soft until then).

INSERT INTO public.playhub_academy_subclubs (
    club_slug,
    subclub_slug,
    display_name,
    logo_url,
    veo_club_slug,
    sort_order,
    is_active
) VALUES
    ('lyl', 'barnes-eagles',     'Barnes Eagles',     'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-barnes-eagles.webp', NULL,  10, true),
    ('lyl', 'champs-fc',         'Champs FC',         'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-champs-fc.jpg',     NULL,  20, true),
    ('lyl', 'chosen-one',        'Chosen One',        'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-chosen-one.png',    NULL,  30, true),
    ('lyl', 'dbx',               'DBX',               'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-dbx.jpg',           NULL,  40, true),
    ('lyl', 'ela',               'ELA',               'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-ela.jpg',           NULL,  50, true),
    ('lyl', 'fc-juniors',        'FC Juniors',        'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-fc-juniors.jpg',    NULL,  60, true),
    ('lyl', 'jsfc',              'JSFC',              'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-jsfc.jpg',          NULL,  70, true),
    ('lyl', 'lfs',               'LFS',               'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-lfs.png',           NULL,  80, true),
    ('lyl', 'london-thames',     'London Thames',     'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-london-thames.jpg', NULL,  90, true),
    ('lyl', 'national-harrow',   'National Harrow',   'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-national-harrow.png', NULL, 100, true),
    ('lyl', 'nsfc',              'N.S.F.C',           'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-nsfc.png',          NULL, 110, true),
    ('lyl', 'project-1v1',       'Project 1v1',       'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-project-1v1.jpg',   NULL, 120, true),
    ('lyl', 'roehampton-elite',  'Roehampton Elite',  'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-roehampton-elite.jpg', NULL, 130, true),
    ('lyl', 'rpt',               'RPT',               'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-rpt.jpg',           NULL, 140, true),
    ('lyl', 'storm-elite',       'Storm Elite',       'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-storm-elite.jpg',   NULL, 150, true),
    ('lyl', 'taa',               'TAA',               'https://zfaadonrmgfxnwzyudxi.supabase.co/storage/v1/object/public/graphic-packages/lyl/lyl-taa.jpg',           NULL, 160, true)
ON CONFLICT (club_slug, subclub_slug) DO NOTHING;
