/**
 * The Exception fingerprint and the upsert that makes a re-run an update rather
 * than a duplicate (task 11.4).
 * Requirements 4.12, 4.15; Requirement 7.10 for the range-scoped categories.
 *
 * An Exception's **identity** is a pure function of *what* was detected. Never of
 * *when* it was detected, never of how much it was worth, never of the order the
 * rows arrived in. That is the whole reason this module exists, and it is what
 * makes property P5 (task 13.4) provable: two Reconciliation_Agent runs over an
 * unchanged dataset compute the same fingerprints, so the second run's writes all
 * land on the first run's rows.
 *
 * ## The hashed string, exactly
 *
 * design.md fixes it, and it is transcribed rather than improved on:
 *
 *     sha256Hex(`${tenant_id}|${category}|${refs}|${scope}`)
 *
 * where `refs` is every Source_Record ref rendered `type:id`, sorted on **type
 * then id** in ascending character order, joined with `,`; and `scope` is
 * `${from}..${to}` for a {@link RANGE_SCOPED_CATEGORIES} category and the **empty
 * string** otherwise. The trailing `|` is therefore always present — the scope
 * segment is empty, never absent — so the string has exactly four segments for
 * every category and a reader can always count the separators. One worked value:
 *
 *     11111111-1111-4111-8111-111111111111|settlement_mismatch|
 *     settlement:setl_SYNTHETIC9282,settlement_recon_report:setlrcn_SYNTHETIC9282|
 *
 * (one line, no newlines, no spaces) hashing to a 64-character lowercase hex
 * digest. `impact_paise`, `detail`, `evidence_chain_id`, `lifecycle_state`, the
 * run identifier and every timestamp are **outside** it, which is what lets a
 * re-run that recomputes a different impact for the same condition update in
 * place (Requirement 4.15).
 *
 * ## Separator injection — defended against, not assumed away
 *
 * If a Source_Record identifier could contain `,`, `:` or `|`, two different ref
 * sets could produce one hashed string, and two genuinely different Exceptions
 * would collide onto one row. Razorpay identifiers are ASCII alphanumerics and
 * underscores, so in practice this cannot happen — but `exception_source_records.
 * source_record_id` is `TEXT`, the identifiers reach us through ingestion rather
 * than from a constant, and "in practice" is not an invariant. Two ways to close
 * it: change the encoding (length-prefix each ref), or make the ambiguous input
 * unrepresentable. Changing the encoding would deviate from design.md's fixed
 * string and change every fingerprint ever computed, so this module takes the
 * second route: {@link assertRefIdentifier} **rejects** any identifier containing
 * `|`, `,`, `:`, a NUL, or any other control character, before anything is hashed.
 * The encoding stays design.md's, and an injecting identifier raises
 * {@link ExceptionFingerprintError} instead of silently colliding.
 *
 * `type` needs no such defence: it is a `source_record_type` enum label, checked
 * against {@link SOURCE_RECORD_TYPES}, and no label contains a separator.
 * `\u0000` is what `src/evidence/chain-builder.ts` uses as its key joiner for the
 * same reason — a Postgres text value cannot contain it — and it is rejected here
 * too, so the two modules agree about what an identifier may be.
 *
 * ## A plain hash, not a keyed MAC
 *
 * `createHash('sha256')`, not the HKDF-and-AES-GCM idiom of
 * `src/config/credential-crypto.ts`. That is deliberate: a fingerprint is an
 * **identity**, not a secret and not an authenticator. It has to be reproducible
 * by any process holding the same Tenant, category and ref set — the next run, a
 * backfill, a test — so a key would have to be shared with all of them, which is
 * a key that protects nothing. Nothing about the system's safety rests on a
 * fingerprint being unguessable: it is never a capability, and reading one grants
 * nothing. What it must be is stable, and an unkeyed hash is stable forever.
 *
 * It is still a hash of Tenant data, so **nothing in this module logs, and no
 * fingerprint input ever reaches an error message.** {@link ExceptionFingerprintError}
 * messages name the *field* and the *rule*, and quote an identifier only where
 * that identifier is the thing being rejected as malformed.
 *
 * ## Is the Tenant inside the hash load-bearing?
 *
 * For row identity it is **belt-and-braces**: `exceptions_fingerprint_uniq` is
 * `UNIQUE (tenant_id, fingerprint)`, so two Tenants could hold the same
 * fingerprint on different rows and neither would collide with the other. Drop the
 * Tenant from the string and the database behaves identically.
 *
 * For the fingerprint used as a **value** it is load-bearing, which is why it
 * stays. A fingerprint is a 64-character string that will get copied into audit
 * payloads, Proposal targets, cache keys and support tickets, and in every one of
 * those places it is unqualified by a Tenant. With the Tenant hashed in, two
 * Tenants with the identical anomaly produce different fingerprints, so a
 * fingerprint can never be used to show that one Tenant has the same condition as
 * another, and an accidental use of a fingerprint as a global key cannot merge two
 * Tenants' Exceptions. That is the same stance as Requirement 14.1: isolation is
 * not something a caller has to remember.
 *
 * ## What the caller learns when the row exists but is not `open`
 *
 * `... DO UPDATE ... WHERE exceptions.lifecycle_state = 'open'` is the clause that
 * stops a re-run reopening an Exception a User resolved (Requirement 4.15 scopes
 * the update to open Exceptions specifically). When the conflicting row is
 * `resolved` or `dismissed`, the `WHERE` matches nothing, the `UPDATE` touches no
 * row, and `RETURNING id` yields **zero rows**.
 *
 * "Not reopened" and "silently discarded" are different things, and a zero-row
 * return is the second one. So the store follows the upsert with
 * {@link EXCEPTION_STATE_PROBE_SQL} inside the same transaction and reports
 * {@link ExceptionNotReopened} — a `kind: 'not_reopened'` **value** carrying the
 * existing Exception identifier and its lifecycle state. The re-detection is a
 * fact the caller is told about: task 13.2 counts it in the run report, and a
 * User asking "why is this not in my Attention_Panel?" has an answer. What must
 * not happen — reopening the row, or writing a second row for the same condition —
 * does not happen either.
 *
 * ## `first_detected_at` is written once
 *
 * It appears in the `VALUES` list and **not** in the `DO UPDATE SET` list. Putting
 * it there would clobber the original detection time on every re-run, and P5's
 * "every `first_detected_at` unchanged and every `last_detected_at` advanced"
 * would fail in the half that is hardest to notice. `test/db/exception-upsert.test.ts`
 * asserts it behaviourally over two runs with different timestamps, and
 * `exception-fingerprint.upsert.test.ts` asserts it textually against
 * {@link EXCEPTION_UPSERT_SQL}, so neither a rewrite of the statement nor a subtle
 * behavioural change passes.
 *
 * `detected_at` is an **input**, not `now()`. The run timestamp belongs to the run
 * (Requirement 4.15 names it), a run writing many Exceptions must stamp them all
 * identically, and P5 needs to choose two distinct instants. The database's own
 * `DEFAULT now()` stays as the fallback for any other writer. Note the
 * consequence: a second run stamped *earlier* than the first is rejected by
 * {@link EXCEPTION_DETECTION_ORDER_CHECK} rather than accepted — a clock that
 * moved backwards between runs is reported, not absorbed.
 *
 * ## Reported, not silently patched
 *
 * 1. **The `exceptions` CHECKs are unnamed** in design.md and in
 *    `20260101000005_exceptions.sql`, so Postgres generated `exceptions_check` and
 *    `exceptions_check1` for the two lifecycle CHECKs — names whose suffix depends
 *    on **declaration order**. A store has to match a rejection by name (the house
 *    rule, see `src/ledger/semantic-ledger.ts`), and matching bare SQLSTATE `23514`
 *    would read a `paise` range violation as a lifecycle violation. The names are
 *    exported below as {@link EXCEPTION_CHECKS} and audited against
 *    `pg_constraint` by the db suite, so reordering the CHECKs fails loudly. Naming
 *    them in the schema is the real fix and belongs to whoever revisits migration 5.
 * 2. **design.md states the upsert twice and the two differ.** The prose at its
 *    "Exceptions" section gives `DO UPDATE SET impact_paise, detail,
 *    last_detected_at` with **no `WHERE` guard**, and the migration's comment
 *    repeats that shorter form; the SQL block in its "Exception fingerprint and
 *    upsert" section adds `direction`, `evidence_chain_id` and
 *    `WHERE exceptions.lifecycle_state = 'open'`. The longer form is the specific
 *    one, the task text agrees with it, and it is the one implemented — but a
 *    reader of only the prose would build a statement that silently reopens a
 *    resolved Exception, so the divergence is flagged rather than quietly resolved.
 * 3. **The direction labels do not match across the two tables.** `exceptions.
 *    direction` CHECKs `'shortfall' | 'excess' | 'not_applicable'`, while
 *    `SettlementRecon.direction` (design.md, task 11.1) is `'unexplained_shortfall'
 *    | 'unexplained_excess' | 'not_applicable'` — and `test/fixtures/set-9281.ts`
 *    carries the *reconciliation* labels on its expected Exception. Nothing in
 *    design.md maps them. {@link exceptionDirectionFor} is that mapping, exported
 *    so task 13.2 does not invent a second one; without it the fixture's stated
 *    direction is rejected by `exceptions_direction_check`.
 * 4. **Requirement 7.10 is unreachable if every contributing ref is hashed.** It
 *    says the Marketplace_Agent updates the impact **and the Source_Record
 *    identifiers** of an existing open Exception in the same category and date
 *    range — but design.md's fingerprint hashes `source_refs`, so a changed ref set
 *    is a changed identity and there would be nothing to update. The split below
 *    ({@link ExceptionUpsertInput.source_refs} identify and are hashed;
 *    {@link ExceptionUpsertInput.context_refs} are linked and are **not** hashed,
 *    and are admissible only for a range-scoped category) is **this module's
 *    decision**, not design.md's. For every non-range-scoped category the whole ref
 *    set stays the identity, which is exactly Requirement 4.15's wording.
 * 5. **"At least 1 Source_Record" is not a table constraint** — migration FINDING 1
 *    says so and invents no trigger. {@link assertExceptionUpsertable} rejects a
 *    ref-less Exception before any statement is issued, so the requirement holds
 *    on this write path and the gap is closed where it can be.
 * 6. **design.md's `RETURNING id` cannot distinguish an insert from an update.**
 *    `(xmax = 0) AS created` is added, and the `not_reopened` case needs the
 *    follow-up probe described above. Both are additions to design.md's statement,
 *    made because an outcome the caller cannot observe is not an outcome.
 * 7. **`evidence_chain_id` carries no foreign key** (the migration's own deferred
 *    note). A wrong chain identifier is therefore not caught by the database; it is
 *    checked here as a UUID and nothing more, which is all this module can do.
 *
 * ## Scope — what each sibling needs from here, and what is left to it
 *
 * - **Task 13.2** (Exception creation in the Reconciliation_Agent run) calls
 *   {@link ExceptionUpserter.upsert} once per detected condition, with
 *   `impact_paise` from `residualImpactPaise(recon)` and `direction` from
 *   `exceptionDirectionFor(recon.direction)` — it computes neither itself. It owns
 *   the run identifier, the scope resolution, the Evidence_Chain, the `detail`
 *   payload, and the decision **not** to call this module at all where Requirement
 *   4.4 forbids an Exception (a zero residual). It must surface the
 *   `not_reopened` count in its run report rather than dropping it, and it must
 *   extend the two blocks marked `TASK 13.2 MUST EXTEND THIS BLOCK` in
 *   `test/worked-example/set-9281.worked-example.test.ts`.
 * - **Task 13.4** (property P5) needs determinism, which is here: the fingerprint
 *   is a pure function with no clock and no database, the ref order is
 *   canonicalised, and the upsert is one row per fingerprint. What is left to 13.4
 *   is the dataset generator, the shuffled second run, the ordering comparison over
 *   `[category, impact_paise, sortedSourceRefs]` tuples, the `exceptionCount`
 *   equality, and the two timestamp assertions. No property test is written here.
 * - **Task 12.5** (`list_exceptions_by_category`, `get_exception_evidence`) reads
 *   what this writes. {@link EXCEPTION_CATEGORIES} is the enum label list its Zod
 *   input schema validates against, `evidence_chain_id` is the join it follows, and
 *   `fingerprint` is the stable handle it can return so a caller can re-identify an
 *   Exception across runs. It must not recompute a fingerprint to find a row —
 *   `exceptions_fingerprint_uniq` is the lookup.
 * - **Tasks 18.x / 19.x** (Marketplace_Agent) are the only callers of the
 *   range-scoped path. They pass the Linked_Account or Payment ref as
 *   `source_refs`, the contributing Transfers and Transfer_Reversals as
 *   `context_refs`, and the reconciliation date range as `scope`. The 366-day bound
 *   of Requirement 7.1 is theirs, not checked here.
 * - **No store adapter is written here**, for the reason `SettlementReconStore` has
 *   none: `exceptions` is RLS `ENABLE`d **and** `FORCE`d with no policies until task
 *   26.1, so PostgREST matches zero rows for every role without `BYPASSRLS`, and
 *   `npm install` cannot currently add a Postgres driver. The three exported SQL
 *   strings are what an adapter runs, and `test/db/exception-upsert.test.ts`
 *   executes those exact strings over a real SQL session.
 */

