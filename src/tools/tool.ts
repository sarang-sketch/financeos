/**
 * The Financial_Tool contract and its enforcement (task 10.1).
 * Requirements 12.1, 12.7, 12.9, 12.11 — and 12.10, whose rejection shape lives
 * in the same envelope.
 *
 * This module owns design.md's `FinancialTool<In, Out>`, `ToolContext` and
 * `ToolResult<T>` (see "Financial_Tool_Layer" and "The shared envelope"), plus the
 * invoker that enforces them. `src/tools/registry.ts` owns the catalogue and the
 * registration-time audit of a declared input schema.
 *
 * ## Who owns which half of `ToolResult<T>`
 *
 * `src/evidence/chain-builder.ts` (task 9.1) declared the ownership split and this
 * module follows it rather than redeclaring anything:
 *
 * | Variant | Declared in |
 * |---|---|
 * | `{ ok: true, value, evidence }` | here, over 9.1's `EvidenceChain` |
 * | `incomplete_evidence` | **9.1** — imported as {@link IncompleteEvidence} |
 * | `schema_violation` | here |
 * | `tool_failure` | here |
 * | `unauthorized_write` | here |
 *
 * The reasoning is 9.1's and it holds: the last three are facts about an
 * *invocation*, not about evidence, so they belong with the layer that enforces
 * them, while `incomplete_evidence` is a fact about evidence and belongs with the
 * builder that discovers it. 9.1's `IncompleteEvidence` also has **no figure
 * field at all**, which is the structural form of Requirement 12.3's "omit the
 * figure"; redeclaring it here would risk a second shape with a nullable figure.
 * `SourceRef` and `SourceRecordType` come from `@/ledger/posting-rules` through
 * the same re-export, so there is no third copy of either.
 *
 * ## Nothing is read before the arguments are accepted
 *
 * The invoke funnel is ordered so that each rejection happens at the earliest
 * point that can detect it, and every step that could touch Tenant data comes
 * after every step that cannot:
 *
 * 1. **Parse** `rawInput` against `tool.inputSchema`. A failure returns
 *    {@link SchemaViolation} naming each non-conforming argument, appends
 *    `tool_invocation_rejected`, and **opens no connection and calls no store** —
 *    the connection is acquired in step 3, and {@link ToolContext} is the only way
 *    a tool can reach a database, so "no Tenant data is read at all" is structural
 *    rather than a claim (Requirement 12.9).
 * 2. **Authorize a write.** A `write_capable` tool whose {@link ToolSession} lacks
 *    `proposal_id` or `authorization_id`, or whose pair does not resolve to a
 *    Proposal with a recorded Authorization, is rejected with
 *    {@link UnauthorizedWrite}, `unauthorized_write_rejected` appended, and again
 *    no connection acquired (Requirement 12.10).
 * 3. **Acquire the connection for the declared mode** (see below).
 * 4. **Run under the 10-second bound** (see below).
 * 5. **Check the result envelope**: an `ok: true` result must carry a resolvable
 *    Evidence_Chain, and its `value` must satisfy `tool.outputSchema`. Neither is
 *    a `ToolResult` variant, so a failure of either is a `tool_failure` with cause
 *    `execution_error`: a figure escaping without its chain is the one thing this
 *    layer exists to prevent (Requirement 12.2).
 *
 * ## `tenant_id` is not an argument, and cannot be made one
 *
 * Two halves, because either alone is insufficient (Requirement 12.7):
 *
 * - **Type level.** Both places `In` is consumed go through {@link NoTenantId},
 *   which maps an `In` declaring `tenant_id` to a type no Zod object schema and no
 *   real handler inhabits, so such a tool does not compile. See that type for why
 *   it is a conditional rather than a `{ tenant_id?: never }` constraint. The
 *   registry additionally rejects a *schema* declaring the key at any depth, which
 *   is what catches an `In` that was inferred loosely.
 * - **Runtime.** Every input schema is `.strict()`, so a caller that sends
 *   `tenant_id` anyway gets `schema_violation` naming it. It is **rejected, not
 *   stripped**: silently ignoring it would let a caller believe it had scoped a
 *   request when it had not (design.md, "Internal endpoints").
 *
 * The Tenant reaches the tool only as `ToolContext.tenant_id`, from the session.
 *
 * ## The declared mode is backed by the connection, not by convention
 *
 * {@link ToolConnections.acquire} is asked for `tool.mode`, and the tool receives
 * whatever it returns as `ctx.db`. A `read_only` tool therefore executes on the
 * connection the provider gives for `read_only`, which is
 * `createReadOnlyClient` in `src/db/clients.ts`.
 *
 * **Stated plainly: the privilege backing does not exist yet.** `createReadOnlyClient`
 * is the client-side half only — it attaches a token and an observability header.
 * The read-only database role and its grants (`GRANT SELECT` with no `INSERT`,
 * `UPDATE` or `DELETE`) are created in the **task 26.1** RLS migration, which has
 * not landed. Until it does, `mode: 'read_only'` is enforced here as *which
 * connection the tool is handed*, and a write attempted on that connection is not
 * yet refused by the database. No comment in this file claims otherwise, and the
 * seam is shaped so that 26.1 changes only the provider adapter.
 *
 * No adapter over `src/db/clients.ts` is built here: both read-only and
 * tenant-scoped factories need the session access token, which is the API layer's
 * to hold, and `createServiceClient` is the wrong client for a tool. The provider
 * is injected for the same reason `LedgerStore` is.
 *
 * ## What the 10-second bound guarantees, and what it cannot
 *
 * On overrun the invoker aborts `ctx.signal`, releases the connection with
 * disposition `rollback`, appends `tool_failure`, and returns
 * `{ kind: 'tool_failure', cause: 'timeout' }` (Requirement 12.11).
 *
 * What that **guarantees**: the invocation returns within the bound; no partial
 * output reaches the caller; the connection the tool was writing on is rolled
 * back and released, so an open transaction on it cannot commit afterwards.
 *
 * What it **cannot** guarantee: JavaScript has no preemption, so a tool sitting in
 * synchronous work is not interrupted, and a tool awaiting I/O keeps running after
 * the race resolves. `Promise.race` abandons the work; it does not cancel it. The
 * two mitigations are honest rather than complete:
 *
 * - {@link ToolContext.signal} is an `AbortSignal` aborted at the deadline. A tool
 *   whose I/O accepts a signal is genuinely cancelled. This is the seam a
 *   signal-aware database layer plugs into; nothing threads it into
 *   `@supabase/supabase-js` today.
 * - {@link ToolConnection.release} with `'rollback'` is what actually protects
 *   Tenant state. It is the transaction, not the promise, that has to die.
 *
 * A tool that ignores the signal *and* holds a second connection the provider did
 * not give it can still write after a timeout. That is not reachable through this
 * contract, since `ctx.db` is the only connection a tool is handed, but it is not
 * prevented by the type system either.
 *
 * ## The Audit appends, and a defect a reader should not assume away
 *
 * `tool_invocation_rejected` (Requirement 12.9), `unauthorized_write_rejected`
 * (Requirement 12.10) and `tool_failure` (Requirement 12.11) go through
 * {@link ToolAuditSink} — an injected seam holding **its own connection**, exactly
 * as `LedgerAuditSink` does, so a rejection is recorded whether or not the tool's
 * transaction survived.
 *
 * **`app.append_audit_event_autonomous` is broken today.** Its
 * `dblink_connect('dbname=' || current_database())` fails with SQLSTATE `2F003`
 * because `postgres` on Supabase local is not a superuser; 8 `it.fails` markers in
 * `test/db/append-only.test.ts` record it and its repair is scheduled before
 * Slice 3. So no adapter here may reach for it, and a reader must not assume an
 * out-of-transaction SQL append works. The TypeScript sink is the whole mechanism
 * for now. `FinanceOS_Audit_Service` (task 25.1) will take the sink's place
 * without changing this contract.
 *
 * The append is **not** best-effort: Requirement 12.9 wants the rejection recorded
 * *and* the result returned, so a sink failure propagates rather than yielding a
 * rejection with no audit trail. The one exception is a failed connection release,
 * which is recorded in the `tool_failure` payload rather than thrown, because
 * swallowing the `tool_failure` result would leave the Agent unable to tell
 * "timed out, state unchanged" from "never arrived".
 *
 * ## Scope
 *
 * The registry is `./registry.ts`. The registry-driven contract harness is **task
 * 10.2** (`test/contract/tool-contract.ts`) and is not written here. The tools
 * themselves — `get_settlement_reconciliation` and the rest of the catalogue — are
 * tasks 11.x and 12.x; the only tool in this task's tests is a fixture.
 *
 * ## design.md gaps found, reported rather than patched
 *
 * 1. **One `evidence` per result.** `ToolResult<T>`'s success variant carries a
 *    single `EvidenceChain`, but `get_settlement_difference_breakdown` and
 *    `get_control_tower_metrics` produce **one chain per row / per cell** —
 *    `get_control_tower_metrics` even declares a per-cell `evidence_chain_id` in
 *    its output type. The envelope as written cannot carry them. This module keeps
 *    design.md's shape exactly and requires the top-level chain, so a multi-figure
 *    tool will have to state its per-row chains inside `Out` and nominate one for
 *    the envelope. Whoever writes 11.x needs a decision here.
 * 2. **Free-form text is prohibited and simultaneously required.**
 *    Requirement 12.9 forbids any argument carrying free-form text, and
 *    `mark_exception_resolved` takes `resolution_note: string`, which is prose by
 *    definition. `./registry.ts` resolves this with an explicit, per-tool,
 *    length-bounded allowance rather than by weakening the audit — see
 *    `freeTextArguments` there.
 * 3. **`timeoutMs: 10_000` is a literal type in design.md** but the enforcement
 *    text says "does not return a result within 10 seconds". Kept as the literal,
 *    so a tool cannot declare its own bound.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZodType } from 'zod';

import { PERMISSIONS, type Permission } from '@/authz/permissions';
import type { Actor, TenantId } from '@/config/configuration-service';
import type {
  EvidenceChain,
  IncompleteEvidence,
  SourceRecordType,
  SourceRef,
} from '@/evidence/chain-builder';

/**
 * `IncompleteEvidence`, `EvidenceChain`, `SourceRef` and `SourceRecordType` are
 * re-exported so a tool author can take the whole envelope from one module while
 * there remains exactly one declaration of each — in `@/evidence/chain-builder`
 * for the first two, and in `@/ledger/posting-rules` for the last two.
 */
