/**
 * `POST /internal/tools/{tool_name}` — the server-to-server tool endpoint (task 29.5).
 * Requirements 12.7, 12.9, 12.11, 14.8.
 *
 * The Python Agent Engine holds no database connection and no money arithmetic
 * (design.md, Architecture). Its only data path is this endpoint. The tools
 * themselves are unchanged by it: `@/tools/tool`'s `createToolInvoker` still parses,
 * authorizes the write, acquires the connection, enforces the 10-second bound and
 * checks the envelope. This module is transport plus the two things transport has to
 * add — a caller identity for the Agent runtime, and a Tenant scope that came from a
 * session rather than from a body.
 *
 * ## Why it is not on the public API surface
 *
 * Four separate facts, none of them a comment:
 *
 * 1. **It is not in `SliceOneRouteHandlers`.** `./slice-one.ts` enumerates the
 *    Tenant-facing routes and `./runtime.ts` composes exactly those.
 *    {@link createInternalToolRouteHandler} is a different factory with a different
 *    dependency set, so a route table that lists the public surface cannot acquire
 *    this handler by accident.
 * 2. **It reads no `Authorization` header.** The public routes authenticate a User
 *    from `Authorization: Bearer`. This one *refuses* a request carrying that header
 *    (see {@link SERVICE_CALLER_REJECTIONS}), so replaying a stolen user session
 *    against this path fails at the first check rather than reaching a tool.
 * 3. **A browser-originated request is refused.** A request carrying `Cookie`,
 *    `Origin` or any `Sec-Fetch-*` header is rejected. Those are
 *    [forbidden header names](https://developer.mozilla.org/docs/Glossary/Forbidden_header_name)
 *    that a page cannot suppress, and nothing here emits a CORS header, so the
 *    endpoint is unreachable from a document context even when the credential leaks
 *    into one.
 * 4. **It is absent from `docs/06_API_CONTRACTS.md`.** Deliberately, per design.md:
 *    "not documented as a Tenant-facing route". This doc comment is its contract.
 *
 * ## Two credentials, doing two different jobs
 *
 * | Credential | Header | Establishes | Authorizes |
 * |---|---|---|---|
 * | Service credential | {@link SERVICE_CREDENTIAL_HEADER} | the caller is the Agent runtime | nothing |
 * | Forwarded user session | {@link FORWARDED_USER_SESSION_HEADER} | which Tenant and User | the tool's Permission |
 *
 * That split is the whole security argument. A leaked **user session** cannot reach
 * the endpoint, because the service credential is checked first and a user session
 * is not one. A leaked **service credential** cannot impersonate a user, because it
 * yields no `tenant_id`, no `user_id` and no Permission — the authorization step
 * reads those from the forwarded session alone, so a service credential presented
 * without one authorizes nothing at all.
 *
 * Authorization is **additive, not alternative**: the forwarded user context must
 * hold the Permission the invoked tool requires (Requirement 14.6), checked through
 * the same {@link ApiAuthorizationGate} the public routes use, so there is one
 * Permission decision path rather than two.
 *
 * ## The order of the funnel, and why each step sits where it does
 *
 * ```
 * 1. service credential      -> 401, platform log            (no Tenant exists yet)
 * 2. forwarded user session   -> 401, platform log            (no Tenant resolved)
 * 3. tool name in catalogue   -> 400 schema_violation, audited
 * 4. required Permission      -> 403, audited
 * 5. body: JSON, object, no tenant_id at any depth -> 400 schema_violation, audited
 * 6. ToolInvoker.invoke       -> the tool's own input schema, then the tool
 * ```
 *
 * Steps 1 and 2 are the two auth checks, and both complete **before** step 6 parses
 * the tool's input schema — which is design.md's requirement and the reason step 5
 * reads the body at all rather than handing it straight to the invoker.
 *
 * Step 3 precedes step 4 out of necessity: an unknown tool has no required
 * Permission to check. It answers a **schema violation, not a 404**, so a typo in an
 * Agent is audited the same way a bad argument is — and so the endpoint discloses
 * nothing about which tool names exist.
 *
 * Step 5 is where a body-supplied `tenant_id` dies. The tool layer would also refuse
 * it — every input schema is `.strict()` and `@/tools/registry` rejects a schema
 * declaring the key at any depth — but it would refuse it as "unrecognized argument",
 * which does not tell a caller that its *Tenant scoping* was refused. Rejecting it
 * here, by name, at any depth, is what makes Requirement 12.7 and 14.8 legible
 * across the process boundary: the caller learns it did not scope the request, rather
 * than believing it had.
 *
 * ## What is audited, and the one rejection that cannot be
 *
 * Steps 3, 4 and 5 append {@link INTERNAL_TOOL_REJECTED} — design.md's
 * `tool_invocation_rejected`, the same event type `@/tools/tool` appends for
 * Requirement 12.9, because these *are* Requirement 12.9 rejections. The append goes
 * through {@link NarrowAuditSink}, which holds its own connection, and a sink failure
 * propagates: a rejection with no audit trail is not a rejection this system reports.
 *
 * Steps 1 and 2 **cannot** be appended. `audit_events.tenant_id` is `NOT NULL` and
 * the only source of a Tenant is the forwarded session, which at step 1 has not been
 * read and at step 2 did not resolve. Attributing the row to a *claimed* Tenant would
 * file an Audit_Event under a Tenant identifier a caller supplied, which is the exact
 * failure Requirement 12.7 exists to prevent. So those two go to
 * {@link PlatformLog} with no Tenant data, exactly as
 * `@/authz/rejection-audit`'s `unscopedAccessRejected` does for the same reason, and
 * {@link InternalToolAuditOutcome} states the absence rather than hiding it.
 *
 * The step-4 append is *in addition to* Requirement 14.9's `permission_denied` row,
 * which belongs to the Authorization_Service and records a different fact: 14.9's row
 * says this User lacks this Permission, and this one says this tool invocation was
 * refused at the boundary. A reader of a Proposal's tool history needs the second and
 * would not find it in the first.
 *
 * ## What this module deliberately does not do
 *
 * - **It does not compose itself.** There is no live default here and no
 *   `configureInternalToolApi`. The service credential, the registry, the
 *   Authorization_Service and the connection provider are all injected, for the same
 *   reason `./runtime.ts` stays fail-closed: `authenticated` still holds no grants on
 *   `user_permissions` (see `@/authz/authorization-service`), so a composed default
 *   would replace a truthful refusal with a `42501`.
 * - **It does not enforce the 10-second bound.** That is `TOOL_TIMEOUT_MS` in
 *   `@/tools/tool`, where the tool actually runs (Requirement 12.11). This endpoint
 *   returns the resulting `tool_failure` envelope with cause `timeout`, and
 *   `financeos/agents/tool_client.py` sets a **longer** 13-second deadline so that
 *   envelope is what the Agent receives rather than a client-side transport error.
 * - **It declares no per-tool Permission table.** `FinancialTool` has no Permission
 *   field and design.md's route table has no row for this endpoint, so
 *   {@link permissionForToolMode} derives one from the declared mode and
 *   {@link InternalToolRouteDeps.toolPermissions} overrides it per tool. Reported as
 *   a design.md gap below rather than guessed at silently.
 *
 * ## design.md gap, reported rather than patched
 *
 * **No Permission is stated for a Financial_Tool.** design.md's Permission table
 * grants `view_financial_data` for "Exception lists and drill-downs, Evidence_Chain
 * inspection, trial balance" — which is what every `read_only` tool returns — and
 * `run_agents` for "every route that can trigger an Agent", which is how a
 * `write_capable` tool is ever reached. {@link permissionForToolMode} follows that
 * reading. It is a derivation, not a quotation, and a tool whose Permission differs
 * must say so through `toolPermissions` rather than rely on the default.
 */

