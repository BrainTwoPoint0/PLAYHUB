-- Append-only audit log for privileged actions in PLAYHUB.
-- Initially captures admin-override deletes/updates of recording_events.
-- Service role writes; reads gated by RLS (no policies = no reads from
-- the user-scoped client; future read endpoint will use service role too).

CREATE TABLE IF NOT EXISTS public.playhub_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Who performed the action. Nullable so an auth.users delete (e.g. GDPR
  -- erasure) cascades to NULL here rather than failing the user delete.
  -- An old audit row with NULL actor reads as "an account that no longer
  -- exists did this" — acceptable; the metadata still captures the target.
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Action code in <entity>.<verb> form, e.g. 'recording_event.delete'.
  -- The CHECK enforces the namespace shape so typos don't fragment the log.
  action TEXT NOT NULL,
  -- Target identification
  target_type TEXT NOT NULL,
  target_id UUID,
  target_recording_id UUID REFERENCES public.playhub_match_recordings(id) ON DELETE SET NULL,
  target_organization_id UUID REFERENCES public.organizations(id) ON DELETE SET NULL,
  -- True when the actor used a privilege override (e.g. venue admin
  -- deleting another user's tag). False for ordinary self-actions.
  was_admin_override BOOLEAN NOT NULL DEFAULT FALSE,
  -- Free-form detail capture: prior values, diff, reason, etc.
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT playhub_audit_log_action_format
    CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  CONSTRAINT playhub_audit_log_metadata_is_object
    CHECK (metadata IS NULL OR jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE public.playhub_audit_log IS
  'Append-only audit log of privileged actions. Insert via service role only; UPDATE/DELETE blocked by trigger.';

-- Lookup by recording (most common future query: "show audit history for this recording")
CREATE INDEX IF NOT EXISTS idx_playhub_audit_log_recording
  ON public.playhub_audit_log(target_recording_id, created_at DESC)
  WHERE target_recording_id IS NOT NULL;

-- Lookup by org (venue audit trail)
CREATE INDEX IF NOT EXISTS idx_playhub_audit_log_org
  ON public.playhub_audit_log(target_organization_id, created_at DESC)
  WHERE target_organization_id IS NOT NULL;

-- Lookup by actor (compliance / investigation)
CREATE INDEX IF NOT EXISTS idx_playhub_audit_log_actor
  ON public.playhub_audit_log(actor_user_id, created_at DESC);

-- Note: deliberately NOT indexing `action` — it's a low-cardinality column
-- (one or two dominant values) and an index would fragment quickly while
-- duplicating the time-ordered scan we already get from sequential storage.
-- Add a partial composite index later if a real query pattern needs it.

-- Lock down: RLS on with explicit deny-all for clarity. Service role
-- bypasses RLS, so the API can still write freely.
ALTER TABLE public.playhub_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "playhub_audit_log_deny_all_user_clients"
  ON public.playhub_audit_log
  FOR ALL
  TO authenticated, anon
  USING (FALSE)
  WITH CHECK (FALSE);

-- Append-only enforcement at the DB layer. Service role can disable the
-- trigger for surgical corrections, but the default is locked. Stops a
-- well-meaning ad-hoc UPDATE in the Supabase SQL editor from rewriting
-- audit history.
CREATE OR REPLACE FUNCTION public.playhub_audit_log_block_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'playhub_audit_log is append-only (op=%)', TG_OP;
END
$$;

CREATE TRIGGER playhub_audit_log_no_mutation
  BEFORE UPDATE OR DELETE OR TRUNCATE ON public.playhub_audit_log
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.playhub_audit_log_block_mutation();
