/**
 * The VERIFY stage of the FinanceOS_Action_Service (task 23.3).
 * Requirements 5.11, 5.12.
 *
 * design.md gives this one signature and one result shape:
 *
 * ```ts
 * verify(proposalId: string): Promise<VerificationOutcome>;
 *
 * interface VerificationOutcome {
 *   matched: boolean;
 *   observed_paise: Paise; expected_paise: Paise; difference_paise: Paise;  // |diff| <= 1 counts as matched
 *   exception_id?: string;
 * }
 * ```
 *
 * and the two requirements give it two sentences:
 *
 * - **5.11** — WHEN execution of a Proposal completes, perform Verification **within 60
 *   seconds of execution completion** by comparing the observed post-execution state
 *   against the Proposal expected outcome, **treating a monetary difference of 1 paisa or
 *   less as matching**.
 * - **5.12** — IF Verification detects a monetary difference greater than 1 paisa **or a
 *   non-monetary difference**, mark the Proposal verification-failed, create an Exception
 *   in the `verification_failure` category **with the absolute INR difference as the INR
 *   impact and the Proposal identifier and target Source_Record identifiers attached**,
 *   and **make no further automatic change** to Tenant state for that Proposal.
 *
 * That is the whole of what this module does.
 *
 * ## Why this is a third file rather than more of `./action-service.ts`
 *
 * Task 23.1's module doc makes a checkable claim: *"this file imports no ledger, no
 * Razorpay client and no Exception writer, which is what makes Requirement 5.10's 'no
 * change to Tenant state' checkable by reading the import list rather than by trusting a
 * comment."* VERIFY needs an Exception writer — Requirement 5.12 is half about creating
 * one — so putting it there would spend exactly the property that comment names. Task
 * 23.2 kept the approval path's import list empty by adding `./execute-authorized.ts`
 * one module further out; this is the same move for the same reason. Nothing here
 * duplicates approval, rejection, execution or the outcome vocabulary of either sibling:
 * `ActionServiceError`, `requireIdentifier` and the `proposal_state` list are imported.
 *
 * ## The tolerance, and why it is a `bigint` comparison
 *
 * `|expected − observed| <= 1` **paisa**, on {@link PAISA_TOLERANCE}` = 1n`. Both sides
 * are `Paise` (`bigint`), the subtraction is `subtract` from the
 * FinanceOS_Calculation_Service so operands and result are range-checked, and the
 * magnitude is taken on the `bigint`. There is no float anywhere in the path: a tolerance
 * of one hundredth of a rupee is below the resolution at which an IEEE-754 double can be
 * trusted for the rupee magnitudes this system carries, so a tolerance test written on
 * `number` would be a tolerance test that sometimes reports the wrong answer at the
 * boundary. `Requirement 15.1`'s integer-paise rule is not decoration here — it is what
 * makes 5.11's boundary decidable at all.
 *
 * The boundary is **inclusive**: `1` matches, `2` does not, and `-1` matches, because
 * 5.11 says "1 paisa or less" and the difference is signed. {@link withinPaisaTolerance}
 * is the one expression that decides it and it is exported, so the boundary is asserted
 * directly rather than through a whole verification.
 *
 * ## The 60-second window is checked *before* anything is observed
 *
 * {@link verifyExecutedProposal} reads the clock once, compares it against
 * `proposals.executed_at` — which task 23.2's `PROPOSAL_EXECUTED_SQL` writes in the same
 * update as `state = 'executed'`, precisely so this instant exists — and **refuses
 * without observing anything** where more than {@link VERIFICATION_WINDOW_MS} has
 * elapsed. That ordering is the point rather than an optimisation:
 *
 * Requirement 5.12's Exception carries the difference as its **impact**, so the
 * difference has to be attributable to *this* execution. Sixty seconds after the fact it
 * is not: another Agent's Proposal, an ingestion run or a User's own correction can have
 * moved the observed figure in between, and an Exception raised on that difference would
 * name the wrong cause and the wrong amount. So a late call is not a Verification that
 * failed — it is a Verification that did not happen, and it is reported as
 * {@link NOT_VERIFIED_REASONS}`'verification_window_elapsed'` with **no write at all**.
 * {@link verificationDeadline} is exported so a scheduler can meet the deadline rather
 * than discover it.
 *
 * See FINDING 3: nothing in requirements.md or design.md states what becomes of a
 * Proposal whose window elapsed, and this module deliberately does not invent a state
 * transition for it.
 *
 * ## What "make no further automatic change" means here, concretely
 *
 * It is a constraint on the code, not a claim about it. After the failure is recorded
 * this module issues **no** further statement: there is no reversal (Requirement 5.17's
 * reversal is the *execution* failure path, task 23.4, and reversing a **verified-failed**
 * execution is not something any requirement asks for), no retry, no second Exception, no
 * `authorizations` row. The two writes on the failure path are the Exception upsert and
 * the state transition, in that order, and the function returns immediately after them.
 * Structurally: this module imports no ledger, no Razorpay client and no tool registry,
 * so the reversal and re-execution it must not perform are not expressible in it — the
 * same kind of evidence 23.1 offers for Requirement 5.10.
 *
 * ## The Exception is written before the state transition, and why that inverts 5.12's order
 *
 * Requirement 5.12 lists "mark the Proposal verification-failed" before "create an
 * Exception". The two are obligations rather than a write order, and the order this module
 * uses is the recoverable one:
 *
 * - The Exception upsert is **idempotent by construction**. Its identity is
 *   `sha256(tenant | verification_failure | refs | '')` and
 *   `exceptions_fingerprint_uniq` is `UNIQUE (tenant_id, fingerprint)`, so a retry after a
 *   crash updates the same row instead of writing a second one (Requirement 4.15).
 * - {@link PROPOSAL_VERIFICATION_FAILED_SQL} is guarded on `state = 'executed'`, so it is
 *   the **irreversible** step: once it lands, `verify` refuses the Proposal as
 *   already-verified and will not run again.
 *
 * Marking first therefore risks the one outcome that cannot be repaired automatically — a
 * Proposal that says verification-failed with no Exception in the Attention_Panel, which a
 * User has no way to see. Writing the idempotent step first risks only an open Exception
 * whose Proposal is still `executed`, which the next `verify` call completes. Both orders
 * satisfy 5.12 when nothing fails; only one of them satisfies it when something does.
 *
 * Concurrency lands the same way: two simultaneous calls upsert the same fingerprint onto
 * one row, and only the first `UPDATE` matches, so the loser's store throws rather than
 * both reporting success.
 *
 * ## FINDINGS — reported, not silently patched
 *
 * 1. **`proposals.expected_outcome` has no stated shape, and this is the third task to
 *    need it.** Task 23.1 FINDING 2 needed it for the accounting rule check, task 23.2
 *    finding 1 needed it for the tool arguments, and VERIFY needs it as the **expected
 *    side of the comparison** — the one use design.md's own column comment names
 *    (`expected_outcome JSONB NOT NULL, -- verified against in VERIFY`). design.md still
 *    specifies no fields, so {@link VerifiableOutcome} is an **assumption made here and
 *    escalated, not a specification being implemented**:
 *
 *    ```jsonc
 *    { "paise": "38200000", "fields": { "lifecycle_state": "resolved" } }
 *    ```
 *
 *    — exactly one monetary figure as a decimal **string** (never a JSON number: JSONB
 *    would keep `38200000.0` as an IEEE-754 double and nothing downstream could recover
 *    the paisa), plus named non-monetary fields holding a string, a boolean or `null`.
 *    Unknown top-level keys are **rejected**, so a Proposal written against a different
 *    shape fails loudly instead of being verified against half of what it stated.
 *
 *    Three consequences whoever fixes the shape has to decide about, stated rather than
 *    left to be discovered:
 *
 *    - **One monetary figure, not several.** design.md's `VerificationOutcome` carries a
 *      single `observed_paise`/`expected_paise`/`difference_paise` triple, so the
 *      comparison is over one figure. `post_reconciliation_adjustment` returns
 *      `{ set_id, total_debit_paise, total_credit_paise }`, which reads like two — but a
 *      Ledger_Entry set that balances has one total, and that debits equal credits is the
 *      Semantic_Ledger's own invariant (Requirement 2.2), not VERIFY's to re-derive. A
 *      genuinely two-figure outcome would need design.md's result shape widened first.
 *    - **A field the write assigns cannot be in `expected_outcome`.** A set identifier is
 *      generated by the write, so a Proposal cannot state it in advance; stating it would
 *      make every adjustment fail verification on a field nobody could have predicted.
 *    - **Counts are not expressible.** `fields` admits no `number`, because the money
 *      rule cannot tell `{ "total": 2 }` from `{ "total": 66100 }` and JSONB keeps both as
 *      doubles. An outcome that genuinely needs a count needs a decision about how.
 * 2. **`mark_exception_resolved` is not verifiable until FINDING 1 is settled.** Task
 *    23.2 finding 1 already records that no column of `proposals` carries its
 *    `exception_id` or `resolution_note`, so it is not *executable* either. Its outcome
 *    is entirely non-monetary (`{ exception_id, lifecycle_state, resolved_at }`), which is
 *    what a `paise` of `"0"` and three `fields` entries would express — but `resolved_at`
 *    is assigned by the write, so it falls under the second bullet above.
 * 3. **Nothing states what happens to a Proposal whose verification window elapsed.**
 *    Requirement 5.11 makes the 60 seconds an obligation on the service; requirements.md
 *    describes no state for a Proposal that executed and was never verified in time.
 *    Marking it `verification_failed` would be a lie — 5.12's condition is a *detected*
 *    difference, and a late comparison detects nothing attributable to this execution
 *    (see the section above). Leaving it `executed` is honest and leaves the Proposal
 *    visible to whoever asks. So the refusal writes nothing, and **the gap is real**: a
 *    Proposal can sit `executed` and unverified for ever, and closing that needs either a
 *    sweep (the shape of task 23.5's `expireOverdue`) or a stated policy. Escalated.
 * 4. **A missed observation is a fault, not a verdict.** {@link OutcomeObserver.observe}
 *    returns the observed outcome or **throws**. It has no "could not read" result,
 *    because "the observed state is unavailable" is not a difference between observed
 *    state and the expected outcome, and reporting it as one would raise an Exception
 *    naming an impact nobody measured. An observer that can read the state and finds the
 *    effect **absent** must say so as a figure (`"0"`) and a field set, which is a
 *    difference and is reported as one.
 * 5. **No Audit_Event is appended here.** design.md's error table wants an Audit_Event at
 *    stage `VERIFY`, outcome `failed`, with observed, expected and difference figures;
 *    the per-stage Audit_Event of Requirement 5.2 is the FinanceOS_Audit_Service's, whose
 *    serialized per-Tenant sequence is tasks 25.x. {@link VerificationOutcome} carries
 *    exactly those three figures so the event can be appended around this call, which is
 *    task 23.6's pipeline harness.
 * 6. **`execution_failed` is not written here.** It is task 23.4's, as task 23.2 finding 4
 *    already records. This module writes the `verified` and `verification_failed`
 *    transitions and nothing else, and each statement carries its state as a **literal**
 *    so neither can be bent into the other or into 23.4's.
 *
 * ## Money
 *
 * `Paise` (`bigint`) on both sides of the comparison, on the difference, on the tolerance
 * and on the Exception impact. Money reaches SQL as the decimal string
 * {@link toWire} produces, cast `::paise` by the statement, and reaches
 * `exceptions.detail` the same way. No `Number(...)` on a monetary value, no `toFixed`,
 * no `Intl.NumberFormat`, no `NUMERIC`. The Exception impact is `|difference|`, taken on
 * the `bigint` — `exceptions.impact_paise` is CHECKed `>= 0` and the sign lives in
 * `direction`, which is why {@link verificationFailureException} maps the sign onto
 * `shortfall` / `excess` rather than passing a signed figure.
 */