export type { EvidenceChain, IncompleteEvidence, SourceRecordType, SourceRef };

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/** Requirement 12.11's bound. A literal, so no tool can declare its own. */
export const TOOL_TIMEOUT_MS = 10_000;

/* -------------------------------------------------------------------------- */
/* Session, permissions and context                                           */
/* -------------------------------------------------------------------------- */

/**
 * The 6 Permissions of Requirement 14.6, in `permission` enum order.
 *
 * **Re-exported, not declared.** `@/authz/permissions` (task 26.2) owns the single
 * declaration, which is what the transcription that used to sit here promised would
 * happen once `src/authz` existed. Tool-layer callers may keep importing from this
 * module; there is one set of labels behind both paths.
 *
 * **Nothing in this module checks a Permission.** design.md puts the Permission
 * check on the internal endpoint, *before* the input schema is parsed; the context
 * carries the set so the tool and the endpoint agree on what was granted.
 */
export { PERMISSIONS };
export type { Permission };

/** design.md's `TenantScopedClient`: the RLS-bound connection a tool reads through. */
export type ToolDbClient = SupabaseClient;

/**
 * What the invoker is given about the caller: everything in {@link ToolContext}
 * except the connection and the deadline signal, both of which the invoker
 * supplies.
 *
 * The split is the enforcement. A tool cannot be handed a database before its
 * arguments have been accepted, because the only `db` in existence at that point
 * is the one the invoker has not yet acquired.
 */
