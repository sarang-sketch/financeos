/**
 * The write-capable tool gate (task 24.3).
 * Requirement 12.10, and Requirement 12.7 for where the Tenant comes from.
 *
 * `./tool.ts` already refuses a `write_capable` invocation whose {@link ToolSession}
 * carries no `proposal_id` and `authorization_id` resolving to a Proposal with a
 * recorded Authorization: step 2 of `createToolInvoker`'s funnel appends
 * `unauthorized_write_rejected` and returns `unauthorized_write` **before a
 * connection is acquired**. That gate is not restated here and is not weakened here.
 *
 * What this module adds is the other half of "impossible to bypass by forgetting a
 * check": the gate the *tool body* is behind, so a write is unreachable without a
 * proof that the gate ran.
 *
 * ## Why a second gate exists at all
 *
 * The invoker's gate protects every invocation that goes **through the invoker**. A
 * tool is an ordinary object, so `tool.execute(ctx, input)` is callable directly — by
 * a future internal endpoint that assembles a `ToolContext` itself, by an Agent
 * runtime shim, by a test. Nothing in the type system stopped that, and the write
 * tools are the two places where "somebody called execute directly" means a
 * Ledger_Entry set or an Exception lifecycle transition landed with no Authorization
 * behind it.
 *
 * So the write seams of both tools are **not reachable from a `ToolContext` alone**.
 * They are {@link WriteSeam}s: functions of `(ctx, authorized)`, where
 * {@link AuthorizedWrite} carries a module-private symbol key and is therefore
 * constructible only by {@link createWriteCapableTool}'s gate. A tool body that wants
 * to write must be handed the token; the token exists only after the pair resolved.
 * Forgetting the check is not an available mistake — the code does not compile.
 *
 * This is the same shape task 23.1 gave withholding: there is exactly one expression
 * that can start a write, and it sits behind the gate rather than beside a comment
 * asking to be remembered.
 *
 * ## The Audit_Event is appended once, never twice
 *
 * Both gates append `unauthorized_write_rejected`, and only one of them ever runs for
 * a given rejection:
 *
 * - **Through the invoker** (every production path): the invoker rejects at step 2 and
 *   `execute` is never called, so this module's gate does not see the invocation. One
 *   event, appended by `./tool.ts`.
 * - **Direct `execute` call** (the bypass this module exists for): the invoker's gate
 *   was skipped, this gate refuses, and the event is appended here. One event again.
 *
 * The payload is deliberately the same shape the invoker writes — tool, mode, reason,
 * and whether each identifier was supplied at all — plus `gate: 'tool'`, so an
 * operator reading the Audit_Log can tell which barrier caught it. Whether an
 * identifier was *supplied* is a fact about the invocation; whether a particular
 * Proposal *exists* is not disclosed, exactly as {@link ProposalAuthorizationLookup}'s
 * boolean answer requires (Requirement 14.4).
 *
 * The append is **not** best-effort. Requirement 12.10 wants the rejection recorded
 * *and* the invocation refused, so a sink failure propagates rather than yielding a
 * refusal with no audit trail — the same stance `./tool.ts` and
 * `@/ledger/semantic-ledger` take.
 *
 * ## What the gate does not do
 *
 * - It does not check a Permission. design.md puts the Permission check on the
 *   internal endpoint, before the input schema is parsed.
 * - It does not read Tenant data. `isAuthorized` answers a boolean over
 *   `(tenant, proposal, authorization)`; nothing else is read, and the tool's own
 *   seams are not touched on the rejection path, so "Tenant state unchanged" holds
 *   because nothing was called rather than because something was rolled back.
 * - It does not decide *what* a Proposal authorizes. Whether this Proposal's
 *   `action_type` matches the tool being invoked is the Action_Service's (task 23.2,
 *   which invokes one of these tools carrying both identifiers) and the Policy_Engine's.
 *   See finding 2 below.
 *
 * ## Reported, not silently patched
 *
 * 1. **`ToolSession.proposal_id` and `authorization_id` are plain `string`s and
 *    `proposals.id` / `authorizations.id` are `UUID`s.** This gate holds both to a
 *    UUID before asking the lookup, because a malformed identifier can only fail to
 *    resolve and asking is a database round trip that discloses timing. Note that
 *    `test/contract/tool-contract.test.ts`'s specimen session uses `prop_9281` and
 *    `auth_9281`, so a UUID requirement *here* would refuse that fixture — which is
 *    why the shape check is a **pre-filter on the lookup only** and the refusal is the
 *    same `unauthorized_write` either way, never a distinct error a caller could use
 *    to probe identifier formats.
 * 2. **Nothing binds a Proposal's `action_type` to the tool it authorizes.**
 *    `ProposalAuthorizationLookup.isAuthorized` answers "this pair resolves to a
 *    Proposal of this Tenant holding a recorded Authorization" and says nothing about
 *    *what* was authorized, so an Authorization for a `mark_exception_resolved`
 *    Proposal would satisfy the gate of `post_reconciliation_adjustment`.
 *    `PROPOSAL_ACTION_TYPES` in `@/policy/risk` is the three write-capable tool names,
 *    so the binding is expressible — it is just not stated anywhere in design.md or
 *    requirements.md, and widening the lookup is a change to `./tool.ts`'s contract
 *    and to task 23.2's executor. Escalated rather than invented here.
 * 3. **`ToolResult` has no variant for "the write was refused on its merits".** Both
 *    tools need one — an unbalanced adjustment, a dismissed Exception — and the
 *    closest available shape is `tool_failure` with cause `execution_error`. See the
 *    findings in `./post-reconciliation-adjustment.ts` and
 *    `./mark-exception-resolved.ts`.
 */

