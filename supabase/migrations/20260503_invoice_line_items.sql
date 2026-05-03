-- 20260503_invoice_line_items.sql
--
-- Adds playhub_invoice_line_items: per-recording cost-basis snapshots written
-- when generateMonthlyInvoice() finalises an invoice. Freezes the values used
-- in profit-share math so future edits to billing config or recording prices
-- cannot move closed periods.
--
-- Also tightens the venue billing-config currency CHECK and adds a unique
-- constraint on (organization_id, period_start, period_end) so two parallel
-- invoice generations cannot both pass the read-then-write duplicate-check.

-- ─── 1. Tighten currency CHECK to match the application code ──────────
--   generateMonthlyInvoice currently throws on anything other than KWD/EUR/AED.
--   Tighten the constraint to match — GBP/USD venues do not exist today and
--   adding them later is a one-line ALTER alongside the code branch.
ALTER TABLE playhub_venue_billing_config
  DROP CONSTRAINT IF EXISTS playhub_venue_billing_config_currency_check;

ALTER TABLE playhub_venue_billing_config
  ADD CONSTRAINT playhub_venue_billing_config_currency_check
  CHECK (currency IN ('KWD', 'EUR', 'AED'));

-- ─── 2. Atomic duplicate guard on invoices ────────────────────────────
--   The generator does a maybeSingle() duplicate check then INSERT. Two
--   parallel callers (Lambda cron + admin retry) can both pass the read
--   and both insert. A unique index makes the insert serialisable: the
--   second caller hits a unique violation and bails before any Stripe
--   call, so we never end up with two rows for the same period.
CREATE UNIQUE INDEX IF NOT EXISTS playhub_venue_invoices_org_period_uniq
  ON playhub_venue_invoices(organization_id, period_start, period_end);

-- ─── 3. New table: playhub_invoice_line_items ─────────────────────────
CREATE TABLE IF NOT EXISTS playhub_invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES playhub_venue_invoices(id) ON DELETE CASCADE,

  -- Recording reference (nullable so we can keep the line item if the source
  -- recording is later hard-deleted; the snapshot is the source of truth).
  recording_id UUID REFERENCES playhub_match_recordings(id) ON DELETE SET NULL,

  -- Snapshotted recording metadata (frozen at invoice time)
  recording_title TEXT,
  recording_match_date TIMESTAMPTZ,
  duration_seconds INTEGER NOT NULL,

  -- Money: every figure stored in the venue's local currency (matches
  -- the invoice currency). 3 decimals fits KWD/BHD/JOD/OMR/TND; 2-decimal
  -- currencies like AED simply ignore the trailing fractional digit.
  billable_amount NUMERIC(12, 3) NOT NULL,
  fixed_cost_local NUMERIC(12, 3) NOT NULL,
  ambassador_fee NUMERIC(12, 3) NOT NULL,
  currency TEXT NOT NULL,
  collected_by TEXT NOT NULL,

  -- Audit: the EUR per-hour figure used as input + the FX rate that produced
  -- fixed_cost_local. Useful for rebuilding numbers if a downstream caller
  -- needs to re-derive them.
  fixed_cost_eur_per_hour NUMERIC(10, 4),
  fx_rate NUMERIC(12, 6),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT playhub_invoice_line_items_collected_by_check
    CHECK (collected_by IN ('venue', 'playhub')),
  CONSTRAINT playhub_invoice_line_items_currency_check
    CHECK (currency IN ('KWD', 'EUR', 'AED')),
  CONSTRAINT playhub_invoice_line_items_duration_check
    CHECK (duration_seconds > 0)
);

CREATE INDEX IF NOT EXISTS idx_playhub_invoice_line_items_invoice
  ON playhub_invoice_line_items(invoice_id);

CREATE INDEX IF NOT EXISTS idx_playhub_invoice_line_items_recording
  ON playhub_invoice_line_items(recording_id)
  WHERE recording_id IS NOT NULL;

-- One snapshot per (invoice, recording). A retry that bypassed the invoice
-- duplicate-check (e.g. by deleting the draft row) cannot insert two snapshot
-- sets for the same recording.
CREATE UNIQUE INDEX IF NOT EXISTS playhub_invoice_line_items_invoice_recording_uniq
  ON playhub_invoice_line_items(invoice_id, recording_id)
  WHERE recording_id IS NOT NULL;

-- ─── 4. RLS ───────────────────────────────────────────────────────────
ALTER TABLE playhub_invoice_line_items ENABLE ROW LEVEL SECURITY;

-- Mirror the parent invoice policy: anyone who can read the invoice can read
-- the line items for that invoice. Uses the existing is_org_member() helper
-- (SECURITY DEFINER, default role set: admin/club_admin/league_admin/manager).
CREATE POLICY "Venue admins can read their invoice line items"
  ON playhub_invoice_line_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM playhub_venue_invoices i
      WHERE i.id = playhub_invoice_line_items.invoice_id
        AND is_org_member(i.organization_id)
    )
  );

-- No INSERT/UPDATE/DELETE policy — writes happen exclusively via the service
-- role inside generateMonthlyInvoice(). Service role bypasses RLS, end users
-- can never mutate cost-basis snapshots.

COMMENT ON TABLE playhub_invoice_line_items IS
  'Per-recording cost-basis snapshots, written at invoice generation time. Immutable after insert.';
