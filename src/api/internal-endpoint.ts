/**
 * The transport primitives every `/internal/*` server-to-server route shares
 * (extracted for task 29.6).
 *
 * Task 29.5 established this model on one route, `POST /internal/tools/{tool_name}`.
 * Task 29.6 adds two more — `GET /internal/model-cost-cap` and
 * `POST /internal/model-requests` — under, in the task's words, "the same
 * service-credential plus forwarded-user-context model". "The same" is only true if
 * it is literally the same code, so the pieces that are not about tools or about
 * metering live here and both route modules import them. `./internal-tools.ts`
 * re-exports the names it exported before this extraction, so its contract and the
 * header literals `financeos/agents/tool_client.py` transcribes from it are unchanged.
 *
 * ## What "the same model" consists of
 *
 * | Piece | What it establishes |
 * |---|---|
 * | {@link createServiceCredentialVerifier} | the caller is the Agent runtime, and nothing else |
 * | {@link BROWSER_ORIGIN_HEADERS} | the request did not come from a document context |
 * | {@link createForwardedSessionResolver} | the Tenant and the User, from a session rather than a body |
 * | {@link findDeclaredKeys} | a key the caller may not supply, refused by name at any depth |
 * | {@link recordUnattributable} | a rejection with no Tenant to file it under, stated rather than hidden |
 *
 * The security argument is unchanged and is stated in full in `./internal-tools.ts`:
 * a leaked user session cannot reach an internal route because the service credential
 * is checked first and a user session is not one, and a leaked service credential
 * cannot impersonate a user because {@link ServiceCaller} carries no Tenant, no User
 * and no Permission.
 *
 * ## Keys a caller may never supply
 *
 * Two of them now, for the same structural reason and with the same treatment —
 * refused by name, at any depth, before the route's own schema runs:
 *
 * - {@link SESSION_ONLY_BODY_KEY} (`tenant_id`) is refused because the Tenant comes
 *   from the forwarded session (Requirement 12.7, 14.8). A caller whose scoping was
 *   silently dropped would believe it had scoped the request.
 * - {@link COMPUTED_ONLY_BODY_KEY} (`cost_paise`) is refused because cost is money
 *   arithmetic and money arithmetic is TypeScript's (Requirement 11.8). A Gateway
 *   that priced its own measurement would produce a figure nobody could reproduce.
 *
 * Both are refused *by name* rather than left to a `.strict()` schema, which would
 * answer "unrecognized argument" — true, but it would not tell the caller that its
 * Tenant scoping, or its cost, was what got refused.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { PlatformLog } from '@/authz/rejection-audit';
import type { Secret } from '@/config/env';
import type { SchemaViolation, ToolArgumentViolation } from '@/tools/tool';

import { AuthenticationRequiredError, type ApiSession, type SessionResolver } from './session';
import { toJsonWire } from './slice-one';

/* -------------------------------------------------------------------------- */
/* Headers, limits, and the keys that are never arguments                     */
/* -------------------------------------------------------------------------- */

/**
 * The service credential header. Establishes that the caller is the Agent runtime
 * and nothing else.
 *
 * A custom header rather than `Authorization` for two reasons: the two credentials
 * must be impossible to confuse, and a custom header cannot be attached to a
 * cross-origin request without a CORS preflight no internal endpoint answers.
 */
export const SERVICE_CREDENTIAL_HEADER = 'x-financeos-service-credential';

/**
 * The forwarded originating user session, as `Bearer <access token>`.
 *
 * Every internal route resolves `tenant_id`, `user_id` and `permissions` from this
 * and from nothing else (Requirement 12.7, 14.8). It is verified by the **same**
 * {@link SessionResolver} the public routes use, so a forwarded credential is held to
 * the identical standard: exactly one claimed Tenant, a real Supabase Auth user, and
 * one generic failure for every invalid case.
 */
export const FORWARDED_USER_SESSION_HEADER = 'x-financeos-forwarded-user-session';

