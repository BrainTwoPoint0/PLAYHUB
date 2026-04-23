-- Phase 2: Venue billing schema
-- Enables tracking what venues owe and generating invoices
-- NUMERIC(10,3) because KWD uses 3 decimal places (1 KWD = 1000 fils)

-- Venue billing configuration
CREATE TABLE playhub_venue_billing_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID UNIQUE NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  billing_model TEXT DEFAULT 'per_recording'
    CHECK (billing_model IN ('per_recording', 'flat_monthly', 'none')),
  default_billable_amount NUMERIC(10,3) DEFAULT 5.000,
  currency TEXT DEFAULT 'KWD'
    CHECK (currency IN ('KWD', 'GBP', 'USD', 'EUR')),
  -- Profit share: venue collects full price, owes PLAYHUB its portion
  fixed_cost_per_recording NUMERIC(10,3) DEFAULT 0.000,  -- PLAYBACK's fixed costs per recording
  venue_profit_share_pct NUMERIC(5,2) DEFAULT 30.00,      -- venue's % of profit (revenue - fixed costs)
  stripe_customer_id TEXT,
  daily_recording_target INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Monthly invoices (net settlement between PLAYHUB and venue)
CREATE TABLE playhub_venue_invoices (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  -- Breakdown: venue-collected recordings → venue owes PLAYHUB
  venue_collected_count INTEGER DEFAULT 0,
  venue_collected_revenue NUMERIC(10,3) DEFAULT 0,
  venue_owes_playhub NUMERIC(10,3) DEFAULT 0,
  -- Breakdown: PLAYHUB-collected recordings → PLAYHUB owes venue
  playhub_collected_count INTEGER DEFAULT 0,
  playhub_collected_revenue NUMERIC(10,3) DEFAULT 0,
  playhub_owes_venue NUMERIC(10,3) DEFAULT 0,
  -- Net: positive = venue owes PLAYHUB, negative = PLAYHUB owes venue
  net_amount NUMERIC(10,3) NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'KWD',
  stripe_invoice_id TEXT UNIQUE,
  status TEXT DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'paid', 'void', 'overdue')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(organization_id, period_start, period_end)
);

-- Add billable tracking columns to existing recordings table
ALTER TABLE playhub_match_recordings
  ADD COLUMN IF NOT EXISTS is_billable BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS billable_amount NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS billable_currency TEXT DEFAULT 'KWD',
  -- Who collected payment: determines which direction money flows
  -- 'venue' = venue collected (e.g. reception, QR/Apple Pay on-site) → venue owes PLAYHUB its share
  -- 'playhub' = PLAYHUB collected (e.g. online sale through platform) → PLAYHUB owes venue its share
  ADD COLUMN IF NOT EXISTS collected_by TEXT DEFAULT 'venue'
    CHECK (collected_by IN ('venue', 'playhub'));

-- RLS
ALTER TABLE playhub_venue_billing_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE playhub_venue_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Venue admins can read their billing config"
  ON playhub_venue_billing_config FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE profile_id IN (SELECT id FROM profiles WHERE user_id = auth.uid())
      AND role IN ('club_admin', 'league_admin') AND is_active = true
    )
  );

CREATE POLICY "Venue admins can read their invoices"
  ON playhub_venue_invoices FOR SELECT USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE profile_id IN (SELECT id FROM profiles WHERE user_id = auth.uid())
      AND role IN ('club_admin', 'league_admin') AND is_active = true
    )
  );