export interface ToolSession {
  /** From the session. Never from a tool argument (Requirement 12.7). */
  readonly tenant_id: TenantId;
  readonly user_id: string;
  readonly permissions: readonly Permission[];
  /** Required for `write_capable` (Requirement 12.10). */
  readonly proposal_id?: string;
  /** Required for `write_capable` (Requirement 12.10). */
  readonly authorization_id?: string;
}

/**
 * design.md's `ToolContext`, plus {@link signal}.
 *
 * `tenant_id` is here and nowhere else: it is not, and cannot be, an argument.
 */
export interface ToolContext extends ToolSession {
  /** The connection for the tool's declared mode. The only one it is handed. */
  readonly db: ToolDbClient;
  /**
   * Aborted when the 10-second bound elapses. A tool whose I/O takes a signal is
   * genuinely cancelled; one that ignores it is merely abandoned. See the module
   * doc comment on what the bound can and cannot guarantee.
   */
  readonly signal: AbortSignal;
}

/* -------------------------------------------------------------------------- */
/* ToolResult (Requirement 12.2, 12.3, 12.9, 12.10, 12.11)                    */
/* -------------------------------------------------------------------------- */

/** One non-conforming argument, named, with why it was refused. */
export interface ToolArgumentViolation {
  /**
   * The argument path as a caller wrote it: `from`, `entries[0].amount_paise`, or
   * the offending key itself for an unrecognised one.
   */
  readonly argument: string;
  readonly reason: string;
}

/**
 * Requirement 12.9. Returned **before any Tenant data is read and before any
 * connection is opened**, with `tool_invocation_rejected` appended.
 */
export interface SchemaViolation {
  readonly ok: false;
  readonly kind: 'schema_violation';
  /** One entry per non-conforming argument. Never empty. */
  readonly violations: readonly ToolArgumentViolation[];
}

