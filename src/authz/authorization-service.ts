/**
 * FinanceOS_Authorization_Service (task 26.2, Requirement 14.6, 14.9).
 *
 * `require(session, permission)` over the six Permissions, evaluated **before** any
 * read or change of Tenant financial data. design.md's interface is followed exactly:
 * `require` throws, `permissionsFor` answers the granted set.
 *
 * ## What makes "before any read of financial data" true
 *
 * Not the call order in a comment. Three structural facts:
 *
 * 1. **This service cannot read financial data.** Its only injected reader is
 *    {@link PermissionReader}, whose one method answers Permission labels. There is no
 *    connection, no store and no tool in {@link AuthorizationServiceDeps}, so a
 *    financial read cannot happen inside a decision even by mistake.
 * 2. **The API funnel awaits it first.** `createSliceOneRouteHandlers` in
 *    `src/api/slice-one.ts` resolves the session, `await`s the authorization gate, and
 *    only then calls the delegate that reaches a service. A route cannot skip the gate
 *    without being written outside that funnel.
 * 3. **A denial is a thrown error, not a returned flag.** A caller that forgets to
 *    check a result cannot proceed past `await require(...)`; there is no falsy value
 *    to ignore. `void` is the whole return type — the service hands back no data, not
 *    even the granted set, on the `require` path.
 *
 * ## The Tenant comes from the session, and there is no argument for it
 *
 * No method here takes a Tenant identifier. {@link PermissionReader.grantedPermissions}
 * takes the {@link Session} itself, so the Tenant an adapter filters on is the bound
 * one by construction (Requirement 12.7, 14.8). The `WHERE tenant_id = $1` in
 * {@link GRANTED_PERMISSIONS_SQL} is **defence in depth**: the control is the RLS
 * policy on `user_permissions` from migration `20260101000009`, which is bound to
 * `app.current_tenant_id()` and applies whether or not application code filters.
 * Remove the filter and the answer would be identical; remove the policy and it would
 * not.
 *
 * ## Denial (Requirement 14.9)
 *
 * A denial names the required Permission, changes nothing, and returns no Tenant data:
 * {@link PermissionDeniedError} carries the Permission and the action type and nothing
 * else. **No state is changed on any path here** — the service holds no writer at all,
 * which is a stronger statement than "it does not write".
 *
 * The Audit_Event append is **task 26.5's** (`permission_denied`, with the fields of
 * design.md's Error Handling table). {@link AuthorizationDenialSink} is the seam it
 * fills, and {@link PermissionDenialEvent} is the record it receives. An absent sink
 * still denies — the safe direction — so it is optional; a sink that *fails* propagates
 * rather than being swallowed, following `src/tools/tool.ts`: a rejection with no
 * audit trail is not an outcome this system may produce quietly.
 *
 * ## No live adapter, and the grant gap that is why
 *
 * `authenticated` holds table privileges on `ledger_entries` and `audit_events` only.
 * Migration `20260101000009` deliberately issued no grants, so a `SELECT` on
 * `user_permissions` fails with `42501` before RLS is consulted. {@link
 * GRANTED_PERMISSIONS_SQL} is therefore documented rather than executed, and
 * `src/api/runtime.ts` stays fail-closed. The missing grants are reported by task 26.2,
 * not issued by it: a blanket grant would widen the surface in the change that is
 * supposed to narrow it.
 *
 * Nothing here calls `app.current_tenant_id()`, so the missing `USAGE` on schema `app`
 * for `authenticated` does not block this service and **no grant is requested for it**.
 */

import {
  canonicalisePermissions,
  isPermission,
  type Permission,
} from './permissions';
import { isScopedSession, type Session } from './session';

/**
 * The `user_permissions` read. Parameters: `($1 tenant_id, $2 user_id)`.
 *
 * `$1` is bound by the adapter from the session (Requirement 12.7); it is not a
 * caller argument, and it is defence in depth beside the RLS policy rather than a
 * substitute for it. The `ORDER BY` keeps the row order stable so two reads of the
 * same grants are literally the same list, though
 * {@link AuthorizationService.permissionsFor} canonicalises regardless.
 */
export const GRANTED_PERMISSIONS_SQL = `
SELECT permission
  FROM user_permissions
 WHERE tenant_id = $1
   AND user_id = $2
 ORDER BY permission ASC`.trim();