import type { NarrowAuditSink } from '@/audit/audit-service';
import { assertAuditTimestamp } from '@/audit/audit-service';
import type { Permission } from '@/authz/permissions';
import { defaultPlatformLog, type PlatformLog } from '@/authz/rejection-audit';
import type { Actor, TenantId } from '@/config/configuration-service';
import { TOOL_NAME_RE, type ToolRegistry } from '@/tools/registry';
import type {
  ErasedFinancialTool,
  ToolInvoker,
  ToolMode,
  ToolResult,
  ToolSession,
} from '@/tools/tool';

import {
  findSessionOnlyKeys,
  isRecord,
  jsonWire as json,
  MAX_BODY_DEPTH,
  MAX_INTERNAL_BODY_BYTES,
  recordUnattributable,
  schemaViolation,
  type ForwardedSessionResolver,
  type InternalAuditOutcome,
  type ServiceCaller,
  type ServiceCredentialVerifier,
} from './internal-endpoint';
import { AuthenticationRequiredError, type ApiSession } from './session';
import {
  ApiPermissionDeniedError,
  toolResultStatus,
  type ApiAuthorizationGate,
} from './slice-one';

/* -------------------------------------------------------------------------- */
/* The shared internal-endpoint model, re-exported                            */
/* -------------------------------------------------------------------------- */