/**
 * Headers whose presence means the request came from a document context.
 *
 * A page cannot suppress `Cookie`, `Origin` or `Sec-Fetch-*` — they are forbidden
 * header names, set by the user agent — so their presence is evidence rather than a
 * hint. `Referer` is not here: a legitimate server-side HTTP client may set it, and a
 * check that refuses honest callers to catch nothing new is not a control.
 */
export const BROWSER_ORIGIN_HEADERS: readonly string[] = [
  'cookie',
  'origin',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-dest',
] as const;

/** The key that is never an argument, at any depth (Requirement 12.7, 14.8). */
export const SESSION_ONLY_BODY_KEY = 'tenant_id';

/** The other key that is never an argument: cost is computed server-side (Requirement 11.8). */
export const COMPUTED_ONLY_BODY_KEY = 'cost_paise';

/**
 * A service credential shorter than this is refused at construction.
 *
 * 32 characters is `CREDENTIAL_ENCRYPTION_KEY`'s floor in `@/config/env`, and this
 * credential guards every Tenant's internal surface, so it does not get a lower bar.
 * A weak credential is a process that does not start, not a request that fails.
 */
export const MIN_SERVICE_CREDENTIAL_LENGTH = 32;

/** A body larger than this is refused unparsed. An internal payload is a named set. */
export const MAX_INTERNAL_BODY_BYTES = 1_048_576;

/** How deep a key scan will walk before refusing the body outright. */
export const MAX_BODY_DEPTH = 32;

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when an internal endpoint itself is misconfigured: a credential below the
 * length floor, or a dependency that is absent.
 *
 * A caller fault of the *composition root*, never of the Agent runtime. Every fault
 * the runtime can commit is a response, not an exception.
 */
export class InternalEndpointError extends Error {
  override readonly name = 'InternalEndpointError';
}

/* -------------------------------------------------------------------------- */
/* The service credential                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Why a caller was not accepted as the Agent runtime.
 *
 * Recorded on the platform log and **never returned to the caller**: telling a
 * caller that its credential was merely *wrong* rather than *absent*, or that a
 * `Cookie` header was what refused it, hands an attacker a probe. One 401 for all
 * four (Requirement 14.4's shape).
 */
export const SERVICE_CALLER_REJECTIONS = [
  /** `Cookie`, `Origin` or `Sec-Fetch-*`: the request came from a document context. */
  'browser_originated',
  /** An `Authorization` header: a user session is not a service credential. */
  'user_session_presented',
  'service_credential_missing',
  'service_credential_invalid',
] as const;

export type ServiceCallerRejection = (typeof SERVICE_CALLER_REJECTIONS)[number];

/**
 * The Agent runtime, once the service credential has been accepted.
 *
 * It carries a runtime name and **no Tenant, no User and no Permission**. That
 * emptiness is the point: it is the shape of "a leaked service credential cannot
 * impersonate a user", because there is no field on it a route could read as a scope.
 */
export interface ServiceCaller {
  /** `audit_events.actor_id` for an Agent-runtime actor (Requirement 13.1). */
  readonly runtime: string;
}

export type ServiceCallerVerdict =
  | { readonly ok: true; readonly caller: ServiceCaller }
  | { readonly ok: false; readonly rejection: ServiceCallerRejection };

/** Decides whether a request carries the Agent runtime's service credential. */
export interface ServiceCredentialVerifier {
  verify(request: Request): ServiceCallerVerdict;
}

/** SHA-256 of a UTF-8 string. Fixed 32 bytes whatever the input length. */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * A verifier over one configured credential.
 *
 * The comparison is over SHA-256 digests through `timingSafeEqual` rather than over
 * the strings: `timingSafeEqual` throws on a length mismatch, so comparing raw
 * credentials would leak the expected length through the error path before it leaked
 * anything through timing. Digesting first makes both sides 32 bytes, so length is
 * not observable at all.
 *
 * `expected` is a {@link Secret}, so the configured value cannot reach a log or an
 * error payload by serialisation; `reveal()` is called once, here.
 *
 * @throws {InternalEndpointError} for a credential below
 * {@link MIN_SERVICE_CREDENTIAL_LENGTH}.
 */
