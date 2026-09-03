/**
 * Session Tenant binding (task 26.2, Requirement 14.8).
 *
 * One Tenant per session, chosen at authentication from the Tenants the User holds
 * membership in, unchanged for the session lifetime. Acting in another Tenant needs a
 * new session.
 *
 * ## Immutability is structural, not a runtime check
 *
 * Four properties, each of which removes a way the binding could move:
 *
 * 1. **There is no rebinder.** {@link bindSessionTenant} takes a User identifier and
 *    a Tenant selection; it does not take a {@link SessionTenantBinding}. No exported
 *    function in this module accepts a binding and returns a different one, so
 *    "change the Tenant of this session" is not an operation that exists to call.
 * 2. **`tenant_id` is `readonly` and the object is frozen.** The type refuses the
 *    assignment at compile time; `Object.freeze` refuses it at run time, so a
 *    `Session` reaching JavaScript through an `any`-shaped boundary is still not
 *    writable.
 * 3. **A binding cannot be forged.** {@link SessionTenantBinding} carries a brand
 *    keyed on a module-private `unique symbol`. No other module holds that symbol, so
 *    no object literal elsewhere satisfies the type — a binding can only have come
 *    from a membership check here.
 * 4. **Nothing downstream takes a Tenant argument.** `AuthorizationService.require`
 *    takes a {@link Session}, the `PermissionReader` takes a {@link Session}, and the
 *    Financial_Tool layer rejects a `tenant_id` argument at both the type level and
 *    the schema level (Requirement 12.7). A caller therefore has no channel to name a
 *    Tenant other than the one its session was bound to.
 *
 * What none of this can do is stop a *new* session being established for another
 * Tenant the User is a member of — which is precisely what Requirement 14.8 requires
 * to happen instead.
 *
 * ## Where the bound Tenant is carried, and what the database does with it
 *
 * The binding is written into the Supabase Auth session as the `tenant_id` claim
 * ({@link sessionTenantClaims}). Per-request resolution in `src/api/session.ts`
 * validates that the presented credential names **exactly one** Tenant and fails on
 * the authentication-required path otherwise; it never re-derives the Tenant from a
 * request argument. `app.current_tenant_id()` reads that claim, and every RLS policy
 * of migration `20260101000009` is bound to it. So the claim is simultaneously the
 * session binding and the data-layer control.
 *
 * Two facts about that function, found while landing task 26.1, bear on immutability
 * and are stated here rather than worked around:
 *
 * - **A session cannot be returned to unscoped.** `set_config('request.jwt.claims',
 *   NULL, ...)` assigns the empty string rather than restoring absence, and
 *   `app.current_tenant_id()` raises `22P02` on the empty string rather than
 *   returning `NULL`. For a bound session that is help, not harm: there is no
 *   downgrade-to-unscoped step available mid-session. It hurts only a connection that
 *   wants to *reset* its claim — a pooled connection or a test — and that is migration
 *   01's to fix, not this task's.
 * - **`authenticated` holds no `USAGE` on schema `app`.** Nothing here calls
 *   `app.current_tenant_id()` from application code, and nothing needs to: the claim
 *   this module produces is the input to that function, not its output, and policy
 *   evaluation resolved the reference at policy-creation time. **No grant is
 *   requested by task 26.2.**
 *
 * ## Finding, reported rather than decided unilaterally
 *
 * **Requirement 14.8 does not say who selects the Tenant** when a User holds
 * membership in several. It says the session binds exactly one "selected from the
 * Tenants in which the User holds membership". This module therefore requires the
 * selection to be *stated* when it is ambiguous, and answers
 * {@link SessionBindingErrorKind} `tenant_selection_required` rather than picking one:
 * an arbitrary pick would silently decide whose books a session reads. A Tenant
 * chooser in the UI is task 27.x's if it is wanted; the fail-closed answer is correct
 * until then.
 */

import type { TenantId } from '@/config/configuration-service';

/** `tenants.id` and `users.id` are both UUIDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The per-request Tenant scope every authorization decision is made against.
 *
 * Deliberately two fields and nothing else: a permission decision needs the Tenant
 * and the User and has no business reading a credential. `ApiSession` in
 * `src/api/session.ts` and {@link SessionTenantBinding} both satisfy it.
 */
