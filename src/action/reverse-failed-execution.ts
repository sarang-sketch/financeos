/**
 * The EXECUTE-failure path of the FinanceOS_Action_Service (task 23.4).
 * Requirement 5.17.
 *
 * Requirement 5.17 is one sentence with four obligations, transcribed rather than
 * improved on:
 *
 * > IF execution of an authorized Proposal fails at the EXECUTE stage, THEN THE
 * > FinanceOS_Action_Service SHALL mark the Proposal as execution-failed, SHALL reverse
 * > each change already applied for that Proposal by creating a reversing Ledger_Entry set
 * > through THE Semantic_Ledger, SHALL create an Exception in the execution failure
 * > Exception_Category identifying the Proposal identifier and the failure reason, and
 * > SHALL attempt no further execution of that Proposal without a new Authorization.
 *
 * All four land in {@link recordExecutionFailure}, and they land **together**. That is the
 * whole point of this module: task 23.2 deliberately left the gap and recorded it as its
 * finding 4 — a failed invocation returns {@link ExecutionFailedOutcome} and writes
 * nothing, because *"stamping the state without the other three would leave a Proposal
 * that looks handled and has not been"*. This is the module that closes it.
 *
 * | Obligation | Where it lands |
 * |---|---|
 * | mark the Proposal execution-failed | {@link PROPOSAL_EXECUTION_FAILED_SQL}, guarded on `authorized` |
 * | reverse each applied change | {@link LedgerReverser.reverseSet} once per unreversed applied set |
 * | create an `execution_failure` Exception | {@link executionFailureException} through the {@link ExceptionUpserter} |
 * | no further execution without a new Authorization | the `executed_at` stamp the gate's rule reads — see below |
 *
 * ## Why this is a fourth file rather than more of `./action-service.ts`
 *
 * Task 23.1's module doc makes a checkable claim: *"this file imports no ledger, no
 * Razorpay client and no Exception writer, which is what makes Requirement 5.10's 'no
 * change to Tenant state' checkable by reading the import list rather than by trusting a
 * comment."* This module imports **both** a ledger and an Exception writer, so putting it
 * there would spend that property twice over. Task 23.2 added `./execute-authorized.ts`
 * one module further out and task 23.3 added `./verify-execution.ts` beside it for the same
 * reason; this is the fourth sibling, and `./action-service.ts` is not edited at all.
 * Nothing here duplicates approval, rejection, execution, verification or the outcome
 * vocabulary of any sibling: `ActionServiceError`, `requireIdentifier` and
 * {@link ExecutionFailedOutcome} are imported.
 *
 * ## "Reverse each applied change" needs to know which changes were applied
 *
 * `ledger_entry_sets.proposal_id` is that seam, and it is the only one in the schema:
 * `20260101000003_semantic_ledger.sql` declares it `UUID` with the comment *"set when
 * posted by an executed Proposal"*. {@link APPLIED_LEDGER_SETS_SQL} reads it, and
 * {@link FailureReversalStore.appliedLedgerSets} is the seam an adapter implements.
 *
 * **FINDING 1 — nothing populates that column today.** `LedgerSetWrite` in
 * `src/ledger/semantic-ledger.ts` has no `proposal_id` field, `postSet` never sets one, and
 * no `INSERT INTO ledger_entry_sets` in `src/` mentions it. So for every Proposal in the
 * system as it stands, {@link APPLIED_LEDGER_SETS_SQL} returns **zero rows** and the
 * reversal loop reverses nothing — not because the Proposal applied nothing, but because
 * nothing recorded that it did. Stated plainly rather than guessed around: this module
 * cannot invent the link, and reversing "every set this Tenant posted near the failure" or
 * "every set citing the Proposal's targets" would reverse other Proposals' work and other
 * Agents' derivations. The missing piece is exactly two things, and whoever writes the
 * ledger store adapter (task 26.1) or the tool's write seam (task 24.3) owns them:
 *
 * 1. a `proposal_id: string | null` field on `LedgerSetWrite`, and
 * 2. that column in the adapter's `INSERT INTO ledger_entry_sets` column list, set from
 *    `ToolSession.proposal_id` — which the write-capable tool gate already resolves and
 *    already requires (Requirement 12.10).
 *
 * Until both land, obligation 2 of Requirement 5.17 is **structurally implemented and
 * factually inert**, and that is the honest description. The reversal loop, the
 * already-reversed rule and the statements are all here and all tested; what is absent is
 * the write that makes the query non-empty.
 *
 * ## Reversing twice is not the same as reversing once
 *
 * `SemanticLedger.reverseSet` gives its reversal a NULL derivation identity precisely so a
 * reversal cannot collide with the set it reverses on `ledger_set_derivation_uniq` — and
 * because Postgres treats `NULL` as distinct in a unique constraint, **reversing the same
 * set twice yields two independent reversal sets** (`semantic-ledger.ts`, task 24.2's
 * property P14 asserts it). So `reverseSet` is not idempotent, and a failure path that
 * retried its own reversal loop would double-reverse: the pair would net to zero and the
 * *third* set would leave the accounts wrong by the original amount.
 *
 * This module therefore does not rely on `reverseSet` being safe to repeat. It asks the
 * ledger which applied sets **already carry a reversal**, in the same statement that finds
 * them:
 *
 * ```sql
 * EXISTS (SELECT 1 FROM ledger_entry_sets r
 *          WHERE r.tenant_id = s.tenant_id AND r.reverses_set_id = s.id)
 * ```
 *
 * and skips those, reporting them as {@link LedgerSetReversal}`.outcome = 'already_reversed'`
 * rather than silently. The record of what has been reversed is thus the **ledger itself**,
 * which is append-only and cannot drift from the fact it records — no `reversed_at` column,
 * no bookkeeping flag that a crash could leave stale. `reverses_set_id IS NULL` in the
 * `WHERE` clause is the other half of the same care: a reversal set must never be read back
 * as an applied change, or the loop would reverse the correction it just posted.
 *
 * ## The order of the writes, and why it differs from task 23.3's
 *
 * In order: **transition**, then **Exception**, then **reversals**. Task 23.3 writes its
 * Exception *before* its state transition and gives a reason — the transition is guarded on
 * `state = 'executed'`, so it is the irreversible step, and marking first risks a Proposal
 * that says verification-failed with nothing in the Attention_Panel. That reasoning is
 * about ordering an idempotent write against a re-entry-blocking one, and it is reused
 * here with one premise changed and one added:
 *
 * - **Changed: the transition does not block re-entry here.**
 *   {@link FAILURE_RECORDABLE_STATES} admits `execution_failed` as well as `authorized`, so
 *   a second call **resumes** an interrupted handling rather than being refused. That is
 *   safe only because both of the writes after it are repeat-safe: the Exception upsert is
 *   idempotent by fingerprint (Requirement 4.15) and the reversal loop skips what is
 *   already reversed. Every prefix of the sequence is a state the path can be re-entered
 *   from and finish.
 * - **Added: until the transition lands, the Proposal is still `authorized`, and
 *   `authorized` is the one state task 23.2 will execute from.** So the window before the
 *   stamp is a window in which the *same* Authorization could drive a second invocation of
 *   a write-capable tool — the exact thing obligation 4 forbids. Closing that door
 *   outranks Attention_Panel latency, and it is the only one of the four obligations whose
 *   delay can cause a second write.
 *
 * The Exception is nonetheless written **before** the reversals, which is 23.3's reasoning
 * applied unchanged: the reversal loop is the only fallible, multi-step part of the path,
 * and its `detail` names the sets that still stand
 * ({@link ExecutionFailureInput.applied}) — read before the upsert, so an Exception raised
 * on a handling that then failed half way tells a User exactly which Ledger_Entry sets are
 * uncorrected. An Exception written last would say "all reversed" only in the case where
 * nothing went wrong, and say nothing at all in the case where something did.
 *
 * ## "No further execution without a new Authorization" is not a new rule
 *
 * It is already half-implemented at the gate, and this module's job is to **agree with it**
 * rather than to invent a second rule:
 *
 * - `src/policy/checks.ts`'s `approvalRequirementCheck` fails an `execution_failed`
 *   Proposal unless some Authorization is recorded with `decided_at` **after**
 *   `proposals.executed_at`, naming Requirement 5.17 as the reason. It also fails one whose
 *   `executed_at` is NULL, because then *"a new Authorization cannot be told from the one
 *   that authorized the failed attempt"*.
 * - `DUPLICATE_BLOCKING_STATES` deliberately **excludes** `execution_failed`, because 5.17
 *   reverses every applied change so nothing stands to be duplicated — which is what makes
 *   a legitimate retry reachable at all.
 * - Task 23.2's `EXECUTABLE_STATES` is `['authorized']` and its `PROPOSAL_EXECUTED_SQL`
 *   carries `AND state = 'authorized'`, so an `execution_failed` Proposal is refused in
 *   TypeScript and refused again by the database.
 *
 * The one thing those three need from this module is the **instant of the failed attempt**,
 * and that is why {@link PROPOSAL_EXECUTION_FAILED_SQL} writes `executed_at` in the same
 * update as the state — exactly as task 23.2's statement does for a successful execution,
 * and differing from it in the state literal alone. Without the stamp the gate's comparison
 * has nothing to compare against and fails *every* retry, which would lock a Tenant out of
 * remediation rather than requiring a new Authorization for it. The stamp is the whole of
 * obligation 4: `execution_failed` is not executable, and leaving it needs an Authorization
 * dated after the stamp. No predicate here restates that; `approvalRequirementCheck` is the
 * one place it lives, and `./reverse-failed-execution.test.ts` asserts the agreement by
 * running that check against a row shaped as this module leaves it.
 *
 * ## FINDINGS — reported, not silently patched
 *
 * 1. **Nothing populates `ledger_entry_sets.proposal_id`.** See the section above. This is
 *    the headline finding: the column, the statement and the loop exist, and the write that
 *    fills the column does not.
 * 2. **Requirement 5.17 states no impact figure for the Exception, and
 *    `exceptions.impact_paise` is `NOT NULL`.** The choice made here is
 *    `|proposals.impact_paise|` — the impact the Proposal stated — with `direction`
 *    `not_applicable`. Reasons, so the choice can be argued with: the Attention_Panel
 *    orders by impact, and "a ₹3,82,000 adjustment failed" is the fact a User needs ranked,
 *    whereas the *residue* after a complete reversal is zero by construction and would rank
 *    every execution failure at the bottom. `direction` is `not_applicable` because once
 *    every applied change is reversed nothing is short and nothing is in excess; a
 *    `shortfall` label would assert money is missing when 5.17's own remedy is that it is
 *    not. The gross debit total of the applied sets travels in `detail` as
 *    `applied_debit_total_paise`, so the figure that *was* posted is not lost.
 * 3. **The applied Ledger_Entry sets are in `detail`, not in `source_refs`.** `source_record_type`
 *    has a `ledger_entry_set` label and attaching them would put them in
 *    `exception_source_records`, which is tempting. It would also be a bug:
 *    `execution_failure` is not range-scoped, so its whole ref set **is** its identity
 *    (Requirement 4.15), and a resumed or retried handling that finds a different number of
 *    applied sets would compute a different fingerprint and open a *second* Exception for
 *    one failure. The refs are therefore the Proposal and its targets — both fixed for the
 *    life of the Proposal — and the sets are `detail`, which a re-run is free to rewrite.
 * 4. **No Audit_Event is appended here.** design.md's error table asks for *"Audit_Event
 *    stage `EXECUTE`, outcome `failed`, plus an Audit_Event for each reversing
 *    Ledger_Entry set"*; Requirement 5.17 asks for no Audit_Event at all, unlike
 *    Requirement 5.16, which says "SHALL append an Audit_Event" in as many words and is why
 *    task 23.5 appends one. The per-stage EXECUTE event is Requirement 5.2's, which the
 *    FinanceOS_Audit_Service owns and task 23.6's pipeline harness appends around this
 *    call; {@link ExecutionFailureRecorded} carries the failure reason, the failure instant
 *    and one {@link LedgerSetReversal} per set so that both the stage event and the
 *    per-reversal events can be appended from it without this module guessing at the
 *    divergence. Flagged rather than resolved either way.
 * 5. **A reversal that cannot be posted throws.** `reverseSet` returns
 *    `{ ok: false, kind: 'unbalanced' }` for a set the store misreported, and a set that
 *    balanced still balances with its sides exchanged — so this is unreachable for a
 *    correctly persisted set. Reached anyway, it is a fault and not an outcome: reporting
 *    "handled" for a Proposal whose money still stands is the one answer that must not be
 *    available. The Exception is already open by then, naming the set, which is why the
 *    Exception is written first.
 * 6. **`Actor` has no label for the Action_Service itself.** `reverseSet` writes
 *    `ledger_entry_sets.created_by` from the `actor` argument, whose `kind` is
 *    `'user' | 'agent' | 'policy_engine'`. A reversal is attributable to whoever requested
 *    the execution that failed, so {@link FailureReversalDeps.actor} is a required
 *    dependency the caller binds from the session — the approving User, or `policy_engine`
 *    for an `auto_execute` Proposal. Defaulting it here would attribute every reversal to a
 *    constant.
 * 7. **`proposals.expected_outcome` still has no stated shape**, and this is the fourth
 *    task to say so (23.1 FINDING 2, 23.2 finding 1, 23.3 FINDING 1). This module does not
 *    read it — a failed execution has no observed outcome to compare — so it is flagged
 *    only to keep the count honest.
 *
 * ## Money
 *
 * `Paise` (`bigint`) throughout: the Proposal's stated impact, each applied set's declared
 * debit total, and their sum through the range-checked `sum` of the
 * FinanceOS_Calculation_Service. Money reaches SQL and `exceptions.detail` as the decimal
 * string {@link toWire} produces, and comes back out of `::text` as `BigInt(...)` in the
 * adapter. No `Number(...)` on a monetary value, no `toFixed`, no `NUMERIC`. No monetary
 * arithmetic decides anything here — the reversal amounts are the ledger's, mirrored by
 * `reverseSet`, and this module never computes one.
 */