export function createServiceCredentialVerifier(
  expected: Secret,
  runtime = 'agent_runtime',
): ServiceCredentialVerifier {
  const revealed = expected.reveal();
  if (revealed.length < MIN_SERVICE_CREDENTIAL_LENGTH) {
    // The message names the floor and the variable's role, never the value.
    throw new InternalEndpointError(
      `the internal service credential must be at least ` +
        `${MIN_SERVICE_CREDENTIAL_LENGTH} characters; it guards every Tenant's internal ` +
        `endpoint surface, so a weak one is a process that does not start`,
    );
  }
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(runtime)) {
    throw new InternalEndpointError(
      `${JSON.stringify(runtime)} is not an Agent runtime name: snake_case, 3..64 characters. ` +
        `It reaches audit_events.actor_id`,
    );
  }
  const expectedDigest = digest(revealed);

  return {
    verify(request): ServiceCallerVerdict {
      for (const header of BROWSER_ORIGIN_HEADERS) {
        if (request.headers.has(header)) {
          return { ok: false, rejection: 'browser_originated' };
        }
      }
      if (request.headers.has('authorization')) {
        return { ok: false, rejection: 'user_session_presented' };
      }
      const presented = request.headers.get(SERVICE_CREDENTIAL_HEADER);
      if (presented === null || presented === '') {
        return { ok: false, rejection: 'service_credential_missing' };
      }
      if (!timingSafeEqual(digest(presented), expectedDigest)) {
        return { ok: false, rejection: 'service_credential_invalid' };
      }
      return { ok: true, caller: { runtime } };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The forwarded user session                                                 */
/* -------------------------------------------------------------------------- */

/** Resolves the forwarded originating user context. The only source of a Tenant. */
export interface ForwardedSessionResolver {
  /** @throws {AuthenticationRequiredError} for an absent or invalid forwarded session. */
  resolve(request: Request): Promise<ApiSession>;
}

/**
 * Adapts the public {@link SessionResolver} to the forwarded header.
 *
 * It rebuilds the credential onto `authorization` of a throwaway `Request` rather
 * than reimplementing token verification, so the forwarded session is validated by
 * exactly the code path a first-party request goes through — one Supabase Auth
 * verification, one Tenant claim, one generic failure. A second verifier would be a
 * second place for the Tenant-claim rule of Requirement 14.8 to drift.
 *
 * The synthetic request carries the forwarded credential and nothing else: no method,
 * no body, and none of the original headers, so a header the real request carried
 * cannot influence session resolution.
 */
export function createForwardedSessionResolver(
  sessions: SessionResolver,
): ForwardedSessionResolver {
  return {
    async resolve(request): Promise<ApiSession> {
      const forwarded = request.headers.get(FORWARDED_USER_SESSION_HEADER);
      if (forwarded === null || forwarded === '') {
        throw new AuthenticationRequiredError();
      }
      return sessions.resolve(
        new Request('https://internal.invalid/forwarded-session', {
          headers: { authorization: forwarded },
        }),
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether a rejection reached the Audit_Log, and why not when it did not.
 *
 * Returned rather than swallowed, following `@/authz/rejection-audit`'s
 * `UnscopedAuditOutcome`: a caller that cannot append must be able to say so, or an
 * unrecorded rejection reads as a recorded one.
 */
export type InternalAuditOutcome =
  | { readonly recorded: true }
  | { readonly recorded: false; readonly reason: 'no_attributable_tenant' };

/**
 * Record a rejection that has no Tenant to file it under.
 *
 * `audit_events.tenant_id` is `NOT NULL` and the only source of a Tenant is the
 * forwarded session, which a credential rejection has not read and a session
 * rejection did not resolve. Attributing the row to a *claimed* Tenant would file an
 * Audit_Event under a Tenant identifier a caller supplied, which is the exact failure
 * Requirement 12.7 exists to prevent. So it goes to the {@link PlatformLog} with no
 * Tenant data, exactly as `@/authz/rejection-audit`'s `unscopedAccessRejected` does
 * for the same reason, and the returned outcome states the absence rather than hiding
 * it.
 */
export function recordUnattributable(
  platformLog: PlatformLog,
  params: {
    readonly event: string;
    readonly endpoint: string;
    readonly reason: string;
    readonly occurredAt: string;
  },
): InternalAuditOutcome {
  platformLog.record({
    event: params.event,
    endpoint: params.endpoint,
    reason: params.reason,
    occurred_at: params.occurredAt,
    recorded: 'false',
    why: 'no_attributable_tenant',
  });
  return { recorded: false, reason: 'no_attributable_tenant' };
}

/* -------------------------------------------------------------------------- */
/* Body inspection                                                            */
/* -------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One place a body declared a key it may not supply. */
export interface BodyKeyMatch {
  /** Which forbidden key it was, so a caller-facing reason can be specific. */
  readonly key: string;
  /** The path a caller wrote it at: `tenant_id`, `entries[0].cost_paise`. */
  readonly path: string;
}

/**
 * Every path at which the body declares one of `keys`, at any depth.
 *
 * Paths are rendered the way `@/tools/tool` renders an argument path —
 * `entries[0].tenant_id` — so a violation from this check and a violation from a
 * schema read the same to a caller.
 *
 * @throws {RangeError} beyond {@link MAX_BODY_DEPTH}, which the caller turns into a
 * malformed-body schema violation. A body nested deeper than any internal payload is
 * refused rather than walked: an unbounded walk over a hostile body is a denial of
 * service, and the check that finds a smuggled key must not itself be the weakness.
 */
export function findDeclaredKeys(
  body: unknown,
  keys: readonly string[],
  path = '',
  depth = 0,
): readonly BodyKeyMatch[] {
  if (depth > MAX_BODY_DEPTH) {
    throw new RangeError(`the request body nests deeper than ${MAX_BODY_DEPTH} levels`);
  }
  if (Array.isArray(body)) {
    return body.flatMap((element, index) =>
      findDeclaredKeys(element, keys, `${path}[${index}]`, depth + 1),
    );
  }
  if (!isRecord(body)) {
    return [];
  }
  const found: BodyKeyMatch[] = [];
  for (const [key, value] of Object.entries(body)) {
    const here = path === '' ? key : `${path}.${key}`;
    if (keys.includes(key)) {
      found.push({ key, path: here });
    }
    found.push(...findDeclaredKeys(value, keys, here, depth + 1));
  }
  return found;
}

/**
 * {@link findDeclaredKeys} specialised to {@link SESSION_ONLY_BODY_KEY}, which is the
 * one forbidden key every internal route shares.
 *
 * @throws {RangeError} beyond {@link MAX_BODY_DEPTH}.
 */
export function findSessionOnlyKeys(body: unknown, path = '', depth = 0): readonly string[] {
  return findDeclaredKeys(body, [SESSION_ONLY_BODY_KEY], path, depth).map((match) => match.path);
}

/* -------------------------------------------------------------------------- */
/* Responses                                                                  */
/* -------------------------------------------------------------------------- */

/** A JSON response with every `bigint` rendered as a decimal string (design.md's money wire). */
export function jsonWire(value: unknown, status: number): Response {
  return Response.json(toJsonWire(value), { status });
}

/** The `schema_violation` envelope, so every internal route answers one shape. */
export function schemaViolation(violations: readonly ToolArgumentViolation[]): SchemaViolation {
  return { ok: false, kind: 'schema_violation', violations };
}