export interface Session {
  /** The one Tenant this session acts in. Immutable for the session lifetime. */
  readonly tenant_id: TenantId;
  /** `users.id`, which equals `auth.users.id`. */
  readonly user_id: string;
}

declare const bindingBrand: unique symbol;

/**
 * A Tenant binding that was checked against the User's memberships.
 *
 * The brand is keyed on a module-private symbol, so this type has no inhabitant that
 * did not come from {@link bindSessionTenant}. A function that requires a
 * `SessionTenantBinding` rather than a {@link Session} is therefore requiring proof
 * that a membership check happened.
 */
export interface SessionTenantBinding extends Session {
  readonly [bindingBrand]: 'checked_against_memberships';
}

export type SessionBindingErrorKind =
  /** The User holds no Tenant membership, so no Tenant-scoped session can exist. */
  | 'no_membership'
  /** The named Tenant is not one the User is a member of — or does not exist. One answer for both. */
  | 'not_a_member'
  /** Several memberships and no stated selection. See the finding in the module comment. */
  | 'tenant_selection_required'
  /** A User or Tenant identifier that is not a UUID. */
  | 'malformed_identifier';

/**
 * Authentication could not bind exactly one Tenant.
 *
 * The message carries **no identifier of any kind**, following
 * `AuthenticationRequiredError`: `not_a_member` is the answer for a Tenant that does
 * not exist and for one that exists and belongs to someone else, and a message
 * echoing the requested identifier back would let a caller tell those apart by
 * reading its own input in the reply (Requirement 14.4). {@link kind} is for the
 * server's own logs and for `src/api/session.ts`, which collapses every kind onto one
 * authentication-required response.
 */
export class SessionBindingError extends Error {
  override readonly name = 'SessionBindingError';
  constructor(readonly kind: SessionBindingErrorKind, message: string) {
    super(message);
  }
}

/**
 * Where the User's memberships come from: `tenant_memberships`.
 *
 * A seam rather than a query, for the same two reasons the rest of this codebase uses
 * seams — the connection belongs to the caller, and the unit tests need to count
 * reads — plus one specific to this table:
 *
 * **No live adapter can be composed yet.** `authenticated` holds table privileges on
 * `ledger_entries` and `audit_events` only; migration `20260101000009` issued no
 * grants, deliberately, and `tenant_memberships` was not among the two tables an
 * earlier migration granted. A `SELECT` here would fail with `42501` before RLS was
 * ever consulted. That gap is reported by task 26.2 rather than closed with a blanket
 * grant. {@link TENANT_MEMBERSHIPS_SQL} is the statement the adapter will run.
 *
 * It answers identifiers only. A membership row carries no financial data, and this
 * read happens at authentication — before any Permission has been checked — so it
 * must be incapable of returning anything a Permission would have gated.
 */
export interface TenantMembershipReader {
  /** The Tenants this User is a member of. Empty, never an error, for none. */
  membershipsFor(userId: string): Promise<readonly TenantId[]>;
}

/**
 * The membership read. Parameter: `($1 user_id)`.
 *
 * There is no `tenant_id` parameter, and there cannot be: this is the query that
 * *establishes* the Tenant scope, so it is the one read in the system that legitimately
 * spans a User's Tenants. It returns identifiers only.
 *
 * RLS on `tenant_memberships` (migration `20260101000009`) is bound to
 * `app.current_tenant_id()`, which is `NULL` for a session that has not been bound
 * yet — so this statement returns zero rows on a tenant-scoped connection during
 * authentication. It must run on a connection that is authoritative for the
 * authentication step, which is the Supabase Auth hook's, not a bound session's.
 * Stated here because an adapter author who reaches for `createTenantScopedClient`
 * will get an empty membership list and read it as "no memberships".
 */
export const TENANT_MEMBERSHIPS_SQL = `
SELECT tenant_id
  FROM tenant_memberships
 WHERE user_id = $1
 ORDER BY tenant_id ASC`.trim();

