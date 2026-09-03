/**
 * `get_unsettled_payments` — the Payments no Settlement claims, with their ageing
 * (task 12.4). Requirements 4.11, 4.14, 12.2, 12.3.
 *
 * Requirement 4.11: a Payment that cannot be matched to **any** Settlement is
 * *unsettled*, and what gets recorded is the Payment identifier and the Payment age
 * in whole days from its creation timestamp to the run timestamp. design.md fixes the
 * contract exactly:
 *
 *     in   { as_of: DateOnly; page: Page<100> }
 *     out  { rows: Array<{ payment_id: string; amount_paise: Paise; age_days: number }>;
 *            total: number }
 *
 * ## What this module owns, and what it only calls
 *
 * | Concern | Where |
 * |---|---|
 * | the Zod schemas, the row set, the order, the page, the catalogue entry | here |
 * | the per-row and aggregate Evidence_Chains | here (they are one `sum` each; see below) |
 * | `Page<100>`, the offset/limit bounds, the slice | `./paging.ts` (task 12.4) |
 * | `DateOnly` validation and whole-day arithmetic | `./settlement-scope.ts` (task 12.1) |
 * | composing, validating and persisting a chain | `@/evidence/chain-builder` (task 9.1) |
 * | every addition | `@/calc/calculation-service` (task 2.1) |
 * | parse, authorize, bound, envelope check | `./tool.ts` (task 10.1) |
 *
 * **No money is computed in this file.** The one arithmetic operation is the aggregate
 * `sum` behind the envelope chain, and it goes through the Calculation Service, which
 * range-checks every operand and the running total.
 *
 * ## Decision 1: "unsettled" is zero candidate Settlements, and ambiguity is not it
 *
 * Requirement 4.11 is about a Payment that matches **no** Settlement. Requirement
 * 4.14 is about one that matches **two or more**, which is an *ambiguous match* and
 * which 4.14 explicitly "SHALL exclude from the unsettled classification". So the
 * classification is a count of candidates, and both requirements fall out of it:
 *
 * | Candidate Settlements | Classification |
 * |---|---|
 * | 0 | **unsettled** — a row here (Requirement 4.11) |
 * | 1 | settled — not a row |
 * | 2 or more | ambiguous — **not** a row (Requirement 4.14) |
 *
 * {@link isUnsettled} is that predicate, and {@link ScopedPayment.settlement_candidate_count}
 * is what the store reports. The count is deliberately the store's and the
 * classification deliberately this module's: an adapter that returned a boolean
 * `unsettled` flag would be deciding Requirement 4.14 in SQL, where no test in this
 * suite can see it.
 *
 * **Matching is by stored Razorpay identifier link only** (Requirement 4.1). The
 * count is over the Settlements the stored links name; no amount and no date is
 * compared, here or in any adapter this seam admits.
 *
 * ## Decision 2: `age_days` is a whole-day difference between UTC calendar dates
 *
 * Requirement 4.11 says "the Payment age in whole days from the Payment creation
 * timestamp to the run timestamp". design.md's input gives this tool a **`DateOnly`**
 * `as_of` and no time of day, so the run timestamp's clock time is not available to
 * it at all. The only total function of the inputs design.md hands over is therefore:
 *
 * > **`age_days` = whole days from the UTC calendar date of the Payment's creation
 * > timestamp to `as_of`.** A Payment created on `as_of` is 0 days old.
 *
 * Computed through `rangeLengthInDays` from `./settlement-scope.ts` minus one, so
 * there is one spelling of `DateOnly` day arithmetic in the codebase rather than a
 * second UTC subtraction here. Reported as a finding: an ageing figure derived from
 * two timestamps and one derived from two dates differ by up to a day, and design.md
 * chose the argument type.
 *
 * `age_days` is a **count of days, not money**: `number`, not `Paise`, and the ESLint
 * money rule does not fire on it. It carries no Evidence_Chain of its own for the
 * same reason — Requirement 12.2 grounds *monetary* figures — but the row's chain
 * cites the Payment's `created_at` field beside its `amount`, so a drill-down can see
 * the timestamp the ageing came from.
 *
 * ## Decision 3: the order, which design.md fixes for neither this tool nor 4.11
 *
 * > **Descending `age_days`, ties broken on ascending Payment identifier.**
 *
 * Oldest first, because Requirement 4.11's own subject is the ageing and the operator
 * question behind it is "what has been sitting unsettled longest". The tie-break is
 * the house pattern — `inScopeOrder` in `./settlement-scope.ts`, task 12.2's
 * `breakdownRowsInOrder`, and Requirement 10.4 and 10.5's "ascending Source_Record
 * identifier" — and it is what makes the order **total**: a Payment identifier is
 * unique per Tenant, so which rows land on a page is a function of the in-scope set
 * and never of the order the store returned rows in (Requirement 4.15). Without it a
 * page boundary would fall between two equally-aged Payments arbitrarily, and two
 * identical requests could return different pages.
 *
 * ## Decision 4: `total` is the whole result set, and the page never clamps
 *
 * `total` is the count of **every** unsettled Payment, not the count on the page, so a
 * caller can tell "100 of 4,312" from "100 of 100". An `offset` past the end yields
 * zero rows and the true total; an out-of-range `offset` or `limit` is a
 * `schema_violation` naming the argument with no connection opened, never a clamp
 * (see `./paging.ts`, decision 3).
 *
 * ## Decision 5: this tool has **no top-level monetary figure**, and that changes the
 * empty case
 *
 * design.md's output states `rows` and `total`. `total` is a count, so **every**
 * monetary figure this tool returns lives inside a row, and each row carries its own
 * `evidence_chain_id` grounding it (Requirement 12.2) — the resolution task 10.1's
 * finding 1 asks for, with `ToolResult`'s single-`evidence` envelope left untouched.
 *
 * That has a consequence 12.1 and 12.2 did not have. Those tools refuse an empty
 * scope, because their top-level figure would otherwise be an ungrounded `0n`. Here a
 * **zero-row page is a perfectly good answer** — "nothing is unsettled" is what a
 * healthy book looks like, and there is no figure to omit. So an empty result is
 * returned, with `total: 0`, and the envelope chain grounds the aggregate:
 *
 * > **The envelope chain's figure is Σ `amount` over every unsettled Payment in the
 * > whole result set** — not the page. Its terminal step is one `sum` over the
 * > Payments' `amount` fields, so it replays from the Payment records themselves
 * > (Requirement 12.8), and where nothing is unsettled it sums one `literal '0'` and
 * > cites what was examined, which is a grounded `0n` rather than an assertion.
 *
 * The figure is reported through `evidence.figure_paise` and **not** copied into
 * `Out`: design.md's output shape has no field for it, and inventing a top-level
 * `total_unsettled_paise` would be widening the contract rather than satisfying it.
 * Reported as a finding — a tool whose rows are the only figures still owes the
 * envelope one chain, and design.md never says what it should present.
 *
 * The one case still refused is a scope in which the store examined **nothing at
 * all**: `evidence_chains.source_count >= 1` is a database CHECK, so a chain citing
 * no Source_Record cannot be stored, and `incomplete_evidence` would be a lie because
 * nothing was unreadable. That is the same gap 12.1 and 12.2 reported and it is
 * unchanged here. {@link UnsettledPaymentResult.examined} is what keeps it rare: an
 * adapter reports the citations it read to decide the answer, so a Tenant with
 * Payments but no unsettled ones is answered, not refused.
 *
 * ## The read seam, and what is not here
 *
 * `ctx.db` is **not read**. Every Razorpay table is `ENABLE`d *and* `FORCE`d for
 * row-level security with no policies until task 26.1, so PostgREST matches zero rows
 * for every role without `BYPASSRLS`, and a live adapter written today would silently
 * answer "nothing is unsettled" for every Tenant. {@link UnsettledPaymentStore} and
 * `EvidenceChainStore` are injected as **factories over the `ToolContext`**, exactly
 * as tasks 12.1 and 12.2 inject theirs, so 26.x supplies `ctx.db`-backed adapters with
 * no change to this file.
 *
 * `tenant_id` reaches the store from `ctx.tenant_id` — the session — and is not an
 * argument at any depth (Requirement 12.7). A cross-Tenant request answers zero rows,
 * never a permission error.
 *
 * ## Scope — deliberately left elsewhere
 *
 * - **Task 12.7** runs the contract harness over the Slice 1 catalogue. This module
 *   exports {@link createGetUnsettledPayments} and {@link catalogueEntryFor}, and
 *   `./catalogue.ts` — 12.7's module, not this one — registers it in one line;
 *   `test/contract/slice-1-catalogue.test.ts` drives it through `runToolContract`.
 * - **Task 13.5** owns the *detector*: creating the `ambiguous match` Exceptions of
 *   Requirement 4.14, excluding unsettled Payments from every Settlement Expected
 *   Amount in a run (Requirement 4.11's third clause), and the Requirement 4.15
 *   fingerprint upsert. **This tool creates no Exception and excludes nothing from any
 *   computation**: it is `read_only` and it reports.
 * - **Task 26.x** owns the RLS policies, the read-only role and the live adapters.
 *
 * ## Reported, not silently patched
 *
 * 1. **design.md never declares `Page<N>`.** Declared in `./paging.ts` as
 *    `{ offset, limit }` with `N` the maximum size; see that module's decision 1.
 * 2. **`as_of` is a `DateOnly`, so Requirement 4.11's "creation timestamp to run
 *    timestamp" ageing cannot be computed to the second.** Whole calendar days, see
 *    decision 2.
 * 3. **design.md fixes no row order.** Descending age, ties on ascending identifier;
 *    see decision 3.
 * 4. **The output has no top-level monetary figure, and the envelope still needs a
 *    chain.** The envelope presents the aggregate over the whole result set; see
 *    decision 5.
 * 5. **A scope in which nothing at all was examined has no specified result shape.**
 *    Refused, as in 12.1 and 12.2.
 * 6. **Requirement 4.11 says "cannot match a Payment to any Settlement" and 4.14
 *    excludes the ambiguous ones**, but neither says what a Payment matching exactly
 *    one *cancelled* or *failed* Settlement is. Treated as settled, because a stored
 *    link exists and no requirement distinguishes the Settlement's own state.
 */

