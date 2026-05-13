-- Display-only price string shown on the PLAYBACK landing page team picker.
-- Stripe stays canonical for the actual amount charged at checkout — this is
-- pure marketing copy ("£15/month", "From £20/mo", etc.) so the parent can
-- see cost-of-entry before they click. Nullable: if not set, the UI omits
-- the price line and parents see the real number on Stripe Checkout.
ALTER TABLE public.playhub_academy_config
  ADD COLUMN display_price text;

COMMENT ON COLUMN public.playhub_academy_config.display_price IS
  'Display-only price string for the landing page team picker (e.g. "£15/month"). Stripe is canonical at checkout.';

-- Length cap (defense in depth): the value renders on a public,
-- unauthenticated page. A 50MB blob would tank the landing-page render even
-- though there's no XSS path (React auto-escapes; never use
-- dangerouslySetInnerHTML for this column).
ALTER TABLE public.playhub_academy_config
  ADD CONSTRAINT playhub_academy_config_display_price_length_chk
  CHECK (display_price IS NULL OR length(display_price) <= 64);
