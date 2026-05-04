// Audit log helper. Inserts into playhub_audit_log via the service-role
// client (RLS allows no user-scoped writes). Errors are logged but never
// thrown — the caller's primary action must NOT fail because audit logging
// failed. The trade-off is that an audit-write outage can lose records;
// for that case we emit a structured console.error so it surfaces in logs
// even when the row isn't durable.

import type { SupabaseClient } from '@supabase/supabase-js'

export type AuditAction =
  | 'recording_event.delete'
  | 'recording_event.update'
  | 'recording_access.grant'
  | 'recording_access.decline'

export interface AuditEntry {
  actorUserId: string
  action: AuditAction
  targetType: string
  targetId?: string | null
  targetRecordingId?: string | null
  targetOrganizationId?: string | null
  wasAdminOverride: boolean
  metadata?: Record<string, unknown> | null
}

export async function recordAuditEvent(
  serviceClient: SupabaseClient,
  entry: AuditEntry
): Promise<void> {
  const { error } = await (serviceClient as any)
    .from('playhub_audit_log')
    .insert({
      actor_user_id: entry.actorUserId,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId ?? null,
      target_recording_id: entry.targetRecordingId ?? null,
      target_organization_id: entry.targetOrganizationId ?? null,
      was_admin_override: entry.wasAdminOverride,
      metadata: entry.metadata ?? null,
    })
  if (error) {
    console.error('audit_log insert failed', {
      action: entry.action,
      target_id: entry.targetId,
      error: error.message,
    })
  }
}
