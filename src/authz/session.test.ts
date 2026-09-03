/** Session Tenant binding (task 26.2, Requirement 14.8). */
import { describe, expect, it } from 'vitest';

import {
  bindSessionTenant,
  isScopedSession,
  SessionBindingError,
  sessionTenantClaims,
  type TenantMembershipReader,
} from './session';

const USER = '11111111-1111-4111-8111-111111111111';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The thrown value, or `undefined` when the call resolved. */
async function thrownBy(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

function memberships(held: readonly string[]): { calls: string[]; reader: TenantMembershipReader } {
  const calls: string[] = [];
  return {
    calls,
    reader: {
      membershipsFor(userId) {
        calls.push(userId);
        return Promise.resolve(held);
      },
    },
  };
}

describe('bindSessionTenant', () => {
  it('binds the single membership when the session names no Tenant', async () => {
    const { reader, calls } = memberships([TENANT_A]);

    const binding = await bindSessionTenant({ memberships: reader }, { user_id: USER });

    expect(binding.tenant_id).toBe(TENANT_A);
    expect(binding.user_id).toBe(USER);
    expect(calls).toEqual([USER]);
  });

  it('binds the selected Tenant when the User holds membership in it', async () => {
    const { reader } = memberships([TENANT_A, TENANT_B]);

    const binding = await bindSessionTenant(
      { memberships: reader },
      { user_id: USER, tenant_id: TENANT_B },
    );

    expect(binding.tenant_id).toBe(TENANT_B);
  });

  it('refuses to choose when several memberships and no selection', async () => {
    const { reader } = memberships([TENANT_A, TENANT_B]);

    await expect(bindSessionTenant({ memberships: reader }, { user_id: USER })).rejects.toThrow(
      SessionBindingError,
    );
    await expect(
      bindSessionTenant({ memberships: reader }, { user_id: USER }),
    ).rejects.toMatchObject({ kind: 'tenant_selection_required' });
  });

  it('answers not_a_member for a foreign Tenant and for an unknown one alike', async () => {
    const { reader } = memberships([TENANT_A]);
    const unknown = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    const foreign = await thrownBy(
      bindSessionTenant({ memberships: reader }, { user_id: USER, tenant_id: TENANT_B }),
    );
    const absent = await thrownBy(
      bindSessionTenant({ memberships: reader }, { user_id: USER, tenant_id: unknown }),
    );

    expect(foreign).toBeInstanceOf(SessionBindingError);
    expect(absent).toBeInstanceOf(SessionBindingError);
    expect((foreign as SessionBindingError).kind).toBe('not_a_member');
    // Byte-identical: nothing distinguishes "someone else's Tenant" from "no such
    // Tenant" (Requirement 14.4).
    expect((absent as SessionBindingError).message).toBe((foreign as SessionBindingError).message);
  });

  it('carries no identifier in any binding failure message', async () => {
    const { reader } = memberships([TENANT_A]);

    const error = (await thrownBy(
      bindSessionTenant({ memberships: reader }, { user_id: USER, tenant_id: TENANT_B }),
    )) as SessionBindingError;

    expect(error.message).not.toContain(TENANT_A);
    expect(error.message).not.toContain(TENANT_B);
    expect(error.message).not.toContain(USER);
  });

  it('refuses a User with no membership', async () => {
    const { reader } = memberships([]);

    await expect(
      bindSessionTenant({ memberships: reader }, { user_id: USER }),
    ).rejects.toMatchObject({ kind: 'no_membership' });
  });

  it('refuses malformed identifiers without reading memberships', async () => {
    const { reader, calls } = memberships([TENANT_A]);

    await expect(
      bindSessionTenant({ memberships: reader }, { user_id: 'not-a-uuid' }),
    ).rejects.toMatchObject({ kind: 'malformed_identifier' });
    await expect(
      bindSessionTenant({ memberships: reader }, { user_id: USER, tenant_id: 'tenant-1' }),
    ).rejects.toMatchObject({ kind: 'malformed_identifier' });
    expect(calls).toEqual([]);
  });

  it('treats a repeated membership row as one membership', async () => {
    const { reader } = memberships([TENANT_A, TENANT_A]);

    const binding = await bindSessionTenant({ memberships: reader }, { user_id: USER });

    expect(binding.tenant_id).toBe(TENANT_A);
  });

  it('ignores a malformed membership row rather than binding it', async () => {
    const { reader } = memberships(['', TENANT_A]);

    const binding = await bindSessionTenant({ memberships: reader }, { user_id: USER });

    expect(binding.tenant_id).toBe(TENANT_A);
  });

  it('returns a frozen binding whose Tenant cannot be rebound', async () => {
    const { reader } = memberships([TENANT_A]);

    const binding = await bindSessionTenant({ memberships: reader }, { user_id: USER });

    expect(Object.isFrozen(binding)).toBe(true);
    // The type refuses this at compile time; the cast is how the run-time half is
    // exercised. Acting in another Tenant requires a new session (Requirement 14.8).
    expect(() => {
      (binding as { tenant_id: string }).tenant_id = TENANT_B;
    }).toThrow(TypeError);
    expect(binding.tenant_id).toBe(TENANT_A);
  });
});

describe('sessionTenantClaims', () => {
  it('contributes exactly the tenant_id claim', async () => {
    const { reader } = memberships([TENANT_A]);
    const binding = await bindSessionTenant({ memberships: reader }, { user_id: USER });

    const claims = sessionTenantClaims(binding);

    expect(Object.keys(claims)).toEqual(['tenant_id']);
    expect(claims.tenant_id).toBe(TENANT_A);
    expect(Object.isFrozen(claims)).toBe(true);
  });
});

describe('isScopedSession', () => {
  it('accepts a UUID pair and rejects anything else', () => {
    expect(isScopedSession({ tenant_id: TENANT_A, user_id: USER })).toBe(true);
    expect(isScopedSession({ tenant_id: '', user_id: USER })).toBe(false);
    expect(isScopedSession({ tenant_id: TENANT_A, user_id: 'user-1' })).toBe(false);
  });
});
