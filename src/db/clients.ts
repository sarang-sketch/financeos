import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv, type Env } from '@/config/env';

/**
 * Supabase client factories. Three of them, and the distinctions are load-bearing.
 *
 * | Factory | Key | Role privileges | Used by |
 * |---|---|---|---|
 * | `createTenantScopedClient` | anon + session JWT | the session's role | every normal request path |
 * | `createServiceClient` | service role | elevated, still RLS-filtered | server-only privileged paths |
 * | `createReadOnlyClient` | anon + read-only JWT | **no write grants** | `read_only` Financial_Tools |
 *
 * None of these verifies connectivity. They construct a client; the first query is what
 * touches the network. Nothing here logs, echoes, or serialises a credential: keys are
 * held as `Secret` and revealed only at the point of constructing the request headers.
 * Any diagnostic added later must go through `redactSecrets` from `@/config/env`, which
 * matches on credential **value** rather than key name (docs/09_SECURITY.md).
 */

/** No browser storage, no refresh loop, no URL session detection: these are server clients. */
const AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const;

/** Thrown when a factory is called without the scope that makes the call safe. */
export class ClientScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientScopeError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireAccessToken(token: string, factory: string): string {
  // Length only. The token itself never appears in the message.
  if (token.trim().length === 0) {
    throw new ClientScopeError(
      `${factory} requires a session access token; the Tenant scope is resolved from its ` +
        `tenant_id claim and an absent claim yields zero rows, not all rows.`,
    );
  }
  return token;
}

function requireTenantId(tenantId: string, factory: string): string {
  if (!UUID_RE.test(tenantId)) {
    throw new ClientScopeError(
      `${factory} requires an explicit Tenant identifier as a UUID. An unscoped ` +
        `privileged query is rejected and audited, so it must be impossible to write by accident.`,
    );
  }
  return tenantId;
}

/**
 * 1. **Tenant-scoped client.** Carries the caller's session JWT, so `app.current_tenant_id()`
 *    resolves from the `tenant_id` claim and every RLS policy predicate evaluates against
 *    the session's Tenant. This is the client every normal request path uses.
 *
 * When the session carries no Tenant claim the function returns `NULL`, and
 * `tenant_id = NULL` is never true, so the query returns zero rows rather than every row.
 * The failure mode is closed (Requirement 14.4, 14.10).
 */
export function createTenantScopedClient(
  accessToken: string,
  env: Env = getEnv(),
): SupabaseClient {
  const token = requireAccessToken(accessToken, 'createTenantScopedClient');
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY.reveal(), {
    auth: AUTH_OPTIONS,
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
}

/** A service client is never handed out bare; it arrives with the Tenant scope attached. */
export interface ScopedServiceClient {
  readonly client: SupabaseClient;
  /** The Tenant every query on this client must filter on, as defence in depth. */
  readonly tenantId: string;
}

/**
 * 2. **Service client.** Server-only, for privileged paths such as appending an
 *    Audit_Event on a separate connection so it survives a rollback.
 *
 * **This is not a bypass.** Every tenant-scoped table is declared
 * `FORCE ROW LEVEL SECURITY`, which applies the Tenant predicate to the table owner and to
 * a service-role connection alike. There is no privileged read path around the predicate.
 * A privileged path that issues a query with no explicit Tenant scope is rejected and
 * audited as `unscoped_access_rejected` (Requirement 14.10).
 *
 * The `tenantId` argument is mandatory and returned alongside the client precisely so an
 * unscoped call is impossible to write by accident: there is no overload that omits it,
 * and the caller has the identifier in hand for the `tenant_id` filter that accompanies
 * every query as defence in depth.
 *
 * The SQL half — `app.current_tenant_id()` and the policies — landed in the task 4.1 and
 * 26.1 migrations. The rejection audit is `createRejectionAuditRecorder` in
 * `@/authz/rejection-audit` (task 26.5), in TypeScript rather than in SQL, and its module
 * comment reports why an `unscoped_access_rejected` with no attributable Tenant cannot be
 * filed as an Audit_Event at all: `audit_events.tenant_id` is `NOT NULL`.
 */
export function createServiceClient(
  scope: { readonly tenantId: string },
  env: Env = getEnv(),
): ScopedServiceClient {
  const tenantId = requireTenantId(scope.tenantId, 'createServiceClient');
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY.reveal(), {
    auth: AUTH_OPTIONS,
    global: {
      headers: {
        // Read by `app.current_tenant_id()` for service-role requests only, and carried on
        // the audit trail of every privileged call.
        'x-financeos-tenant-id': tenantId,
      },
    },
  });
  return Object.freeze({ client, tenantId });
}

/**
 * 3. **Read-only client.** The connection a `read_only` Financial_Tool executes on.
 *
 * The token supplied here must be issued for the read-only database role, whose grants are
 * `SELECT` only. A tool declaring `mode: 'read_only'` is then backed by privilege rather
 * than by convention: an attempted write fails at the database, not at a code review
 * (Requirement 12.7).
 *
 * The role itself and its grants — `GRANT SELECT` with no `INSERT`, `UPDATE` or `DELETE`
 * on any Tenant table — are created in the task 26.1 RLS migration. This factory is the
 * client-side half.
 *
 * Tenant scoping is unchanged: the token carries the `tenant_id` claim, so read-only and
 * tenant-scoped clients see exactly the same rows. Only the write privilege differs.
 */
export function createReadOnlyClient(accessToken: string, env: Env = getEnv()): SupabaseClient {
  const token = requireAccessToken(accessToken, 'createReadOnlyClient');
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY.reveal(), {
    auth: AUTH_OPTIONS,
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        // Observability only. The privilege boundary is the role's grants, not this header.
        'x-financeos-tool-mode': 'read_only',
      },
    },
  });
}