import type { ZodType } from 'zod';

import type { Actor, TenantId } from '@/config/configuration-service';

import {
  type FinancialTool,
  type NoTenantId,
  type ProposalAuthorizationLookup,
  TOOL_TIMEOUT_MS,
  type ToolAuditSink,
  type ToolContext,
  type ToolResult,
  type UnauthorizedWrite,
} from './tool';

/* -------------------------------------------------------------------------- */
/* The proof                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The key that makes {@link AuthorizedWrite} unforgeable.
 *
 * Module-private and never exported, so no other module can write an object literal
 * satisfying the interface: the property name is a `unique symbol` nothing else holds
 * a reference to. A cast could still manufacture one, which is why this is a
 * guardrail rather than a proof — but a cast is visible in review, and forgetting a
 * check is not.
 */
const AUTHORIZED_WRITE = Symbol('financeos.authorized_write');

/**
 * Evidence that this invocation's `proposal_id` and `authorization_id` resolved to a
 * Proposal of this Tenant holding a recorded Authorization (Requirement 12.10).
 *
 * Held by a tool body only after {@link createWriteCapableTool}'s gate passed, and
 * required by every {@link WriteSeam}, so a write cannot be issued without it.
 */
export interface AuthorizedWrite {
  readonly [AUTHORIZED_WRITE]: true;
  /** The Proposal the write is attributable to. `proposals.id`. */
  readonly proposal_id: string;
  /** The Authorization the write rests on. `authorizations.id` (Requirement 5.14). */
  readonly authorization_id: string;
  /** The session Tenant the pair resolved under. Never from an argument. */
  readonly tenant_id: TenantId;
}

/**
 * A dependency a write-capable tool may only reach with the gate's token.
 *
 * `(ctx) => SemanticLedger` would be reachable from any `ToolContext`; this is not.
 * It is the type-level half of Requirement 12.10 — a seam that can write is a seam
 * that cannot be obtained without an Authorization.
 */
export type WriteSeam<T> = (ctx: ToolContext, authorized: AuthorizedWrite) => T;

/* -------------------------------------------------------------------------- */
/* The gate                                                                   */
/* -------------------------------------------------------------------------- */

/** design.md's single reason, restated as a constant so both gates agree on it. */
export const UNAUTHORIZED_WRITE: UnauthorizedWrite = Object.freeze({
  ok: false,
  kind: 'unauthorized_write',
  reason: 'missing_authorized_proposal',
});

/** What every write-capable tool needs besides its own read and write seams. */
export interface WriteCapableToolGate {
  /**
   * Resolves the `(tenant, proposal, authorization)` triple. **Required**, unlike
   * `ToolInvokerDeps.authorization`, which is optional and fails closed: a tool
   * assembled with no lookup at all would refuse every invocation, which reads in
   * production as "the feature is broken" rather than as "the gate is working". A
   * missing lookup is a wiring fault and belongs at construction.
   */
  readonly authorization: ProposalAuthorizationLookup;
  /** Where `unauthorized_write_rejected` goes. Its own connection (see `./tool.ts`). */
  readonly audit: ToolAuditSink;
  /** `audit_events.actor_kind` / `actor_id`, both `NOT NULL`. */
  readonly actor: Actor;
  /** Injectable clock, so `occurred_at` is assertable. Defaults to the wall clock. */
  readonly now?: () => Date;
}

