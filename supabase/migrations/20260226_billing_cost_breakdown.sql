-- Replace single fixed_cost_per_recording with proper cost breakdown:
-- fixed_cost_eur: PLAYBACK's infrastructure cost per recording (in EUR)
-- ambassador_pct: percentage of recording price paid to ambassadors

ALTER TABLE playhub_venue_billing_config
  ADD COLUMN IF NOT EXISTS fixed_cost_eur NUMERIC(10,3) DEFAULT 9.710,
  ADD COLUMN IF NOT EXISTS ambassador_pct NUMERIC(5,2) DEFAULT 10.00;
