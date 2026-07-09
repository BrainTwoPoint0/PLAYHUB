-- 20260709120500_invoice_line_items_share.sql
--
-- Evolves playhub_invoice_line_items from the cost-recovery model to the
-- "partner share of gross" model introduced by the Li3ib Post-Pilot Annex.
--
-- New snapshot columns freeze, per recording, the sport, gross amount, the
-- partner share % that applied that month, and the resulting split. Frozen at
-- invoice generation so later edits to camera counts / recordings cannot move
-- closed periods (same immutability guarantee the old cost columns had).
--
-- The legacy cost-recovery columns (fixed_cost_local, ambassador_fee, and the
-- audit pair fixed_cost_eur_per_hour / fx_rate) are KEPT so historical invoices
-- remain a faithful record. New rows leave them NULL, so their NOT NULL
-- constraints are dropped.

ALTER TABLE playhub_invoice_line_items
  ADD COLUMN IF NOT EXISTS sport TEXT
    CHECK (sport IS NULL OR sport IN ('football', 'padel')),
  ADD COLUMN IF NOT EXISTS gross_amount      NUMERIC(12, 3)
    CHECK (gross_amount IS NULL OR gross_amount >= 0),
  ADD COLUMN IF NOT EXISTS partner_share_pct NUMERIC(5, 2)
    CHECK (partner_share_pct IS NULL OR partner_share_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS partner_share     NUMERIC(12, 3)
    CHECK (partner_share IS NULL OR partner_share >= 0),
  ADD COLUMN IF NOT EXISTS playback_share    NUMERIC(12, 3)
    CHECK (playback_share IS NULL OR playback_share >= 0);

-- Legacy cost-recovery columns are no longer written for new invoices. Drop the
-- NOT NULL so the rewritten generator can insert NULL, while existing rows keep
-- their frozen historical values untouched.
ALTER TABLE playhub_invoice_line_items
  ALTER COLUMN fixed_cost_local DROP NOT NULL,
  ALTER COLUMN ambassador_fee   DROP NOT NULL;

COMMENT ON COLUMN playhub_invoice_line_items.partner_share_pct IS
  'Partner (group) share % of gross frozen for this recording at invoice time (15 or 5 for tiered groups; 5 flat otherwise).';
COMMENT ON COLUMN playhub_invoice_line_items.fixed_cost_local IS
  'Legacy cost-recovery model. NULL for invoices generated under the partner-share model (annex, 2026-07).';
