/**
 * The EXECUTE stage of the FinanceOS_Action_Service (task 23.2).
 * Requirements 5.9, 5.14, 12.10.
 *
 * design.md gives this one line — `executeAuthorized(proposalId, authorizationId):
 * Promise<ExecutionOutcome>` — and the task text gives it two clauses:
 *
 * - **invoke a write-capable tool carrying both identifiers**, and
 * - **refuse to execute without a resolvable Authorization.**
 *
 * That is the whole of what this module does. It is the other end of the hand-off
 * `./action-service.ts` describes: {@link AuthorizedExecutor} is the seam the approval
 * path calls after it has recorded a User's Authorization and re-run the Policy_Engine,
 * and this is its implementation.
 *
 * ## Why this is a separate file rather than more of `./action-service.ts`
 *
 * Task 23.1's module doc makes a checkable claim: *"this file imports no ledger, no
 * Razorpay client and no Exception writer, which is what makes Requirement 5.10's 'no
 * change to Tenant state' checkable by reading the import list rather than by trusting a
 * comment."* Adding the write-capable tool layer to that file would spend that
 * property — a reader could no longer tell by looking that a rejection cannot write.
 * So the approval path keeps its empty import list and the execution path lives here,
 * one module further out, implementing the interface 23.1 declared. There is no second
 * Action_Service: nothing here duplicates approval, rejection, withholding or the
 * outcome vocabulary, all of which are imported from `./action-service.ts`.
 *
 * ## What "invoke a write-capable tool carrying both identifiers" means concretely
 *
 * The identifiers travel on the {@link ToolSession}, because that is the only place
 * Requirement 12.10's gate reads them from — `ToolSession.proposal_id` and
 * `authorization_id`, which `createToolInvoker` resolves at step 2 of its funnel and
 * `createWriteCapableTool` resolves again inside the tool. Neither gate is restated
 * here and neither is weakened here. {@link executionSession} builds the session with
 * **this module's two identifiers spread last**, so a caller-supplied session cannot
 * carry a different pair than the one the outcome is attributed to.
 *
 * The tool itself is selected from the catalogue by the Proposal's own `action_type`
 * (see below). Its arguments come from the Proposal, not from the caller
 * ({@link ProposalExecutionSnapshot.tool_arguments}), and they are **not** validated
 * here: the tool's own `inputSchema` is the authority, so arguments that do not conform
 * come back as `schema_violation` from the invoker with no connection opened and no
 * Tenant data read (Requirement 12.9). Re-deriving that check here would be a second
 * rejection funnel for the same fact.
 *
 * ## The refusal, and why it is before the invocation rather than around it
 *
 * Requirement 5.14 is an invariant over the Audit_Log — every Proposal reaching EXECUTE
 * has an Authorization referencing it — and an invariant is cheapest to keep by making
 * its violation unreachable. So {@link executeAuthorizedProposal} resolves the named
 * Authorization through {@link ExecutionStore.findAuthorization} **before** it looks up a
 * tool, and every refusal returns a `withheld` outcome having called nothing at all:
 *
 * | Refusal | Reason returned |
 * |---|---|
 * | the Proposal does not resolve for this Tenant | `proposal_absent` |
 * | the Authorization does not resolve, references another Proposal, or is a rejection | `authorization_unresolvable` |
 * | the Proposal is not `authorized` | `not_authorized_for_execution` |
 * | `action_type` names no write-capable catalogue tool | `execution_tool_absent` |
 *
 * All four leave Tenant state exactly as it was, because the only writes this module can
 * issue are the tool invocation and {@link ExecutionStore.markExecuted}, and both sit
 * after all four. That is also what makes Property P8 (task 23.6) true rather than
 * tested-true in one direction: `authorized` is the only executable state, and it is
 * reachable only from the Policy_Engine's `auto_execute` (Requirement 5.6) or from an
 * approval that resubmitted to a non-`block` decision (Requirement 5.9, 5.14). A
 * `blocked`, `awaiting_approval`, `rejected` or `expired` Proposal is refused here, so
 * no EXECUTE-stage work happens for one — and a Proposal that reaches the invocation
 * necessarily has an approved Authorization on record.
 *
 * A rejection row is refused for the same reason Requirement 5.10 discards a rejected
 * Proposal: an `authorizations` row exists either way, so 5.14 read at its narrowest
 * would be satisfied by one, and executing on it would contradict the decision it
 * records. The same rule is what `src/tools/write-tools.test-support.ts` already applies
 * in its `ProposalAuthorizationLookup`, so the two gates agree.
 *
 * ## The action_type ↔ tool binding, and what is still open
 *
 * `./write-tool.ts` finding 2 records that nothing binds a Proposal's `action_type` to
 * the tool it authorizes, so one valid `(proposal_id, authorization_id)` pair authorizing
 * a `mark_exception_resolved` Proposal also satisfies `post_reconciliation_adjustment`'s
 * gate. **On this path that hole is closed, and here is exactly how:** the tool is not
 * an argument. {@link executeAuthorizedProposal} takes `(proposalId, authorizationId)` —
 * design.md's signature, unchanged — and resolves the tool by
 * `registry.get(snapshot.action_type)`, where `action_type` is read from the Proposal
 * the Authorization references. A caller cannot nominate a tool, so it cannot nominate a
 * different one than the Proposal proposed.
 *
 * **What is still open, stated rather than left silent:** that is a property of *this
 * entry point*, not of the gate. `createWriteCapableTool` still answers "some
 * Authorization exists" rather than "this Authorization authorized this tool", so a
 * future caller assembling a `ToolContext` itself — an internal endpoint, an Agent
 * runtime shim — can still cross the pair over. Closing it in general means widening
 * {@link ProposalAuthorizationLookup} in `src/tools/tool.ts` to take the invoked tool's
 * name (or the Proposal's `action_type`) and to answer over
 * `proposals.action_type = $tool`, which changes that module's published contract, both
 * gates, and the fixtures in `src/tools/write-tools.test-support.ts` and
 * `test/contract/tool-contract.ts`. Requirement 5.14's wording is about *an*
 * Authorization existing and neither requirements.md nor design.md states the stronger
 * rule, so the widening is a **design.md decision and is escalated, not invented here**.
 *
 * ## Reported, not silently patched
 *
 * 1. **`proposals.expected_outcome` still has no stated shape, and now two tasks need
 *    it.** Task 23.1's FINDING 2 flagged it for the accounting rule check; the EXECUTE
 *    stage needs the same column to carry the *arguments* the write-capable tool is
 *    invoked with, and task 23.3 will need it as the expected side of a comparison.
 *    {@link ProposalExecutionSnapshot.tool_arguments} is therefore typed `unknown` and
 *    passed straight to the invoker, which parses it against the tool's own schema. That
 *    keeps this module free of an invented shape at the cost of pushing the reconstitution
 *    into the adapter. Only one of the derivations is actually determined today:
 *    `post_reconciliation_adjustment`'s arguments are field-for-field a
 *    `LedgerEntrySetDraft`, which is what {@link adjustmentArgumentsFrom} states and
 *    tests. `mark_exception_resolved` needs an `exception_id` and a `resolution_note`
 *    and **no column of `proposals` carries either**, so a Proposal of that action type
 *    is not executable until `expected_outcome` is specified. Whoever specifies it
 *    closes three tasks at once.
 * 2. **A Proposal that corrects a Ledger_Entry set cannot be executed through
 *    `post_reconciliation_adjustment`.** `LedgerEntrySetDraft` carries
 *    `reverses_set_id` and Requirements 2.4 and 2.7 admit a correction only as a new
 *    reversing set, but the tool's input schema is `.strict()` and declares no such
 *    argument, so the reversal cannot be expressed as an invocation.
 *    {@link adjustmentArgumentsFrom} therefore **raises** rather than dropping the field:
 *    silently omitting it would post an ordinary adjustment for a Proposal that promised
 *    a reversal, which is a wrong Ledger_Entry set rather than a refused one. The fix is
 *    an argument on the tool (task 24.3's module) or a dedicated action type; both are
 *    above this task.
 * 3. **The two authorization lookups can disagree.** This module reads the
 *    `authorizations` row through {@link ExecutionStore}; the invoker and the tool gate
 *    ask a `ProposalAuthorizationLookup`. A pair that satisfies one and not the other —
 *    non-UUID identifiers, which the tool gate pre-filters, or two adapters over
 *    different connections — surfaces as `unauthorized_write`, and this module maps it
 *    back to a **withholding** with `authorization_unresolvable` rather than to a
 *    failure: `createWriteCapableTool` refuses before any {@link WriteSeam} is reachable
 *    and the invoker refuses before a connection is acquired, so Tenant state is
 *    provably untouched and there is nothing for Requirement 5.17 to reverse. The gate's
 *    answer wins because it is the one guarding the write.
 * 4. **`state = 'executed'` is written here; `execution_failed` is not.** Task 23.1's
 *    `PROPOSAL_STATE_TRANSITION_SQL` deliberately writes no `executed_at` and says the
 *    column belongs to this task, so {@link PROPOSAL_EXECUTED_SQL} is that statement:
 *    `state` and `executed_at` move together, guarded on `authorized`. The failure
 *    direction is **not** written, because Requirement 5.17 makes marking the Proposal
 *    execution-failed one part of a four-part obligation — reverse each applied change
 *    through `SemanticLedger.reverseSet`, raise an `execution_failure` Exception, require
 *    a new Authorization for any retry — and stamping the state without the other three
 *    would leave a Proposal that looks handled and has not been. So a failed invocation
 *    returns {@link ExecutionFailedOutcome} and writes nothing; the Proposal stays
 *    `authorized` until task 23.4's path lands. This is the same stance 23.1 took toward
 *    task 23.5's expiry, and it is a **gap while 23.4 is open**, not a completed design.
 *
 *    **Task 23.4 has since landed it**, in `./reverse-failed-execution.ts`, and nothing in
 *    this module changed for it: `recordExecutionFailure` takes the
 *    {@link ExecutionFailedOutcome} returned here and discharges all four of Requirement
 *    5.17's obligations together, and `withExecutionFailureReversal` wraps this module's
 *    {@link AuthorizedExecutor} so the approval path discharges them too. The Proposal
 *    therefore stays `authorized` only until that recorder is called — which means a caller
 *    that invokes this module **without** wiring one still leaves the gap open, and that is
 *    now a wiring obligation rather than a missing implementation.
 * 5. **No Audit_Event is appended here.** Requirement 5.2's per-stage EXECUTE event is
 *    the FinanceOS_Audit_Service's (tasks 25.x), and the invoker already appends the
 *    rejection and failure events of Requirements 12.9, 12.10, 12.11 on its own
 *    connection. The outcomes returned here are what a stage event records; task 23.6's
 *    pipeline harness is what appends them around this call.
 *
 * ## Money
 *
 * No money arithmetic. The one monetary thing that passes through is the drafted
 * `amount_paise` of an adjustment, which is `bigint` on the way in, `bigint` in the
 * tool's `z.bigint()` schema and `bigint` in the ledger. Nothing here converts, rounds,
 * formats or compares a figure, and {@link PROPOSAL_EXECUTED_SQL} touches no paise
 * column.
 */