import type { Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  assertDateOnly,
  type DateOnly,
  SOURCE_RECORD_TYPES,
  type SourceRecordType,
  type SourceRef,
} from '@/ledger/posting-rules';
import { type PaiseWire, toWire } from '@/wire/paise-wire';
import { createHash } from 'node:crypto';

/* -------------------------------------------------------------------------- */
/* The enums, transcribed from the schema                                     */
/* -------------------------------------------------------------------------- */

/**
 * The 14 `exception_category` labels, in migration order.
 *
 * Order is load-bearing in the database — enum comparison follows declaration
 * order, so it is the sort order `exceptions_attention_panel_idx` materialises —
 * and it is preserved here so the two lists can be compared line for line.
 */
export const EXCEPTION_CATEGORIES = [
  'settlement_mismatch',
  'possible_duplicate_refund',
  'unmatched_credit_note',
  'missing_accrual',
  'ambiguous_match',
  'gst_anomaly',
  'missing_gst_information',
  'invalid_gstin',
  'itc_discrepancy',
  'record_needing_review',
  'seller_settlement_mismatch',
  'over_allocated_split',
  'verification_failure',
  'execution_failure',
] as const;

export type ExceptionCategory = (typeof EXCEPTION_CATEGORIES)[number];

/** The three `exception_state` labels, in migration order. */
export const EXCEPTION_STATES = ['open', 'resolved', 'dismissed'] as const;

export type ExceptionState = (typeof EXCEPTION_STATES)[number];

/**
 * The three values `exceptions_direction_check` admits.
 *
 * **Not** the same labels as `ResidualDirection` in
 * `src/agents/reconciliation/reconcile-settlement.ts` — see gap 3 in the module
 * doc comment, and {@link exceptionDirectionFor} for the mapping.
 */
export const EXCEPTION_DIRECTIONS = ['shortfall', 'excess', 'not_applicable'] as const;

export type ExceptionDirection = (typeof EXCEPTION_DIRECTIONS)[number];

/**
 * `ResidualDirection` (task 11.1) rendered as an `exceptions.direction` value.
 *
 * The one place the two vocabularies meet. Exported so task 13.2 and the
 * Marketplace_Agent path do not each write their own `startsWith('unexplained_')`,
 * which is exactly the kind of restatement that drifts.
 */
