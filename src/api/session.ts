/** Authenticated request-session resolution for the FinanceOS_API. */
import { createClient, type User } from '@supabase/supabase-js';

import { isPermission, type Permission } from '@/authz/permissions';
import type { Session } from '@/authz/session';
import { getEnv } from '@/config/env';
import type { ToolSession } from '@/tools/tool';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A validated session. The access token is retained only for request-bound DB clients.
 *
 * It extends `Session` from `@/authz/session` as well as `ToolSession`, so the same
 * object is what the Authorization_Service decides over and what a Financial_Tool
 * executes under — there is no second Tenant scope to keep in step. `tenant_id` is
 * `readonly` on both and the resolved object is frozen (Requirement 14.8).
 */
export interface ApiSession extends ToolSession, Session {
  readonly access_token: string;
}

/** Deliberately carries no credential detail, Tenant identifier, or financial data. */
export class AuthenticationRequiredError extends Error {
  override readonly name = 'AuthenticationRequiredError';
  constructor() {
    super('Authentication required');
  }
}

export interface VerifiedCredential {
  readonly user: User;
  readonly claims: Readonly<Record<string, unknown>>;
}

export type CredentialVerifier = (accessToken: string) => Promise<VerifiedCredential>;

export interface SessionResolver {
  resolve(request: Request): Promise<ApiSession>;
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization');
  if (authorization === null) throw new AuthenticationRequiredError();
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (match?.[1] === undefined) throw new AuthenticationRequiredError();
  return match[1];
}

function decodeClaims(token: string): Readonly<Record<string, unknown>> {
  const encoded = token.split('.')[1];
  if (encoded === undefined) throw new AuthenticationRequiredError();
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new AuthenticationRequiredError();
    }
    return value as Readonly<Record<string, unknown>>;
  } catch {
    throw new AuthenticationRequiredError();
  }
}
function objectClaim(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function tenantFrom(claims: Readonly<Record<string, unknown>>, user: User): string {
  const direct = claims['tenant_id'];
  const appMetadata = objectClaim(user.app_metadata);
  const nested = appMetadata['tenant_id'];
  const candidates = [direct, nested].filter(
    (value): value is string => typeof value === 'string' && UUID_RE.test(value),
  );
  const unique = [...new Set(candidates)];
  // A valid financial-data session names exactly one immutable Tenant. Missing,
  // malformed, or conflicting claims fail on the authentication-required path.
  if (unique.length !== 1) throw new AuthenticationRequiredError();
  return unique[0] as string;
}

function permissionsFrom(
  claims: Readonly<Record<string, unknown>>,
  user: User,
): readonly Permission[] {
  const appMetadata = objectClaim(user.app_metadata);
  const raw = claims['permissions'] ?? appMetadata['permissions'];
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isPermission))];
}

/**
 * Validates the bearer token with Supabase Auth before any untrusted JWT claim is used.
 *
 * The `tenant_id` claim it consumes is issued by `bindSessionTenant` in
 * `@/authz/session` at authentication, from the User's `tenant_memberships`. This
 * resolver never selects or re-derives a Tenant: it accepts exactly one claimed
 * Tenant and fails on the authentication-required path for none, several, or a
 * malformed one, which is what keeps the binding immutable for the session lifetime
 * (Requirement 14.8).
 *
 * The `permissions` claim is carried for `ToolSession` and for the Policy_Engine's
 * `granted_permissions` input. It is **not** the authorization control: the
 * Authorization_Service reads `user_permissions` for the session's Tenant per request
 * (Requirement 14.6), so a grant that was revoked after the token was issued is
 * refused by `require` even though the stale claim still lists it.
 */
export function createSupabaseCredentialVerifier(): CredentialVerifier {
  return async (accessToken) => {
    const env = getEnv();
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY.reveal(), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.getUser(accessToken);
    if (error !== null || data.user === null) throw new AuthenticationRequiredError();
    return { user: data.user, claims: decodeClaims(accessToken) };
  };
}

export function createSessionResolver(
  verify: CredentialVerifier = createSupabaseCredentialVerifier(),
): SessionResolver {
  return {
    async resolve(request): Promise<ApiSession> {
      const accessToken = bearerToken(request);
      try {
        const verified = await verify(accessToken);
        if (!UUID_RE.test(verified.user.id)) throw new AuthenticationRequiredError();
        return Object.freeze({
          access_token: accessToken,
          tenant_id: tenantFrom(verified.claims, verified.user),
          user_id: verified.user.id,
          permissions: permissionsFrom(verified.claims, verified.user),
        });
      } catch {
        // Never relay provider text: it may distinguish expired from unknown sessions
        // or include credential material. All invalid-session cases are one response.
        throw new AuthenticationRequiredError();
      }
    },
  };
}