import { sum, type Paise } from '@/calc/calculation-service';
import type { Actor, TenantId } from '@/config/configuration-service';
import {
  canonicalSourceRefs,
  type ExceptionDetail,
  type ExceptionSourceRef,
  type ExceptionUpsertInput,
  type ExceptionUpserter,
} from '@/agents/exception-fingerprint';
import type { SourceRef } from '@/ledger/posting-rules';
import type { SemanticLedger } from '@/ledger/semantic-ledger';
import { PROPOSAL_STATES, type ProposalState } from '@/policy/checks';
import { toWire } from '@/wire/paise-wire';

import {
  ActionServiceError,
  requireIdentifier,
  type AuthorizedExecutor,
  type ExecutionFailedOutcome,
  type ExecutionOutcome,
} from './action-service';

/* -------------------------------------------------------------------------- */
/* The constants Requirement 5.17 fixes                                       */
/* -------------------------------------------------------------------------- */

/** The `exception_category` Requirement 5.17 names. One of the 14 enum labels. */
export const EXECUTION_FAILURE_CATEGORY = 'execution_failure' as const;

/**
 * The `proposal_state` labels this path may run from.
 *
 * Two, and each is a different call:
 *
 * - **`authorized`** — the state task 23.2 leaves a Proposal in when an invocation failed.
 *   Its finding 4 says so explicitly: the failed invocation writes nothing, so the row
 *   still reads `authorized` when this module is handed the {@link ExecutionFailedOutcome}.
 *   This is the ordinary call.
 * - **`execution_failed`** — a **resumption**. The three writes are ordered so that every
 *   prefix of them is a state this path can finish from, and the two after the transition
 *   are repeat-safe (an idempotent Exception fingerprint, a reversal loop that skips what
 *   already carries a reversal). Refusing a second call would mean an interruption between
 *   the stamp and the last reversal left applied changes standing with no way to reverse
 *   them, because the transition is guarded on `authorized` and could never be re-run.
 *
 * Every other label is refused with a reason and no write:
 *
 * - `proposed`, `blocked`, `awaiting_approval` — nothing was authorized, so no execution
 *   can have failed. Reaching a ledger from `awaiting_approval` is what Requirement 5.8 and
 *   property P8 forbid.
 * - `executed`, `verified`, `verification_failed` — the execution **completed**. Requirement
 *   5.12 leaves an executed change in place for human review rather than auto-reverting it
 *   (design.md's error table says so in as many words), so reversing here would undo a
 *   change no requirement asks to be undone.
 * - `rejected`, `expired` — discarded (Requirement 5.10) or withheld permanently
 *   (Requirement 5.16); neither ever executed.
 */