import { subtract, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import type {
  ExceptionDetail,
  ExceptionDirection,
  ExceptionSourceRef,
  ExceptionUpserter,
  ExceptionUpsertInput,
} from '@/agents/exception-fingerprint';
import { canonicalSourceRefs } from '@/agents/exception-fingerprint';
import type { SourceRef } from '@/ledger/posting-rules';
import { PROPOSAL_STATES, type ProposalState } from '@/policy/checks';
import { toWire, type PaiseWire } from '@/wire/paise-wire';

import { ActionServiceError, requireIdentifier } from './action-service';

/* -------------------------------------------------------------------------- */
/* The constants the two requirements fix                                     */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 5.11's tolerance: a monetary difference of **1 paisa or less** matches.
 *
 * `1n`, not `1`. The comparison is on `bigint` because both sides are integer paise and
 * a rupee-scale float cannot decide a hundredth-of-a-rupee boundary reliably.
 */
export const PAISA_TOLERANCE: Paise = 1n;

/** Requirement 5.11's window: 60 seconds from execution completion, in milliseconds. */
export const VERIFICATION_WINDOW_MS = 60_000;

/**
 * The only `proposal_state` a Verification may run from.
 *
 * `executed` is the state task 23.2's `PROPOSAL_EXECUTED_SQL` lands on, stamped with the
 * `executed_at` Requirement 5.11 measures its 60 seconds from, so it is the one state in
 * which an execution has completed and has not yet been verified. Every other label is
 * refused with a reason and no write:
 *
 * - `proposed`, `blocked`, `awaiting_approval`, `authorized` — nothing has executed, so
 *   there is no post-execution state to observe.
 * - `verified`, `verification_failed` — Verification already concluded. Re-running it
 *   would either overwrite a recorded difference or raise a second Exception, and
 *   Requirement 5.12's "no further automatic change" is the reason neither happens.
 * - `execution_failed` — the execution did not complete, so 5.11's condition never held;
 *   the reversal and the `execution_failure` Exception are Requirement 5.17's and task
 *   23.4's.
 * - `rejected`, `expired` — discarded (5.10) or withheld permanently (5.16).
 */
export const VERIFIABLE_STATES: readonly ProposalState[] = ['executed'];

/** The `proposal_state` labels that say Verification already concluded. */
export const VERIFIED_STATES: readonly ProposalState[] = ['verified', 'verification_failed'];

/** The `exception_category` Requirement 5.12 names. */
export const VERIFICATION_FAILURE_CATEGORY = 'verification_failure' as const;

/**
 * Why no Verification was performed. None of these is a Verification that failed, which
 * is the distinction Requirement 5.12 rests on: it triggers on a **detected** difference,
 * so a comparison that was never made cannot mark a Proposal verification-failed.
 *
 * - `proposal_absent` — no such Proposal for this Tenant. A foreign row is an absent row,
 *   never an error that would confirm its existence (Requirement 14.4).
 * - `not_executed` — the Proposal is in none of {@link VERIFIABLE_STATES} and has not
 *   already been verified, so no execution has completed for 5.11 to follow.
 * - `already_verified` — Verification concluded once already. See
 *   {@link VERIFIED_STATES}.
 * - `verification_window_elapsed` — more than {@link VERIFICATION_WINDOW_MS} has passed
 *   since `executed_at`, so an observed difference is no longer attributable to this
 *   execution. See the module doc comment and FINDING 3.
 */
export const NOT_VERIFIED_REASONS = [
  'proposal_absent',
  'not_executed',
  'already_verified',
  'verification_window_elapsed',
] as const;

export type NotVerifiedReason = (typeof NOT_VERIFIED_REASONS)[number];

/* -------------------------------------------------------------------------- */
/* The comparable outcome — the shape design.md does not state (FINDING 1)     */
/* -------------------------------------------------------------------------- */

/**
 * A non-monetary value an outcome may state: a string, a boolean, or `null`.
 *
 * **No `number`**, deliberately. Every monetary figure belongs in
 * {@link VerifiableOutcome.paise} as integer paise, and a JSON number cannot carry one
 * (Requirement 15.1, 15.8) — `{ "total_paise": 66100 }` is a double in JSONB and stays
 * one. Admitting `number` for non-monetary counts would mean the parser had to decide,
 * per key, whether a number was money, which is exactly the guess the money discipline
 * exists to remove. A count that genuinely needs stating needs a design.md decision
 * first (FINDING 1).
 *
 * `null` is a **value**, not an absence: an outcome stating `{ "resolved_at": null }`
 * differs from one stating no `resolved_at` at all, and both differences are reported
 * under distinct {@link FieldDifferenceKind} labels.
 */
export type VerificationFieldValue = string | boolean | null;

/**
 * One side of Requirement 5.11's comparison: one monetary figure and a set of named
 * non-monetary fields.
 *
 * **The assumed shape of `proposals.expected_outcome`** — see FINDING 1, which is the
 * headline of this module. The same type is what an {@link OutcomeObserver} answers with,
 * so the two sides of the comparison are the same shape by construction rather than by a
 * mapping that could disagree with itself.
 */
export interface VerifiableOutcome {
  /**
   * The single monetary figure design.md's `VerificationOutcome` compares. Integer paise
   * as `bigint`; on the JSONB side it is the decimal **string** {@link toWire} produces.
   */
  readonly paise: Paise;
  /**
   * Every non-monetary field the outcome states, compared for exact equality. Empty where
   * the outcome is purely monetary.
   */
  readonly fields: Readonly<Record<string, VerificationFieldValue>>;
}

/** How two outcomes differ on one named field. */
export const FIELD_DIFFERENCE_KINDS = [
  /** Both state the field and the values are not equal. */
  'value_differs',
  /** The expected outcome states the field and the observed state does not. */
  'absent_from_observed',
  /** The observed state carries a field the Proposal never stated. */
  'absent_from_expected',
] as const;

export type FieldDifferenceKind = (typeof FIELD_DIFFERENCE_KINDS)[number];

/**
 * One non-monetary difference, in the vocabulary Requirement 5.12 needs to explain
 * itself on the Exception.
 *
 * `absent_from_expected` is reported rather than ignored. An {@link OutcomeObserver}'s
 * contract is to project the observed state onto **the field vocabulary the expected
 * outcome states**, so a field it adds means the observer and the Proposal disagree about
 * what the action does — which is a difference between observed state and the expected
 * outcome under any reading of 5.12, and silently dropping it would let an unstated
 * change pass Verification.
 */
export interface FieldDifference {
  readonly field: string;
  readonly kind: FieldDifferenceKind;
  /** Absent where the expected outcome states no such field. */
  readonly expected?: VerificationFieldValue;
  /** Absent where the observed state carries no such field. */
  readonly observed?: VerificationFieldValue;
}

/**
 * The whole of Requirement 5.11's comparison, as a value. **Pure** — no clock, no store,
 * no Exception writer — so the tolerance boundary is assertable on its own.
 */
export interface VerificationComparison {
  readonly expected_paise: Paise;
  readonly observed_paise: Paise;
  /**
   * `expected − observed`, **signed**. Positive means the observed state is short of what
   * the Proposal promised, which is the same convention
   * `settlement_reconciliations.difference_paise` uses (expected − received) and the
   * reason `proposals.difference_paise` is on the signed `paise` domain.
   */
  readonly difference_paise: Paise;
  /** `|difference| <= 1` paisa (Requirement 5.11). */
  readonly monetary_matched: boolean;
  /** Empty where every stated field agrees. */
  readonly field_differences: readonly FieldDifference[];
  /** Requirement 5.11's verdict: the monetary figure is within tolerance **and** no field differs. */
  readonly matched: boolean;
}

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

/** Verification ran and matched (Requirement 5.11). */
export interface VerifiedOutcome extends VerificationComparison {
  readonly kind: 'verified';
  readonly matched: true;
  readonly proposal_id: string;
  /** `proposals.verified_at`. ISO-8601 UTC. */
  readonly verified_at: string;
}

/** Verification ran and found a difference (Requirement 5.12). */
export interface VerificationFailedOutcome extends VerificationComparison {
  readonly kind: 'verification_failed';
  readonly matched: false;
  readonly proposal_id: string;
  readonly verified_at: string;
  /** The `verification_failure` Exception carrying `|difference|` as its impact. */
  readonly exception_id: string;
  /**
   * `false` where the Exception this condition names had already been closed by a User and
   * was therefore **left closed** (Requirement 4.15 scopes the update to open
   * Exceptions). The identifier is still reported, so "not reopened" is never
   * indistinguishable from "created".
   */
  readonly exception_open: boolean;
}

/**
 * No Verification was performed, and why. Nothing was written and nothing was observed.
 *
 * Kept apart from the two concluded cases because Requirement 5.12's obligations follow
 * from a **detected** difference. Collapsing this into `matched: false` would report a
 * comparison that never happened as one that failed.
 */
export interface NotVerifiedOutcome {
  readonly kind: 'not_verified';
  readonly proposal_id: string;
  readonly reason: NotVerifiedReason;
  /** Human-readable, and always present: a User reads this on the Proposal. */
  readonly detail: string;
  /** The state the Proposal was found in, where it resolved. */
  readonly state?: ProposalState;
}

/** design.md's `VerificationOutcome`, widened by the cases its four fields cannot carry. */
export type VerificationOutcome = VerifiedOutcome | VerificationFailedOutcome | NotVerifiedOutcome;

/** design.md's `verify(proposalId)`, with the session Tenant bound at construction. */
export interface ExecutionVerifier {
  verify(proposalId: string): Promise<VerificationOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Parsing the stated outcome                                                 */
/* -------------------------------------------------------------------------- */

/** The only accepted wire form of a monetary figure: optional sign, then digits. */
const INTEGER_STRING = /^-?[0-9]+$/;

/** The two keys {@link VerifiableOutcome} admits. Anything else is rejected. */
const OUTCOME_KEYS = ['paise', 'fields'] as const;

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `proposals.expected_outcome` (or an observer's answer) as a {@link VerifiableOutcome}.
 *
 * Strict on purpose. Every rejection below is something a lenient parser would turn into a
 * Verification that compared less than the Proposal stated, which is worse than a loud
 * failure because it reports `matched` for a comparison it did not make:
 *
 * - a **JSON number** for `paise` — JSONB stores it as an IEEE-754 double, so the paisa is
 *   already gone by the time it is read (Requirement 15.1, 15.8);
 * - a **missing `paise`** — a purely non-monetary outcome states `"0"`, so that "no
 *   monetary figure" and "a monetary figure of zero" stay different statements;
 * - an **unknown top-level key** — a Proposal written against a different shape is
 *   verified against none of it, and FINDING 1 is exactly that the shape is not settled;
 * - a **`number` in `fields`** — see {@link VerificationFieldValue};
 * - a **nested object or array in `fields`** — the comparison is over named scalar fields,
 *   and a structural comparison is not something either requirement asks for.
 *
 * @throws {ActionServiceError} naming the field and the rule. A malformed stored
 * `expected_outcome` is a corrupt row rather than a Verification verdict, the same
 * distinction `./action-service.ts` and `./execute-authorized.ts` draw for a corrupt
 * `state`.
 */
export function verifiableOutcomeFrom(value: unknown, what: string): VerifiableOutcome {
  if (!isPlainObject(value)) {
    throw new ActionServiceError(
      `${what} must be a JSON object stating one monetary figure and its non-monetary fields, ` +
        `got ${Array.isArray(value) ? 'an array' : typeof value}; design.md states no shape for ` +
        `proposals.expected_outcome, and the shape assumed here is documented as FINDING 1`,
    );
  }

  for (const key of Object.keys(value)) {
    if (!(OUTCOME_KEYS as readonly string[]).includes(key)) {
      throw new ActionServiceError(
        `${what} states the key ${JSON.stringify(key)}, which the comparison does not read; ` +
          `only ${OUTCOME_KEYS.join(' and ')} are compared, so ignoring it would verify a ` +
          `Proposal against less than it stated`,
      );
    }
  }

  const paise = value.paise;
  if (typeof paise === 'number') {
    throw new ActionServiceError(
      `${what}.paise is the JSON number ${paise}; money is integer paise carried as a decimal ` +
        `string, never an IEEE-754 double, and JSONB keeps the double (Requirement 15.1, 15.8)`,
    );
  }
  if (typeof paise !== 'string' || !INTEGER_STRING.test(paise)) {
    throw new ActionServiceError(
      `${what}.paise must be the decimal string of an integer paise value, got ` +
        `${JSON.stringify(paise)}; an outcome with nothing monetary about it states "0", so ` +
        `that an absent figure and a figure of zero stay different statements`,
    );
  }

  const fields: Record<string, VerificationFieldValue> = {};
  const stated = value.fields;
  if (stated !== undefined) {
    if (!isPlainObject(stated)) {
      throw new ActionServiceError(
        `${what}.fields must be an object of named non-monetary values, got ` +
          `${Array.isArray(stated) ? 'an array' : typeof stated}`,
      );
    }
    for (const [key, field] of Object.entries(stated)) {
      if (typeof field === 'string' || typeof field === 'boolean' || field === null) {
        fields[key] = field;
        continue;
      }
      throw new ActionServiceError(
        `${what}.fields.${key} is ${
          typeof field === 'number'
            ? `the number ${field}; a monetary figure belongs in ${what}.paise as a decimal ` +
              `string, and a non-monetary count is not expressible until the shape of ` +
              `expected_outcome is settled (FINDING 1)`
            : `${Array.isArray(field) ? 'an array' : typeof field}; the comparison is over ` +
              `named scalar fields (string, boolean or null)`
        }`,
      );
    }
  }

  // `BigInt` is exact at any digit length. Range-checked by `subtract` at comparison time,
  // where a range violation is attributable to a figure rather than to a parse.
  return { paise: BigInt(paise), fields };
}

/* -------------------------------------------------------------------------- */
/* Requirement 5.11's comparison — pure                                       */
/* -------------------------------------------------------------------------- */

/** `|v|` on the `bigint`. No `Math.abs`, which would coerce money to a double. */
function absPaise(v: Paise): Paise {
  return v < 0n ? -v : v;
}

/**
 * Requirement 5.11's tolerance test: `|difference| <= 1` paisa.
 *
 * Exported because it is the one expression that decides 5.11's boundary, and a boundary
 * should be assertable at `0`, `1`, `-1`, `2` and `-2` without a store, a clock or an
 * Exception writer behind it. Inclusive at 1 in both directions: 5.11 says "1 paisa or
 * less" and the difference is signed.
 */
export function withinPaisaTolerance(difference: Paise): boolean {
  return absPaise(difference) <= PAISA_TOLERANCE;
}

/**
 * Every non-monetary difference between two outcomes, ordered by field name.
 *
 * Compared over the **union** of the two key sets, so the answer is empty if and only if
 * both sides state the same fields with the same values — see {@link FieldDifference} for
 * why a field only the observer states is a difference rather than extra information.
 * Sorted so two runs over the same pair produce the same list in the same order, which is
 * what lets `exceptions.detail` be compared across runs.
 */
export function fieldDifferences(
  expected: VerifiableOutcome,
  observed: VerifiableOutcome,
): readonly FieldDifference[] {
  const differences: FieldDifference[] = [];
  const keys = [...new Set([...Object.keys(expected.fields), ...Object.keys(observed.fields)])].sort();

  for (const field of keys) {
    const inExpected = Object.hasOwn(expected.fields, field);
    const inObserved = Object.hasOwn(observed.fields, field);
    const expectedValue = expected.fields[field];
    const observedValue = observed.fields[field];

    if (!inObserved) {
      differences.push({ field, kind: 'absent_from_observed', expected: expectedValue });
      continue;
    }
    if (!inExpected) {
      differences.push({ field, kind: 'absent_from_expected', observed: observedValue });
      continue;
    }
    if (expectedValue !== observedValue) {
      differences.push({
        field,
        kind: 'value_differs',
        expected: expectedValue,
        observed: observedValue,
      });
    }
  }
  return differences;
}

/**
 * Requirement 5.11's comparison, end to end and **pure**.
 *
 * `subtract` rather than `-` so both operands and the difference are range-checked by the
 * FinanceOS_Calculation_Service (Requirement 15.1): a difference that leaves the paise
 * range is a figure nobody can act on, and it raises rather than being carried into an
 * Exception impact.
 *
 * `matched` is the conjunction 5.11 and 5.12 describe between them: the monetary figure is
 * within tolerance **and** no non-monetary field differs. A 1-paisa difference alongside a
 * differing field is a failure, and its impact is still that 1 paisa — which is what
 * Requirement 5.12's "the absolute INR difference" says, tolerance or not.
 *
 * @throws {PaiseRangeError} when either figure or the difference leaves the paise range.
 */
export function compareOutcomes(
  expected: VerifiableOutcome,
  observed: VerifiableOutcome,
): VerificationComparison {
  const difference = subtract(expected.paise, observed.paise);
  const monetaryMatched = withinPaisaTolerance(difference);
  const differences = fieldDifferences(expected, observed);

  return {
    expected_paise: expected.paise,
    observed_paise: observed.paise,
    difference_paise: difference,
    monetary_matched: monetaryMatched,
    field_differences: differences,
    matched: monetaryMatched && differences.length === 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Requirement 5.11's 60-second window — pure                                 */
/* -------------------------------------------------------------------------- */

/**
 * The instant Requirement 5.11's Verification must have run by: `executed_at` plus 60
 * seconds, ISO-8601 UTC.
 *
 * Exported so a scheduler can **meet** the deadline rather than discover it after the
 * fact, and so task 23.6's pipeline harness can assert the window without reimplementing
 * the arithmetic.
 *
 * @throws {ActionServiceError} for an `executed_at` that is not an instant.
 */
export function verificationDeadline(executedAt: string): string {
  return new Date(executionInstant(executedAt) + VERIFICATION_WINDOW_MS).toISOString();
}

/**
 * `proposals.executed_at` is present and an instant, or the row is corrupt.
 *
 * An assertion rather than a returned refusal: task 23.2's `PROPOSAL_EXECUTED_SQL` writes
 * `state = 'executed'` and `executed_at` in one update, so an `executed` Proposal without
 * one cannot arise from this system's own writes.
 */
function assertExecutedAt(value: string | null | undefined): asserts value is string {
  executionInstant(value);
}

/** `executed_at` as milliseconds since the epoch, or a corrupt-row fault. */
function executionInstant(executedAt: string | null | undefined): number {
  const ms = typeof executedAt === 'string' ? Date.parse(executedAt) : Number.NaN;
  if (Number.isNaN(ms)) {
    throw new ActionServiceError(
      `proposals.executed_at is ${JSON.stringify(executedAt)}, which is not an instant; task ` +
        `23.2's PROPOSAL_EXECUTED_SQL writes state = 'executed' and executed_at in one update ` +
        `precisely so Requirement 5.11's 60 seconds can be measured from it, so an executed ` +
        `Proposal without one is a corrupt row rather than a Proposal to verify`,
    );
  }
  return ms;
}

/**
 * Whether Requirement 5.11's window has closed by `at`. **Pure.**
 *
 * @throws {ActionServiceError} for an unparseable `executed_at`, or for an `at` **before**
 * `executed_at`. The second is a clock that moved backwards between the EXECUTE and VERIFY
 * stages, and it is reported rather than absorbed for the same reason
 * `exceptions_check1` rejects a backwards re-detection: a Verification timed before the
 * execution it verifies cannot be reasoned about, and treating it as "comfortably inside
 * the window" would hide the fault for ever.
 */
export function verificationWindowElapsed(executedAt: string, at: Date): boolean {
  const elapsedMs = at.getTime() - executionInstant(executedAt);
  if (elapsedMs < 0) {
    throw new ActionServiceError(
      `the verification clock reads ${at.toISOString()}, which is before executed_at ` +
        `${executedAt}; a Verification cannot precede the execution it verifies, and absorbing ` +
        `the skew would make Requirement 5.11's window unmeasurable`,
    );
  }
  return elapsedMs > VERIFICATION_WINDOW_MS;
}

/* -------------------------------------------------------------------------- */
/* The statements an adapter runs                                             */
/* -------------------------------------------------------------------------- */

/**
 * One Proposal as the VERIFY stage needs it. Parameters:
 * `($1 tenant_id, $2 proposal_id)`.
 *
 * Narrower than task 23.1's `ACTION_PROPOSAL_LOAD_SQL` on purpose: Verification
 * re-evaluates no Policy_Check, so it needs neither the Auto_Execute_Threshold nor the
 * Approval_Window, and selecting them would suggest it did. It needs four things 23.1's
 * statement also selects and one it does not:
 *
 * - `state` and `executed_at` — the two Requirement 5.11 keys its window off;
 * - `expected_outcome` — the expected side of the comparison, and the column design.md's
 *   own comment marks "verified against in VERIFY" (FINDING 1);
 * - `target_source_records` and `evidence_chain_id` — Requirement 5.12 attaches the target
 *   Source_Record identifiers to the Exception, and the Evidence_Chain is what grounds the
 *   impact figure;
 * - `verified_at` — so an adapter can see that Verification already concluded rather than
 *   inferring it from `state` alone.
 *
 * `impact_paise` is deliberately **not** selected. It is the Proposal's stated impact, not
 * the figure Verification compares: 5.11 compares the observed state against
 * `expected_outcome`, and reading the impact here would invite a comparison against the
 * wrong column. Where the two coincide, `expected_outcome` says so.
 */
export const PROPOSAL_VERIFICATION_LOAD_SQL = `
SELECT id,
       action_type,
       target_source_records,
       evidence_chain_id,
       expected_outcome,
       state,
       executed_at,
       verified_at
  FROM proposals
 WHERE tenant_id = $1
   AND id = $2::uuid`.trim();

/** The parameter tuple {@link PROPOSAL_VERIFICATION_LOAD_SQL} expects, in order. */
export function proposalVerificationLoadParams(
  tenantId: TenantId,
  proposalId: string,
): readonly [TenantId, string] {
  return [tenantId, proposalId];
}

/**
 * Requirement 5.11's matching outcome. Parameters:
 * `($1 tenant_id, $2 proposal_id, $3 verified_at, $4 observed_paise, $5 difference_paise)`.
 *
 * Four things about it are load-bearing:
 *
 * - **`state`, `verified_at`, `observed_paise` and `difference_paise` move together.** A
 *   Proposal marked `verified` with no figures is a row that cannot explain its own
 *   verdict, and figures with no state change are a row that contradicts itself. The three
 *   value columns exist for exactly this write — nothing else in the schema fills them.
 * - **`AND state = 'executed'`** is the guard and the concurrency control: two concurrent
 *   Verifications both compare, but only the first `UPDATE` matches a row. It is also the
 *   storage half of {@link VERIFIABLE_STATES} — the database will not stamp a `rejected`
 *   or `expired` Proposal verified even if a caller reached this statement.
 * - **`$4` and `$5` are cast `::paise`**, and they arrive as the decimal strings
 *   {@link toWire} produces. A transport that sent them as JSON numbers would coerce them
 *   to doubles (Requirement 15.1, 15.8), and a 1-paisa tolerance recorded from a double is
 *   not a record of anything.
 * - **`RETURNING id, state, verified_at`** is how an adapter tells a real transition from
 *   a silent no-op, which it must throw on.
 *
 * The state is the literal `'verified'` rather than a parameter, so this statement cannot
 * be bent into {@link PROPOSAL_VERIFICATION_FAILED_SQL}, into task 23.2's `executed`
 * transition, or into task 23.4's `execution_failed` one.
 */
export const PROPOSAL_VERIFIED_SQL = `
UPDATE proposals
   SET state = 'verified',
       verified_at = $3::timestamptz,
       observed_paise = $4::paise,
       difference_paise = $5::paise
 WHERE tenant_id = $1
   AND id = $2::uuid
   AND state = 'executed'
RETURNING id, state, verified_at`.trim();

/**
 * Requirement 5.12's transition, identical to {@link PROPOSAL_VERIFIED_SQL} but for the
 * state literal. Parameters:
 * `($1 tenant_id, $2 proposal_id, $3 verified_at, $4 observed_paise, $5 difference_paise)`.
 *
 * Two separate statements rather than one with the state as a parameter, for the reason
 * task 23.2 gives for `PROPOSAL_EXECUTED_SQL`: a parameterised state is a statement that
 * can write any label, and the two directions of Verification are the two facts a reader
 * most needs to be able to tell apart. `observed_paise` and `difference_paise` are written
 * on **both** paths — a failed Verification is precisely the case where a User needs the
 * figures on the row, and design.md's error table asks for observed, expected and
 * difference to be reported.
 *
 * `difference_paise` is written **signed**. The Exception's impact is the absolute value
 * (Requirement 5.12), and the sign is what tells a shortfall from an excess; discarding it
 * here would lose that, and the column is on the signed `paise` domain for the same reason
 * `settlement_reconciliations.difference_paise` is.
 */
export const PROPOSAL_VERIFICATION_FAILED_SQL = `
UPDATE proposals
   SET state = 'verification_failed',
       verified_at = $3::timestamptz,
       observed_paise = $4::paise,
       difference_paise = $5::paise
 WHERE tenant_id = $1
   AND id = $2::uuid
   AND state = 'executed'
RETURNING id, state, verified_at`.trim();

/**
 * The parameter tuple both verification transitions expect, in order.
 *
 * One function for both statements because the two differ in the state literal and in
 * nothing else — so a matching and a failing Verification are recorded with identical
 * provenance, the same argument task 23.1's `USER_AUTHORIZATION_SQL` makes for recording an
 * approval and a rejection through one statement.
 *
 * `toWire` is the single place a `Paise` becomes a string here, and it range-checks
 * (Requirement 15.1, 15.8).
 */
export function proposalVerificationParams(
  tenantId: TenantId,
  proposalId: string,
  verifiedAt: string,
  observed: Paise,
  difference: Paise,
): readonly [TenantId, string, string, PaiseWire, PaiseWire] {
  return [tenantId, proposalId, verifiedAt, toWire(observed), toWire(difference)];
}

/* -------------------------------------------------------------------------- */
/* Seams                                                                      */
/* -------------------------------------------------------------------------- */

/** One Proposal as {@link PROPOSAL_VERIFICATION_LOAD_SQL} returns it. */
export interface ProposalVerificationSnapshot {
  readonly proposal_id: string;
  /** `proposals.action_type`. Reported on the Exception so the failure names the action. */
  readonly action_type: string;
  readonly state: ProposalState;
  /** `proposals.executed_at`. ISO-8601 UTC. `null` before the EXECUTE stage. */
  readonly executed_at: string | null;
  /** `proposals.target_source_records`, the ordered target Source_Record set. */
  readonly target_source_records: readonly SourceRef[];
  /** `proposals.evidence_chain_id`. `NOT NULL` in the schema. */
  readonly evidence_chain_id: string;
  /**
   * `proposals.expected_outcome`, exactly as stored.
   *
   * `unknown` on purpose, the same stance task 23.2 takes for `tool_arguments`: design.md
   * states no shape (FINDING 1), so the adapter hands over the JSON it read and
   * {@link verifiableOutcomeFrom} is the single place the assumed shape is applied. An
   * adapter that parsed it into a shape of its own would make the assumption twice.
   */
  readonly expected_outcome: unknown;
}

/**
 * The one read and two writes the VERIFY stage needs.
 *
 * Implemented by an adapter that binds the session Tenant at construction — **no method
 * takes a tenant id** (Requirement 12.7, 14.1) — and a foreign Proposal reads back as
 * `null` rather than as an error that would confirm it exists (Requirement 14.4).
 *
 * Both writes must **throw** rather than resolve when they matched no row. A Proposal that
 * was verified and whose row still says `executed` would be verified again by the next
 * call, and on the failure path that would mean a second look at an Exception this module
 * has already raised — which is the "no further automatic change" of Requirement 5.12
 * quietly not holding.
 */
export interface VerificationStore {
  /** {@link PROPOSAL_VERIFICATION_LOAD_SQL}. `null` when the Proposal does not resolve. */
  loadForVerification(proposalId: string): Promise<ProposalVerificationSnapshot | null>;
  /** {@link PROPOSAL_VERIFIED_SQL} with {@link proposalVerificationParams}. */
  markVerified(
    proposalId: string,
    verifiedAt: string,
    observed: Paise,
    difference: Paise,
  ): Promise<void>;
  /** {@link PROPOSAL_VERIFICATION_FAILED_SQL} with the same parameters. */
  markVerificationFailed(
    proposalId: string,
    verifiedAt: string,
    observed: Paise,
    difference: Paise,
  ): Promise<void>;
}

/**
 * The observed post-execution state, projected onto the vocabulary the Proposal stated.
 *
 * This is the seam this module deliberately does **not** implement. What "observed state"
 * means is per action type — the persisted Ledger_Entry set for
 * `post_reconciliation_adjustment`, the Exception row for `mark_exception_resolved`, the
 * recorded Razorpay request and response identifiers for `initiate_payment_retry` (task
 * 35.6's own task text says it records them "so VERIFY has something observable to compare
 * against") — and none of those readers exists yet. Injecting it keeps the tolerance, the
 * window and the failure path testable now, and keeps this module free of a reader per
 * action type.
 *
 * **The contract, in two clauses:**
 *
 * 1. Answer over **the field vocabulary the expected outcome states**. A field the
 *    observer adds is reported as a difference (`absent_from_expected`), because a change
 *    nobody stated is exactly what Verification is for — so an identifier the write
 *    assigns must be in neither side (FINDING 1).
 * 2. **Throw** where the state could not be read. There is no "unavailable" result: see
 *    FINDING 4. An effect that is genuinely absent is a figure of `0n` and an empty field
 *    set, which is a difference and is reported as one.
 */
export interface OutcomeObserver {
  observe(snapshot: ProposalVerificationSnapshot): Promise<VerifiableOutcome>;
}

/** Everything the VERIFY stage reaches outside itself. */
export interface VerifierDeps {
  readonly store: VerificationStore;
  readonly observer: OutcomeObserver;
  /**
   * The Exception writer of Requirement 5.12, bound to the session Tenant
   * (`createExceptionUpserter`). Its fingerprint is what makes the write idempotent, which
   * is why the Exception is written before the state transition — see the module doc
   * comment.
   */
  readonly exceptions: ExceptionUpserter;
  /** Injectable clock, so the 60-second window and `verified_at` are assertable. */
  readonly now?: () => Date;
}

/* -------------------------------------------------------------------------- */
/* Requirement 5.12's Exception — pure                                        */
/* -------------------------------------------------------------------------- */

/**
 * The sign of the difference as an `exceptions.direction` label.
 *
 * `exceptions.impact_paise` is CHECKed `>= 0` and the sign lives in `direction`, exactly as
 * `side` carries it for a Ledger_Entry. `difference = expected − observed`, so a positive
 * difference means the observed state is **short** of what the Proposal promised.
 *
 * A difference of exactly `0` is `not_applicable`, and it has to be: a zero impact points
 * nowhere, and `assertExceptionUpsertable` rejects any other label against it. That case is
 * reachable — a Verification can fail on a non-monetary field alone.
 */
export function verificationDirectionFor(difference: Paise): ExceptionDirection {
  if (difference > 0n) {
    return 'shortfall';
  }
  if (difference < 0n) {
    return 'excess';
  }
  return 'not_applicable';
}

/** What {@link verificationFailureException} needs. All of it comes from the row or the comparison. */
export interface VerificationFailureInput {
  readonly proposal_id: string;
  readonly action_type: string;
  /** `proposals.target_source_records` (Requirement 5.12). */
  readonly target_source_records: readonly SourceRef[];
  readonly evidence_chain_id: string;
  /** `proposals.executed_at`, ISO-8601 UTC. */
  readonly executed_at: string;
  readonly comparison: VerificationComparison;
  /** The instant Verification concluded. ISO-8601 UTC to millisecond precision. */
  readonly detected_at: string;
}

/**
 * Requirement 5.12's Exception, as an {@link ExceptionUpsertInput}. **Pure** — no store, no
 * clock — so what the Exception says is assertable without a database.
 *
 * Every clause of 5.12 is one line of it:
 *
 * - **the `verification_failure` Exception_Category** — {@link VERIFICATION_FAILURE_CATEGORY},
 *   one of the 14 `exception_category` labels;
 * - **the absolute INR difference as the INR impact** — `|difference|` in integer paise,
 *   with the sign moved to `direction` because the column is CHECKed `>= 0`;
 * - **the Proposal identifier and target Source_Record identifiers attached** — the refs
 *   are `{ type: 'proposal', id }` followed by the Proposal's targets. `proposal` is one of
 *   the 13 `source_record_type` labels, so the Proposal is attached as a Source_Record
 *   rather than buried in `detail`, which is what makes it appear in
 *   `exception_source_records` and therefore in the Attention_Panel's evidence.
 *
 * The refs are **identity** refs, not `context_refs`: `verification_failure` is not one of
 * the two range-scoped categories, so its whole ref set is its identity (Requirement 4.15)
 * and `context_refs` would be rejected. That is also what makes the write idempotent — a
 * re-run for the same Proposal and targets computes the same fingerprint and updates one
 * row.
 *
 * `detail` carries the three figures as the decimal strings {@link toWire} produces, never
 * as JSON numbers, and the field differences as rendered strings so a `null` value and an
 * absent field stay distinguishable in JSONB.
 *
 * @throws {ExceptionFingerprintError} for a target ref that cannot be encoded — an
 * identifier carrying a fingerprint separator, which `canonicalSourceRefs` rejects rather
 * than allowing two different target sets to collide onto one Exception.
 */
export function verificationFailureException(
  input: VerificationFailureInput,
): ExceptionUpsertInput {
  const { comparison } = input;
  const proposalRef: ExceptionSourceRef = {
    type: 'proposal',
    id: input.proposal_id,
    role: 'proposal',
  };
  // Canonicalised here so a target repeated in `target_source_records`, or one repeating
  // the Proposal itself, is one link rather than a primary key collision.
  const targets: readonly ExceptionSourceRef[] = canonicalSourceRefs(
    input.target_source_records,
    'target_source_records',
  )
    .filter((ref) => !(ref.type === 'proposal' && ref.id === input.proposal_id))
    .map((ref) => ({ type: ref.type, id: ref.id, role: 'target' }));

  const detail: ExceptionDetail = {
    proposal_id: input.proposal_id,
    action_type: input.action_type,
    executed_at: input.executed_at,
    verified_at: input.detected_at,
    expected_paise: toWire(comparison.expected_paise),
    observed_paise: toWire(comparison.observed_paise),
    difference_paise: toWire(comparison.difference_paise),
    tolerance_paise: toWire(PAISA_TOLERANCE),
    monetary_matched: comparison.monetary_matched,
    field_differences: comparison.field_differences.map((difference) => ({
      field: difference.field,
      kind: difference.kind,
      // Rendered, so `null` and "no such field" stay different statements in JSONB.
      expected: difference.kind === 'absent_from_expected' ? 'absent' : JSON.stringify(difference.expected),
      observed: difference.kind === 'absent_from_observed' ? 'absent' : JSON.stringify(difference.observed),
    })),
    failing_rule:
      'Requirement 5.11 treats a monetary difference of 1 paisa or less as matching, and ' +
      'Requirement 5.12 raises this Exception for a greater monetary difference or any ' +
      'non-monetary difference',
  };

  return {
    category: VERIFICATION_FAILURE_CATEGORY,
    source_refs: [proposalRef, ...targets],
    impact_paise: absPaise(comparison.difference_paise),
    direction: verificationDirectionFor(comparison.difference_paise),
    detail,
    evidence_chain_id: input.evidence_chain_id,
    detected_at: input.detected_at,
  };
}

/* -------------------------------------------------------------------------- */
/* The VERIFY stage                                                           */
/* -------------------------------------------------------------------------- */

function notVerified(
  proposalId: string,
  reason: NotVerifiedReason,
  detail: string,
  state?: ProposalState,
): NotVerifiedOutcome {
  return {
    kind: 'not_verified',
    proposal_id: proposalId,
    reason,
    detail,
    ...(state === undefined ? {} : { state }),
  };
}

/**
 * design.md's `verify(proposalId)`.
 *
 * In order: resolve the Proposal, check that an execution completed and that Verification
 * has not already concluded, check Requirement 5.11's 60-second window **before observing
 * anything**, parse the expected outcome, observe the post-execution state, compare with
 * the 1-paisa tolerance, and record one of the two verdicts. On a failure the Exception of
 * Requirement 5.12 is written first and the state transition second, and **nothing is
 * written after that** — see the module doc comment for both orderings.
 *
 * Every refusal returns a {@link NotVerifiedOutcome} having written nothing and observed
 * nothing.
 *
 * @throws {ActionServiceError} for an empty identifier (a caller fault), a stored `state`
 * that is not a `proposal_state` label, an `executed` Proposal with no parseable
 * `executed_at`, a clock reading before `executed_at`, or an `expected_outcome` that does
 * not state a comparable outcome. All of those are faults rather than verdicts, the same
 * distinction both siblings draw.
 * @throws {PaiseRangeError} when a figure or the difference leaves the paise range.
 * @throws whatever the store or the observer raises. A `markVerified` that matched no row is
 * a fault the caller must hear about rather than read as a tidy success.
 */
export async function verifyExecutedProposal(
  proposalId: string,
  deps: VerifierDeps,
): Promise<VerificationOutcome> {
  const proposal = requireIdentifier(proposalId, 'proposal_id');
  const now = deps.now ?? ((): Date => new Date());

  const snapshot = await deps.store.loadForVerification(proposal);
  if (snapshot === null) {
    return notVerified(
      proposal,
      'proposal_absent',
      'no Proposal with that identifier resolves for this Tenant, so there is nothing to ' +
        'verify (Requirement 14.4)',
    );
  }

  if (!(PROPOSAL_STATES as readonly string[]).includes(snapshot.state)) {
    // A corrupt row, not a Proposal a Verification can be refused *about*.
    throw new ActionServiceError(
      `the stored proposal_state ${JSON.stringify(snapshot.state)} is not one of ` +
        `${PROPOSAL_STATES.join(', ')}`,
    );
  }

  if (VERIFIED_STATES.includes(snapshot.state)) {
    return notVerified(
      proposal,
      'already_verified',
      `the Proposal is ${snapshot.state}, so Verification has already concluded; running it ` +
        `again would overwrite the recorded figures or raise a second Exception for one ` +
        `condition, and Requirement 5.12 makes no further automatic change for that Proposal`,
      snapshot.state,
    );
  }

  if (!VERIFIABLE_STATES.includes(snapshot.state)) {
    return notVerified(
      proposal,
      'not_executed',
      `the Proposal is ${snapshot.state}, and Verification follows the completion of an ` +
        `execution (Requirement 5.11), which is admissible only from ` +
        `${VERIFIABLE_STATES.join(', ')}; ${
          snapshot.state === 'execution_failed'
            ? 'a failed execution is Requirement 5.17\u2019s reversal path (task 23.4), not a ' +
              'completed one to verify'
            : 'no execution has completed for this Proposal, so there is no post-execution ' +
              'state to observe'
        }`,
      snapshot.state,
    );
  }

  // Present because task 23.2 writes it in the same update as the state; absent means a
  // corrupt row rather than a Verification to refuse.
  const executedAt = snapshot.executed_at;
  assertExecutedAt(executedAt);

  // One clock read for the window, for `verified_at` and for the Exception's `detected_at`,
  // so a Verification cannot report itself as having concluded at an instant it did not
  // measure the window against.
  const at = now();
  if (verificationWindowElapsed(executedAt, at)) {
    return notVerified(
      proposal,
      'verification_window_elapsed',
      `execution completed at ${executedAt} and the deadline for Verification was ` +
        `${verificationDeadline(executedAt)}, which ${at.toISOString()} is past; a difference ` +
        `observed now is no longer attributable to this execution, so Requirement 5.12's ` +
        `Exception would carry the wrong impact. Nothing was observed and nothing was written`,
      snapshot.state,
    );
  }

  const expected = verifiableOutcomeFrom(snapshot.expected_outcome, 'proposals.expected_outcome');
  const observed = await deps.observer.observe(snapshot);
  const comparison = compareOutcomes(
    expected,
    // The observer is an adapter over stored state, so its answer is held to the same shape
    // as the stored side rather than trusted because it is typed.
    verifiableOutcomeFrom({ paise: toWire(observed.paise), fields: observed.fields }, 'observed state'),
  );
  const verifiedAt = at.toISOString();

  if (comparison.matched) {
    await deps.store.markVerified(
      proposal,
      verifiedAt,
      comparison.observed_paise,
      comparison.difference_paise,
    );
    return { ...comparison, kind: 'verified', matched: true, proposal_id: proposal, verified_at: verifiedAt };
  }

  // Requirement 5.12. The Exception first: it is idempotent by fingerprint, so a crash
  // between the two writes is recoverable, whereas a state transition without an Exception
  // is a Proposal that looks handled with nothing in the Attention_Panel to act on.
  const raised = await deps.exceptions.upsert(
    verificationFailureException({
      proposal_id: proposal,
      action_type: snapshot.action_type,
      target_source_records: snapshot.target_source_records,
      evidence_chain_id: snapshot.evidence_chain_id,
      executed_at: executedAt,
      comparison,
      detected_at: verifiedAt,
    }),
  );
  await deps.store.markVerificationFailed(
    proposal,
    verifiedAt,
    comparison.observed_paise,
    comparison.difference_paise,
  );

  // Nothing further. No reversal, no retry, no second Exception (Requirement 5.12).
  return {
    ...comparison,
    kind: 'verification_failed',
    matched: false,
    proposal_id: proposal,
    verified_at: verifiedAt,
    exception_id: raised.exception_id,
    exception_open: raised.ok,
  };
}

/**
 * design.md's `verify(proposalId)` with its dependencies bound at construction, ready to
 * sit beside `createApprovalActions` and `createAuthorizedExecutor`.
 *
 * The Tenant is the session's, supplied through the store and the `ExceptionUpserter`
 * (Requirement 12.7) — no argument here carries one.
 */
export function createExecutionVerifier(deps: VerifierDeps): ExecutionVerifier {
  return {
    verify: (proposalId) => verifyExecutedProposal(proposalId, deps),
  };
}