/** What authentication knows: who is signing in, and which Tenant they asked for. */
export interface SessionBindingRequest {
  readonly user_id: string;
  /**
   * The Tenant the User selected. Optional only because a User with exactly one
   * membership has nothing to select; with several it is required. It is checked
   * against the memberships and is **not** trusted as a scope on its own.
   */
  readonly tenant_id?: TenantId;
}

/**
 * Bind the session to exactly one Tenant from the User's memberships
 * (Requirement 14.8).
 *
 * Called once, at authentication. There is no second call for the same session: the
 * returned binding is what {@link sessionTenantClaims} writes into the session
 * credential, and every later request reads that claim rather than re-running this.
 *
 * @throws {SessionBindingError} for a malformed identifier, no membership, a Tenant
 * the User is not a member of, or an unresolved selection among several memberships.
 * Every one of them leaves the caller with no session at all, which is the only
 * fail-closed outcome available: a session with no Tenant would be a session that
 * could be handed to `require`.
 */
export async function bindSessionTenant(
  deps: { readonly memberships: TenantMembershipReader },
  request: SessionBindingRequest,
): Promise<SessionTenantBinding> {
  if (!UUID_RE.test(request.user_id)) {
    throw new SessionBindingError(
      'malformed_identifier',
      'the User identifier is not a UUID, so no membership can be resolved',
    );
  }
  if (request.tenant_id !== undefined && !UUID_RE.test(request.tenant_id)) {
    throw new SessionBindingError(
      'malformed_identifier',
      'the selected Tenant identifier is not a UUID',
    );
  }

  // Deduplicated and shape-checked: a repeated or malformed row must not turn a
  // single membership into an ambiguous selection, or vice versa.
  const held = [
    ...new Set(
      (await deps.memberships.membershipsFor(request.user_id)).filter((tenantId) =>
        UUID_RE.test(tenantId),
      ),
    ),
  ];

  if (held.length === 0) {
    throw new SessionBindingError(
      'no_membership',
      'the User holds no Tenant membership, so no Tenant-scoped session can be established',
    );
  }

  if (request.tenant_id !== undefined) {
    // One answer for "not a member" and "no such Tenant": distinguishing them would
    // confirm the existence of another Tenant (Requirement 14.4).
    if (!held.includes(request.tenant_id)) {
      throw new SessionBindingError(
        'not_a_member',
        'the selected Tenant is not one the User holds membership in',
      );
    }
    return frozenBinding(request.tenant_id, request.user_id);
  }

  if (held.length > 1) {
    throw new SessionBindingError(
      'tenant_selection_required',
      'the User holds membership in more than one Tenant and the session named none; ' +
        'a session binds exactly one Tenant and it is not chosen arbitrarily (Requirement 14.8)',
    );
  }

  return frozenBinding(held[0] as TenantId, request.user_id);
}

function frozenBinding(tenantId: TenantId, userId: string): SessionTenantBinding {
  // The brand exists in the type only; nothing reads it at run time, so the frozen
  // object carries the two real fields and no symbol key.
  return Object.freeze({ tenant_id: tenantId, user_id: userId }) as SessionTenantBinding;
}

/**
 * The claim the binding contributes to the session credential.
 *
 * Exactly one key. `app.current_tenant_id()` reads `request.jwt.claims -> 'tenant_id'`
 * and `app.current_user_id()` reads `-> 'sub'`, which Supabase Auth already sets, so
 * duplicating the User identifier here would create a second place for it to disagree
 * with itself.
 *
 * The granted Permission set is **not** a claim. It is read from `user_permissions`
 * per request by the Authorization_Service, so a revocation takes effect on the next
 * request rather than on the next sign-in.
 */
export function sessionTenantClaims(
  binding: SessionTenantBinding,
): Readonly<{ tenant_id: TenantId }> {
  return Object.freeze({ tenant_id: binding.tenant_id });
}

/**
 * Is this a usable Tenant scope?
 *
 * The Authorization_Service asks before it reads anything, so an unscoped or
 * malformed session is refused at the earliest point rather than turned into a
 * `WHERE tenant_id = NULL` that would answer zero rows and read as "not granted".
 */
export function isScopedSession(session: Session): boolean {
  return UUID_RE.test(session.tenant_id) && UUID_RE.test(session.user_id);
}