export function exceptionDirectionFor(
  residualDirection: 'unexplained_shortfall' | 'unexplained_excess' | 'not_applicable',
): ExceptionDirection {
  switch (residualDirection) {
    case 'unexplained_shortfall':
      return 'shortfall';
    case 'unexplained_excess':
      return 'excess';
    default:
      return 'not_applicable';
  }
}

/* -------------------------------------------------------------------------- */
/* Which categories are scoped by a date range                                */
/* -------------------------------------------------------------------------- */

/**
 * The Exception_Categories whose identity includes the reconciliation date range,
 * and therefore the only ones for which the fingerprint carries a scope segment.
 *
 * **design.md names this list**; it is not a choice made here. Its "Exception
 * fingerprint and upsert" section states: *"Scope is included in the fingerprint
 * only for the categories the requirements scope by reconciliation date range,
 * which is the Marketplace_Agent's `seller_settlement_mismatch` and
 * `over_allocated_split` (Requirement 7.10). Reconciliation and Compliance
 * categories key on category plus Source_Record set alone."* The per-category
 * reasoning below is written out the way `DEFAULT_CHART_OF_ACCOUNTS` writes out its
 * account kinds, because a category added to or removed from this list changes the
 * identity of every Exception in it — a silent duplicate-or-merge, discovered
 * months later as a wrong Attention_Panel count.
 *
 * **Range-scoped** (scope hashed):
 *
 * - `seller_settlement_mismatch` — **yes.** Requirement 7.3 computes the expected
 *   Seller payout *for a reconciliation date range*, and Requirement 7.10 makes
 *   the identity explicitly "the same Exception_Category for the same
 *   reconciliation date range" for a Linked_Account. The same Linked_Account is
 *   short in July and short again in August: two conditions, two Exceptions. Refs
 *   alone cannot tell them apart, because the Linked_Account ref is the same
 *   string in both.
 * - `over_allocated_split` — **yes.** Requirement 7.7 keys on a Payment, and
 *   Requirement 7.10 scopes it by the same date range as the category above. A
 *   Payment belongs to exactly one range in practice, so the scope segment is
 *   usually redundant here — but 7.10 covers "a Linked_Account **or a Payment**"
 *   in one sentence, and splitting the two would make the Marketplace_Agent's two
 *   categories behave differently for no stated reason.
 *
 * **Not range-scoped** (scope segment empty), and why the refs alone are the
 * identity:
 *
 * - `settlement_mismatch` — the Settlement and its Settlement_Recon_Report
 *   (Requirement 4.5). A Settlement occurs once; re-running over a wider window
 *   must find the *same* Exception, which is precisely what a hashed scope would
 *   prevent.
 * - `possible_duplicate_refund` — the Payment and each contributing Refund
 *   (Requirement 4.8). The over-refunded set of records *is* the condition.
 * - `unmatched_credit_note` — the Credit_Note and its linked Invoice where one
 *   exists (Requirement 4.9).
 * - `missing_accrual` — the Payment or Refund with no Ledger_Entry (Requirement
 *   4.10). Tempting to call this period-level, and it is not: the requirement
 *   names *that* Payment or Refund identifier, one record per Exception. A hashed
 *   scope would open a second Exception for the same missing accrual as soon as
 *   the trailing-90-day window moved (Requirement 4.7), which is a duplicate by
 *   construction.
 * - `ambiguous_match` — the Payment and every candidate record (Requirement 4.14).
 * - `gst_anomaly`, `missing_gst_information`, `invalid_gstin` — each keys on the
 *   Invoice, Payment or GSTIN-bearing record it was found on.
 * - `itc_discrepancy` — the other tempting one. An ITC discrepancy is discovered
 *   by comparing a period's input credit against a return, so it reads as
 *   period-level. design.md nonetheless keys the Compliance categories on refs
 *   alone, and that is the right reading: the Exception cites the records that
 *   disagree, and citing them is what makes the discrepancy explainable. The
 *   filing period, where it matters, belongs in `detail`, which is outside the
 *   identity and free to change.
 * - `record_needing_review` — the record under review (the TDS path).
 * - `verification_failure` — the Proposal and its target Source_Records
 *   (Requirement 5.12). A Proposal is verified once.
 * - `execution_failure` — likewise the Proposal.
 *
 * A category absent from both halves of that list is a bug in this comment. Task
 * 11.5 owns `exception-fingerprint.test.ts`, where every one of the 14 labels is
 * asserted to be accounted for; until it lands, this comment is the only record
 * that the two halves are exhaustive.
 */
export const RANGE_SCOPED_CATEGORIES = [
  'seller_settlement_mismatch',
  'over_allocated_split',
] as const;

export type RangeScopedCategory = (typeof RANGE_SCOPED_CATEGORIES)[number];

/** Whether `category`'s identity includes the reconciliation date range. */
export function isRangeScopedCategory(category: ExceptionCategory): category is RangeScopedCategory {
  return (RANGE_SCOPED_CATEGORIES as readonly string[]).includes(category);
}

/**
 * The reconciliation date range a range-scoped Exception belongs to. Two `DateOnly`
 * ends, both inclusive, both real calendar dates.
 */
export interface ExceptionScope {
  readonly from: DateOnly;
  readonly to: DateOnly;
}

/** Thrown when an Exception's identity or its row cannot be formed as stated. */
export class ExceptionFingerprintError extends Error {
  override readonly name = 'ExceptionFingerprintError';
}

/* -------------------------------------------------------------------------- */
/* Canonicalisation                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The characters an identifier may not contain, because the fingerprint encoding
 * uses them: `|` between segments, `,` between refs, `:` inside a ref. NUL and
 * every other control character are rejected with them — a Postgres text value
 * cannot hold a NUL anyway, and a control character in an identifier is malformed
 * data whatever the encoding. See the module doc comment on injection.
 */
// `no-control-regex` guards against a control character reaching a pattern by
// accident. Here the control range IS the thing being matched, and matching it is
// what rejects the identifier — so the rule is disabled for this one line rather
// than the class being narrowed to the characters ESLint finds unsurprising.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_IDENTIFIER = /[|,:\u0000-\u001f\u007f]/;

/**
 * A `source_record_type` enum label, or a rejection naming the field. The type is
 * never quoted back beyond the value being rejected.
 */
function assertRefType(type: SourceRecordType, what: string): SourceRecordType {
  if (!(SOURCE_RECORD_TYPES as readonly string[]).includes(type)) {
    throw new ExceptionFingerprintError(
      `${what} is not a source_record_type label: ${JSON.stringify(type)}`,
    );
  }
  return type;
}

/**
 * A Source_Record identifier that can be encoded unambiguously: non-empty, no
 * leading or trailing whitespace, and none of {@link FORBIDDEN_IN_IDENTIFIER}.
 *
 * This is the injection barrier. Rejecting is the whole point — see the module doc
 * comment for why the encoding is not changed instead.
 */
export function assertRefIdentifier(id: string, what: string): string {
  if (typeof id !== 'string' || id.length === 0) {
    throw new ExceptionFingerprintError(
      `${what} must be a non-empty Source_Record identifier, got ${JSON.stringify(id)}`,
    );
  }
  if (id.trim() !== id) {
    throw new ExceptionFingerprintError(
      `${what} carries leading or trailing whitespace, which would make two identifiers that ` +
        `differ only in padding hash differently: ${JSON.stringify(id)}`,
    );
  }
  if (FORBIDDEN_IN_IDENTIFIER.test(id)) {
    throw new ExceptionFingerprintError(
      `${what} contains a fingerprint separator or a control character, so two different ` +
        `Source_Record sets could hash identically: ${JSON.stringify(id)}. The fingerprint ` +
        `encoding is fixed by design.md, so such an identifier is rejected rather than escaped`,
    );
  }
  return id;
}

/** `type:id`, the encoding of one ref inside the hashed string. */
function refSegment(ref: SourceRef): string {
  return `${ref.type}:${ref.id}`;
}

