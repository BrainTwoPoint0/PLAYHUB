-- Phase 1: Move academy config from hardcoded to database
-- This allows adding new academies/leagues without code deploys

CREATE TABLE playhub_academy_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  club_slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  stripe_product_id TEXT NOT NULL,
  additional_stripe_product_ids TEXT[] DEFAULT '{}',
  veo_club_slug TEXT,
  organization_id UUID REFERENCES organizations(id),
  logo_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed existing academies
INSERT INTO playhub_academy_config (club_slug, name, stripe_product_id, additional_stripe_product_ids, veo_club_slug)
VALUES
  ('cfa', 'PLAYBACK Academy - CFA', 'prod_RWhRQ4wM3PiEBJ', '{}', 'playback-15fdc44b'),
  ('sefa', 'PLAYBACK Academy - SEFA', 'prod_QiMBPC4wf4nff1', '{prod_Qyv9ID1M0sCowi,prod_QuA6axz11zTGbw}', 'soccer-elite-fa-0b0814d2');

-- RLS: authenticated users can read
ALTER TABLE playhub_academy_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read academy config"
  ON playhub_academy_config FOR SELECT TO authenticated USING (true);