import type { TenantId } from '@/config/configuration-service';
import type {
  DateOnly,
  LedgerEntryDraft,
  LedgerEntrySetDraft,
  SourceRef,
} from '@/ledger/posting-rules';
import {
  PROPOSAL_STATES,
  statesNoLedgerEffect,
  type NoLedgerEffect,
  type ProposalState,
  type RecordedAuthorization,
} from '@/policy/checks';
import { POST_RECONCILIATION_ADJUSTMENT } from '@/tools/post-reconciliation-adjustment';
import type { ToolRegistry } from '@/tools/registry';
import type {
  ErasedFinancialTool,
  FinancialTool,
  ToolInvoker,
  ToolResult,
  ToolSession,
} from '@/tools/tool';

import {
  ActionServiceError,
  requireIdentifier,
  type AuthorizedExecutor,
  type ExecutionOutcome,
  type WithheldOutcome,
} from './action-service';

/* -------------------------------------------------------------------------- */
/* The one state an execution may start from                                  */
/* -------------------------------------------------------------------------- */

/**
 * The only `proposal_state` a Proposal may execute from.
 *
 * `authorized` is the state both authorizing paths land on — the Policy_Engine's
 * `auto_execute` (Requirement 5.6, through `proposalStateForDecision`) and an approval
 * whose resubmission came back non-`block` (Requirement 5.9, through
 * `approveProposal`) — so it is the one state in which an Authorization is on record and
 * the Proposal has not yet executed. Every other label is refused with
 * `not_authorized_for_execution` and no write:
 *
 * - `proposed`, `blocked`, `awaiting_approval` — not authorized. `awaiting_approval` in
 *   particular is Requirement 5.8's withholding, and reaching a write-capable tool from
 *   it is exactly what Property P8 forbids.
 * - `executed`, `verified`, `verification_failed` — already executed. A second
 *   invocation would apply the effect twice (Requirement 5.11, 5.12).
 * - `execution_failed` — Requirement 5.17 requires a **new** Authorization before any
 *   retry, and the retry path is task 23.4's.
 * - `rejected`, `expired` — discarded (5.10) or withheld permanently (5.16).
 */
