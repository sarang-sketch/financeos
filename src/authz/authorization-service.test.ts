/** FinanceOS_Authorization_Service (task 26.2, Requirement 14.6, 14.9). */
import { describe, expect, it } from 'vitest';

import {
  AuthorizationScopeError,
  createAuthorizationService,
  GRANTED_PERMISSIONS_SQL,
  PermissionDeniedError,
  type AuthorizationDenialSink,
  type PermissionDenialEvent,
  type PermissionReader,
} from './authorization-service';
import { PERMISSION_COUNT, PERMISSIONS } from './permissions';
import type { Session } from './session';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';

const SESSION: Session = { tenant_id: TENANT, user_id: USER };

/** The thrown value, or `undefined` when the call resolved. */
async function thrownBy(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

interface Harness {
  readonly reads: Session[];
  readonly denials: PermissionDenialEvent[];
  readonly service: ReturnType<typeof createAuthorizationService>;
}

function harness(
  grants: readonly unknown[],
  options: { readonly failReads?: boolean; readonly sink?: boolean } = {},
): Harness {
  const reads: Session[] = [];
  const denials: PermissionDenialEvent[] = [];
  let failNext = options.failReads ?? false;
  const permissions: PermissionReader = {
    grantedPermissions(session) {
      reads.push(session);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('read failed'));
      }
      return Promise.resolve(grants);
    },
  };
  const sink: AuthorizationDenialSink = {
    recordDenial(event) {
      denials.push(event);
      return Promise.resolve();
    },
  };
  return {
    reads,
    denials,
    service: createAuthorizationService({
      permissions,
      ...(options.sink === false ? {} : { denials: sink }),
      now: () => new Date('2026-02-01T10:20:30.456Z'),
    }),
  };
}

describe('require', () => {
  it('resolves when the User holds the Permission in the session Tenant', async () => {
    const h = harness(['view_financial_data']);

    await expect(h.service.require(SESSION, 'view_financial_data')).resolves.toBeUndefined();
    expect(h.reads).toEqual([{ tenant_id: TENANT, user_id: USER }]);
  });

  it('denies with the required Permission named, and changes nothing', async () => {
    const h = harness(['view_financial_data']);

    const error = (await thrownBy(
      h.service.require(SESSION, 'approve_sensitive_actions', 'approve_proposal'),
    )) as PermissionDeniedError;

    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect(error.required).toBe('approve_sensitive_actions');
    expect(error.action).toBe('approve_proposal');
    expect(error.message).toContain('approve_sensitive_actions');
  });

  it('records the denial with User, Tenant, Permission, action and timestamp', async () => {
    const h = harness([]);

    await expect(h.service.require(SESSION, 'manage_users', 'invite_user')).rejects.toThrow(
      PermissionDeniedError,
    );

    expect(h.denials).toEqual([
      {
        tenant_id: TENANT,
        user_id: USER,
        required: 'manage_users',
        action: 'invite_user',
        occurred_at: '2026-02-01T10:20:30.456Z',
      },
    ]);
  });

  it('defaults the recorded action to the Permission label', async () => {
    const h = harness([]);

    await expect(h.service.require(SESSION, 'run_agents')).rejects.toThrow(PermissionDeniedError);

    expect(h.denials[0]?.action).toBe('run_agents');
  });

  it('still denies when no denial sink is composed', async () => {
    const h = harness([], { sink: false });

    await expect(h.service.require(SESSION, 'run_agents')).rejects.toThrow(PermissionDeniedError);
    expect(h.denials).toEqual([]);
  });

  it('refuses a Permission that is not one of the six without reading anything', async () => {
    const h = harness(PERMISSIONS);

    await expect(
      // A route naming a label no User can hold is a defect, not a denial.
      h.service.require(SESSION, 'delete_everything' as (typeof PERMISSIONS)[number]),
    ).rejects.toThrow(AuthorizationScopeError);
    expect(h.reads).toEqual([]);
    expect(h.denials).toEqual([]);
  });

  it('refuses an unscoped session without reading anything', async () => {
    const h = harness(PERMISSIONS);

    await expect(
      h.service.require({ tenant_id: '', user_id: USER }, 'view_financial_data'),
    ).rejects.toThrow(AuthorizationScopeError);
    expect(h.reads).toEqual([]);
    expect(h.denials).toEqual([]);
  });

  it('reads the granted set once per session across repeated checks', async () => {
    const h = harness(['view_financial_data', 'run_agents']);

    await h.service.require(SESSION, 'view_financial_data');
    await h.service.require(SESSION, 'run_agents');
    await h.service.permissionsFor(SESSION);

    expect(h.reads).toHaveLength(1);
  });

  it('keeps a second session Tenant separate from the first', async () => {
    const h = harness(['view_financial_data']);

    await h.service.require(SESSION, 'view_financial_data');
    await h.service.require({ tenant_id: OTHER_TENANT, user_id: USER }, 'view_financial_data');

    expect(h.reads.map((session) => session.tenant_id)).toEqual([TENANT, OTHER_TENANT]);
  });

  it('does not remember a failed read as an empty granted set', async () => {
    const h = harness(['run_agents'], { failReads: true });

    await expect(h.service.require(SESSION, 'run_agents')).rejects.toThrow('read failed');
    // The retry sees the real grants rather than a cached denial.
    await expect(h.service.require(SESSION, 'run_agents')).resolves.toBeUndefined();
    expect(h.reads).toHaveLength(2);
    expect(h.denials).toEqual([]);
  });
});