/**
 * Where the granted set comes from: `user_permissions` for the session's Tenant and
 * User, per {@link GRANTED_PERMISSIONS_SQL}.
 *
 * It answers `readonly unknown[]` rather than `readonly Permission[]` on purpose. The
 * rows come from a database enum this build does not control, so the labels are
 * untrusted input until {@link canonicalisePermissions} has seen them; typing them as
 * `Permission` at the seam would assert what the seam cannot know.
 *
 * A membership that does not exist and a User with no grants are the same answer — an
 * empty list — and both deny. There is no "unknown user" error to distinguish.
 */
export interface PermissionReader {
  grantedPermissions(session: Session): Promise<readonly unknown[]>;
}

/** design.md's 14.9 fields: User, Tenant, required Permission, action type, timestamp. */
export interface PermissionDenialEvent {
  readonly tenant_id: string;
  readonly user_id: string;
  /** What was required. An array for an any-of route (design.md's ingestion route). */
  readonly required: Permission | readonly Permission[];
  /** The requested action type, e.g. `approve_proposal`. */
  readonly action: string;
  /** UTC, ISO-8601 to millisecond precision, matching `audit_events.occurred_at`. */
  readonly occurred_at: string;
}

/**
 * Where a denial is recorded. **Task 26.5** implements it as the `permission_denied`
 * Audit_Event; this task defines the record and the call site.
 *
 * Optional in {@link AuthorizationServiceDeps} because the denial itself does not
 * depend on it: with no sink the action is still refused and no state changes. That is
 * the opposite of the `write_capable` authorization seam in `src/tools/tool.ts`, whose
 * absence must fail *closed* by refusing; an absent audit sink cannot make a denial
 * unsafe.
 */
export interface AuthorizationDenialSink {
  recordDenial(event: PermissionDenialEvent): Promise<void>;
}

/**
 * A permission-denied outcome (Requirement 14.9). Names the required Permission.
 *
 * Carries no Tenant identifier and no financial data: the required Permission and the
 * action are what the caller needs to understand the refusal, and the session already
 * knows its own Tenant. `src/api/slice-one.ts` renders this as
 * `403 { code: 'permission_denied', required }`.
 */
export class PermissionDeniedError extends Error {
  override readonly name = 'PermissionDeniedError';
  constructor(
    readonly required: Permission | readonly Permission[],
    readonly action: string,
  ) {
    super(
      `Permission denied: ${Array.isArray(required) ? required.join(' or ') : String(required)}`,
    );
  }
}

/**
 * A caller fault rather than an authorization outcome: an unscoped or malformed
 * session, or a required Permission that is not one of the six.
 *
 * Separate from {@link PermissionDeniedError} because it is not a fact about the User.
 * A session with no Tenant is not a User lacking a Permission, and rendering it as a
 * 403 would tell an operator that access control is working when scope resolution is
 * broken. Both refuse the action; only this one indicates a defect.
 *
 * It matters most for the unknown-label case. A required Permission nobody can hold
 * would otherwise be denied *correctly and permanently*, which reads as a
 * configuration problem for as long as nobody notices the typo.
 */
export class AuthorizationScopeError extends Error {
  override readonly name = 'AuthorizationScopeError';
}

export interface AuthorizationServiceDeps {
  readonly permissions: PermissionReader;
  /** Task 26.5's `permission_denied` append. Absent still denies. */
  readonly denials?: AuthorizationDenialSink;
  /** Injectable clock so `occurred_at` is assertable. Defaults to the wall clock. */
  readonly now?: () => Date;
}

/**
 * design.md's `AuthorizationService`, plus {@link requireAny}.
 *
 * `requireAny` exists because design.md's own route table has an or-route:
 * `POST /ingestion/runs` requires `manage_credentials` **or** `run_agents`, and
 * `src/api/slice-one.ts` already passes an array for it. Expressing that as two
 * `require` calls would deny a User holding exactly one of the two, and expressing it
 * by reading `permissionsFor` at the call site would put the denial audit outside this
 * service.
 */