export const EXECUTABLE_STATES: readonly ProposalState[] = ['authorized'];

/* -------------------------------------------------------------------------- */
/* Seams                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One Proposal as the EXECUTE stage needs it.
 *
 * Deliberately narrower than `ActionProposalSnapshot`: execution re-evaluates no
 * Policy_Check, so it needs neither the Auto_Execute_Threshold nor the Approval_Window,
 * and asking for them would suggest it did.
 */
export interface ProposalExecutionSnapshot {
  /** `proposals.id`. */
  readonly proposal_id: string;
  /** `proposals.action_type`, which selects the tool. Never a caller argument. */
  readonly action_type: string;
  /** `proposals.state`. */
  readonly state: ProposalState;
  /**
   * The arguments the selected tool is invoked with, as the Proposal stated them.
   *
   * `unknown` on purpose — see finding 1. The tool's own `inputSchema` is what accepts
   * or refuses them, so nothing here has to know the shape of a column design.md never
   * specified.
   */
  readonly tool_arguments: unknown;
}

/**
 * The one read, one lookup and one write the EXECUTE stage needs.
 *
 * Implemented by an adapter that binds the session Tenant at construction — **no method
 * takes a tenant id** (Requirement 12.7, 14.1) — and a foreign Proposal or Authorization
 * reads back as `null` rather than as an error that would confirm it exists
 * (Requirement 14.4).
 */