/**
 * The service-credential, forwarded-session and body-scan primitives moved to
 * `./internal-endpoint.ts` when task 29.6 added the two metering routes under, in
 * its words, "the same service-credential plus forwarded-user-context model" — a
 * claim that is only true if it is the same code.
 *
 * They are re-exported here rather than merely relocated, because this module is the
 * stated source of the two header literals `financeos/agents/tool_client.py`
 * transcribes (see that module's docstring) and of the names
 * `./internal-tools.test.ts` imports. Nothing about this module's contract changed.
 *
 * {@link InternalToolEndpointError} keeps its name here for the same reason; the class
 * itself is `InternalEndpointError`, since a misconfigured credential is not specific
 * to the tool route.
 */
export {
  BROWSER_ORIGIN_HEADERS,
  createForwardedSessionResolver,
  createServiceCredentialVerifier,
  findSessionOnlyKeys,
  FORWARDED_USER_SESSION_HEADER,
  InternalEndpointError as InternalToolEndpointError,
  MAX_BODY_DEPTH,
  MAX_INTERNAL_BODY_BYTES,
  MIN_SERVICE_CREDENTIAL_LENGTH,
  SERVICE_CALLER_REJECTIONS,
  SERVICE_CREDENTIAL_HEADER,
  SESSION_ONLY_BODY_KEY,
  type ForwardedSessionResolver,
  type ServiceCaller,
  type ServiceCallerRejection,
  type ServiceCallerVerdict,
  type ServiceCredentialVerifier,
} from './internal-endpoint';

/** {@link InternalAuditOutcome} under the name this module exported before task 29.6. */
export type InternalToolAuditOutcome = InternalAuditOutcome;

/* -------------------------------------------------------------------------- */
/* The route, its headers, and the one argument that is not an argument        */
/* -------------------------------------------------------------------------- */

/** design.md's path. Stated once so the Python client's transcription has a source. */
export const INTERNAL_TOOL_ROUTE = '/internal/tools/{tool_name}';

/** design.md's error-handling row for Requirement 12.9, appended by `@/tools/tool` too. */
export const INTERNAL_TOOL_REJECTED = 'tool_invocation_rejected';

/* -------------------------------------------------------------------------- */
/* The Permission a tool requires                                             */
/* -------------------------------------------------------------------------- */

/**
 * The Permission a tool of this mode requires of the forwarded user context.
 *
 * See the design.md gap in the module comment: this is derived from design.md's
 * Permission table, not quoted from a per-tool declaration that does not exist.
 *
 * - `read_only` -> `view_financial_data`. Every read-only tool returns exactly what
 *   that Permission grants: metrics, Exception drill-downs, Evidence_Chain
 *   inspection, the trial balance.
 * - `write_capable` -> `run_agents`. A write-capable tool is reachable only inside an
 *   Action_Pipeline run, and "every route that can trigger an Agent requires
 *   `run_agents`". It is **not** `approve_sensitive_actions`: a Proposal below the
 *   Auto_Execute_Threshold executes with no approval at all, so requiring the
 *   approval Permission would deny the auto-execute path design.md defines. The
 *   Authorization the write itself needs is Requirement 12.10's recorded
 *   Proposal Authorization, which `@/tools/tool` checks separately and which this
 *   Permission does not replace.
 */