export const FAILURE_RECORDABLE_STATES: readonly ProposalState[] = [
  'authorized',
  'execution_failed',
];

/**
 * Why no failure was recorded. Neither of these is a failure that was handled, which is the
 * distinction the whole module rests on: 5.17's four obligations follow from an execution
 * that **failed**, and a call about a Proposal that never executed has nothing to reverse.
 *
 * - `proposal_absent` — no such Proposal for this Tenant. A foreign row is an absent row,
 *   never an error that would confirm its existence (Requirement 14.4).
 * - `not_a_failed_execution` — the Proposal is in none of {@link FAILURE_RECORDABLE_STATES}.
 */
export const NOT_RECORDED_REASONS = ['proposal_absent', 'not_a_failed_execution'] as const;

export type NotRecordedReason = (typeof NOT_RECORDED_REASONS)[number];

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What happened to one applied Ledger_Entry set.
 *
 * `already_reversed` carries no `reversal_set_id` because {@link APPLIED_LEDGER_SETS_SQL}
 * answers `EXISTS`, not the identifier: the question the loop asks is "must this be
 * reversed", and reading back *which* reversal answered it would invite a caller to treat
 * one of several reversals as canonical. `reverses_set_id` on the reversal is the link
 * (Requirement 2.4), and it is where a reader should look.
 */
export interface LedgerSetReversal {
  /** The applied `ledger_entry_sets.id`. */
  readonly set_id: string;
  readonly outcome: 'reversed' | 'already_reversed';
  /** The new reversing set, present only for `reversed`. */
  readonly reversal_set_id?: string;
}

/**
 * Requirement 5.17, all four obligations discharged for one Proposal.
 *
 * Carries what an Audit_Event would need (FINDING 4): the failure reason, the instant the
 * failure was stamped, and one {@link LedgerSetReversal} per applied set.
 */
