import { describe, expect, it, vi } from 'vitest';

import { subscribeToAttentionPanelRealtime } from './attention-panel-realtime';

const TENANT = '11111111-1111-4111-8111-111111111111';

interface Registration {
  readonly type: string;
  readonly filter: Record<string, string>;
  readonly callback: () => void;
}

function channel(name: string) {
  const registrations: Registration[] = [];
  const value = {
    name,
    registrations,
    on(type: string, filter: Record<string, string>, callback: () => void) {
      registrations.push({ type, filter, callback });
      return value;
    },
    subscribe() {
      return value;
    },
  };
  return value;
}

describe('Attention Panel Realtime subscription', () => {
  it('subscribes to Tenant-scoped Exception changes and every ingestion run broadcast', () => {
    const channels: ReturnType<typeof channel>[] = [];
    const removeChannel = vi.fn(() => Promise.resolve('ok'));
    const client = {
      channel(name: string) {
        const created = channel(name);
        channels.push(created);
        return created;
      },
      removeChannel,
    };
    const changed = vi.fn();

    const unsubscribe = subscribeToAttentionPanelRealtime(client as never, TENANT, changed);

    expect(channels.map((entry) => entry.name)).toEqual([
      `attention_panel:exceptions:${TENANT}`,
      `ingestion_runs:${TENANT}`,
    ]);
    expect(channels[0]?.registrations[0]).toMatchObject({
      type: 'postgres_changes',
      filter: {
        event: '*',
        schema: 'public',
        table: 'exceptions',
        filter: `tenant_id=eq.${TENANT}`,
      },
    });
    expect(channels[1]?.registrations.map((entry) => entry.filter.event)).toEqual([
      'run_started',
      'object_type_completed',
      'run_completed',
    ]);

    channels[0]?.registrations[0]?.callback();
    channels[1]?.registrations[2]?.callback();
    expect(changed).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(removeChannel).toHaveBeenCalledTimes(2);
  });
});
