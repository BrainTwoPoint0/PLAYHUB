-- playhub_audit_log.target_recording_id had ON DELETE SET NULL, but the
-- append-only guard trigger (playhub_audit_log_no_mutation) blocks ALL
-- updates — including the FK's own SET NULL. Net effect: any recording
-- with an audit entry could never be deleted ("playhub_audit_log is
-- append-only (op=UPDATE)"), which is how zombie rows were born.
--
-- Drop the FK entirely. An append-only audit trail should keep the
-- historical UUID of a deleted recording, not null it out; the audit API
-- already resolves recordings via a separate lookup and tolerates
-- dangling ids (target_recording resolves to null).
ALTER TABLE playhub_audit_log
  DROP CONSTRAINT IF EXISTS playhub_audit_log_target_recording_id_fkey;