/** Requirement 12.11. The invocation was terminated; Tenant state is unchanged. */
export interface ToolFailure {
  readonly ok: false;
  readonly kind: 'tool_failure';
  /** The Financial_Tool name (Requirement 12.11 names the tool). */
  readonly tool: string;
  readonly cause: 'timeout' | 'execution_error';
}

/**
 * Requirement 12.10. The single reason is design.md's: a caller learns that an
 * authorized Proposal was missing, not whether some particular Proposal exists.
 */
export interface UnauthorizedWrite {
  readonly ok: false;
  readonly kind: 'unauthorized_write';
  readonly reason: 'missing_authorized_proposal';
}

/** A figure with its chain. There is no success variant without an Evidence_Chain. */
export interface ToolSuccess<T> {
  readonly ok: true;
  readonly value: T;
  readonly evidence: EvidenceChain;
}

/**
 * design.md's envelope, composed from 9.1's evidence shapes and this module's
 * three invocation-level variants. See the module doc comment for the split.
 */
export type ToolResult<T> =
  | ToolSuccess<T>
  | IncompleteEvidence
  | SchemaViolation
  | ToolFailure
  | UnauthorizedWrite;

/* -------------------------------------------------------------------------- */
/* The tool contract                                                          */
/* -------------------------------------------------------------------------- */

export type ToolMode = 'read_only' | 'write_capable';

/** Both modes, for iteration by the task 10.2 harness. */
export const TOOL_MODES: readonly ToolMode[] = ['read_only', 'write_capable'] as const;

/**
 * The message a tool author sees instead of their input type when they declare a
 * `tenant_id` argument.
 */
export interface TenantIdIsNotAnArgument {
  readonly __tenant_id_is_not_a_tool_argument: 'the Tenant comes from ToolContext, never from an argument (Requirement 12.7)';
}

/**
 * `In`, unless `In` declares `tenant_id` — in which case it becomes
 * {@link TenantIdIsNotAnArgument}, which no Zod object schema and no real handler
 * can satisfy.
 *
 * A conditional rather than a `{ tenant_id?: never }` constraint on purpose:
 * `{ tenant_id?: never }` is a *weak type* (every property optional), and
 * TypeScript's weak-type check rejects assignment from any type with **no**
 * properties in common — which is every legitimate tool input. The constraint
 * would have rejected `{ from, to, limit }` and accepted nothing, the exact
 * inverse of the intent.
 *
 * Applied at both places `In` is consumed — `inputSchema` and `execute` — so a
 * `FinancialTool<{ tenant_id: string, ... }, Out>` has no inhabitant. It is a
 * guardrail, not a proof: an author determined to satisfy
 * `ZodType<TenantIdIsNotAnArgument>` can construct one. The registry's audit of
 * the *schema* is what closes that off, and `.strict()` closes off the caller.
 */
export type NoTenantId<In> = 'tenant_id' extends keyof In ? TenantIdIsNotAnArgument : In;

/**
 * design.md's `FinancialTool<In, Out>`.
 *
 * `inputSchema` must be a `.strict()` object schema whose every argument is
 * bounded; `./registry.ts` proves both at registration rather than trusting the
 * declaration. `timeoutMs` is the literal {@link TOOL_TIMEOUT_MS}.
 *
 * `execute` receives the **parsed** input and a {@link ToolContext} it did not
 * build. It returns `ToolResult<Out>` rather than throwing for an expected
 * outcome; a thrown error is caught by the invoker and becomes `tool_failure` with
 * cause `execution_error`.
 */
export interface FinancialTool<In, Out> {
  readonly name: string;
  readonly mode: ToolMode;
  /** Rejects unknown keys and any free-form text or SQL argument. */
  readonly inputSchema: ZodType<NoTenantId<In>>;
  readonly outputSchema: ZodType<Out>;
  readonly timeoutMs: typeof TOOL_TIMEOUT_MS;
  /**
   * Argument paths permitted to be length-bounded prose rather than
   * pattern-bounded, each of which must still carry a maximum length. Empty for
   * every tool but the one design.md's catalogue forces — see gap 2 in the module
   * doc comment. Omitted means none.
   */
  readonly freeTextArguments?: readonly string[];
  execute(ctx: ToolContext, input: NoTenantId<In>): Promise<ToolResult<Out>>;
}

/**
 * A tool with its type parameters erased, which is what a catalogue can hold and
 * what the task 10.2 harness iterates over.
 *
 * `execute` is declared with method syntax deliberately: TypeScript's method
 * parameter bivariance is what lets a `FinancialTool<In, Out>` satisfy it without
 * a cast, so the registry needs no `any` and no assertion.
 */