export interface ExecutionFailureRecorded {
  readonly kind: 'execution_failure_recorded';
  readonly proposal_id: string;
  /** The Authorization the failed attempt rested on (Requirement 5.14). */
  readonly authorization_id: string;
  /**
   * `proposals.executed_at` after the stamp: the instant of the failed attempt, and the
   * instant a retry's Authorization must be dated after (Requirement 5.17, and
   * `approvalRequirementCheck`).
   */
  readonly failed_at: string;
  /** The refused `ToolResult`'s discriminant, verbatim from task 23.2. */
  readonly failure: ExecutionFailedOutcome['failure'];
  /** One entry per applied set, in the order they were posted. Empty where none was applied. */
  readonly reversals: readonly LedgerSetReversal[];
  /** The `execution_failure` Exception naming the Proposal and the failure reason. */
  readonly exception_id: string;
  /**
   * `false` where the Exception this condition names had already been closed by a User and
   * was therefore **left closed** (Requirement 4.15 scopes the update to open Exceptions).
   * The identifier is still reported, so "not reopened" is never indistinguishable from
   * "created".
   */
  readonly exception_open: boolean;
  /**
   * `false` where the Proposal was already `execution_failed` and this call **resumed** an
   * interrupted handling. The transition is not re-run and `failed_at` is the instant the
   * earlier call stamped, never a fresh one — moving it would move the deadline a retry's
   * Authorization has to beat.
   */
  readonly transitioned: boolean;
}

/** No failure was recorded, and why. Nothing was written and nothing was reversed. */
export interface ExecutionFailureNotRecorded {
  readonly kind: 'not_recorded';
  readonly proposal_id: string;
  readonly reason: NotRecordedReason;
  /** Human-readable, and always present: a User reads this on the Proposal. */
  readonly detail: string;
  /** The state the Proposal was found in, where it resolved. */
  readonly state?: ProposalState;
}

export type ExecutionFailureOutcome = ExecutionFailureRecorded | ExecutionFailureNotRecorded;

/**
 * Requirement 5.17's path, with the session bound at construction.
 *
 * Not part of design.md's `ActionService` interface, which names five methods and none of
 * them this: design.md folds the failure path into the prose for `executeAuthorized`
 * (*"EXECUTE failure reverses applied changes through `SemanticLedger.reverseSet`, raises an
 * execution failure Exception, and requires a new Authorization for any retry"*). It is a
 * separate seam here for the reason the module doc gives — the import list of
 * `./action-service.ts` is evidence, and a ledger imported into it would spend that.
 */