export interface ExecutionStore {
  /**
   * The Proposal, or `null` when it does not resolve for this Tenant.
   *
   * An adapter runs task 23.1's `ACTION_PROPOSAL_LOAD_SQL`, which already selects
   * `action_type`, `state` and `expected_outcome`, and reconstitutes `tool_arguments`
   * from the last of those. See finding 1.
   */
  loadForExecution(proposalId: string): Promise<ProposalExecutionSnapshot | null>;
  /**
   * {@link EXECUTION_AUTHORIZATION_LOOKUP_SQL}. `null` when the pair does not resolve
   * for this Tenant.
   */
  findAuthorization(
    proposalId: string,
    authorizationId: string,
  ): Promise<RecordedAuthorization | null>;
  /**
   * {@link PROPOSAL_EXECUTED_SQL}. Must **throw** rather than resolve when it matched no
   * row: a Proposal that executed and whose row still says `authorized` would be
   * executed a second time by the next call, and Verification (Requirement 5.11) would
   * have no `executed_at` to run within 60 seconds of.
   */
  markExecuted(proposalId: string, executedAt: string): Promise<void>;
}

/**
 * The session an execution runs under, less the two identifiers this module supplies.
 *
 * `tenant_id` comes from the session and from nowhere else (Requirement 12.7), and the
 * `Omit` is what stops a caller from passing a `proposal_id` or `authorization_id` that
 * disagrees with the arguments the outcome is attributed to.
 */
export type ExecutionSession = Omit<ToolSession, 'proposal_id' | 'authorization_id'>;

