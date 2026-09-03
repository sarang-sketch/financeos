/** The API adapter over the Authorization_Service (task 26.2). */
import { describe, expect, it } from 'vitest';

import {
  AuthorizationScopeError,
  PermissionDeniedError,
  type AuthorizationService,
} from '@/authz/authorization-service';
import type { Permission } from '@/authz/permissions';

import { createApiAuthorizationGate } from './authorization';
import type { ApiSession } from './session';
import { ApiPermissionDeniedError } from './slice-one';

const SESSION = Object.freeze({
  access_token: 'header.payload.signature',
  tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  user_id: '11111111-1111-4111-8111-111111111111',
  permissions: ['view_financial_data'] as readonly Permission[],
}) as ApiSession;

interface Call {
  readonly kind: 'require' | 'requireAny';
  readonly required: Permission | readonly Permission[];
  readonly action: string | undefined;
}

function service(behaviour: 'grant' | 'deny' | 'scope_error'): {
  readonly calls: Call[];
  readonly service: AuthorizationService;
} {
  const calls: Call[] = [];
  function answer(required: Permission | readonly Permission[]): Promise<void> {
    if (behaviour === 'deny') return Promise.reject(new PermissionDeniedError(required, 'act'));
    if (behaviour === 'scope_error') {
      return Promise.reject(new AuthorizationScopeError('unscoped session'));
    }
    return Promise.resolve();
  }
  return {
    calls,
    service: {
      require(_session, permission, action) {
        calls.push({ kind: 'require', required: permission, action });
        return answer(permission);
      },
      requireAny(_session, permissions, action) {
        calls.push({ kind: 'requireAny', required: permissions, action });
        return answer([...permissions]);
      },
      permissionsFor() {
        return Promise.resolve([]);
      },
    },
  };
}

describe('createApiAuthorizationGate', () => {
  it('sends a single Permission through require with the route action', async () => {
    const backing = service('grant');
    const gate = createApiAuthorizationGate(backing.service);

    await gate.require(SESSION, 'view_financial_data', 'view_control_tower_metrics');

    expect(backing.calls).toEqual([
      {
        kind: 'require',
        required: 'view_financial_data',
        action: 'view_control_tower_metrics',
      },
    ]);
  });

  it('sends an or-route through requireAny', async () => {
    const backing = service('grant');
    const gate = createApiAuthorizationGate(backing.service);

    await gate.require(SESSION, ['manage_credentials', 'run_agents'], 'start_ingestion');

    expect(backing.calls[0]?.kind).toBe('requireAny');
    expect(backing.calls[0]?.required).toEqual(['manage_credentials', 'run_agents']);
  });

  it('translates a denial into the transport error naming the required Permission', async () => {
    const gate = createApiAuthorizationGate(service('deny').service);

    let thrown: unknown;
    try {
      await gate.require(SESSION, 'approve_sensitive_actions', 'approve_proposal');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiPermissionDeniedError);
    expect((thrown as ApiPermissionDeniedError).required).toBe('approve_sensitive_actions');
  });

  it('propagates a scope defect rather than dressing it as a denial', async () => {
    const gate = createApiAuthorizationGate(service('scope_error').service);

    await expect(gate.require(SESSION, 'view_financial_data', 'act')).rejects.toThrow(
      AuthorizationScopeError,
    );
  });
});