export interface ErasedFinancialTool {
  readonly name: string;
  readonly mode: ToolMode;
  readonly inputSchema: ZodType;
  readonly outputSchema: ZodType;
  readonly timeoutMs: typeof TOOL_TIMEOUT_MS;
  readonly freeTextArguments?: readonly string[];
  execute(ctx: ToolContext, input: never): Promise<ToolResult<unknown>>;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when an invocation is malformed in a way no `ToolResult` variant carries:
 * a session with no Tenant, or a tool declaring a bound other than 10 s.
 *
 * A caller fault, not a tool outcome. Every fault the *caller of a tool* can
 * commit — a bad argument, a missing authorization, an overrun — is a value, not
 * an exception, so an Agent never has to catch anything.
 */
export class ToolContractError extends Error {
  override readonly name = 'ToolContractError';
}

/* -------------------------------------------------------------------------- */
/* Connection seam                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One connection, held for exactly one invocation.
 *
 * {@link release} is called on **every** exit path, and its disposition is what
 * makes "Tenant state unchanged" true for a timeout or a thrown error: it is the
 * transaction that has to be rolled back, not the promise that has to be
 * cancelled.
 */
export interface ToolConnection {
  /** Handed to the tool as `ctx.db`. */
  readonly db: ToolDbClient;
  /** The mode this connection was acquired for. Must equal the tool's. */
  readonly mode: ToolMode;
  /**
   * Roll back or commit any open transaction and release the connection.
   *
   * `'rollback'` for a timeout, a thrown error, and every `ok: false` result.
   * `'commit'` only for an `ok: true` result whose envelope checked out.
   */
  release(disposition: 'commit' | 'rollback'): Promise<void>;
}

/**
 * Where a connection for a declared mode comes from.
 *
 * Injected, not imported: `read_only` maps to `createReadOnlyClient` and
 * `write_capable` to `createTenantScopedClient` in `src/db/clients.ts`, both of
 * which need the session access token that only the API layer holds. Keeping the
 * mapping outside this module is also what lets the unit tests count acquisitions
 * and prove that a schema violation makes none.
 */
export interface ToolConnections {
  /**
   * A connection whose privileges match `mode`.
   *
   * For `read_only` the role must hold no write grants (Requirement 12.7). That
   * role lands in the task 26.1 migration; see the module doc comment for what is
   * true today.
   */
  acquire(mode: ToolMode): Promise<ToolConnection>;
}

/* -------------------------------------------------------------------------- */
/* Authorization seam (Requirement 12.10)                                     */
/* -------------------------------------------------------------------------- */

/** The pair a `write_capable` invocation must carry, resolved together. */
export interface ProposalAuthorizationRef {
  readonly tenantId: TenantId;
  readonly proposalId: string;
  readonly authorizationId: string;
}

/**
 * Does this pair resolve to a Proposal of this Tenant holding a recorded
 * Authorization?
 *
 * A seam because `proposals` and `authorizations` are **task 21.1's** tables and
 * do not exist yet. Absent from {@link ToolInvokerDeps} it **fails closed**: every
 * `write_capable` invocation is rejected as `unauthorized_write`. An absent
 * authorization source must never read as "authorized".
 *
 * It answers a boolean rather than an object on purpose: "not authorized" and "no
 * such Proposal" are the same answer, because distinguishing them would confirm
 * the existence of another Tenant's Proposal (Requirement 14.4).
 */
export interface ProposalAuthorizationLookup {
  isAuthorized(ref: ProposalAuthorizationRef): Promise<boolean>;
}

/* -------------------------------------------------------------------------- */
/* Audit seam                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The Audit_Event types this layer appends, from design.md's error-handling table.
 *
 * The task text names two — `tool_invocation_rejected` and `tool_failure` — and
 * design.md's table names two more for conditions this invoker is the only funnel
 * for: `unauthorized_write_rejected` (Requirement 12.10) and `incomplete_evidence`
 * (Requirement 12.3). `@/evidence/chain-builder` deliberately appends nothing, so
 * without the append here the `incomplete_evidence` row design.md requires would
 * have no owner at all.
 */
export type ToolAuditEventType =
  | 'tool_invocation_rejected'
  | 'unauthorized_write_rejected'
  | 'incomplete_evidence'
  | 'tool_failure';

/**
 * One Audit_Event to append.
 *
 * `sourceRefs` carries identifiers only, never payload content and never a
 * credential (Requirement 13.2). `payload` carries the tool name and the reason;
 * it never carries the rejected arguments' values, because a rejected argument is
 * exactly where an injected string would be, and the Audit_Log is read by humans.
 */
export interface ToolAuditEvent {
  readonly tenantId: TenantId;
  readonly eventType: ToolAuditEventType;
  readonly actor: Actor;
  /** `audit_events.outcome`: a refused invocation is `blocked`, an overrun `failed`. */
  readonly outcome: 'blocked' | 'failed';
  readonly sourceRefs: readonly SourceRef[];
  readonly payload: Readonly<Record<string, unknown>>;
  /** UTC, ISO-8601 to millisecond precision (Requirement 13.1). */
  readonly occurredAt: string;
}

/**
 * Where the rejection Audit_Event goes — **on its own connection**, independent of
 * whatever {@link ToolConnections} handed the tool, so it commits whether or not
 * the tool's transaction did.
 *
 * See the module doc comment for why this is a TypeScript seam rather than
 * `app.append_audit_event_autonomous`, which currently fails with `2F003`.
 */
export interface ToolAuditSink {
  append(event: ToolAuditEvent): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Schema violations from Zod issues                                          */
/* -------------------------------------------------------------------------- */

/** A Zod issue, structurally, so this module needs no import of Zod's error class. */
interface ZodIssueLike {
  readonly code?: string;
  readonly path?: readonly PropertyKey[];
  readonly message: string;
  /** Present on `unrecognized_keys`, where `path` is the *container*, not the key. */
  readonly keys?: readonly string[];
}

/** `entries[0].amount_paise` from `['entries', 0, 'amount_paise']`. */
function argumentPath(path: readonly PropertyKey[]): string {
  let rendered = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      rendered += `[${segment}]`;
    } else {
      rendered += rendered === '' ? String(segment) : `.${String(segment)}`;
    }
  }
  return rendered;
}