/** Everything the EXECUTE stage reaches outside itself. */
export interface AuthorizedExecutorDeps {
  readonly store: ExecutionStore;
  /**
   * The audited Financial_Tool catalogue (`createSliceOneToolRegistry`). The tool is
   * selected from it **by the Proposal's `action_type`**, which is what binds the
   * invocation to what was authorized on this path — see the module doc comment.
   */
  readonly registry: ToolRegistry;
  /** `createToolInvoker`. Its funnel is the gate; this module does not restate it. */
  readonly invoker: ToolInvoker;
  readonly session: ExecutionSession;
  /** Injectable clock, so `executed_at` is assertable. Defaults to the wall clock. */
  readonly now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* The statements an adapter runs                                             */
/* -------------------------------------------------------------------------- */

/**
 * The named Authorization for a Proposal. Parameters:
 * `($1 tenant_id, $2 proposal_id, $3 authorization_id)`.
 *
 * Both identifiers are in the `WHERE` clause, so the statement cannot answer with an
 * Authorization recorded against a *different* Proposal — the row's `proposal_id` is
 * matched rather than merely returned. `tenant_id = $1` is the adapter's own session
 * Tenant, so another Tenant's pair reads back as zero rows (Requirement 14.4).
 *
 * No paise column is selected because an Authorization holds none.
 */
export const EXECUTION_AUTHORIZATION_LOOKUP_SQL = `
SELECT id,
       proposal_id,
       actor_kind,
       actor_user_id,
       decision,
       decided_at
  FROM authorizations
 WHERE tenant_id = $1
   AND proposal_id = $2::uuid
   AND id = $3::uuid`.trim();

/** The parameter tuple {@link EXECUTION_AUTHORIZATION_LOOKUP_SQL} expects, in order. */
export function executionAuthorizationLookupParams(
  tenantId: TenantId,
  proposalId: string,
  authorizationId: string,
): readonly [TenantId, string, string] {
  return [tenantId, proposalId, authorizationId];
}

/**
 * The EXECUTE stage's own transition. Parameters:
 * `($1 tenant_id, $2 proposal_id, $3 executed_at)`.
 *
 * Three things about it are load-bearing:
 *
 * - **`state` and `executed_at` move together.** A Proposal marked `executed` with no
 *   `executed_at` has no instant for Requirement 5.11's 60-second Verification window to
 *   be measured from, and an `executed_at` with no state change is a row that contradicts
 *   itself.
 * - **`AND state = 'authorized'`** is the guard and the concurrency control: two
 *   concurrent executions both invoke, but only the first `UPDATE` matches a row. It is
 *   also the structural half of {@link EXECUTABLE_STATES} — the database will not let a
 *   `rejected` or `expired` Proposal be stamped executed even if a caller reached this
 *   statement, which is the same invariant Property P8 asserts from outside.
 * - **`RETURNING id, state, executed_at`** is how an adapter tells a real transition from
 *   a silent no-op, which it must throw on.
 *
 * The state is the literal `'executed'` rather than a parameter, so this statement cannot
 * be bent into the `execution_failed` transition Requirement 5.17 owns (finding 4) or
 * into the `verified` one task 23.3 owns.
 */
export const PROPOSAL_EXECUTED_SQL = `
UPDATE proposals
   SET state = 'executed',
       executed_at = $3::timestamptz
 WHERE tenant_id = $1
   AND id = $2::uuid
   AND state = 'authorized'
RETURNING id, state, executed_at`.trim();

/** The parameter tuple {@link PROPOSAL_EXECUTED_SQL} expects, in order. */
export function proposalExecutedParams(
  tenantId: TenantId,
  proposalId: string,
  executedAt: string,
): readonly [TenantId, string, string] {
  return [tenantId, proposalId, executedAt];
}

/* -------------------------------------------------------------------------- */
/* Pure rules                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Why the named Authorization may not be executed on, or `null` where it may.
 *
 * **Pure**: no store, no clock, no tool. Exported because it is the whole of the task's
 * "refuse to execute without a resolvable Authorization" clause and of Requirement
 * 5.14's invariant, and a rule that decides whether a write may be issued should be
 * testable without a database behind it.
 *
 * A row that resolves must satisfy all three: it is the row that was asked for, it
 * references *this* Proposal, and it records an approval. The third is Requirement
 * 5.10's — a rejection is an `authorizations` row too, and executing on one would
 * contradict the decision it holds.
 */
export function executionAuthorizationRefusal(
  proposalId: string,
  authorizationId: string,
  recorded: RecordedAuthorization | null,
): string | null {
  if (recorded === null) {
    return (
      `no Authorization ${authorizationId} resolves for Proposal ${proposalId} under this ` +
      `Tenant, so there is nothing for the execution to rest on; Requirement 5.14 requires an ` +
      `Authorization record referencing every Proposal that reaches EXECUTE`
    );
  }
  if (recorded.id !== authorizationId) {
    return (
      `the resolved Authorization is ${recorded.id}, not the ${authorizationId} the execution ` +
      `was asked to rest on`
    );
  }
  if (recorded.proposal_id !== proposalId) {
    return (
      `Authorization ${authorizationId} references Proposal ${recorded.proposal_id}, not ` +
      `${proposalId}, so it authorizes a different action (Requirement 5.14)`
    );
  }
  if (recorded.decision !== 'approved') {
    return (
      `Authorization ${authorizationId} records the decision ${recorded.decision}, and a ` +
      `rejection discards the Proposal without execution (Requirement 5.10); an ` +
      `authorizations row alone is not an authorization to execute`
    );
  }
  return null;
}

/**
 * `post_reconciliation_adjustment`'s three arguments, in design.md's own order.
 *
 * Not a re-declaration of the tool's input type: it is the *argument object* an invoker
 * parses, and it is stated here so the derivation below has a name to return. `Paise` is
 * `bigint` and stays `bigint`.
 */
export interface AdjustmentArguments {
  readonly entry_date: DateOnly;
  readonly entries: readonly LedgerEntryDraft[];
  readonly source_refs: readonly SourceRef[];
}

/**
 * `post_reconciliation_adjustment`'s arguments from a Proposal's stated Ledger_Entry
 * effect.
 *
 * The only tool-argument derivation that is actually determined today: design.md's
 * contract for that tool is `{ entry_date, entries, source_refs }` and
 * `LedgerEntrySetDraft` carries those three fields with the same names and the same
 * meanings, so this is a projection rather than a mapping. It is exported for the
 * adapter that has to reconstitute `tool_arguments` (finding 1) and for task 23.6's
 * pipeline harness, and it is pure so both can use it with no database.
 *
 * `bigint` amounts pass through untouched — no conversion, no rounding, no formatting.
 *
 * @throws {ActionServiceError} for a stated absence of a Ledger_Entry effect (there are
 * no arguments to derive from "this action posts nothing"), or for an effect carrying
 * `reverses_set_id`, which the tool's strict input schema has no argument for. See
 * finding 2: dropping it would post an ordinary adjustment for a Proposal that promised
 * a reversal.
 */
export function adjustmentArgumentsFrom(effect: LedgerEntrySetDraft | NoLedgerEffect): AdjustmentArguments {
  if (statesNoLedgerEffect(effect)) {
    throw new ActionServiceError(
      `${POST_RECONCILIATION_ADJUSTMENT} posts a Ledger_Entry set, but the Proposal states no ` +
        `ledger effect (${effect.reason}), so there are no arguments to invoke it with`,
    );
  }
  if (effect.reverses_set_id !== undefined) {
    throw new ActionServiceError(
      `the Proposal reverses Ledger_Entry set ${effect.reverses_set_id}, and ` +
        `${POST_RECONCILIATION_ADJUSTMENT} declares no reverses_set_id argument, so the ` +
        `reversal cannot be expressed as an invocation; dropping it would post an ordinary ` +
        `adjustment for a Proposal that promised a reversing set (Requirement 2.4, 2.7)`,
    );
  }
  return {
    entry_date: effect.entry_date,
    entries: effect.entries.map((entry) => ({
      account_code: entry.account_code,
      side: entry.side,
      amount_paise: entry.amount_paise,
    })),
    source_refs: effect.source_refs.map((ref) => ({ type: ref.type, id: ref.id })),
  };
}

/**
 * The {@link ToolSession} an execution runs under: the caller's session, plus the two
 * identifiers Requirement 12.10's gate reads.
 *
 * The pair is spread **last**, so it is this module's and not the caller's.
 */
export function executionSession(
  session: ExecutionSession,
  proposalId: string,
  authorizationId: string,
): ToolSession {
  return { ...session, proposal_id: proposalId, authorization_id: authorizationId };
}

/** `FinancialTool<unknown, unknown>` is what an erased catalogue entry satisfies. */
type InvocableTool = FinancialTool<unknown, unknown>;

/**
 * A catalogue entry as something `ToolInvoker.invoke` accepts.
 *
 * No cast, for the reason `test/contract/tool-contract.ts` states: `execute` is declared
 * with method syntax, whose parameters are bivariant, and `NoTenantId<unknown>` is
 * `unknown` because `keyof unknown` is `never`.
 */
function invocable(tool: ErasedFinancialTool): InvocableTool {
  return tool;
}

/* -------------------------------------------------------------------------- */
/* The EXECUTE stage                                                          */
/* -------------------------------------------------------------------------- */

function withheld(
  proposalId: string,
  reason: WithheldOutcome['reason'],
  detail: string,
): WithheldOutcome {
  return { kind: 'withheld', proposal_id: proposalId, reason, detail };
}

/**
 * design.md's `executeAuthorized(proposalId, authorizationId)`.
 *
 * In order: resolve the Proposal, resolve the Authorization, check the state, select the
 * tool the Proposal's `action_type` names, invoke it through the {@link ToolInvoker} with
 * both identifiers on the session, and mark the Proposal executed where the invocation
 * succeeded. Nothing is written before the invocation and nothing else is written after
 * it.
 *
 * @throws {ActionServiceError} for an empty identifier — a caller fault, not a
 * withholding, the same distinction `./action-service.ts` draws.
 * @throws whatever the store raises. A `markExecuted` that matched no row is a fault the
 * caller must hear about rather than read as a tidy success.
 */
export async function executeAuthorizedProposal(
  proposalId: string,
  authorizationId: string,
  deps: AuthorizedExecutorDeps,
): Promise<ExecutionOutcome> {
  const proposal = requireIdentifier(proposalId, 'proposal_id');
  const authorization = requireIdentifier(authorizationId, 'authorization_id');
  const now = deps.now ?? ((): Date => new Date());

  const snapshot = await deps.store.loadForExecution(proposal);
  if (snapshot === null) {
    return withheld(
      proposal,
      'proposal_absent',
      'no Proposal with that identifier resolves for this Tenant, so there is nothing to ' +
        'execute (Requirement 14.4)',
    );
  }

  // Requirement 5.14, before a tool is even looked up. See the module doc comment for
  // why the invariant is kept by unreachability rather than by assertion.
  const refusal = executionAuthorizationRefusal(
    proposal,
    authorization,
    await deps.store.findAuthorization(proposal, authorization),
  );
  if (refusal !== null) {
    return withheld(proposal, 'authorization_unresolvable', refusal);
  }

  if (!(PROPOSAL_STATES as readonly string[]).includes(snapshot.state)) {
    // A corrupt row, not a Proposal an execution can be refused *about*. Refusing it as
    // "not authorized" would report a data fault as a policy outcome — the same
    // distinction `refusalFor` draws in `./action-service.ts`.
    throw new ActionServiceError(
      `the stored proposal_state ${JSON.stringify(snapshot.state)} is not one of ` +
        `${PROPOSAL_STATES.join(', ')}`,
    );
  }

  if (!EXECUTABLE_STATES.includes(snapshot.state)) {
    return withheld(
      proposal,
      'not_authorized_for_execution',
      `the Proposal is ${snapshot.state}, and execution is admissible only from ` +
        `${EXECUTABLE_STATES.join(', ')}; ${
          snapshot.state === 'executed' ||
          snapshot.state === 'verified' ||
          snapshot.state === 'verification_failed'
            ? 'it has already executed, and a second invocation would apply the effect twice ' +
              '(Requirement 5.11, 5.12)'
            : 'no Authorization stands over it in that state'
        }`,
    );
  }

  // The tool is the Proposal's, never the caller's. This is the action_type binding.
  const entry = deps.registry.get(snapshot.action_type);
  if (entry === undefined || entry.mode !== 'write_capable') {
    return withheld(
      proposal,
      'execution_tool_absent',
      entry === undefined
        ? `the Proposal's action_type ${JSON.stringify(snapshot.action_type)} names no tool in ` +
          `the catalogue, so there is nothing authorized to invoke; the catalogue holds ` +
          `${deps.registry.names().join(', ')}`
        : `the Proposal's action_type ${JSON.stringify(snapshot.action_type)} names the ` +
          `${entry.mode} tool ${entry.name}, which changes no Tenant state and therefore ` +
          `executes nothing (Requirement 12.10)`,
    );
  }

  const result: ToolResult<unknown> = await deps.invoker.invoke(
    invocable(entry),
    executionSession(deps.session, proposal, authorization),
    snapshot.tool_arguments,
  );

  if (result.ok) {
    const executedAt = new Date(now().getTime()).toISOString();
    // The EXECUTE stage's own transition, guarded on `authorized`. After the write, so a
    // Proposal is never marked executed for an invocation that did not succeed.
    await deps.store.markExecuted(proposal, executedAt);
    return {
      kind: 'executed',
      proposal_id: proposal,
      authorization_id: authorization,
      executed_at: executedAt,
    };
  }

  if (result.kind === 'unauthorized_write') {
    // Finding 3: the gate refused before any write seam was reachable and before a
    // connection was acquired, so Tenant state is untouched and this is a withholding
    // rather than a failure. `unauthorized_write_rejected` is already appended.
    return withheld(
      proposal,
      'authorization_unresolvable',
      `the write-capable tool ${entry.name} refused the invocation as ${result.reason}: the ` +
        `Authorization ${authorization} resolved for this module and not for the gate guarding ` +
        `the write, so nothing was executed and no Tenant state changed (Requirement 12.10)`,
    );
  }

  // Requirement 5.17's condition. Nothing is written here — marking the Proposal
  // execution-failed is one part of a four-part obligation task 23.4 owns. Finding 4.
  return {
    kind: 'execution_failed',
    proposal_id: proposal,
    authorization_id: authorization,
    tool: entry.name,
    failure: result.kind,
    detail: failureDetail(entry.name, result),
  };
}

/** What a refused `ToolResult` says, in one sentence a User can read. */
function failureDetail(
  tool: string,
  result: Extract<
    ToolResult<unknown>,
    { readonly kind: 'schema_violation' | 'incomplete_evidence' | 'tool_failure' }
  >,
): string {
  switch (result.kind) {
    case 'schema_violation':
      return (
        `${tool} refused the Proposal's stated arguments: ` +
        `${result.violations.map((violation) => violation.argument).join(', ')}. No connection ` +
        `was opened and no Tenant data was read (Requirement 12.9)`
      );
    case 'incomplete_evidence':
      return (
        `${tool} could not read every contributing Source_Record ` +
        `(${result.unavailable.map((entry) => `${entry.type}: ${entry.count}`).join(', ')}), so ` +
        `the figure was withheld and the write was not attempted (Requirement 12.3)`
      );
    default:
      return (
        `${tool} failed with cause ${result.cause}; whether any part of the write landed is not ` +
        `stated by the envelope, which is why Requirement 5.17 reverses each change already ` +
        `applied rather than assuming there were none`
      );
  }
}

/**
 * design.md's `executeAuthorized(proposalId, authorizationId)` with the session bound at
 * construction, ready to hand to `ActionServiceDeps.executor`.
 *
 * The session is bound rather than passed per call for the same reason
 * `createApprovalActions` binds the granted Permission set: design.md's signature takes
 * two identifiers and nothing else, and the Tenant is the session's to supply
 * (Requirement 12.7).
 */
export function createAuthorizedExecutor(deps: AuthorizedExecutorDeps): AuthorizedExecutor {
  return {
    executeAuthorized: (proposalId, authorizationId) =>
      executeAuthorizedProposal(proposalId, authorizationId, deps),
  };
}