export interface AuthorizationService {
  /**
   * Verify that the User holds `permission` in the session's Tenant.
   *
   * @param action The requested action type, recorded by Requirement 14.9's
   * Audit_Event. Defaults to the Permission label — design.md's signature is
   * two-argument, so a call site that states nothing more specific still records
   * something true rather than a placeholder.
   * @throws {PermissionDeniedError} when the Permission is not held.
   * @throws {AuthorizationScopeError} for an unscoped session or an unknown label.
   */
  require(session: Session, permission: Permission, action?: string): Promise<void>;
  /**
   * Verify that the User holds **at least one** of `permissions`.
   *
   * @throws {AuthorizationScopeError} when `permissions` is empty: an unstated
   * requirement is not an absent one, the same reading `userPermissionCheck` in
   * `src/policy/checks.ts` takes.
   */
  requireAny(
    session: Session,
    permissions: readonly Permission[],
    action?: string,
  ): Promise<void>;
  /** The granted set, deduplicated and in `PERMISSIONS` order. */
  permissionsFor(session: Session): Promise<readonly Permission[]>;
}

/**
 * One instance per request scope, matching `ToolInvoker`.
 *
 * The granted set is read once per instance per session and memoised. That is what
 * makes six `require` calls in one request six comparisons and one query rather than
 * six queries. The consequence is stated plainly: a Permission revoked *during* a
 * request is not observed by that request. It is observed by the next one, because the
 * set is not a session claim — see `sessionTenantClaims` in `./session`. Requirement
 * 14.6 asks for the check before the action, which this satisfies; nothing asks for
 * mid-request revocation, and re-reading before each of six checks would multiply the
 * queries to buy a guarantee no requirement states.
 */
export function createAuthorizationService(
  deps: AuthorizationServiceDeps,
): AuthorizationService {
  const now = deps.now ?? ((): Date => new Date());
  const memo = new Map<string, Promise<readonly Permission[]>>();

  function scoped(session: Session): void {
    if (!isScopedSession(session)) {
      throw new AuthorizationScopeError(
        'the session names no Tenant and User pair as UUIDs; an unscoped session is ' +
          'refused rather than evaluated (Requirement 14.8, 14.10)',
      );
    }
  }

  async function granted(session: Session): Promise<readonly Permission[]> {
    scoped(session);
    // `\u0000` cannot appear in a UUID, so the two fields cannot run together into a
    // key that collides with a different pair.
    const key = `${session.tenant_id}\u0000${session.user_id}`;
    const existing = memo.get(key);
    if (existing !== undefined) return existing;
    const pending = deps.permissions
      .grantedPermissions({ tenant_id: session.tenant_id, user_id: session.user_id })
      .then((rows) => canonicalisePermissions(rows));
    // A failed read must not be remembered as a granted set of none: that would turn
    // one transient error into a denial for the rest of the request.
    memo.set(
      key,
      pending.catch((error: unknown) => {
        memo.delete(key);
        throw error;
      }),
    );
    return memo.get(key) as Promise<readonly Permission[]>;
  }

  async function deny(
    session: Session,
    required: Permission | readonly Permission[],
    action: string,
  ): Promise<never> {
    // No state has been changed and none is changed here: the sink appends an
    // Audit_Event, which is the one write Requirement 14.9 asks for.
    await deps.denials?.recordDenial({
      tenant_id: session.tenant_id,
      user_id: session.user_id,
      required,
      action,
      occurred_at: now().toISOString(),
    });
    throw new PermissionDeniedError(required, action);
  }

  return {
    async require(session, permission, action) {
      if (!isPermission(permission)) {
        throw new AuthorizationScopeError(
          'the required Permission is not one of the 6 of Requirement 14.6; a label ' +
            'no User can hold is a defect, not a denial',
        );
      }
      const held = await granted(session);
      if (!held.includes(permission)) {
        await deny(session, permission, action ?? permission);
      }
    },

    async requireAny(session, permissions, action) {
      if (permissions.length === 0) {
        throw new AuthorizationScopeError(
          'no required Permission was stated; an unstated requirement is not an absent ' +
            'one (Requirement 14.6), so the action is refused rather than waved through',
        );
      }
      for (const permission of permissions) {
        if (!isPermission(permission)) {
          throw new AuthorizationScopeError(
            'a required Permission is not one of the 6 of Requirement 14.6',
          );
        }
      }
      const held = await granted(session);
      if (!permissions.some((permission) => held.includes(permission))) {
        await deny(session, [...permissions], action ?? permissions.join('|'));
      }
    },

    permissionsFor(session) {
      return granted(session);
    },
  };
}
