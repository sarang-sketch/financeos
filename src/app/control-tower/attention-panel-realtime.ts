import type { SupabaseClient } from '@supabase/supabase-js';

import type { TenantId } from '@/config/configuration-service';

/** Must match the server publisher's `ingestion_runs:${tenantId}` channel contract. */
function ingestionRunChannel(tenantId: TenantId): string {
  return `ingestion_runs:${tenantId}`;
}

/** Subscribe to authoritative Exception and Ingestion_Run changes; no timer or polling. */
export function subscribeToAttentionPanelRealtime(
  client: SupabaseClient,
  tenantId: TenantId,
  onChange: () => void,
): () => void {
  const notify = () => {
    onChange();
  };
  const exceptions = client
    .channel(`attention_panel:exceptions:${tenantId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'exceptions',
        filter: `tenant_id=eq.${tenantId}`,
      },
      notify,
    )
    .subscribe();

  const runs = client
    .channel(ingestionRunChannel(tenantId))
    .on('broadcast', { event: 'run_started' }, notify)
    .on('broadcast', { event: 'object_type_completed' }, notify)
    .on('broadcast', { event: 'run_completed' }, notify)
    .subscribe();

  return () => {
    void client.removeChannel(exceptions);
    void client.removeChannel(runs);
  };
}