export function permissionForToolMode(mode: ToolMode): Permission {
  return mode === 'write_capable' ? 'run_agents' : 'view_financial_data';
}

/** Per-tool override for {@link permissionForToolMode}. */
export interface ToolPermissionResolver {
  permissionFor(tool: ErasedFinancialTool): Permission;
}

/* -------------------------------------------------------------------------- */
/* The invocation seam                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Invoking a tool the catalogue handed back, whose type parameters are erased.
 *
 * A seam of its own so the endpoint holds one erasure boundary rather than a cast
 * per call site, and so a test can count invocations and prove that a rejected
 * request made none.
 */
export interface InternalToolInvocation {
  invoke(
    tool: ErasedFinancialTool,
    session: ToolSession,
    rawInput: unknown,
  ): Promise<ToolResult<unknown>>;
}

/**
 * The one place the catalogue's erasure is reconciled with `ToolInvoker.invoke`.
 *
 * `ToolInvoker.invoke` is generic in `In` and `Out` and a catalogue entry has neither,
 * so the erased tool is widened to `FinancialTool<unknown, unknown>` here. It is sound
 * in the direction that matters: the invoker only *reads* `inputSchema`,
 * `outputSchema`, `mode` and `timeoutMs`, and calls `execute` with the value its own
 * `inputSchema` produced. Nothing downstream is told that `rawInput` conformed to
 * anything — the invoker parses it, which is step 6 of the funnel.
 */
