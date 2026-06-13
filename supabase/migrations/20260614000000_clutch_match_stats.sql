-- Headline padel stats denormalized at publish time by the clutch-sync
-- Lambda (whitelisted extraction from Clutch's match.json — see
-- infrastructure/lambda/clutch-sync/match-stats.ts for the exact shape).
-- NULL = no stats (empty court, mirror failure, or pre-feature row).
-- Venue aggregates read this column only — never S3 — so the venue
-- padel dashboard is pure Postgres.
ALTER TABLE playhub_match_recordings
  ADD COLUMN IF NOT EXISTS clutch_match_stats jsonb;