export interface ExecutionFailureRecorder {
  record(failure: ExecutionFailedOutcome): Promise<ExecutionFailureOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Seams                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One Ledger_Entry set applied for a Proposal, as {@link APPLIED_LEDGER_SETS_SQL} returns
 * it.
 *
 * `reversed` is read from the ledger rather than from a flag this module writes — see the
 * module doc comment on why `reverseSet` being non-idempotent makes that the only safe
 * record.
 */
export interface AppliedLedgerSet {
  /** `ledger_entry_sets.id`. */
  readonly set_id: string;
  /** The set's declared `total_debit_paise`. `bigint`, equal to its credit total. */
  readonly total_debit_paise: Paise;
  /** Whether some set already carries `reverses_set_id = this set`. */
  readonly reversed: boolean;
}

/**
 * One Proposal as the failure path needs it.
 *
 * Deliberately not task 23.1's `ActionProposalSnapshot`: the failure path re-evaluates no
 * Policy_Check, so it needs neither the Auto_Execute_Threshold nor the Approval_Window, and
 * asking for them would suggest it did. It needs `impact_paise`, which task 23.3's VERIFY
 * snapshot deliberately omits — for the opposite reason. VERIFY has an *observed* figure and
 * compares it against `expected_outcome`, so reading the stated impact there would invite a
 * comparison against the wrong column; a failed execution has no observed figure at all, and
 * the stated impact is the only honest magnitude for the Exception (FINDING 2).
 */
export interface ProposalFailureSnapshot {
  readonly proposal_id: string;
  /** `proposals.action_type`. Reported on the Exception so the failure names the action. */
  readonly action_type: string;
  readonly state: ProposalState;
  /**
   * `proposals.executed_at`. `null` for a Proposal still `authorized` — which is the
   * ordinary case here, because the attempt that failed wrote nothing. Present on a
   * resumption, where it is the instant the earlier call stamped.
   */
  readonly executed_at: string | null;
  /** `proposals.target_source_records`, the ordered target Source_Record set. */
  readonly target_source_records: readonly SourceRef[];
  /** `proposals.evidence_chain_id`. `NOT NULL` in the schema. */
  readonly evidence_chain_id: string;
  /** `proposals.impact_paise`, **signed**. Integer paise as `bigint` (Requirement 15.1). */
  readonly impact_paise: Paise;
}

/**
 * The two reads and one write the failure path needs.
 *
 * Implemented by an adapter that binds the session Tenant at construction — **no method
 * takes a tenant id** (Requirement 12.7, 14.1) — and a foreign Proposal reads back as
 * `null` rather than as an error that would confirm it exists (Requirement 14.4).
 */
export interface FailureReversalStore {
  /** {@link PROPOSAL_FAILURE_LOAD_SQL}. `null` when the Proposal does not resolve. */
  loadForFailure(proposalId: string): Promise<ProposalFailureSnapshot | null>;
  /**
   * {@link APPLIED_LEDGER_SETS_SQL}. Every set posted for this Proposal that is not itself
   * a reversal, in posting order, each carrying whether it has already been reversed.
   *
   * Empty is a legitimate answer — an invocation can fail before it writes anything — and
   * it is also what FINDING 1 makes the answer for **every** Proposal until
   * `ledger_entry_sets.proposal_id` is populated.
   */
  appliedLedgerSets(proposalId: string): Promise<readonly AppliedLedgerSet[]>;
  /**
   * {@link PROPOSAL_EXECUTION_FAILED_SQL}. Must **throw** rather than resolve when it
   * matched no row: a Proposal whose row still says `authorized` is a Proposal task 23.2
   * will execute again on the same Authorization, which is precisely what obligation 4
   * forbids.
   */
  markExecutionFailed(proposalId: string, failedAt: string): Promise<void>;
}

/**
 * The one ledger operation this path performs, and the only one it may.
 *
 * `Pick` of the real {@link SemanticLedger} rather than a fresh interface, so there is no
 * second declaration of `reverseSet` to drift from it, and so a fake in a test satisfies
 * one method instead of four. `postSet`, `postFromSource` and `trialBalance` are
 * deliberately out of reach: Requirement 5.17 corrects by reversal and by nothing else
 * (Requirement 2.4, 2.7), and a module that could post an arbitrary set could "correct" one
 * by writing a different one.
 */
export type LedgerReverser = Pick<SemanticLedger, 'reverseSet'>;

/** Everything the failure path reaches outside itself. */
export interface FailureReversalDeps {
  readonly store: FailureReversalStore;
  /** `createSemanticLedger(...)`, narrowed to {@link LedgerReverser}. */
  readonly ledger: LedgerReverser;
  /**
   * The Exception writer of Requirement 5.17, bound to the session Tenant
   * (`createExceptionUpserter`). Its fingerprint is what makes the write repeat-safe, which
   * is what lets a resumption re-raise the same condition onto one row.
   */
  readonly exceptions: ExceptionUpserter;
  /**
   * The session Tenant. `SemanticLedger.reverseSet` takes one as its first argument, unlike
   * every store seam in this directory, so it is bound here **once** from the session and
   * never passed by a caller of {@link recordExecutionFailure} (Requirement 12.7).
   */
  readonly tenantId: TenantId;
  /**
   * Who the reversal is attributed to: `ledger_entry_sets.created_by` on each reversing
   * set. Required rather than defaulted — see FINDING 6.
   */
  readonly actor: Actor;
  /** Injectable clock, so `failed_at` and the Exception's `detected_at` are assertable. */
  readonly now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* The statements an adapter runs                                             */
/* -------------------------------------------------------------------------- */

/**
 * One Proposal as the failure path needs it. Parameters: `($1 tenant_id, $2 proposal_id)`.
 *
 * `impact_paise::text` is the money wire contract (Requirement 15.1, 15.8): the `paise`
 * domain is `BIGINT`, and any transport that parses it as a JSON number coerces it to an
 * IEEE-754 double. It crosses as a decimal string and becomes `bigint` in the adapter, never
 * `Number(...)`.
 *
 * `expected_outcome` is **not** selected. A failed execution has no observed outcome to
 * compare against it, and selecting the one column whose shape nobody has specified
 * (FINDING 7) would suggest this path reads it.
 */
export const PROPOSAL_FAILURE_LOAD_SQL = `
SELECT id,
       action_type,
       target_source_records,
       impact_paise::text AS impact_paise,
       evidence_chain_id,
       state,
       executed_at
  FROM proposals
 WHERE tenant_id = $1
   AND id = $2::uuid`.trim();

/** The parameter tuple {@link PROPOSAL_FAILURE_LOAD_SQL} expects, in order. */
export function proposalFailureLoadParams(
  tenantId: TenantId,
  proposalId: string,
): readonly [TenantId, string] {
  return [tenantId, proposalId];
}

/**
 * Every change applied for one Proposal, with whether it has already been reversed.
 * Parameters: `($1 tenant_id, $2 proposal_id)`.
 *
 * Four clauses, each load-bearing:
 *
 * - **`s.proposal_id = $2`** is the only record of "applied for that Proposal" the schema
 *   has (`ledger_entry_sets.proposal_id`, *"set when posted by an executed Proposal"*). See
 *   FINDING 1: nothing writes it yet, so this returns zero rows today.
 * - **`s.reverses_set_id IS NULL`** keeps a reversal from being read back as an applied
 *   change. Without it a resumed handling would reverse the corrections the first pass
 *   posted, and each round trip would leave the accounts wrong by the original amount.
 * - **the `EXISTS` subquery** is the already-reversed test, taken from the ledger itself
 *   rather than from a flag. `reverseSet` is not idempotent — reversing twice yields two
 *   independent reversal sets — so this is what makes the loop repeat-safe.
 * - **`ORDER BY s.created_at, s.id`** so two passes see the same sets in the same order and
 *   the reported {@link LedgerSetReversal} list is deterministic.
 *
 * `total_debit_paise::text` for the money wire contract, as above. It is selected because
 * the Exception's `detail` reports the gross magnitude that was posted (FINDING 2); no
 * arithmetic is done in SQL.
 */
export const APPLIED_LEDGER_SETS_SQL = `
SELECT s.id,
       s.total_debit_paise::text AS total_debit_paise,
       EXISTS (
         SELECT 1
           FROM ledger_entry_sets r
          WHERE r.tenant_id = s.tenant_id
            AND r.reverses_set_id = s.id
       ) AS reversed
  FROM ledger_entry_sets s
 WHERE s.tenant_id = $1
   AND s.proposal_id = $2::uuid
   AND s.reverses_set_id IS NULL
 ORDER BY s.created_at, s.id`.trim();

/** The parameter tuple {@link APPLIED_LEDGER_SETS_SQL} expects, in order. */
export function appliedLedgerSetsParams(
  tenantId: TenantId,
  proposalId: string,
): readonly [TenantId, string] {
  return [tenantId, proposalId];
}

/**
 * Requirement 5.17's transition. Parameters: `($1 tenant_id, $2 proposal_id, $3 failed_at)`.
 *
 * Identical to task 23.2's `PROPOSAL_EXECUTED_SQL` but for the state literal, and that is
 * deliberate rather than incidental — the two directions of the EXECUTE stage are recorded
 * with identical provenance, the same argument task 23.1's `USER_AUTHORIZATION_SQL` makes
 * for an approval and a rejection, and task 23.3's two verification statements make for a
 * match and a difference. Three things about it:
 *
 * - **`state` and `executed_at` move together.** `approvalRequirementCheck` tells "a new
 *   Authorization" from the one that authorized the failed attempt by comparing
 *   `authorizations.decided_at` against `proposals.executed_at`, and it fails an
 *   `execution_failed` Proposal that carries no `executed_at` at all. So a stamp with no
 *   instant would not merely lose information: it would make every retry unauthorizable and
 *   lock the Tenant out of remediating (Requirement 5.17).
 * - **`AND state = 'authorized'`** is the guard and the concurrency control: two callers
 *   handling the same failure both try, and only the first `UPDATE` matches a row. The
 *   loser's store throws, and its caller re-enters from `execution_failed` — which is
 *   admissible, and which is why the guard can be this narrow. It is also the storage half
 *   of task 23.2's `EXECUTABLE_STATES`: the database will not stamp a `rejected` or
 *   `expired` Proposal execution-failed even if a caller reached this statement.
 * - **`RETURNING id, state, executed_at`** is how an adapter tells a real transition from a
 *   silent no-op, which it must throw on.
 *
 * The state is the literal `'execution_failed'` rather than a parameter, so this statement
 * cannot be bent into task 23.2's `executed` transition, task 23.3's two verification ones,
 * or task 23.5's `expired` one.
 */
export const PROPOSAL_EXECUTION_FAILED_SQL = `
UPDATE proposals
   SET state = 'execution_failed',
       executed_at = $3::timestamptz
 WHERE tenant_id = $1
   AND id = $2::uuid
   AND state = 'authorized'
RETURNING id, state, executed_at`.trim();

/** The parameter tuple {@link PROPOSAL_EXECUTION_FAILED_SQL} expects, in order. */
export function proposalExecutionFailedParams(
  tenantId: TenantId,
  proposalId: string,
  failedAt: string,
): readonly [TenantId, string, string] {
  return [tenantId, proposalId, failedAt];
}

/* -------------------------------------------------------------------------- */
/* Pure rules                                                                 */
/* -------------------------------------------------------------------------- */

/** `|v|` on the `bigint`. No `Math.abs`, which would coerce money to a double. */
function absPaise(v: Paise): Paise {
  return v < 0n ? -v : v;
}

/** Σ of the declared debit totals of the applied sets. `0n` for none. Range-checked. */
export function appliedDebitTotalPaise(applied: readonly AppliedLedgerSet[]): Paise {
  return sum(applied.map((set) => set.total_debit_paise));
}

/** Reason and detail for a refusal, or `null` when the failure may be recorded. */
interface Refusal {
  readonly reason: NotRecordedReason;
  readonly detail: string;
}

/**
 * Whether Requirement 5.17's obligations may be discharged against this Proposal, and why
 * not where they may not.
 *
 * **Pure**: no store, no clock, no ledger. Exported because it is the whole of the
 * admissibility rule and a rule that decides whether a reversal may be posted should be
 * testable without a database behind it.
 *
 * @throws {ActionServiceError} for a stored `state` that is not a `proposal_state` label —
 * a corrupt row is a data fault rather than a Proposal a failure can be refused *about*,
 * the same distinction all three siblings draw.
 */
export function failureRecordingRefusalFor(snapshot: ProposalFailureSnapshot): Refusal | null {
  if (!(PROPOSAL_STATES as readonly string[]).includes(snapshot.state)) {
    throw new ActionServiceError(
      `the stored proposal_state ${JSON.stringify(snapshot.state)} is not one of ` +
        `${PROPOSAL_STATES.join(', ')}`,
    );
  }

  if (FAILURE_RECORDABLE_STATES.includes(snapshot.state)) {
    return null;
  }

  const executed =
    snapshot.state === 'executed' ||
    snapshot.state === 'verified' ||
    snapshot.state === 'verification_failed';

  return {
    reason: 'not_a_failed_execution',
    detail:
      `the Proposal is ${snapshot.state}, and Requirement 5.17 follows an execution that ` +
      `failed at the EXECUTE stage, which is admissible only from ` +
      `${FAILURE_RECORDABLE_STATES.join(', ')}; ${
        executed
          ? 'this execution completed, and Requirement 5.12 leaves a completed change in ' +
            'place for human review rather than reverting it'
          : 'no execution was ever authorized for this Proposal, so there is nothing applied ' +
            'to reverse'
      }`,
  };
}

/* -------------------------------------------------------------------------- */
/* Requirement 5.17's Exception — pure                                        */
/* -------------------------------------------------------------------------- */

/** What {@link executionFailureException} needs. All of it comes from the row or the failure. */
export interface ExecutionFailureInput {
  readonly proposal_id: string;
  /** The Authorization the failed attempt rested on (Requirement 5.14). */
  readonly authorization_id: string;
  readonly action_type: string;
  /** The write-capable Financial_Tool that was invoked. */
  readonly tool: string;
  /** Requirement 5.17's "failure reason": the refused `ToolResult`'s discriminant. */
  readonly failure: ExecutionFailedOutcome['failure'];
  /** The sentence task 23.2 wrote about that failure, verbatim. */
  readonly failure_detail: string;
  /** `proposals.target_source_records` — attached as Source_Records, like task 23.3's. */
  readonly target_source_records: readonly SourceRef[];
  readonly evidence_chain_id: string;
  /** `proposals.impact_paise`, signed. The Exception carries its magnitude (FINDING 2). */
  readonly impact_paise: Paise;
  /** `proposals.executed_at` after the stamp: the instant of the failed attempt. */
  readonly failed_at: string;
  /** The applied sets as read **before** the reversal loop ran. */
  readonly applied: readonly AppliedLedgerSet[];
  /** The instant the failure was recorded. ISO-8601 UTC to millisecond precision. */
  readonly detected_at: string;
}

/**
 * Requirement 5.17's Exception, as an {@link ExceptionUpsertInput}. **Pure** — no store, no
 * clock, no ledger — so what the Exception says is assertable without a database.
 *
 * Requirement 5.17 asks for two things by name and the row needs three more:
 *
 * - **the execution failure Exception_Category** — {@link EXECUTION_FAILURE_CATEGORY}, one
 *   of the 14 `exception_category` labels;
 * - **the Proposal identifier and the failure reason** — the Proposal is attached as a
 *   Source_Record (`{ type: 'proposal', id }`, one of the 13 `source_record_type` labels),
 *   so it appears in `exception_source_records` and therefore in the Attention_Panel's
 *   evidence rather than only in `detail`, where it is *also* stated; the failure reason is
 *   `detail.failure` and `detail.failure_detail`, the discriminant and the sentence task
 *   23.2 wrote about it;
 * - **an impact**, because `exceptions.impact_paise` is `NOT NULL` and 5.17 states none —
 *   `|proposals.impact_paise|`, with `direction` `not_applicable`. See FINDING 2 for why
 *   that figure and why no direction.
 *
 * The Proposal's target Source_Records are attached too, as task 23.3's
 * `verificationFailureException` attaches them: they are what the action was about, and
 * they are fixed for the life of the Proposal, so they can be part of the identity without
 * making it move. The **applied Ledger_Entry sets are not** — see FINDING 3, which is the
 * subtle one: `execution_failure` is not range-scoped, so its whole ref set is its identity
 * (Requirement 4.15), and a resumption that saw a different number of applied sets would
 * open a second Exception for one failure.
 *
 * `detail` carries every figure as the decimal string {@link toWire} produces, never as a
 * JSON number (Requirement 15.1, 15.8).
 *
 * @throws {ExceptionFingerprintError} for a target ref that cannot be encoded — an
 * identifier carrying a fingerprint separator, which `canonicalSourceRefs` rejects rather
 * than allowing two different target sets to collide onto one Exception.
 * @throws {PaiseRangeError} when the applied debit totals do not sum inside the paise range.
 */
export function executionFailureException(input: ExecutionFailureInput): ExceptionUpsertInput {
  const proposalRef: ExceptionSourceRef = {
    type: 'proposal',
    id: input.proposal_id,
    role: 'proposal',
  };
  // Canonicalised here so a target repeated in `target_source_records`, or one repeating the
  // Proposal itself, is one link rather than a primary key collision.
  const targets: readonly ExceptionSourceRef[] = canonicalSourceRefs(
    input.target_source_records,
    'target_source_records',
  )
    .filter((ref) => !(ref.type === 'proposal' && ref.id === input.proposal_id))
    .map((ref) => ({ type: ref.type, id: ref.id, role: 'target' }));

  const pending = input.applied.filter((set) => !set.reversed);

  const detail: ExceptionDetail = {
    proposal_id: input.proposal_id,
    authorization_id: input.authorization_id,
    action_type: input.action_type,
    tool: input.tool,
    // Requirement 5.17's "failure reason", in both the machine and the human form.
    failure: input.failure,
    failure_detail: input.failure_detail,
    failed_at: input.failed_at,
    // What must be reversed, as read before the loop ran. An Exception raised on a handling
    // that then failed half way names exactly which sets are still uncorrected.
    applied_set_count: input.applied.length,
    pending_reversal_set_ids: pending.map((set) => set.set_id),
    already_reversed_set_ids: input.applied
      .filter((set) => set.reversed)
      .map((set) => set.set_id),
    applied_debit_total_paise: toWire(appliedDebitTotalPaise(input.applied)),
    proposal_impact_paise: toWire(absPaise(input.impact_paise)),
    failing_rule:
      'Requirement 5.17 marks a Proposal whose EXECUTE stage failed as execution-failed, ' +
      'reverses each applied change through SemanticLedger.reverseSet, records this ' +
      'Exception, and requires a new Authorization dated after failed_at before any retry',
  };

  return {
    category: EXECUTION_FAILURE_CATEGORY,
    source_refs: [proposalRef, ...targets],
    impact_paise: absPaise(input.impact_paise),
    // Nothing is short and nothing is in excess once every applied change is reversed.
    direction: 'not_applicable',
    detail,
    evidence_chain_id: input.evidence_chain_id,
    detected_at: input.detected_at,
  };
}

/* -------------------------------------------------------------------------- */
/* The EXECUTE-failure path                                                   */
/* -------------------------------------------------------------------------- */

function notRecorded(
  proposalId: string,
  reason: NotRecordedReason,
  detail: string,
  state?: ProposalState,
): ExecutionFailureNotRecorded {
  return {
    kind: 'not_recorded',
    proposal_id: proposalId,
    reason,
    detail,
    ...(state === undefined ? {} : { state }),
  };
}

/**
 * Requirement 5.17, end to end.
 *
 * In order: resolve the Proposal, check that a failed execution is what this is about,
 * **stamp the state and the failure instant** so no further execution is possible without a
 * new Authorization, read the applied Ledger_Entry sets, **record the Exception** naming the
 * Proposal and the failure reason, and **reverse** every applied set that does not already
 * carry a reversal. See the module doc comment for why that order and not another.
 *
 * A refusal returns {@link ExecutionFailureNotRecorded} having written nothing and reversed
 * nothing.
 *
 * @throws {ActionServiceError} for an empty identifier (a caller fault), a stored `state`
 * that is not a `proposal_state` label, an `execution_failed` Proposal carrying no
 * `executed_at` to resume from, or a reversal the ledger refused (FINDING 5).
 * @throws {PaiseRangeError} when the applied debit totals do not sum inside the paise range.
 * @throws whatever the store, the ledger or the Exception writer raises. A
 * `markExecutionFailed` that matched no row is a fault the caller must hear about rather
 * than read as a tidy success — it means the Proposal is still executable.
 */
export async function recordExecutionFailure(
  failure: ExecutionFailedOutcome,
  deps: FailureReversalDeps,
): Promise<ExecutionFailureOutcome> {
  const proposal = requireIdentifier(failure.proposal_id, 'proposal_id');
  const authorization = requireIdentifier(failure.authorization_id, 'authorization_id');
  const now = deps.now ?? ((): Date => new Date());

  const snapshot = await deps.store.loadForFailure(proposal);
  if (snapshot === null) {
    return notRecorded(
      proposal,
      'proposal_absent',
      'no Proposal with that identifier resolves for this Tenant, so there is no failed ' +
        'execution to record and nothing to reverse (Requirement 14.4)',
    );
  }

  const refusal = failureRecordingRefusalFor(snapshot);
  if (refusal !== null) {
    return notRecorded(proposal, refusal.reason, refusal.detail, snapshot.state);
  }

  // One clock read, used for the failure stamp and for the Exception's `detected_at`, so the
  // Proposal and the Exception cannot disagree about when the failure was recorded.
  const at = now().toISOString();

  // Obligation 1 and 4, first: until this lands the Proposal is `authorized`, which is the
  // one state task 23.2 executes from, so the same Authorization could drive a second
  // invocation of a write-capable tool.
  const resuming = snapshot.state === 'execution_failed';
  const failedAt = resuming ? resumedFailureInstant(proposal, snapshot.executed_at) : at;
  if (!resuming) {
    await deps.store.markExecutionFailed(proposal, failedAt);
  }

  // Read before the Exception, so its `detail` names the sets that still stand (FINDING 3).
  const applied = await deps.store.appliedLedgerSets(proposal);

  // Obligation 3. Idempotent by fingerprint, so a resumption re-raises this same condition
  // onto one row rather than opening a second Exception for one failure.
  const raised = await deps.exceptions.upsert(
    executionFailureException({
      proposal_id: proposal,
      authorization_id: authorization,
      action_type: snapshot.action_type,
      tool: failure.tool,
      failure: failure.failure,
      failure_detail: failure.detail,
      target_source_records: snapshot.target_source_records,
      evidence_chain_id: snapshot.evidence_chain_id,
      impact_paise: snapshot.impact_paise,
      failed_at: failedAt,
      applied,
      detected_at: at,
    }),
  );

  // Obligation 2. One reversal per applied set that does not already carry one — see the
  // module doc comment on why `reverseSet` being non-idempotent makes the skip mandatory
  // rather than an optimisation. Sequential on purpose: each reversal is a separate
  // transaction, and a partial pass must leave the remainder reversible by a later call.
  const reversals: LedgerSetReversal[] = [];
  for (const set of applied) {
    if (set.reversed) {
      reversals.push({ set_id: set.set_id, outcome: 'already_reversed' });
      continue;
    }
    const result = await deps.ledger.reverseSet(deps.tenantId, set.set_id, deps.actor);
    if (!result.ok) {
      // Unreachable for a correctly persisted set: a set that balanced still balances with
      // its sides exchanged. Reached anyway, it is a fault (FINDING 5) — the Exception is
      // already open naming this set, and reporting "handled" would be a lie.
      throw new ActionServiceError(
        `the Semantic_Ledger refused the reversal of Ledger_Entry set ${set.set_id} for ` +
          `Proposal ${proposal} as ${result.kind} (imbalance ${result.imbalance_paise} paise); ` +
          `Requirement 5.17 reverses each applied change, so the change still stands and the ` +
          `execution_failure Exception ${raised.exception_id} names it`,
      );
    }
    reversals.push({
      set_id: set.set_id,
      outcome: 'reversed',
      reversal_set_id: result.set_id,
    });
  }

  return {
    kind: 'execution_failure_recorded',
    proposal_id: proposal,
    authorization_id: authorization,
    failed_at: failedAt,
    failure: failure.failure,
    reversals,
    exception_id: raised.exception_id,
    exception_open: raised.ok,
    transitioned: !resuming,
  };
}

/**
 * The failure instant of an already-`execution_failed` Proposal.
 *
 * A resumption must **not** re-stamp `executed_at`: that instant is the deadline a retry's
 * Authorization has to be dated after (`approvalRequirementCheck`), and moving it forward
 * would invalidate an Authorization a User had already given in good faith.
 *
 * Absent, it is a corrupt row rather than something to default. Nothing in this system can
 * produce it — {@link PROPOSAL_EXECUTION_FAILED_SQL} writes both columns in one update —
 * except task 23.1's generic `PROPOSAL_STATE_TRANSITION_SQL`, which writes no `executed_at`
 * at all, and a Proposal stamped `execution_failed` through it can never be retried because
 * the gate cannot tell a new Authorization from the old one.
 */
function resumedFailureInstant(proposalId: string, executedAt: string | null): string {
  if (typeof executedAt !== 'string' || Number.isNaN(Date.parse(executedAt))) {
    throw new ActionServiceError(
      `Proposal ${proposalId} is execution_failed and carries executed_at ` +
        `${JSON.stringify(executedAt)}, which is not an instant; PROPOSAL_EXECUTION_FAILED_SQL ` +
        `writes the state and the failure instant in one update precisely so a retry's ` +
        `Authorization can be told from the one that authorized the failed attempt, and ` +
        `approvalRequirementCheck fails such a Proposal outright (Requirement 5.17)`,
    );
  }
  return executedAt;
}

/**
 * Requirement 5.17's path with its dependencies bound at construction, ready to sit beside
 * `createApprovalActions`, `createAuthorizedExecutor` and `createExecutionVerifier`.
 *
 * The Tenant is the session's, supplied through the store, the `ExceptionUpserter` and
 * {@link FailureReversalDeps.tenantId} (Requirement 12.7) — no method argument carries one.
 */
export function createExecutionFailureRecorder(
  deps: FailureReversalDeps,
): ExecutionFailureRecorder {
  return {
    record: (failure) => recordExecutionFailure(failure, deps),
  };
}

/**
 * Task 23.2's executor with Requirement 5.17 attached: a failed invocation is handled
 * before the outcome is returned.
 *
 * This is the wiring that makes the four obligations happen rather than merely be
 * available. `approveProposal` ends in `deps.executor.executeAuthorized(...)`, so an
 * {@link AuthorizedExecutor} wrapped here discharges 5.17 on the approval path too, and
 * nothing in `./action-service.ts` or `./execute-authorized.ts` changes to allow it —
 * {@link AuthorizedExecutor} is the seam task 23.1 already declared.
 *
 * The {@link ExecutionFailedOutcome} is returned **unchanged**. Widening it to carry the
 * reversal record would edit task 23.1's published union, and a caller that needs the record
 * — an Audit_Event appender (FINDING 4), task 23.6's pipeline harness — calls
 * {@link createExecutionFailureRecorder} directly and gets the full
 * {@link ExecutionFailureRecorded}. What is *not* silently absorbed is a failure of the
 * handling itself: a refused reversal or a store that matched no row propagates, because a
 * Proposal whose applied changes still stand must not come back as a tidy
 * `execution_failed`.
 */
export function withExecutionFailureReversal(
  executor: AuthorizedExecutor,
  deps: FailureReversalDeps,
): AuthorizedExecutor {
  return {
    async executeAuthorized(proposalId: string, authorizationId: string): Promise<ExecutionOutcome> {
      const outcome = await executor.executeAuthorized(proposalId, authorizationId);
      if (outcome.kind === 'execution_failed') {
        await recordExecutionFailure(outcome, deps);
      }
      return outcome;
    },
  };
}