/**
 * Zod issues as {@link ToolArgumentViolation}s, one per non-conforming argument.
 *
 * `unrecognized_keys` needs special handling: Zod 4 reports it with an **empty
 * path** and the offending names in `keys`, so reading `path` alone would name the
 * whole object rather than the argument. This is the path a smuggled `tenant_id`
 * takes, and naming it is the point — a violation reading "the input object is
 * wrong" would not tell a caller that its Tenant scoping was refused.
 */
export function violationsFromIssues(
  issues: readonly ZodIssueLike[],
): readonly ToolArgumentViolation[] {
  const violations: ToolArgumentViolation[] = [];
  for (const issue of issues) {
    const container = argumentPath(issue.path ?? []);
    if (issue.code === 'unrecognized_keys' && issue.keys !== undefined) {
      for (const key of issue.keys) {
        violations.push({
          argument: container === '' ? key : `${container}.${key}`,
          reason:
            `unrecognized argument; the input schema declares no such argument and unknown ` +
            `keys are rejected rather than stripped`,
        });
      }
      continue;
    }
    violations.push({
      argument: container === '' ? '(input)' : container,
      reason: issue.message,
    });
  }
  if (violations.length === 0) {
    // Unreachable from Zod, which never fails with no issue, but `violations` is
    // documented as never empty and a caller must not have to check.
    violations.push({ argument: '(input)', reason: 'the input does not conform to the schema' });
  }
  return violations;
}

/* -------------------------------------------------------------------------- */
/* The invoker                                                                */
/* -------------------------------------------------------------------------- */

export interface ToolInvokerDeps {
  readonly connections: ToolConnections;
  /** Must append on a connection independent of {@link connections}. */
  readonly audit: ToolAuditSink;
  /**
   * Who is invoking. `audit_events.actor_kind` / `actor_id` are `NOT NULL`, and an
   * Agent invocation is `{ kind: 'agent', id: <agent name> }`.
   */
  readonly actor: Actor;
  /** Absent means every `write_capable` invocation is refused. Fails closed. */
  readonly authorization?: ProposalAuthorizationLookup;
  /** Injectable clock, so `occurred_at` is assertable. Defaults to the wall clock. */
  readonly now?: () => Date;
}