/**
 * The refs as an identity: validated, deduplicated, and sorted on **type then id**
 * in ascending character order.
 *
 * Deduplication is what makes the fingerprint a function of the **set** rather than
 * of the list. Requirement 4.15 says "the same set of Source_Record identifiers",
 * and `exception_source_records`' composite primary key admits one row per
 * `(exception, type, id)` — so a caller that cites one record twice has described
 * one link, not two, and the repeat is collapsed rather than rejected. The same
 * stance as `collectCitations` in `src/evidence/chain-builder.ts`.
 *
 * @throws {ExceptionFingerprintError} for an unknown type, or an identifier that
 * cannot be encoded unambiguously.
 */
export function canonicalSourceRefs(
  refs: readonly SourceRef[],
  what = 'source_refs',
): readonly SourceRef[] {
  const byKey = new Map<string, SourceRef>();
  for (const [position, ref] of refs.entries()) {
    const where = `${what}[${position}]`;
    assertRefType(ref.type, `${where}.type`);
    assertRefIdentifier(ref.id, `${where}.id`);
    const key = refSegment(ref);
    if (!byKey.has(key)) {
      byKey.set(key, { type: ref.type, id: ref.id });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

/** The `refs` segment: canonical refs as `type:id`, joined with `,`. */
export function sourceRefsSegment(refs: readonly SourceRef[], what = 'source_refs'): string {
  return canonicalSourceRefs(refs, what).map(refSegment).join(',');
}

/**
 * The `scope` segment: `from..to` for a range-scoped category, `''` otherwise.
 *
 * design.md fixes the `..` form. Both ends are held to a real calendar date by
 * `assertDateOnly`, so `2026-02-30..2026-03-01` is rejected rather than hashed as a
 * distinct identity, and `from <= to` is required — **this module's decision**,
 * because an inverted range describes the same period as its reverse and hashing
 * the two differently would open two Exceptions for one condition.
 *
 * Equal ranges give one string, so one fingerprint; a one-day shift at either end
 * gives a different string, so a different fingerprint. Both belong to task 11.5's
 * fingerprint unit tests, not to the upsert tests beside this module.
 *
 * @throws {ExceptionFingerprintError} when a range-scoped category has no scope,
 * when a non-range-scoped category has one, or when the range is malformed.
 */
export function exceptionScopeSegment(
  category: ExceptionCategory,
  scope: ExceptionScope | undefined,
): string {
  if (isRangeScopedCategory(category)) {
    if (scope === undefined) {
      throw new ExceptionFingerprintError(
        `${category} is identified by its reconciliation date range as well as its ` +
          `Source_Records (Requirement 7.10), so scope is required; without it two ranges ` +
          `would collapse onto one Exception`,
      );
    }
    assertScopeDates(scope);
    return `${scope.from}..${scope.to}`;
  }
  if (scope !== undefined) {
    // Ignoring it would let a caller believe it had scoped an identity when it had
    // not — the same objection tool.ts makes to a tenant override in a payload.
    throw new ExceptionFingerprintError(
      `${category} is identified by its Source_Record set alone (Requirement 4.15), so a scope ` +
        `is not part of its identity and is rejected rather than ignored; the date range belongs ` +
        `in detail, which is outside the fingerprint. Range-scoped categories are ` +
        `${RANGE_SCOPED_CATEGORIES.join(', ')}`,
    );
  }
  return '';
}

function assertScopeDates(scope: ExceptionScope): void {
  assertDateOnly(scope.from, 'scope.from');
  assertDateOnly(scope.to, 'scope.to');
  // Fixed-width `YYYY-MM-DD` compares lexicographically as it does chronologically.
  if (scope.from > scope.to) {
    throw new ExceptionFingerprintError(
      `scope.from ${scope.from} is after scope.to ${scope.to}; an inverted range describes the ` +
        `same period as its reverse, and hashing the two differently would open two Exceptions ` +
        `for one condition`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The fingerprint                                                            */
/* -------------------------------------------------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, what: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ExceptionFingerprintError(`${what} must be a UUID, got ${JSON.stringify(value)}`);
  }
  return value;
}

function assertCategory(category: ExceptionCategory): ExceptionCategory {
  if (!(EXCEPTION_CATEGORIES as readonly string[]).includes(category)) {
    throw new ExceptionFingerprintError(
      `category is not an exception_category label: ${JSON.stringify(category)}`,
    );
  }
  return category;
}

/** design.md's `exceptionFingerprint` input, field for field. */
export interface ExceptionFingerprintInput {
  readonly tenant_id: TenantId;
  readonly category: ExceptionCategory;
  /** At least 1 (Requirement 4.12). Order is irrelevant: it is canonicalised. */
  readonly source_refs: readonly SourceRef[];
  /** Required for a {@link RANGE_SCOPED_CATEGORIES} category, rejected for any other. */
  readonly scope?: ExceptionScope;
}

/**
 * The deterministic identity of an Exception: 64 lowercase hex characters.
 *
 * Pure — no clock, no database, no context — and a function of the Tenant, the
 * category, the **set** of Source_Record refs, and the date range for the two
 * range-scoped categories. Nothing else. `impact_paise`, `detail`,
 * `evidence_chain_id`, `lifecycle_state`, the run identifier and every timestamp
 * are outside it (Requirement 4.15).
 *
 * @throws {ExceptionFingerprintError} for a non-UUID Tenant, an unknown category,
 * an empty ref set, an unencodable identifier, or a scope that disagrees with the
 * category.
 */
export function exceptionFingerprint(input: ExceptionFingerprintInput): string {
  const tenantId = assertUuid(input.tenant_id, 'tenant_id');
  const category = assertCategory(input.category);
  if (input.source_refs.length === 0) {
    // Requirement 4.12, and the identity would otherwise be the category alone.
    throw new ExceptionFingerprintError(
      `an Exception references at least 1 Source_Record (Requirement 4.12); with none, every ` +
        `${category} for this Tenant would share one fingerprint and collapse onto one row`,
    );
  }
  const refs = sourceRefsSegment(input.source_refs);
  const scope = exceptionScopeSegment(category, input.scope);

  // Never logged, never put in an error message: this is Tenant data.
  return createHash('sha256')
    .update(`${tenantId}|${category}|${refs}|${scope}`, 'utf8')
    .digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Persistence: constraint names                                              */
/* -------------------------------------------------------------------------- */

/**
 * `UNIQUE (tenant_id, fingerprint)` on `exceptions`.
 *
 * This is the database half of Requirement 4.15: it is what makes a re-run an
 * **UPDATE** rather than a second Exception for one condition. Named here so every
 * store adapter and every test writes `ON CONFLICT ON CONSTRAINT
 * exceptions_fingerprint_uniq DO UPDATE` against one string, exactly as
 * `LEDGER_SET_DERIVATION_UNIQ` is used in `src/ledger/semantic-ledger.ts` and
 * `SETTLEMENT_RECON_UNIQ` in `./reconciliation/reconcile-settlement.ts`.
 *
 * design.md's SQL block writes the conflict target as the column list
 * `ON CONFLICT (tenant_id, fingerprint)`. {@link EXCEPTION_UPSERT_SQL} names the
 * constraint instead. The two resolve to the same unique index — the constraint
 * *is* `UNIQUE (tenant_id, fingerprint)`, and `test/db/exception-upsert.test.ts`
 * asserts that definition against `pg_constraint` so the two forms cannot drift —
 * and naming it is the house pattern, for the reason above: a column list restated
 * in every adapter is a column list that can be restated wrongly, and a rename in
 * the schema then fails silently by matching a different index rather than loudly.
 */
export const EXCEPTIONS_FINGERPRINT_UNIQ = 'exceptions_fingerprint_uniq';

/** `PRIMARY KEY (exception_id, source_record_type, source_record_id)`. */
export const EXCEPTION_SOURCE_RECORDS_PKEY = 'exception_source_records_pkey';

/**
 * `(lifecycle_state = 'open') = (resolved_at IS NULL)` — the lifecycle
 * biconditional of Requirement 4.12.
 *
 * The generated name, not a chosen one: the CHECK is unnamed in design.md and in
 * `20260101000005_exceptions.sql`, so Postgres derived `exceptions_check` from the
 * table name. See gap 1 in the module doc comment — the suffix depends on
 * **declaration order**, which is why the db suite audits both names against
 * `pg_constraint` rather than trusting them.
 */
export const EXCEPTION_LIFECYCLE_RESOLVED_CHECK = 'exceptions_check';

/**
 * `last_detected_at >= first_detected_at` — the second generated name, and the
 * reason {@link EXCEPTION_UPSERT_SQL} spends **one** parameter on both detection
 * columns.
 *
 * Two separate `now()` reads, or two parameters a caller fills independently, could
 * differ by a millisecond in the wrong direction and be rejected here. `$8, $8` on
 * insert makes `first_detected_at = last_detected_at` exactly, and the `DO UPDATE`
 * only ever advances `last_detected_at`, so the only way to reach this CHECK
 * through this module is a second run stamped *earlier* than the first — a clock
 * that moved backwards, which is reported rather than absorbed.
 */
export const EXCEPTION_DETECTION_ORDER_CHECK = 'exceptions_check1';

/** `impact_paise >= 0`: the impact is a **magnitude**, and the sign lives in `direction`. */
export const EXCEPTION_IMPACT_RANGE_CHECK = 'exceptions_impact_paise_check';

/** `direction IN ('shortfall', 'excess', 'not_applicable')` — {@link EXCEPTION_DIRECTIONS}. */
export const EXCEPTION_DIRECTION_CHECK = 'exceptions_direction_check';

/**
 * Every CHECK on `exceptions`, in declaration order.
 *
 * A store must match a rejection **by constraint name** and never on bare SQLSTATE
 * `23514`: all four raise the same class, and reading any of them as "the lifecycle
 * disagrees" would report an out-of-range impact as a lifecycle fault. The db suite
 * asserts each name against `pg_constraint` **with its definition**, so reordering
 * the two unnamed CHECKs — which would swap `exceptions_check` and
 * `exceptions_check1` — fails loudly instead of silently reinterpreting a rejection.
 */
export const EXCEPTION_CHECKS = [
  EXCEPTION_LIFECYCLE_RESOLVED_CHECK,
  EXCEPTION_DETECTION_ORDER_CHECK,
  EXCEPTION_IMPACT_RANGE_CHECK,
  EXCEPTION_DIRECTION_CHECK,
] as const;

export type ExceptionCheck = (typeof EXCEPTION_CHECKS)[number];

/* -------------------------------------------------------------------------- */
/* Persistence: the three statements an adapter runs                          */
/* -------------------------------------------------------------------------- */

/**
 * design.md's Exception upsert, transcribed: the longer of the two forms it states.
 *
 * Parameters are {@link ExceptionUpsertParams}, in that order. Two things about it
 * are load-bearing and neither is decoration:
 *
 * - **`$8` appears twice.** One detection timestamp fills both `first_detected_at`
 *   and `last_detected_at`, so a first insert cannot violate
 *   {@link EXCEPTION_DETECTION_ORDER_CHECK} and the two columns are exactly equal
 *   until a second run advances one of them.
 * - **`first_detected_at` is absent from `DO UPDATE SET`.** It is written once, on
 *   the insert, and never again. Property P5 asserts every `first_detected_at`
 *   unchanged and every `last_detected_at` advanced across two runs, and adding one
 *   line here would fail the half nobody looks at.
 *
 * `WHERE exceptions.lifecycle_state = 'open'` is Requirement 4.15's scope. When the
 * conflicting row is `resolved` or `dismissed` the `UPDATE` touches nothing and this
 * statement returns **zero rows** — which is why {@link EXCEPTION_STATE_PROBE_SQL}
 * exists and why the caller is handed {@link ExceptionNotReopened} rather than a
 * silent success.
 *
 * `(xmax = 0) AS created` is added to design.md's bare `RETURNING id`, because
 * design.md's version cannot tell a first detection from a re-detection and an
 * outcome the caller cannot observe is not an outcome (gap 6 in the module doc).
 * `xmax` is `0` on a freshly inserted tuple and non-zero on one this statement
 * updated.
 */
export const EXCEPTION_UPSERT_SQL = `
INSERT INTO exceptions (tenant_id, category, lifecycle_state, impact_paise, direction,
                        detail, evidence_chain_id, fingerprint,
                        first_detected_at, last_detected_at)
VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $8)
ON CONFLICT ON CONSTRAINT ${EXCEPTIONS_FINGERPRINT_UNIQ} DO UPDATE
   SET impact_paise      = EXCLUDED.impact_paise,
       direction         = EXCLUDED.direction,
       detail            = EXCLUDED.detail,
       evidence_chain_id = EXCLUDED.evidence_chain_id,
       last_detected_at  = EXCLUDED.last_detected_at
 WHERE exceptions.lifecycle_state = 'open'
RETURNING id, (xmax = 0) AS created`.trim();

/**
 * Why {@link EXCEPTION_UPSERT_SQL} returned nothing: `($1 tenant, $2 fingerprint)`
 * to the Exception that already exists and its lifecycle state.
 *
 * Run in the **same transaction** as the upsert, so the answer is the row the
 * upsert declined to touch and not a later state. A zero-row upsert has exactly one
 * other explanation — the row does not exist — and that is unreachable, because
 * {@link EXCEPTIONS_FINGERPRINT_UNIQ} is the only thing that can suppress the
 * insert. A probe that finds nothing is therefore a fault, not a `not_reopened`.
 */
export const EXCEPTION_STATE_PROBE_SQL = `
SELECT id, lifecycle_state
  FROM exceptions
 WHERE tenant_id = $1
   AND fingerprint = $2`.trim();

/**
 * One Exception → Source_Record link. Parameters:
 * `($1 exception_id, $2 tenant_id, $3 source_record_type, $4 source_record_id, $5 role)`.
 *
 * Requirement 4.12's "at least 1 Source_Record" is written through this statement,
 * once per {@link ExceptionWrite.links} entry, in the same transaction as the
 * upsert — the parent and its links are one write or neither, since the "at least
 * 1" half is not a table constraint (migration FINDING 1).
 *
 * `DO UPDATE SET role` rather than `DO NOTHING`: the composite primary key already
 * makes a re-link one row rather than two, so neither form multiplies, and a re-run
 * that classifies the same record differently should correct the label instead of
 * leaving a stale one. Nothing else on the row can change — the key is the whole row
 * minus the role.
 *
 * Requirement 7.10 requires a same-range Marketplace re-run to replace the linked
 * Source_Record identifiers as well as the impact. {@link EXCEPTION_SOURCE_RECORD_CLEAR_SQL}
 * removes the prior link set after a successful open-row upsert, and this statement
 * rebuilds the current canonical set in the same transaction. A closed-row upsert
 * returns no row, so the clear and link statements are not run and resolved evidence
 * remains untouched.
 */
export const EXCEPTION_SOURCE_RECORD_CLEAR_SQL = `
DELETE FROM exception_source_records
 WHERE exception_id = $1
   AND tenant_id = $2`.trim();

/** Insert one member of the current, already-cleared Source_Record link set. */
export const EXCEPTION_SOURCE_RECORD_LINK_SQL = `
INSERT INTO exception_source_records (exception_id, tenant_id, source_record_type,
                                      source_record_id, role)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT ON CONSTRAINT ${EXCEPTION_SOURCE_RECORDS_PKEY} DO UPDATE
   SET role = EXCLUDED.role`.trim();

/* -------------------------------------------------------------------------- */
/* Persistence: shapes                                                        */
/* -------------------------------------------------------------------------- */

/** One Source_Record cited by an Exception, with the label it is cited under. */
export interface ExceptionSourceRef extends SourceRef {
  /**
   * `exception_source_records.role`, e.g. `'settlement'`,
   * `'contributing_refund'`. Defaults to `'identifying'` for a
   * {@link ExceptionUpsertInput.source_refs} entry and `'contributing'` for a
   * {@link ExceptionUpsertInput.context_refs} one, so the two are distinguishable on
   * the row without a second column. Outside the fingerprint either way: a
   * relabelled link is the same link.
   */
  readonly role?: string;
}

/** A JSON value `detail` may hold. `bigint` is deliberately not one — see below. */
export type ExceptionDetailValue =
  | string
  | number
  | boolean
  | null
  | readonly ExceptionDetailValue[]
  | { readonly [key: string]: ExceptionDetailValue };

/**
 * `exceptions.detail`: design.md's "named fields, failing rule, counts".
 *
 * Outside the fingerprint, so a re-run is free to rewrite it entirely (Requirement
 * 4.15). **Money in here is an integer string from `toWire`, never a `number`** —
 * JSONB would accept `66100.0` as an IEEE-754 double and nothing downstream could
 * recover the paisa (Requirement 15.1, 15.8). {@link assertExceptionUpsertable}
 * rejects a money-named key holding a number, which is the only barrier: the column
 * is plain `JSONB` and the ESLint money rule cannot see inside a JSON value.
 */
export type ExceptionDetail = { readonly [key: string]: ExceptionDetailValue };

/**
 * One detected condition, ready to be upserted.
 *
 * The **identity** is `category`, `source_refs` and, for a range-scoped category,
 * `scope`. Everything else is a value a re-run may change.
 *
 * `impact_paise` is the **absolute** impact: `exceptions.impact_paise` is CHECKed
 * `>= 0` and the sign lives in `direction`, exactly as `side` carries it for a
 * Ledger_Entry. A caller holding a signed residual passes
 * `residualImpactPaise(recon)` from `./reconciliation/reconcile-settlement.ts` and
 * `exceptionDirectionFor(recon.direction)` — a negative value here is **rejected**,
 * not silently made positive, because a caller that hands over a signed residual has
 * misread the column and coercing it would hide that in every future run.
 */
export interface ExceptionUpsertInput {
  readonly category: ExceptionCategory;
  /**
   * The Source_Records that **identify** the condition. At least 1 (Requirement
   * 4.12), hashed into the fingerprint, order irrelevant.
   */
  readonly source_refs: readonly ExceptionSourceRef[];
  /**
   * Records that contribute to the impact but do **not** identify the Exception:
   * linked, never hashed. Admissible only for a {@link RANGE_SCOPED_CATEGORIES}
   * category, which is what makes Requirement 7.10's "update the impact and the
   * Source_Record identifiers of the existing open Exception" reachable at all — see
   * gap 4 in the module doc comment.
   */
  readonly context_refs?: readonly ExceptionSourceRef[];
  /** Required for a range-scoped category, rejected for any other. */
  readonly scope?: ExceptionScope;
  /** `|impact|` in integer paise. `>= 0n`. */
  readonly impact_paise: Paise;
  readonly direction: ExceptionDirection;
  readonly detail: ExceptionDetail;
  /** The chain grounding the impact, composed by the tool that produced the figure. */
  readonly evidence_chain_id: string | null;
  /**
   * The **run** timestamp, ISO-8601 UTC to millisecond precision. An input, not
   * `now()`: Requirement 4.15 names the run timestamp as the last-detected
   * timestamp, a run writing many Exceptions stamps them all identically, and P5
   * needs to choose two distinct instants.
   */
  readonly detected_at: string;
}

/** One row of `exception_source_records`, with the role resolved. */
export interface ExceptionSourceRecordLink {
  readonly source_record_type: SourceRecordType;
  readonly source_record_id: string;
  readonly role: string;
}

/**
 * One `exceptions` row and its links, validated.
 *
 * `impact_paise` is the integer string `toWire` produced, which range-checked it
 * (Requirement 15.1, 15.8) — never a `number`, and never a `bigint` handed to
 * `JSON.stringify`. `detail` is already JSON **text**, serialised once here, so the
 * adapter has nothing left to decide about it.
 */
export interface ExceptionWrite {
  readonly tenant_id: TenantId;
  readonly category: ExceptionCategory;
  readonly impact_paise: PaiseWire;
  readonly direction: ExceptionDirection;
  /** JSON text for the `JSONB` column. */
  readonly detail: string;
  readonly evidence_chain_id: string | null;
  readonly fingerprint: string;
  /** ISO-8601 UTC, ms. Fills **both** detection columns on insert. */
  readonly detected_at: string;
  /** At least 1 (Requirement 4.12), sorted on type then id, one per record. */
  readonly links: readonly ExceptionSourceRecordLink[];
}

/**
 * The eight parameters of {@link EXCEPTION_UPSERT_SQL}, in order.
 *
 * `$8` is bound once and referenced twice by the statement. A tuple rather than the
 * row object so an adapter cannot reorder them by accident, and so
 * `test/db/exception-upsert.test.ts` binds the same values in the same order the
 * adapter will.
 */
export type ExceptionUpsertParams = readonly [
  tenantId: TenantId,
  category: ExceptionCategory,
  impactPaise: PaiseWire,
  direction: ExceptionDirection,
  detail: string,
  evidenceChainId: string | null,
  fingerprint: string,
  detectedAt: string,
];

/** {@link EXCEPTION_UPSERT_SQL}'s parameters, from a validated row. */
export function exceptionUpsertParams(write: ExceptionWrite): ExceptionUpsertParams {
  return [
    write.tenant_id,
    write.category,
    write.impact_paise,
    write.direction,
    write.detail,
    write.evidence_chain_id,
    write.fingerprint,
    write.detected_at,
  ];
}

/**
 * The re-detection of an Exception a User already closed: reported, never applied.
 *
 * `WHERE exceptions.lifecycle_state = 'open'` declined the update, so no field of
 * the existing row moved — not the impact, not `last_detected_at` — and no second
 * row was written. "Not reopened" and "silently discarded" are different things, and
 * this value is what makes it the first: task 13.2 counts it in its run report, so a
 * User asking why a condition is absent from the Attention_Panel has an answer.
 */
export interface ExceptionNotReopened {
  readonly ok: false;
  readonly kind: 'not_reopened';
  /** The Exception that already exists and was left alone. */
  readonly exception_id: string;
  readonly lifecycle_state: Exclude<ExceptionState, 'open'>;
  /** The identity that resolved to it. */
  readonly fingerprint: string;
}

/**
 * What a store reports back.
 *
 * `created` separates a first detection from a re-detection without counting rows.
 * Both are successes; {@link EXCEPTIONS_FINGERPRINT_UNIQ} is what keeps the second
 * one to a single row.
 *
 * A CHECK rejection arrives as a **value** so it funnels into one place, matching
 * `LedgerWriteOutcome` and `SettlementReconWriteOutcome`. It is unreachable through
 * {@link ExceptionUpserter.upsert}, which validates the whole row before any
 * statement is issued; reaching it means the store built a row the input did not
 * describe. Anything else — a connection fault, an absent Tenant, a `paise` domain
 * violation — is a failure and the store throws.
 */
export type ExceptionWriteOutcome =
  | {
      readonly ok: true;
      readonly exception_id: string;
      /** `false` when a previous run's Exception was updated (Requirement 4.15). */
      readonly created: boolean;
    }
  | ExceptionNotReopened
  | {
      readonly ok: false;
      readonly kind: 'malformed_row';
      readonly constraint: ExceptionCheck;
    };

/**
 * Persistence for Exceptions. Injected rather than imported, so the identity and the
 * row mapping are unit-testable with no database, and the transaction boundary is the
 * adapter's concern.
 *
 * **No adapter is written here**, for the reason given in the module doc comment:
 * `exceptions` is RLS `ENABLE`d and `FORCE`d with no policies until task 26.1, so
 * PostgREST matches zero rows for every role without `BYPASSRLS`, and `npm install`
 * cannot currently add a Postgres driver. `test/db/exception-upsert.test.ts` runs
 * {@link EXCEPTION_UPSERT_SQL}, {@link EXCEPTION_STATE_PROBE_SQL},
 * {@link EXCEPTION_SOURCE_RECORD_CLEAR_SQL}, and
 * {@link EXCEPTION_SOURCE_RECORD_LINK_SQL} — the exact strings, bound to the exact
 * parameters — over a real SQL session, which is where the upsert-not-duplicate
 * guarantee is actually proven.
 */
export interface ExceptionStore {
  /**
   * Upsert one Exception and its links, **in one transaction**:
   *
   * 1. {@link EXCEPTION_UPSERT_SQL} with {@link exceptionUpsertParams}.
   * 2. If it returned a row: {@link EXCEPTION_SOURCE_RECORD_CLEAR_SQL}, then
   *    {@link EXCEPTION_SOURCE_RECORD_LINK_SQL} once per {@link ExceptionWrite.links}
   *    entry, then `{ ok: true, ... }`. All statements share one transaction, so the
   *    current non-empty link set replaces the prior set atomically (Requirement 7.10).
   * 3. If it returned **no** row: {@link EXCEPTION_STATE_PROBE_SQL} in the same
   *    transaction, and {@link ExceptionNotReopened}. **No link is written** — the
   *    Exception is closed and its evidence is not the current run's to amend.
   *
   * A CHECK violation naming one of {@link EXCEPTION_CHECKS}, and only those names,
   * is reported as `{ ok: false, kind: 'malformed_row' }`. Any other error throws.
   */
  upsertException(write: ExceptionWrite): Promise<ExceptionWriteOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Persistence: validation and mapping                                        */
/* -------------------------------------------------------------------------- */

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Key names in `detail` that read as money, so a `number` under one of them is a
 * float where an integer-paise string belongs. The same list the ESLint money rule
 * matches identifier names against — the rule cannot see inside a JSON value, so it
 * is restated here for the one place JSON is built.
 */
const MONEY_KEY = /paise|amount|impact|balance|cash|fee|gst|shortfall|headroom/i;

/** JSON nests, but not without bound: a cycle or a runaway structure is rejected. */
const MAX_DETAIL_DEPTH = 8;

function assertIsoUtcMs(value: string, what: string): string {
  if (typeof value !== 'string' || !ISO_UTC_MS.test(value)) {
    throw new ExceptionFingerprintError(
      `${what} must be ISO-8601 UTC to millisecond precision ` +
        `(YYYY-MM-DDTHH:MM:SS.sssZ), got ${JSON.stringify(value)}`,
    );
  }
  if (Number.isNaN(Date.parse(value))) {
    throw new ExceptionFingerprintError(`${what} is not a real instant: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertRole(role: string, what: string): string {
  if (typeof role !== 'string' || role.trim().length === 0) {
    throw new ExceptionFingerprintError(
      `${what} must be a non-empty label when stated, got ${JSON.stringify(role)}`,
    );
  }
  return role;
}

/**
 * `detail` as JSON text, or a rejection naming the path.
 *
 * Four rejections, each for something JSONB would otherwise accept or
 * `JSON.stringify` would otherwise do quietly:
 *
 * - a **`bigint`** — `JSON.stringify` throws on one, and the throw would surface from
 *   the adapter rather than from the caller's own field. Money in `detail` is
 *   `toWire(value)`.
 * - a **money-named key holding a `number`** — the whole point of `Paise = bigint`
 *   (Requirement 15.1, 15.8). `{ impact_paise: 66100 }` is a double, and JSONB keeps
 *   it as one.
 * - a **non-finite number**, which `JSON.stringify` turns into `null` — a figure
 *   silently becoming absent.
 * - **`undefined`, a function or a symbol**, which `JSON.stringify` **drops**: the
 *   caller would believe it had recorded a field that is not in the row.
 */
export function exceptionDetailJson(detail: ExceptionDetail, what = 'detail'): string {
  const walk = (value: unknown, path: string, depth: number, moneyKey: boolean): void => {
    if (depth > MAX_DETAIL_DEPTH) {
      throw new ExceptionFingerprintError(
        `${path} nests deeper than ${MAX_DETAIL_DEPTH} levels; detail carries named fields, a ` +
          `failing rule and counts, not a record graph`,
      );
    }
    if (typeof value === 'bigint') {
      throw new ExceptionFingerprintError(
        `${path} is a bigint, which JSON cannot carry. A monetary value in detail is the ` +
          `integer string toWire produces (Requirement 15.1, 15.8)`,
      );
    }
    if (typeof value === 'number') {
      if (moneyKey) {
        throw new ExceptionFingerprintError(
          `${path} reads as a monetary field and holds the number ${value}; money is integer ` +
            `paise carried as the string toWire produces, never an IEEE-754 double ` +
            `(Requirement 15.1, 15.8)`,
        );
      }
      if (!Number.isFinite(value)) {
        throw new ExceptionFingerprintError(
          `${path} is ${String(value)}, which JSON.stringify would write as null — a figure ` +
            `that silently became absent`,
        );
      }
      return;
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return;
    }
    if (Array.isArray(value)) {
      // An array element inherits the key it sits under: `impacts_paise: [66100]`.
      value.forEach((element, index) => walk(element, `${path}[${index}]`, depth + 1, moneyKey));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        walk(nested, `${path}.${key}`, depth + 1, MONEY_KEY.test(key));
      }
      return;
    }
    throw new ExceptionFingerprintError(
      `${path} is ${typeof value}, which JSON.stringify drops silently; detail would be ` +
        `written without it and the caller would never know`,
    );
  };

  walk(detail, what, 0, false);
  return JSON.stringify(detail);
}

/**
 * Every invariant an Exception row must satisfy, checked **before any statement is
 * issued**, so a malformed Exception leaves nothing to roll back and the message names
 * the field rather than a constraint.
 *
 * What only this function can enforce:
 *
 * - **At least 1 Source_Record** (Requirement 4.12). Not expressible as a table
 *   constraint — migration FINDING 1 — so this is the barrier on this write path.
 * - **A signed impact is rejected, not coerced.** `impact_paise` is a magnitude;
 *   `EXCEPTION_IMPACT_RANGE_CHECK` would reject a negative too, but only after a
 *   statement, and by then the caller has already been told the wrong thing about
 *   what the column means.
 * - **A zero impact carries no direction.** `EXCEPTION_DIRECTION_CHECK` admits any
 *   of the three labels against any impact, so nothing downstream would notice a
 *   `shortfall` of ₹0. The converse is allowed: a Compliance Exception has a real
 *   impact and no direction (`not_applicable`).
 * - **`context_refs` only for a range-scoped category**, and never overlapping
 *   `source_refs` — a record cannot both identify the Exception and merely contribute
 *   to it, and the two lists would collide on one primary key.
 * - **Money in `detail` is not a float.** See {@link exceptionDetailJson}.
 *
 * @throws {ExceptionFingerprintError} naming the field and the rule.
 */
export function assertExceptionUpsertable(input: ExceptionUpsertInput): void {
  const category = assertCategory(input.category);

  if (input.source_refs.length === 0) {
    throw new ExceptionFingerprintError(
      `an Exception references at least 1 Source_Record (Requirement 4.12), and "at least 1" is ` +
        `not a table constraint (FINDING 1 of 20260101000005), so a ref-less ${category} would ` +
        `persist as an Exception nothing explains`,
    );
  }

  const identity = canonicalSourceRefs(input.source_refs, 'source_refs');
  const context = input.context_refs ?? [];
  if (context.length > 0) {
    if (!isRangeScopedCategory(category)) {
      throw new ExceptionFingerprintError(
        `${category} is identified by its whole Source_Record set (Requirement 4.15), so it has ` +
          `no contributing records outside that set; context_refs is admissible only for ` +
          `${RANGE_SCOPED_CATEGORIES.join(', ')} (Requirement 7.10)`,
      );
    }
    const identityKeys = new Set(identity.map((ref) => `${ref.type}:${ref.id}`));
    for (const ref of canonicalSourceRefs(context, 'context_refs')) {
      if (identityKeys.has(`${ref.type}:${ref.id}`)) {
        throw new ExceptionFingerprintError(
          `${ref.type}:${ref.id} is in both source_refs and context_refs; a record either ` +
            `identifies the Exception or merely contributes to its impact, and the two lists ` +
            `would collide on one exception_source_records primary key`,
        );
      }
    }
  }

  // Rejects a range-scoped category with no scope, and any other category with one.
  exceptionScopeSegment(category, input.scope);

  for (const ref of [...input.source_refs, ...context]) {
    if (ref.role !== undefined) {
      assertRole(ref.role, `role of ${ref.type}:${ref.id}`);
    }
  }

  if (typeof input.impact_paise !== 'bigint') {
    throw new ExceptionFingerprintError(
      `impact_paise must be Paise (bigint), got ${typeof input.impact_paise}; money is integer ` +
        `paise and never a number (Requirement 15.1, 15.8)`,
    );
  }
  if (input.impact_paise < 0n) {
    throw new ExceptionFingerprintError(
      `impact_paise is ${input.impact_paise}, but exceptions.impact_paise is the ABSOLUTE ` +
        `impact and is CHECKed >= 0 (${EXCEPTION_IMPACT_RANGE_CHECK}); the sign belongs in ` +
        `direction. A caller holding a signed residual passes residualImpactPaise(recon) and ` +
        `exceptionDirectionFor(recon.direction) — the value is rejected rather than made ` +
        `positive, because coercing it would hide the misreading in every later run`,
    );
  }

  if (!(EXCEPTION_DIRECTIONS as readonly string[]).includes(input.direction)) {
    throw new ExceptionFingerprintError(
      `direction is not one of ${EXCEPTION_DIRECTIONS.join(', ')}: ` +
        `${JSON.stringify(input.direction)} (${EXCEPTION_DIRECTION_CHECK})`,
    );
  }
  if (input.impact_paise === 0n && input.direction !== 'not_applicable') {
    throw new ExceptionFingerprintError(
      `an impact of 0 paise points nowhere, but direction states ${input.direction}; ` +
        `${EXCEPTION_DIRECTION_CHECK} admits any label against any impact, so nothing ` +
        `downstream would catch this`,
    );
  }

  if (input.evidence_chain_id !== null) {
    // The column carries no foreign key (gap 7), so this is the only check there is.
    assertUuid(input.evidence_chain_id, 'evidence_chain_id');
  }
  assertIsoUtcMs(input.detected_at, 'detected_at');
  exceptionDetailJson(input.detail);
}

/**
 * A validated condition as a row: the fingerprint, the eight parameter values, and the
 * link list.
 *
 * The single place a `Paise` becomes an integer string, through `toWire`, which
 * range-checks it (Requirement 15.1, 15.8), and the single place `detail` becomes JSON
 * text. Links are sorted on type then id — the same canonical order the fingerprint
 * uses — so two runs issue the same statements in the same order and P5's "identical
 * order" holds over the writes as well as over the reads.
 *
 * @throws {ExceptionFingerprintError} for anything {@link assertExceptionUpsertable}
 * rejects.
 */
export function exceptionWriteFor(
  tenantId: TenantId,
  input: ExceptionUpsertInput,
): ExceptionWrite {
  assertExceptionUpsertable(input);

  const roles = new Map<string, string>();
  const record = (refs: readonly ExceptionSourceRef[], fallback: string): void => {
    for (const ref of refs) {
      roles.set(`${ref.type}:${ref.id}`, ref.role ?? fallback);
    }
  };
  // `source_refs` last, so a record cited in both lists keeps its identifying role.
  // `assertExceptionUpsertable` has already rejected that overlap; the order is
  // stated anyway, because a silent dependence on which loop ran last is the kind of
  // thing that survives a refactor and changes a row.
  record(input.context_refs ?? [], 'contributing');
  record(input.source_refs, 'identifying');

  const links = canonicalSourceRefs(
    [...input.source_refs, ...(input.context_refs ?? [])],
    'links',
  ).map((ref) => ({
    source_record_type: ref.type,
    source_record_id: ref.id,
    role: roles.get(`${ref.type}:${ref.id}`) ?? 'identifying',
  }));

  return {
    tenant_id: tenantId,
    category: input.category,
    impact_paise: toWire(input.impact_paise),
    direction: input.direction,
    detail: exceptionDetailJson(input.detail),
    evidence_chain_id: input.evidence_chain_id,
    fingerprint: exceptionFingerprint({
      tenant_id: tenantId,
      category: input.category,
      // Identity is `source_refs` alone. `context_refs` are linked, never hashed.
      source_refs: input.source_refs,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    }),
    detected_at: input.detected_at,
    links,
  };
}

/* -------------------------------------------------------------------------- */
/* The upserter                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What one upsert did. Three outcomes, all of them facts rather than failures:
 * a first detection (`ok`, `created`), a re-detection of an open Exception (`ok`,
 * `created: false`), and a re-detection of one a User closed
 * ({@link ExceptionNotReopened}).
 */
export type ExceptionUpsertResult =
  | {
      readonly ok: true;
      readonly exception_id: string;
      readonly fingerprint: string;
      /** `false` when this run updated an Exception a previous run opened. */
      readonly created: boolean;
    }
  | ExceptionNotReopened;

/**
 * Create and re-detect Exceptions for **one** Tenant.
 *
 * No method takes a `tenant_id`: it is bound once at construction from the session
 * context, so a cross-Tenant Exception is not "denied", it is unrepresentable
 * (Requirement 12.7, 14.10). The Tenant is also what goes into the fingerprint, so
 * binding it here is what makes two Tenants' identical anomalies distinct identities.
 */
export interface ExceptionUpserter {
  /**
   * Requirement 4.15, end to end: compute the identity, then insert or update the one
   * row it names.
   *
   * Validates the whole row first, so a malformed Exception issues **no statement**.
   * A re-detection of a `resolved` or `dismissed` Exception returns
   * {@link ExceptionNotReopened} rather than throwing — it is an expected outcome that
   * the caller has to report, not an error.
   *
   * @throws {ExceptionFingerprintError} for a malformed condition, and for a store
   * that reports a CHECK rejection the validation already excludes.
   * @throws {PaiseRangeError} when `impact_paise` leaves the paise range.
   */
  upsert(input: ExceptionUpsertInput): Promise<ExceptionUpsertResult>;
}

export interface ExceptionUpserterDeps {
  readonly store: ExceptionStore;
  /** The session Tenant. Never an argument to a method (Requirement 12.7). */
  readonly tenantId: TenantId;
}

export function createExceptionUpserter(deps: ExceptionUpserterDeps): ExceptionUpserter {
  const { store } = deps;
  const tenantId = assertUuid(
    deps.tenantId,
    'createExceptionUpserter requires the session Tenant identifier, which',
  );

  return {
    async upsert(input: ExceptionUpsertInput): Promise<ExceptionUpsertResult> {
      const write = exceptionWriteFor(tenantId, input);
      const outcome = await store.upsertException(write);

      if (outcome.ok) {
        return {
          ok: true,
          exception_id: outcome.exception_id,
          fingerprint: write.fingerprint,
          created: outcome.created,
        };
      }
      if (outcome.kind === 'not_reopened') {
        // Requirement 4.15 scopes the update to open Exceptions. Reported, not applied.
        return { ...outcome, fingerprint: write.fingerprint };
      }
      // Unreachable: `exceptionWriteFor` checks every CHECK first. Reaching it means
      // the store wrote a row the input did not describe.
      throw new ExceptionFingerprintError(
        `the store rejected a ${input.category} Exception on ${outcome.constraint}, which the ` +
          `validation funnel already excludes`,
      );
    },
  };
}