export function internalToolInvocation(invoker: ToolInvoker): InternalToolInvocation {
  return {
    invoke(tool, session, rawInput) {
      return invoker.invoke(tool as Parameters<ToolInvoker['invoke']>[0], session, rawInput);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

/** Why the endpoint refused the invocation. Reaches the Audit_Event payload. */
export const INTERNAL_TOOL_REJECTION_REASONS = [
  'unknown_tool_name',
  'missing_required_permission',
  'body_tenant_id',
  'malformed_body',
] as const;

export type InternalToolRejectionReason = (typeof INTERNAL_TOOL_REJECTION_REASONS)[number];

/*
 * `InternalToolAuditOutcome`, `isRecord` and `findSessionOnlyKeys` moved to
 * `./internal-endpoint.ts` (task 29.6). The first two are re-exported at the top of
 * this module; the scan is now `findDeclaredKeys` specialised to `tenant_id`.
 */

/* -------------------------------------------------------------------------- */
/* The handler                                                                */
/* -------------------------------------------------------------------------- */

export interface InternalToolRouteDeps {
  /** The catalogue `{tool_name}` selects from. */
  readonly registry: ToolRegistry;
  /** Authentication: establishes the Agent runtime, authorizes nothing. */
  readonly serviceCredential: ServiceCredentialVerifier;
  /** The only source of `tenant_id`, `user_id` and `permissions`. */
  readonly forwardedSessions: ForwardedSessionResolver;
  /** The same gate the public routes use, so there is one Permission decision path. */
  readonly authorization: ApiAuthorizationGate;
  /** Per-tool override of {@link permissionForToolMode}. */
  readonly toolPermissions?: ToolPermissionResolver;
  /**
   * One invoker per request scope, matching `ToolInvoker`'s own contract.
   *
   * It takes the **forwarded** {@link ApiSession}, which is what completes the fourth
   * field of `ToolContext`: the RLS-bound `db` client. `ToolConnections.acquire`
   * needs the session access token, and the only access token in scope is the
   * forwarded one — so the connection a tool reads through is bound to the forwarded
   * user's Tenant by construction, not by a filter this endpoint applies.
   */
  readonly invocations: (session: ApiSession) => InternalToolInvocation;
  /** Must append on a connection independent of the invocation's. */
  readonly audit: NarrowAuditSink;
  /** Where an unattributable rejection is recorded. Defaults to a redacting console. */
  readonly platformLog?: PlatformLog;
  /** Injectable clock, so `occurred_at` is assertable. */
  readonly now?: () => Date;
}

export interface InternalToolRouteHandler {
  /**
   * `POST /internal/tools/{tool_name}`.
   *
   * @param toolName The `{tool_name}` path segment, unvalidated. An unknown or
   * malformed name is a schema violation, not a 404.
   */
  postTool(request: Request, toolName: string): Promise<Response>;
}

export function createInternalToolRouteHandler(
  deps: InternalToolRouteDeps,
): InternalToolRouteHandler {
  const platformLog = deps.platformLog ?? defaultPlatformLog();
  const now = deps.now ?? ((): Date => new Date());
  const occurredAt = (): string => assertAuditTimestamp(new Date(now().getTime()).toISOString());

  function permissionFor(tool: ErasedFinancialTool): Permission {
    return deps.toolPermissions?.permissionFor(tool) ?? permissionForToolMode(tool.mode);
  }

  /**
   * A rejection with a resolved Tenant. Appended, never best-effort: a sink failure
   * propagates and surfaces as `500 internal_error`, because a refused invocation
   * with no audit trail is worse than a failed request.
   */
  async function audited(
    session: ApiSession,
    caller: ServiceCaller,
    reason: InternalToolRejectionReason,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<InternalToolAuditOutcome> {
    const actor: Actor = { kind: 'agent', id: caller.runtime };
    const tenantId: TenantId = session.tenant_id;
    await deps.audit.append({
      tenantId,
      eventType: INTERNAL_TOOL_REJECTED,
      actor,
      outcome: 'blocked',
      // The endpoint read nothing, so there is no Source_Record to cite.
      sourceRefs: [],
      payload: {
        endpoint: INTERNAL_TOOL_ROUTE,
        reason,
        // The forwarded User, so a rejection is attributable to a person as well as
        // to the runtime that relayed it. Not a credential (Requirement 13.2).
        forwarded_user_id: session.user_id,
        ...payload,
      },
      occurredAt: occurredAt(),
    });
    return { recorded: true };
  }

  /**
   * A rejection with no resolved Tenant. See the module comment: there is no Tenant
   * to file it under and a claimed one must never be used, so it is logged without
   * Tenant data and the absence is stated.
   */
  function unattributable(rejection: string): InternalToolAuditOutcome {
    return recordUnattributable(platformLog, {
      event: INTERNAL_TOOL_REJECTED,
      endpoint: INTERNAL_TOOL_ROUTE,
      reason: rejection,
      occurredAt: occurredAt(),
    });
  }

  return {
    async postTool(request, toolName): Promise<Response> {
      /* 1. The caller is the Agent runtime, or it is nothing. */
      const verdict = deps.serviceCredential.verify(request);
      if (!verdict.ok) {
        unattributable(verdict.rejection);
        // One response for all four rejections, carrying no Tenant identifier, no
        // Tenant data, and no indication of which check refused it.
        return json(
          { error: { code: 'service_credential_required', message: 'Service credential required' } },
          401,
        );
      }
      const caller = verdict.caller;

      /* 2. The Tenant and User come from the forwarded session, or the request ends. */
      let session: ApiSession;
      try {
        session = await deps.forwardedSessions.resolve(request);
      } catch (error) {
        if (error instanceof AuthenticationRequiredError) {
          unattributable('forwarded_user_session_invalid');
          return json(
            { error: { code: 'authentication_required', message: 'Authentication required' } },
            401,
          );
        }
        return json({ error: { code: 'internal_error' } }, 500);
      }

      try {
        /* 3. The name selects from the catalogue. A miss is a schema violation. */
        const named = TOOL_NAME_RE.test(toolName);
        const tool = named ? deps.registry.get(toolName) : undefined;
        if (tool === undefined) {
          await audited(session, caller, 'unknown_tool_name', {
            // The value only when it is a well-formed tool name. An arbitrary path
            // segment is exactly where injected text would be, and the Audit_Log is
            // read by humans (Requirement 13.2, and `@/tools/tool`'s convention).
            ...(named ? { tool: toolName } : { tool_name_malformed: true }),
          });
          return json(
            schemaViolation([
              {
                argument: 'tool_name',
                reason:
                  `no Financial_Tool is registered under this name; the name selects from the ` +
                  `catalogue and an unknown one is refused as a non-conforming argument rather ` +
                  `than as a missing resource`,
              },
            ]),
            400,
          );
        }

        /* 4. The forwarded user context must hold the tool's Permission. */
        const required = permissionFor(tool);
        try {
          await deps.authorization.require(session, required, `invoke_tool:${tool.name}`);
        } catch (error) {
          if (error instanceof ApiPermissionDeniedError) {
            await audited(session, caller, 'missing_required_permission', {
              tool: tool.name,
              mode: tool.mode,
              required_permission: error.required,
            });
            return json({ error: { code: 'permission_denied', required: error.required } }, 403);
          }
          throw error;
        }

        /* 5. The body: JSON, an object, and no `tenant_id` at any depth. */
        const text = await request.text();
        // Measured in UTF-8 bytes, not UTF-16 code units, so the limit is the one the
        // constant names rather than one that shifts with the alphabet of the payload.
        if (Buffer.byteLength(text, 'utf8') > MAX_INTERNAL_BODY_BYTES) {
          await audited(session, caller, 'malformed_body', {
            tool: tool.name,
            limit_bytes: MAX_INTERNAL_BODY_BYTES,
          });
          return json(
            schemaViolation([
              {
                argument: '(body)',
                reason: `the request body exceeds ${MAX_INTERNAL_BODY_BYTES} bytes`,
              },
            ]),
            400,
          );
        }

        let rawInput: unknown;
        try {
          rawInput = text.trim() === '' ? {} : JSON.parse(text);
        } catch {
          await audited(session, caller, 'malformed_body', { tool: tool.name });
          return json(
            schemaViolation([
              { argument: '(body)', reason: 'the request body is not valid JSON' },
            ]),
            400,
          );
        }
        if (!isRecord(rawInput)) {
          await audited(session, caller, 'malformed_body', { tool: tool.name });
          return json(
            schemaViolation([
              {
                argument: '(body)',
                reason:
                  `the request body must be a JSON object holding the tool's arguments; a tool's ` +
                  `arguments are a named set`,
              },
            ]),
            400,
          );
        }

        let smuggled: readonly string[];
        try {
          smuggled = findSessionOnlyKeys(rawInput);
        } catch {
          await audited(session, caller, 'malformed_body', {
            tool: tool.name,
            max_depth: MAX_BODY_DEPTH,
          });
          return json(
            schemaViolation([
              {
                argument: '(body)',
                reason: `the request body nests deeper than ${MAX_BODY_DEPTH} levels`,
              },
            ]),
            400,
          );
        }
        if (smuggled.length > 0) {
          await audited(session, caller, 'body_tenant_id', {
            tool: tool.name,
            // Paths only. The rejected *value* is never recorded.
            arguments: smuggled,
          });
          return json(
            schemaViolation(
              smuggled.map((argument) => ({
                argument,
                reason:
                  `the Tenant comes from the forwarded session and never from the request body ` +
                  `(Requirement 12.7, 14.8). The key is rejected rather than ignored, because a ` +
                  `caller whose Tenant scoping was silently dropped would believe it had scoped ` +
                  `the request`,
              })),
            ),
            400,
          );
        }

        /* 6. The tool layer: its input schema, its bound, its envelope. */
        const result = await deps.invocations(session).invoke(tool, session, rawInput);
        return json(result, toolResultStatus(result));
      } catch {
        // Nothing about the failure reaches the caller: an internal message could
        // carry a Tenant identifier or a credential (Requirement 14.4, 14.5).
        return json({ error: { code: 'internal_error' } }, 500);
      }
    },
  };
}