describe('requireAny', () => {
  it('accepts a session holding either Permission of an or-route', async () => {
    const manager = harness(['manage_credentials']);
    const runner = harness(['run_agents']);
    const required = ['manage_credentials', 'run_agents'] as const;

    await expect(
      manager.service.requireAny(SESSION, required, 'start_ingestion'),
    ).resolves.toBeUndefined();
    await expect(
      runner.service.requireAny(SESSION, required, 'start_ingestion'),
    ).resolves.toBeUndefined();
  });

  it('denies with both required Permissions named when neither is held', async () => {
    const h = harness(['view_financial_data']);

    const error = (await thrownBy(
      h.service.requireAny(SESSION, ['manage_credentials', 'run_agents'], 'start_ingestion'),
    )) as PermissionDeniedError;

    expect(error.required).toEqual(['manage_credentials', 'run_agents']);
    expect(h.denials[0]?.required).toEqual(['manage_credentials', 'run_agents']);
  });

  it('refuses an empty requirement rather than waving it through', async () => {
    const h = harness(PERMISSIONS);

    await expect(h.service.requireAny(SESSION, [], 'unnamed')).rejects.toThrow(
      AuthorizationScopeError,
    );
    expect(h.reads).toEqual([]);
  });
});

describe('permissionsFor', () => {
  it('answers the granted set in PERMISSIONS order, deduplicated', async () => {
    const h = harness(['run_agents', 'view_financial_data', 'run_agents']);

    await expect(h.service.permissionsFor(SESSION)).resolves.toEqual([
      'view_financial_data',
      'run_agents',
    ]);
  });

  it('drops a label the six do not name', async () => {
    const h = harness(['view_financial_data', 'impersonate_tenant', 42, null]);

    await expect(h.service.permissionsFor(SESSION)).resolves.toEqual(['view_financial_data']);
  });

  it('answers all six for a fully granted User', async () => {
    const h = harness(PERMISSIONS);

    const held = await h.service.permissionsFor(SESSION);

    expect(held).toEqual([...PERMISSIONS]);
    expect(held).toHaveLength(PERMISSION_COUNT);
  });
});

describe('the documented read', () => {
  it('filters on the session Tenant as defence in depth and takes no other parameter', () => {
    expect(GRANTED_PERMISSIONS_SQL).toContain('FROM user_permissions');
    expect(GRANTED_PERMISSIONS_SQL).toContain('WHERE tenant_id = $1');
    expect(GRANTED_PERMISSIONS_SQL).toContain('AND user_id = $2');
    expect(GRANTED_PERMISSIONS_SQL).not.toContain('$3');
  });
});
