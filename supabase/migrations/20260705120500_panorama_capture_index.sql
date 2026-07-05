-- Partial index for the raw-VP capture rate-limiter. The panorama-source route
-- runs a global in-flight COUNT (WHERE panorama_capture_status='pending' AND
-- panorama_capture_started_at > cutoff) plus the compare-and-set's stuck-check on
-- every trigger. This partial index (in-flight rows only — normally near-zero)
-- serves both cheaply without touching the rest of the hot table.
--
-- MUST be its own migration with no other statements: CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block, and the Supabase CLI won't wrap a lone
-- concurrent-index statement.

create index concurrently if not exists idx_pmr_panorama_pending
  on public.playhub_match_recordings (panorama_capture_started_at)
  where panorama_capture_status = 'pending';