/** Invokes a tool under the whole contract. One instance per request scope. */
export interface ToolInvoker {
  /**
   * Parse, authorize, acquire, run under the bound, and check the envelope.
   *
   * Never throws for a caller fault: every one is a `ToolResult` variant. Throws
   * {@link ToolContractError} for an unscoped session or a bad `timeoutMs`, and
   * propagates a {@link ToolAuditSink} failure, because a rejection with no audit
   * trail is not a rejection this system may report.
   */
  invoke<In, Out>(
    tool: FinancialTool<In, Out>,
    session: ToolSession,
    rawInput: unknown,
  ): Promise<ToolResult<Out>>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ISO-8601 UTC to millisecond precision, matching `LedgerAuditEvent.occurredAt`. */
function isoMs(now: () => Date): string {
  return new Date(now().getTime()).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Does an `ok: true` result actually carry a chain a drill-down could resolve?
 *
 * Structural rather than a full validation: the Evidence_Chain shape is
 * `@/evidence/chain-builder`'s to enforce, and it already did so when the chain
 * was composed. What matters here is that a figure is not escaping without one.
 */
function carriesResolvableChain(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const chain = value['evidence'];
  if (!isRecord(chain)) {
    return false;
  }
  const id = chain['evidence_chain_id'];
  return typeof id === 'string' && UUID_RE.test(id);
}

export function createToolInvoker(deps: ToolInvokerDeps): ToolInvoker {
  const { connections, audit, actor } = deps;
  const now = deps.now ?? ((): Date => new Date());

  async function appendAudit(
    tenantId: TenantId,
    eventType: ToolAuditEventType,
    outcome: 'blocked' | 'failed',
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await audit.append({
      tenantId,
      eventType,
      actor,
      outcome,
      // A rejected invocation has read nothing, so it has no Source_Record to cite.
      sourceRefs: [],
      payload,
      occurredAt: isoMs(now),
    });
  }

  /**
   * Release the connection, and never let a release failure hide the result.
   *
   * Returns the release error rather than throwing it, so a failed rollback is
   * recorded on the `tool_failure` payload — where an operator can see that
   * "Tenant state unchanged" was not confirmed — instead of replacing the
   * `tool_failure` result with an exception the Agent cannot interpret.
   */
  async function release(
    connection: ToolConnection,
    disposition: 'commit' | 'rollback',
  ): Promise<string | null> {
    try {
      await connection.release(disposition);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function invoke<In, Out>(
    tool: FinancialTool<In, Out>,
    session: ToolSession,
    rawInput: unknown,
  ): Promise<ToolResult<Out>> {
    if (!UUID_RE.test(session.tenant_id)) {
      // Not a `ToolResult`: an unscoped invocation is not a rejected argument, it
      // is an invocation that must never have been issued (Requirement 12.7).
      throw new ToolContractError(
        `invoking ${tool.name} requires the session Tenant identifier as a UUID, got ` +
          `${JSON.stringify(session.tenant_id)}; the Tenant comes from the session and an ` +
          `unscoped read must be impossible to issue by accident`,
      );
    }
    if (tool.timeoutMs !== TOOL_TIMEOUT_MS) {
      throw new ToolContractError(
        `${tool.name} declares timeoutMs ${tool.timeoutMs}; Requirement 12.11 fixes the bound ` +
          `at ${TOOL_TIMEOUT_MS} ms and a tool does not choose its own`,
      );
    }

    /* 1. Parse. No connection, no store call, no Tenant data. */
    const parsed = tool.inputSchema.safeParse(rawInput);
    if (!parsed.success) {
      const violations = violationsFromIssues(parsed.error.issues as readonly ZodIssueLike[]);
      await appendAudit(session.tenant_id, 'tool_invocation_rejected', 'blocked', {
        tool: tool.name,
        mode: tool.mode,
        // Argument *names* and reasons only. Never the rejected values: a rejected
        // argument is exactly where injected text would be.
        violations: violations.map((v) => ({ argument: v.argument, reason: v.reason })),
      });
      return { ok: false, kind: 'schema_violation', violations };
    }

    /* 2. A write needs an authorized Proposal. Still no connection. */
    if (tool.mode === 'write_capable') {
      const authorized = await isWriteAuthorized(session);
      if (!authorized) {
        await appendAudit(session.tenant_id, 'unauthorized_write_rejected', 'blocked', {
          tool: tool.name,
          mode: tool.mode,
          reason: 'missing_authorized_proposal',
          // Whether each was supplied at all, which is a fact about the invocation
          // rather than about any Proposal's existence.
          proposal_id_supplied: session.proposal_id !== undefined,
          authorization_id_supplied: session.authorization_id !== undefined,
        });
        return { ok: false, kind: 'unauthorized_write', reason: 'missing_authorized_proposal' };
      }
    }

    /* 3. The connection for the declared mode. */
    let connection: ToolConnection;
    try {
      connection = await connections.acquire(tool.mode);
    } catch (error) {
      await appendAudit(session.tenant_id, 'tool_failure', 'failed', {
        tool: tool.name,
        cause: 'execution_error',
        stage: 'acquire_connection',
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, kind: 'tool_failure', tool: tool.name, cause: 'execution_error' };
    }
    if (connection.mode !== tool.mode) {
      // The mode declaration is only as good as the connection behind it, so a
      // provider that answered the wrong one is a fault, not a fallback.
      await release(connection, 'rollback');
      throw new ToolContractError(
        `the connection provider returned a ${connection.mode} connection for ${tool.name}, ` +
          `which declares ${tool.mode}; the declared mode must be backed by privilege`,
      );
    }

    /* 4. Run under the bound. */
    const controller = new AbortController();
    const ctx: ToolContext = { ...session, db: connection.db, signal: controller.signal };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(
          new ToolContractError(`${tool.name} exceeded its ${tool.timeoutMs} ms bound`),
        );
        resolve({ kind: 'timeout' });
      }, tool.timeoutMs);
    });

    // The catch is attached before the race, so a rejection arriving *after* the
    // deadline is already handled and cannot surface as an unhandled rejection.
    const running: Promise<
      { readonly kind: 'result'; readonly result: ToolResult<Out> } | { readonly kind: 'threw'; readonly error: unknown }
    > = tool
      .execute(ctx, parsed.data)
      .then((result) => ({ kind: 'result' as const, result }))
      .catch((error: unknown) => ({ kind: 'threw' as const, error }));

    let outcome: Awaited<typeof running> | { readonly kind: 'timeout' };
    try {
      outcome = await Promise.race([running, deadline]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }

    if (outcome.kind === 'timeout') {
      // The rollback, not the abandoned promise, is what leaves Tenant state
      // unchanged. See the module doc comment on what this can and cannot promise.
      const releaseError = await release(connection, 'rollback');
      await appendAudit(session.tenant_id, 'tool_failure', 'failed', {
        tool: tool.name,
        cause: 'timeout',
        timeout_ms: tool.timeoutMs,
        ...(releaseError === null ? {} : { connection_release_failed: releaseError }),
      });
      return { ok: false, kind: 'tool_failure', tool: tool.name, cause: 'timeout' };
    }

    if (outcome.kind === 'threw') {
      const releaseError = await release(connection, 'rollback');
      await appendAudit(session.tenant_id, 'tool_failure', 'failed', {
        tool: tool.name,
        cause: 'execution_error',
        error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        ...(releaseError === null ? {} : { connection_release_failed: releaseError }),
      });
      return { ok: false, kind: 'tool_failure', tool: tool.name, cause: 'execution_error' };
    }

    /* 5. The envelope. A figure never leaves without its chain. */
    const result = outcome.result;
    if (!result.ok) {
      // A tool that could not read every contributing record has nothing to commit.
      await release(connection, 'rollback');
      if (result.kind === 'incomplete_evidence') {
        // design.md's error-handling table requires this row and nothing else
        // appends it — the chain builder deliberately appends nothing. Type counts
        // only, never a figure: there is no figure (Requirement 12.3).
        await appendAudit(session.tenant_id, 'incomplete_evidence', 'failed', {
          tool: tool.name,
          unavailable: result.unavailable.map((entry) => ({
            type: entry.type,
            count: entry.count,
          })),
        });
      }
      return result;
    }

    if (!carriesResolvableChain(result)) {
      const releaseError = await release(connection, 'rollback');
      await appendAudit(session.tenant_id, 'tool_failure', 'failed', {
        tool: tool.name,
        cause: 'execution_error',
        reason: 'ok_result_without_resolvable_evidence_chain',
        ...(releaseError === null ? {} : { connection_release_failed: releaseError }),
      });
      return { ok: false, kind: 'tool_failure', tool: tool.name, cause: 'execution_error' };
    }

    const validated = tool.outputSchema.safeParse(result.value);
    if (!validated.success) {
      // Output drift has no `ToolResult` variant, and returning an unvalidated
      // figure would defeat the typed output schema of Requirement 12.1. The task
      // 10.2 harness turns this into a test failure rather than a runtime surprise.
      const releaseError = await release(connection, 'rollback');
      await appendAudit(session.tenant_id, 'tool_failure', 'failed', {
        tool: tool.name,
        cause: 'execution_error',
        reason: 'output_schema_violation',
        violations: violationsFromIssues(
          validated.error.issues as readonly ZodIssueLike[],
        ).map((v) => ({ argument: v.argument, reason: v.reason })),
        ...(releaseError === null ? {} : { connection_release_failed: releaseError }),
      });
      return { ok: false, kind: 'tool_failure', tool: tool.name, cause: 'execution_error' };
    }

    await release(connection, 'commit');
    return { ok: true, value: validated.data, evidence: result.evidence };
  }

  async function isWriteAuthorized(session: ToolSession): Promise<boolean> {
    const { proposal_id: proposalId, authorization_id: authorizationId } = session;
    if (proposalId === undefined || authorizationId === undefined) {
      return false;
    }
    if (deps.authorization === undefined) {
      // Fail closed. An absent authorization source is not an authorization.
      // `proposals` and `authorizations` are task 21.1's.
      return false;
    }
    return deps.authorization.isAuthorized({
      tenantId: session.tenant_id,
      proposalId,
      authorizationId,
    });
  }

  return { invoke };
}