/**
 * What a write-capable tool declares. Everything {@link FinancialTool} declares
 * except `mode` — which is always `write_capable` — and `timeoutMs`, which is the
 * literal bound.
 */
export interface WriteCapableToolSpec<In, Out> {
  readonly name: string;
  readonly inputSchema: ZodType<NoTenantId<In>>;
  readonly outputSchema: ZodType<Out>;
  readonly freeTextArguments?: readonly string[];
  /**
   * The tool body, which receives the gate's proof as a third argument.
   *
   * It cannot be reached without one, and neither can any {@link WriteSeam} it holds.
   */
  execute(
    ctx: ToolContext,
    input: NoTenantId<In>,
    authorized: AuthorizedWrite,
  ): Promise<ToolResult<Out>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ISO-8601 UTC to millisecond precision, matching every other audit append. */
function isoMs(now: () => Date): string {
  return new Date(now().getTime()).toISOString();
}

/**
 * Wrap a tool body in Requirement 12.10's gate.
 *
 * The returned tool declares `mode: 'write_capable'`, so the invoker's own gate runs
 * first on every invocation that goes through it and this one is the backstop for a
 * direct `execute` call. Either way the invocation is refused with
 * {@link UNAUTHORIZED_WRITE}, Tenant state is untouched — no seam of the tool is
 * called at all — and `unauthorized_write_rejected` is appended exactly once.
 */
export function createWriteCapableTool<In, Out>(
  spec: WriteCapableToolSpec<In, Out>,
  gate: WriteCapableToolGate,
): FinancialTool<In, Out> {
  const now = gate.now ?? ((): Date => new Date());

  async function refuse(ctx: ToolContext): Promise<UnauthorizedWrite> {
    await gate.audit.append({
      tenantId: ctx.tenant_id,
      eventType: 'unauthorized_write_rejected',
      actor: gate.actor,
      outcome: 'blocked',
      // A refused write read nothing, so it cites no Source_Record.
      sourceRefs: [],
      payload: {
        tool: spec.name,
        mode: 'write_capable',
        reason: UNAUTHORIZED_WRITE.reason,
        // Which barrier caught it. The invoker writes no `gate` key.
        gate: 'tool',
        // Whether each was supplied — a fact about the invocation, not about any
        // Proposal's existence (Requirement 14.4).
        proposal_id_supplied: ctx.proposal_id !== undefined,
        authorization_id_supplied: ctx.authorization_id !== undefined,
      },
      occurredAt: isoMs(now),
    });
    return UNAUTHORIZED_WRITE;
  }

  /** The pair, resolved, or `null`. Both identifiers are required (Requirement 12.10). */
  async function authorize(ctx: ToolContext): Promise<AuthorizedWrite | null> {
    const proposalId = ctx.proposal_id;
    const authorizationId = ctx.authorization_id;
    if (proposalId === undefined || authorizationId === undefined) {
      return null;
    }
    if (!UUID_RE.test(proposalId) || !UUID_RE.test(authorizationId)) {
      // A malformed identifier cannot resolve, so the lookup is not asked. Finding 1:
      // the refusal is identical either way, so this discloses no identifier format.
      return null;
    }
    const authorized = await gate.authorization.isAuthorized({
      // From the session. A write is scoped to the requesting Tenant and to no other
      // (Requirement 12.7, 14.1).
      tenantId: ctx.tenant_id,
      proposalId,
      authorizationId,
    });
    if (!authorized) {
      return null;
    }
    return {
      [AUTHORIZED_WRITE]: true,
      proposal_id: proposalId,
      authorization_id: authorizationId,
      tenant_id: ctx.tenant_id,
    };
  }

  return {
    name: spec.name,
    mode: 'write_capable',
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,
    ...(spec.freeTextArguments === undefined ? {} : { freeTextArguments: spec.freeTextArguments }),

    async execute(ctx: ToolContext, input: NoTenantId<In>): Promise<ToolResult<Out>> {
      const authorized = await authorize(ctx);
      if (authorized === null) {
        return refuse(ctx);
      }
      // The only call site of the body, and the only place a token exists.
      return spec.execute(ctx, input, authorized);
    },
  };
}