import { type Paise, sum } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChain,
  type EvidenceChainInput,
  type EvidenceChainStore,
  type EvidenceOperand,
  type EvidenceSourceCitation,
  type EvidenceStep,
  incompleteEvidence,
  type IncompleteEvidence,
  MAX_STEP_INDEX,
} from '@/evidence/chain-builder';
import type { DateOnly, SourceRef } from '@/ledger/posting-rules';
import { z } from 'zod';

import { MAX_PAGE_SIZE_100, type Page, pageOf, pageSchema } from './paging';
import { catalogued } from './registry';
import { assertDateOnlyValue, rangeLengthInDays } from './settlement-scope';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

/** design.md's catalogue name, and `evidence_chains.produced_by` for every chain here. */
export const GET_UNSETTLED_PAYMENTS = 'get_unsettled_payments';

/**
 * A Razorpay Payment identifier, for the **output** schema.
 *
 * Pattern-bounded so a row cannot carry free-form text. Wider than a live identifier
 * (`pay_` plus 14 base-62 characters) because the fixtures and the property
 * generators use readable synthetic ones (`pay_p1_a`), and a pattern that rejected the
 * test data would be a pattern nothing exercised.
 */
const PAYMENT_ID_RE = /^pay_[A-Za-z0-9_]{2,40}$/;

/** The fields this tool's chains cite. `amount` is the figure; `created_at` the ageing. */
export const PAYMENT_FIELD = {
  amount: 'amount',
  created_at: 'created_at',
} as const;

/**
 * How many unsettled Payments one aggregate chain can carry.
 *
 * The aggregate is a single `sum` step over one source operand per contributor, so the
 * step count is 1 whatever the size — but the operands and the citations are not free,
 * and a chain that cannot be *read back* is not evidence. The ceiling is stated at the
 * same order as `evidence_chain_steps.step_index`'s `SMALLINT` limit
 * ({@link MAX_STEP_INDEX}), which is the only comparable bound the schema states.
 * Beyond it the tool refuses rather than presenting a figure whose evidence was
 * truncated.
 */
export const MAX_UNSETTLED_CONTRIBUTORS = MAX_STEP_INDEX;

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Aborted, or handed a malformed row. Becomes `tool_failure` cause `execution_error`. */
export class UnsettledPaymentsError extends Error {
  override readonly name = 'UnsettledPaymentsError';
}

/* -------------------------------------------------------------------------- */
/* Input schema                                                               */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM-DD` that is also a real calendar date. `2026-02-30` is neither. */
function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const inputSchema = z
  .strictObject({
    /** Requirement 4.11's run date: the ageing is measured to this date. */
    as_of: z.iso.date(),
    /** design.md's `Page<100>`. Bounded in the schema, never clamped in `execute`. */
    page: pageSchema(MAX_PAGE_SIZE_100),
  })
  // Here rather than in `execute` so a bad date is a `schema_violation` naming the
  // argument, with no connection opened and the rejection audited (Requirement 12.9).
  .refine((value) => isRealDate(value.as_of), {
    error: 'as_of must be a real calendar date',
    path: ['as_of'],
  });

export type GetUnsettledPaymentsInput = z.infer<typeof inputSchema>;

/* -------------------------------------------------------------------------- */
/* Output schema                                                              */
/* -------------------------------------------------------------------------- */

const paise = z.bigint();

/**
 * One unsettled Payment: design.md's three fields, plus the two Requirement 12.2 and
 * 12.4 need against the figure.
 */
export const unsettledPaymentRowSchema = z.strictObject({
  payment_id: z.string().regex(PAYMENT_ID_RE),
  /** The Payment amount, in integer paise. Grounded by this row's chain. */
  amount_paise: paise,
  /** Whole days from the Payment's creation date to `as_of`. A count, not money. */
  age_days: z.number().int().nonnegative(),
  /** Grounds this row's monetary field (Requirement 12.2). Never null. */
  evidence_chain_id: z.uuid(),
  /** The chain's as-of: the newest contributing `record_updated_at`. */
  evidence_as_of: z.iso.datetime(),
});

const outputSchema = z.strictObject({
  /** Descending `age_days`, ties on ascending `payment_id`. At most `page.limit` rows. */
  rows: z.array(unsettledPaymentRowSchema).max(MAX_PAGE_SIZE_100),
  /** Every unsettled Payment, across every page — not the size of `rows`. */
  total: z.number().int().nonnegative(),
});

export type GetUnsettledPaymentsOutput = z.infer<typeof outputSchema>;
export type UnsettledPaymentRow = z.infer<typeof unsettledPaymentRowSchema>;

/* -------------------------------------------------------------------------- */
/* The read seam                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One scoped read. `tenant_id` comes from the session and is passed explicitly, never
 * accepted as a tool argument (Requirement 12.7).
 */
export interface UnsettledPaymentQuery {
  readonly tenant_id: TenantId;
  /** Requirement 4.11's run date. Payments created after it are out of scope. */
  readonly as_of: DateOnly;
}

/**
 * One Payment the store could not match to exactly one Settlement.
 *
 * `settlement_candidate_count` is the number of Settlements the **stored Razorpay
 * identifier links** name — never an amount or date inference (Requirement 4.1). `0`
 * is Requirement 4.11's unsettled; `2` or more is Requirement 4.14's ambiguous match,
 * which is returned so it can be *excluded* here rather than invisibly in SQL, and so
 * it can still be cited as examined.
 */
export interface ScopedPayment {
  readonly payment_id: string;
  /** Stored Razorpay status. Only the exact `captured` state can be unsettled. */
  readonly status_rzp: string;
  /** The UTC calendar date of the Payment's creation timestamp. `<= as_of`. */
  readonly created_on: DateOnly;
  readonly amount_paise: Paise;
  /** ISO-8601 UTC, ms precision, as the Payment record stood when read. */
  readonly record_updated_at: string;
  /** Settlements the stored links match. See the interface doc comment. */
  readonly settlement_candidate_count: number;
  /**
   * Source_Records the store knows contribute to this Payment and could not read.
   * Non-empty anywhere in the result means the figure is **omitted** and
   * `incomplete_evidence` is returned instead (Requirement 12.3).
   */
  readonly unreadable?: readonly SourceRef[];
}

/**
 * What the store answers.
 *
 * `examined` is the citations the store read to decide the answer, and it is what
 * makes a **zero-row** answer representable: the envelope chain cites them, so "no
 * Payment is unsettled" is a grounded `0n` rather than a refusal. An adapter may
 * report a bounded witness rather than every Payment it scanned — one citation is
 * enough — but it must report at least one whenever the scope held any Payment at all.
 */
export interface UnsettledPaymentResult {
  /** Every Payment whose stored links do not name exactly one Settlement. */
  readonly payments: readonly ScopedPayment[];
  readonly examined: readonly EvidenceSourceCitation[];
  /** Requirement 12.3, at the scope level: a record the store could not read at all. */
  readonly unreadable?: readonly SourceRef[];
}

/**
 * Where unsettled Payments come from. Injected rather than imported: there is no live
 * adapter until task 26.1 — see the module doc comment.
 *
 * Three contracts every adapter owes:
 *
 * 1. **Tenant scoping is the query's, and rows outside it do not exist.** A
 *    cross-Tenant request answers zero rows, never a permission error
 *    (Requirement 14.4).
 * 2. **Only Payments created on or before `as_of`.** A later Payment has a negative
 *    age, which this tool refuses rather than reports.
 * 3. **Timestamps are ISO-8601 UTC to millisecond precision.** `TIMESTAMPTZ` renders
 *    in the session time zone by default, and `record_updated_at` feeds `as_of` and
 *    the stale indicator, both of which compare as strings. Select it as
 *    `to_char(x AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`.
 */
export interface UnsettledPaymentStore {
  listCandidates(query: UnsettledPaymentQuery): Promise<UnsettledPaymentResult>;
}

/* -------------------------------------------------------------------------- */
/* Dependencies                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The two seams, as factories over the invocation context — the shape tasks 12.1 and
 * 12.2 declare, for the same reason: the Tenant and the connection travel from
 * `ToolContext` into the store, which is what lets task 26.x hand back a
 * `ctx.db`-backed adapter with no change here.
 */
export interface GetUnsettledPaymentsDeps {
  readonly payments: (ctx: ToolContext) => UnsettledPaymentStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

/* -------------------------------------------------------------------------- */
/* Classification, ageing and order                                           */
/* -------------------------------------------------------------------------- */

/** Requirement 4.11's classification, with Requirement 4.14's exclusion. */
export function isUnsettled(payment: ScopedPayment): boolean {
  const count = payment.settlement_candidate_count;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new UnsettledPaymentsError(
      `${payment.payment_id} states settlement_candidate_count ` +
        `${JSON.stringify(count)}; it must be a non-negative whole count of the Settlements the ` +
        `stored identifier links name`,
    );
  }
  // Only a captured Payment is eligible. Failed, authorised, refunded, or any
  // unknown provider state is not silently promoted to captured.
  if (payment.status_rzp !== 'captured') {
    return false;
  }
  // 0 is unsettled (4.11); 1 is settled; 2 or more is an ambiguous match, which 4.14
  // excludes from the unsettled classification.
  return count === 0;
}

/**
 * Requirement 4.11's age: whole days from the Payment's creation date to `as_of`.
 *
 * Through `rangeLengthInDays`, which counts **inclusive** dates, so the same date is 1
 * and the age is one less. See decision 2 in the module doc comment for why the
 * calendar date rather than the timestamp.
 *
 * @throws {UnsettledPaymentsError} for a Payment created after `as_of`, which the
 * store contract forbids and which would otherwise report a negative age.
 */
export function ageInDays(payment: ScopedPayment, asOf: DateOnly): number {
  assertDateOnlyValue(payment.created_on, `${payment.payment_id}.created_on`);
  assertDateOnlyValue(asOf, 'as_of');
  if (payment.created_on > asOf) {
    // Lexicographic comparison of `YYYY-MM-DD` is chronological comparison.
    throw new UnsettledPaymentsError(
      `${payment.payment_id} was created on ${payment.created_on}, after as_of ${asOf}; a ` +
        `Payment created after the run date is out of scope and its age is not a whole number ` +
        `of days a report may state`,
    );
  }
  return rangeLengthInDays({ from: payment.created_on, to: asOf }) - 1;
}

/** One unsettled Payment with its computed age, so the order is not recomputed per compare. */
interface AgedPayment {
  readonly payment: ScopedPayment;
  readonly age_days: number;
}

/**
 * Requirement 4.11's rows in this tool's order: the unsettled Payments, descending
 * `age_days`, ties on ascending Payment identifier.
 *
 * Pure, total, and a function of the **set**: `payments` may arrive in any order and
 * the answer is the same, which is what a page boundary needs to be deterministic
 * (Requirement 4.15). Exported so a test can assert the order without going through
 * the invoker.
 */
export function unsettledPaymentsInOrder(
  payments: readonly ScopedPayment[],
  asOf: DateOnly,
): readonly AgedPayment[] {
  const aged: AgedPayment[] = [];
  for (const payment of payments) {
    if (isUnsettled(payment)) {
      aged.push({ payment, age_days: ageInDays(payment, asOf) });
    }
  }
  return aged.sort((a, b) => {
    if (a.age_days !== b.age_days) {
      // Oldest first. Both are day counts, so a numeric subtraction is exact.
      return b.age_days - a.age_days;
    }
    const left = a.payment.payment_id;
    const right = b.payment.payment_id;
    if (left === right) {
      return 0;
    }
    // The tie-break design.md leaves open. See decision 3.
    return left < right ? -1 : 1;
  });
}

/* -------------------------------------------------------------------------- */
/* Evidence chains                                                            */
/* -------------------------------------------------------------------------- */

const paymentRef = (paymentId: string): SourceRef => ({ type: 'payment', id: paymentId });

const sourceOperand = (ref: SourceRef, field: string): EvidenceOperand => ({
  kind: 'source',
  ref,
  field,
});

/** The zero an aggregate over no contributor sums. A string, because `operands` is JSONB. */
const ZERO_LITERAL: EvidenceOperand = { kind: 'literal', value: '0' };

function citation(ref: SourceRef, field: string, recordUpdatedAt: string): EvidenceSourceCitation {
  return { ref, field, record_updated_at: recordUpdatedAt };
}

/**
 * One row's chain: a single `sum` over the Payment's own `amount`.
 *
 * The figure is read, not derived, so one step states the whole derivation — the same
 * shape `unreconciledSettlementChain` uses in `./settlement-evidence.ts` for a figure
 * that comes straight off a record. `created_at` is cited beside `amount` although no
 * step reads it: `age_days` is not a monetary figure and needs no chain, but the field
 * it was derived from belongs in the drill-down.
 */
export function unsettledPaymentChain(
  producedBy: string,
  payment: ScopedPayment,
): EvidenceChainInput {
  const ref = paymentRef(payment.payment_id);
  return {
    produced_by: producedBy,
    figure_paise: payment.amount_paise,
    steps: [
      {
        index: 1,
        operation: 'sum',
        operands: [sourceOperand(ref, PAYMENT_FIELD.amount)],
        result_paise: payment.amount_paise,
        note:
          'the Payment amount, read from the Payment object. No Settlement names this Payment, ' +
          'so it is unsettled (Requirement 4.11)',
      },
    ],
    sources: [
      citation(ref, PAYMENT_FIELD.amount, payment.record_updated_at),
      // Not read by a step: age_days is a count of days, not a monetary figure.
      citation(ref, PAYMENT_FIELD.created_at, payment.record_updated_at),
    ],
  };
}

/**
 * The envelope chain: Σ `amount` over every unsettled Payment in the whole result set.
 *
 * One `sum` step over the Payments' `amount` fields, so a replay reproduces the total
 * from the Payment records rather than from literals (Requirement 12.8). Where nothing
 * is unsettled the step sums one `literal '0'` and the chain cites what was examined,
 * which is a grounded `0n` — see decision 5 in the module doc comment.
 *
 * @throws {UnsettledPaymentsError} when the chain would cite no Source_Record at all,
 * or when there are more contributors than {@link MAX_UNSETTLED_CONTRIBUTORS}.
 * @throws {PaiseRangeError} when the running total leaves the paise range.
 */
export function totalUnsettledChain(
  producedBy: string,
  contributors: readonly ScopedPayment[],
  examined: readonly EvidenceSourceCitation[],
): EvidenceChainInput {
  if (contributors.length > MAX_UNSETTLED_CONTRIBUTORS) {
    throw new UnsettledPaymentsError(
      `${contributors.length} Payments are unsettled, and one Evidence_Chain states at most ` +
        `${MAX_UNSETTLED_CONTRIBUTORS} contributing Source_Records here. Narrow the scope rather ` +
        `than presenting a figure whose evidence is truncated`,
    );
  }
  // Every operand and the running total range-checked by the Calculation Service.
  const total = sum(contributors.map((payment) => payment.amount_paise));
  const operands = contributors.map((payment) =>
    sourceOperand(paymentRef(payment.payment_id), PAYMENT_FIELD.amount),
  );
  const citations: EvidenceSourceCitation[] = contributors.map((payment) =>
    citation(paymentRef(payment.payment_id), PAYMENT_FIELD.amount, payment.record_updated_at),
  );
  // The examined witness, so the scope the figure was computed over is in the chain.
  // Duplicates of one (record, field) collapse in `composeEvidenceChain`.
  citations.push(...examined);
  if (citations.length === 0) {
    throw new UnsettledPaymentsError(
      `the ${producedBy} scope cites no Source_Record at all, so there is nothing to ground the ` +
        `answer in; evidence_chains.source_count >= 1 would reject the chain (Requirement 12.2)`,
    );
  }
  const step: EvidenceStep = {
    index: 1,
    operation: 'sum',
    operands: operands.length === 0 ? [ZERO_LITERAL] : operands,
    result_paise: total,
    note:
      'Σ Payment amounts over every unsettled Payment in scope (Requirement 4.11). The zero ' +
      'literal states that the scope was examined and held no unsettled Payment',
  };
  return { produced_by: producedBy, figure_paise: total, steps: [step], sources: citations };
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build the tool. A factory because both seams are injected — see
 * {@link GetUnsettledPaymentsDeps}.
 */
export function createGetUnsettledPayments(
  deps: GetUnsettledPaymentsDeps,
): FinancialTool<GetUnsettledPaymentsInput, GetUnsettledPaymentsOutput> {
  return {
    name: GET_UNSETTLED_PAYMENTS,
    // Reads only. It persists Evidence_Chains, which is not Tenant financial state: a
    // figure cannot be returned without one (Requirement 12.2).
    mode: 'read_only',
    inputSchema,
    outputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,

    async execute(
      ctx: ToolContext,
      input: GetUnsettledPaymentsInput,
    ): Promise<ToolResult<GetUnsettledPaymentsOutput>> {
      const read = await deps.payments(ctx).listCandidates({
        // From the session, never from an argument (Requirement 12.7).
        tenant_id: ctx.tenant_id,
        as_of: input.as_of,
      });

      // Requirement 12.3, before any figure is composed: one unreadable contributing
      // record withholds the whole answer, because the aggregate is composed from every
      // unsettled Payment and a row set missing a Payment nobody could read would be a
      // partial answer presented as a whole one.
      const unreadable = [
        ...(read.unreadable ?? []),
        ...read.payments.flatMap((payment) => payment.unreadable ?? []),
      ];
      if (unreadable.length > 0) {
        return incompleteEvidence(unreadable);
      }

      const ordered = unsettledPaymentsInOrder(read.payments, input.as_of);
      // `total` is the whole result set; the page is a window on it (decision 4). The
      // argument is already bounded to `1..100` by the input schema, so no clamp.
      const requested: Page<typeof MAX_PAGE_SIZE_100> = input.page;
      const page = pageOf(ordered, requested);

      const builder = createEvidenceChainBuilder({
        store: deps.chains(ctx),
        // The session Tenant, bound once. No method takes one.
        tenantId: ctx.tenant_id,
      });

      /** Compose and persist one chain, or hand back `incomplete_evidence` as-is. */
      const persist = async (
        chain: EvidenceChainInput,
      ): Promise<EvidenceChain | IncompleteEvidence> => {
        if (ctx.signal.aborted) {
          // The 10-second bound has elapsed. Stop before issuing another write rather
          // than leaving chains behind for a figure that will never be returned.
          throw new UnsettledPaymentsError(
            `${GET_UNSETTLED_PAYMENTS} was aborted while composing Evidence_Chains`,
          );
        }
        const built = await builder.build(chain);
        return built.ok ? built.evidence : built;
      };

      const rows: UnsettledPaymentRow[] = [];
      for (const aged of page.rows) {
        const persisted = await persist(
          unsettledPaymentChain(GET_UNSETTLED_PAYMENTS, aged.payment),
        );
        if ('ok' in persisted) {
          return persisted;
        }
        rows.push({
          payment_id: aged.payment.payment_id,
          amount_paise: aged.payment.amount_paise,
          age_days: aged.age_days,
          evidence_chain_id: persisted.evidence_chain_id,
          evidence_as_of: persisted.as_of,
        });
      }

      // The envelope chain: the aggregate over the whole result set, not the page.
      const envelope = await persist(
        totalUnsettledChain(
          GET_UNSETTLED_PAYMENTS,
          ordered.map((aged) => aged.payment),
          read.examined,
        ),
      );
      if ('ok' in envelope) {
        return envelope;
      }

      return {
        ok: true,
        // A count of Payments, not money.
        value: { rows, total: page.total },
        evidence: envelope,
      };
    },
  };
}

/**
 * The tool as a catalogue entry, ready for `createToolRegistry` (task 12.7).
 *
 * `catalogued` is identity at runtime; it exists so TypeScript checks the whole
 * declaration — including `NoTenantId<In>`, which is what makes a `tenant_id` argument
 * uninhabitable — at the hand-off rather than losing it in an erased list.
 */
export function catalogueEntryFor(deps: GetUnsettledPaymentsDeps): ErasedFinancialTool {
  return catalogued(createGetUnsettledPayments(deps));
}
