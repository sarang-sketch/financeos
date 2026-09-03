/**
 * The Semantic_Ledger: `postSet` and its atomic imbalance rejection (task 8.3),
 * `postFromSource` and its derivation idempotency, and `trialBalance` (task 8.4).
 *
 * The posting rules of `./posting-rules` derive a draft; this module is what
 * persists one. Everything the two share — {@link LedgerEntrySetDraft},
 * {@link SourceRef}, {@link totalDebitPaise}, {@link imbalancePaise},
 * {@link assertDraftWellFormed} — is imported from there rather than redeclared,
 * per that file's closing note.
 *
 * ## Nothing is attempted for a set that cannot balance
 *
 * Requirement 2.6 wants an unbalanced write rejected in whole, with 0
 * Ledger_Entries persisted. There are three places that could be enforced, and
 * only the first of them is this module's:
 *
 * 1. **Here, before any statement.** `postSet` computes `Σdebit − Σcredit` from
 *    the draft and returns the rejection **without opening a transaction and
 *    without issuing a statement**. Nothing attempted is the strongest form of
 *    "persist 0 Ledger_Entries" available: there is no window in which a row
 *    exists, so there is nothing for a rollback to have to undo, and no
 *    dependence on the rollback working.
 * 2. The `ledger_set_balanced` CHECK on `ledger_entry_sets`, immediate, which
 *    catches declared totals that disagree (SQLSTATE `23514`).
 * 3. The `ledger_entries_balance_check` constraint trigger, `DEFERRABLE
 *    INITIALLY DEFERRED`, which fires at `COMMIT` and catches entry rows that
 *    disagree with each other or with the set's declared totals (SQLSTATE
 *    `23000`).
 *
 * 2 and 3 are proven working against live Postgres by `test/db/ledger-balance.test.ts`
 * (task 4.8) and stay as backstops: a well-formed caller of `postSet` reaches
 * neither, and a caller that somehow does gets the same
 * `{ ok: false, kind: 'unbalanced' }` result, because {@link LedgerStore} reports
 * a barrier rejection as {@link LedgerWriteOutcome} rather than throwing. So
 * there is exactly one rejection funnel and exactly one place the Audit_Event is
 * appended, whichever barrier caught it.
 *
 * ## Structural faults throw; imbalance is reported
 *
 * {@link assertDraftWellFormed} runs first and raises `PostingRuleError` for a
 * draft outside 2..20 entries, an amount that is not `> 0`, an absent
 * Source_Record ref, or an `entry_date` that is not a real calendar date. Those
 * are caller faults — no posting rule produces such a draft — and there is no
 * `PostResult` shape for them. Imbalance is different: Requirement 2.6 requires
 * an error *response* carrying the imbalance and the Source_Record identifiers,
 * so it is a returned value, never a throw. This is why
 * `assertDraftWellFormed` deliberately does not check balance.
 *
 * ## Every Ledger_Entry gets at least 1 Source_Record link
 *
 * `source_refs` is set-level on the draft, and `postSet` links **every entry to
 * every ref**, writing one `ledger_entry_sources` row per (entry, ref) pair. So
 * Requirement 2.2's "at least 1 link per Ledger_Entry" holds by construction
 * from `source_refs` being non-empty, which is checked before any insert. The
 * links travel with the entries in a single {@link LedgerSetWrite}, so a store
 * cannot persist an entry and then fail to link it: the write is one
 * transaction, and an entry with no link is not a state this module can produce.
 *
 * ## Balanced, but with a partial sum outside the paise range
 *
 * {@link totalDebitPaise} and {@link totalCreditPaise} go through `sum`, which
 * range-checks each **running total**. So a draft can balance while one side's
 * partial sum exceeds `PAISE_MAX` — 2 debits and 2 credits of `PAISE_MAX` each,
 * for instance — and `postSet` then raises `PaiseRangeError` instead of
 * returning a rejection report. **That is the intended behaviour, chosen rather
 * than inherited:**
 *
 * - Such a set is not unbalanced, it is unstoreable. `total_debit_paise` is the
 *   `paise` domain (±99999999999999), so the total has no representation in the
 *   schema at all. Reporting it as `{ kind: 'unbalanced', imbalance_paise: 0n }`
 *   would be a false statement about a set that balances exactly.
 * - `imbalance_paise` is itself a `Paise` and must be in range, so there is no
 *   honest value to put in the report.
 * - Requirement 15.1 and 15.8 say an out-of-range monetary value raises rather
 *   than flowing onward, and `PostResult` has no shape for this case. Adding one
 *   would be a design.md change, not a task 8.3 decision.
 *
 * Either way the ledger writes nothing, which is what Requirement 2.6 protects.
 * `postSet` raises before it computes the imbalance, so no statement is issued
 * and no Audit_Event is appended — an out-of-range total is a rejected argument,
 * not a rejected ledger write.
 *
 * ## The `ledger_set_rejected` Audit_Event, and the SQL path that cannot carry it
 *
 * design.md requires the rejection Audit_Event to be appended **on a separate
 * connection so it survives the rollback**. The SQL-side mechanism for that,
 * `app.append_audit_event_autonomous`, is broken: task 4.8 proved at runtime
 * that its `dblink_connect('dbname=' || current_database())` fails with `2F003
 * password or GSSAPI delegated credentials required`, because `postgres` on
 * Supabase local is not a superuser — the same shape as Supabase-hosted, so it
 * is a production defect rather than a local quirk. It is documented with 8
 * `it.fails` markers in `test/db/append-only.test.ts`, and fixing it is task
 * 4.4's, not this task's.
 *
 * So this module does not call it. The append goes through {@link LedgerAuditSink},
 * which is a **separate connection in TypeScript**: the sink holds its own client
 * and its own transaction, entirely outside whatever the {@link LedgerStore} is
 * doing, so it commits independently of a rolled-back posting transaction. Same
 * intent as design.md, no `dblink`. For the application-level rejection there is
 * no transaction to survive in the first place, since nothing was attempted.
 *
 * The append is **not** best-effort. Requirement 2.6 wants both the recording and
 * the error response, so a sink failure propagates rather than returning a
 * rejection with no audit trail.
 *
 * `FinanceOS_Audit_Service` (`src/audit/audit-service.ts`) is **task 25.1** and
 * does not exist yet, so this follows task 5.1's pattern: a narrow injectable
 * sink, one method, exactly the fields a ledger rejection needs. When 25.1 lands
 * the adapter delegates to it and nothing here changes. Note also that
 * `app.append_audit_event` reads an `audit_sequence_counters` row it never
 * creates (FINDING 4 of `20260101000004_audit_log_append_only.sql`), so a Tenant
 * with no counter row cannot record its first Audit_Event; the db fixtures seed
 * it in `provision()` and the production seeding step is still unassigned.
 *
 * ## `postFromSource`: a second derivation is a successful no-op (task 8.4)
 *
 * Requirement 2.8 wants a second derivation from one Source_Record to retain the
 * existing set, create 0 additional Ledger_Entries, and leave every account
 * balance unchanged. That is a **success**, not a failure: the result is
 * `{ ok: true, created: false }` carrying the identifier of the set that was
 * already there. The caller asked for "this Source_Record is posted", and it is.
 *
 * The guarantee is the database's, not a pre-read's.
 * `ledger_set_derivation_uniq` is `UNIQUE (tenant_id, source_record_type,
 * source_record_id)` on `ledger_entry_sets`, so two concurrent derivations cannot
 * both win — one commits and the other is rejected. A "select, then insert if
 * absent" would have a window between the two statements; this has none. Task
 * 4.8 proved the constraint rejects the duplicate at runtime
 * (`test/db/idempotency-constraints.test.ts`).
 *
 * {@link LedgerStore} reports that rejection as a **value**,
 * `{ ok: false, kind: 'duplicate_derivation' }`, exactly as it reports a barrier
 * rejection — see {@link LedgerWriteOutcome}. Two things follow. First, the store
 * must match the violation **by constraint name**
 * ({@link LEDGER_SET_DERIVATION_UNIQ}) and not merely on SQLSTATE `23505`: a
 * different unique violation — `ledger_entries (set_id, line_no)`, say — is a
 * fault and must surface as one, and a rename of the constraint has to break
 * loudly rather than be silently read as idempotency. Second, the no-op writes
 * nothing: the store's whole insert is one transaction, so the rejected statement
 * takes the set row, every entry row and every link row with it. `created: false`
 * and "0 additional Ledger_Entries" are the same fact.
 *
 * No Audit_Event is appended for it. `ledger_set_rejected` means a write was
 * refused; a successful no-op refused nothing.
 *
 * ## `postFromSource` gets its draft from the stored Source_Record
 *
 * design.md's signature is `postFromSource(tenantId, source: SourceRef)` — a type
 * and an identifier, no amounts — while `postingDraftFor` needs amounts and a
 * date. The gap is closed by **reading the stored Source_Record**: `source` is
 * resolved through {@link LedgerStore.findSourceRecord} against
 * `razorpay_objects`, whose `payload` is the verbatim Razorpay object
 * (Requirement 1.2) and whose `amount_paise` / `fee_paise` / `gst_on_fee_paise`
 * are its integer-paise projections (Requirement 1.7). Nothing is inferred and no
 * amount is recomputed: {@link postingSourceFrom} is a projection of the stored
 * row onto `PostingSource`, and the posting rules do the rest. So the amounts a
 * Ledger_Entry carries are the amounts Razorpay returned, which is what
 * Requirement 2.3 means by "read from the stored Payment Source_Record".
 *
 * `entry_date` is the **IST calendar date of `created_at_rzp`**, computed with
 * `formatIstIso` from `src/format/ist.ts` rather than by a timezone cast in SQL.
 * IST is a fixed +05:30 offset with no daylight saving, that module is the one
 * place that fact is written down, and doing it here keeps the projection a pure
 * function a unit test can drive.
 *
 * Payment, Refund, Settlement, Transfer, and Transfer_Reversal are projected
 * here. Any other Source_Record type raises rather than becoming a silent no-op:
 * reporting `created: false` without entries would falsely claim it was posted.
 *
 * ## `trialBalance`: aggregate in SQL, sign the closing balance per account kind
 *
 * Requirement 2.5 wants, for each account holding 1 or more Ledger_Entries dated
 * within an inclusive range, the total debit, the total credit and the closing
 * balance in integer paise, with Σdebit equal to Σcredit across the result.
 *
 * The two totals are summed **in SQL over `BIGINT`** — `ledger_entries` is the
 * only table that knows which entries fall in the range, and
 * `ledger_entries_account_date_idx (tenant_id, account_code, entry_date)` exists
 * for exactly this query. `amount_paise` is `paise_positive` with direction
 * carried by `side`, so the two sides are summed separately rather than as one
 * signed column, and the totals reach TypeScript as `bigint` — digit text out of
 * the driver, `BigInt(...)`, never `Number(...)` (Requirement 15.1, 15.8).
 * {@link LedgerStore.trialBalanceTotals} is that seam, and it returns each
 * account's `account_kind` alongside its totals because the closing balance
 * cannot be computed without it.
 *
 * The closing balance is then signed per kind, here, in one expression:
 *
 * - `asset`, `expense` → `debits − credits`
 * - `liability`, `equity`, `income` → `credits − debits`
 *
 * which is the normal-balance convention and what property **P13** asserts. Doing
 * it in TypeScript rather than in the aggregate keeps it readable, keeps it under
 * the range-checked `subtract` of the Calculation Service, and lets a unit test
 * cover all five kinds with no database. `DEFAULT_CHART_OF_ACCOUNTS` in
 * `./posting-rules` records each account's kind and the reasoning for it.
 *
 * Range edges: `from` and `to` are held to the same real-calendar-date rule as a
 * draft's `entry_date` (`assertDateOnly`), `from` after `to` raises rather than
 * quietly returning nothing, the range is inclusive at both ends, and a range
 * holding no entries returns **0 rows** — not a row of zeros per account. An
 * account with no entry in range does not appear at all, so the empty result is
 * `rows: []` and both grand totals are `0n`.
 *
 * ## `reverseSet`: correction is an append, never an edit (task 24.1)
 *
 * Requirement 2.4 wants a correction to create a **new** set whose per-account
 * amounts equal the original's with the debit and credit designations exchanged,
 * carrying the original set's identifier, and to leave every original
 * Ledger_Entry — account, amount, side, Source_Record links — unchanged. So
 * `reverseSet` reads the original through {@link LedgerStore.findSet}, builds a
 * draft from it, and posts it through the same `postSet` path every other set
 * goes through. There is no update statement anywhere in it: `UPDATE` and
 * `DELETE` on `ledger_entries` are revoked at the privilege level
 * (Requirement 2.7), and "the original is untouched" is therefore a property of
 * the operation being an insert, not of a check that could be forgotten.
 *
 * Three decisions are worth stating, because each one is a choice rather than the
 * only option:
 *
 * 1. **A reversal set carries no derivation identity.** `source_record_type` and
 *    `source_record_id` are `NULL` on it, which is exactly what
 *    `20260101000003_semantic_ledger.sql` says those columns are nullable for:
 *    "reversal sets and Proposal-posted adjustment sets are not derived from a
 *    single Razorpay Source_Record". Two consequences, both wanted. A reversal
 *    cannot collide with the set it reverses on `ledger_set_derivation_uniq` —
 *    which it would if it reused the original's `(type, id)` pair, and `postSet`
 *    would then report the *original* back as an idempotent no-op and write no
 *    reversal at all. And because Postgres treats `NULL` as distinct in a unique
 *    constraint, reversing the same set twice yields **two independent reversal
 *    sets**, both linked to the one original, which is the behaviour task 24.2's
 *    property P14 asserts. A second reversal is a second correction, not a
 *    repeated derivation.
 *
 *    {@link writeFor} implements this by keying off `draft.reverses_set_id`: a
 *    draft that reverses something has a `NULL` identity regardless of its
 *    `source_refs`. That is the one place the rule lives.
 *
 * 2. **The Source_Record links are preserved, and the original set is added to
 *    them.** Requirement 2.2 wants at least 1 link per Ledger_Entry, and the
 *    reversal's amounts were read from the original set, so
 *    `{ type: 'ledger_entry_set', id: <original> }` leads the refs — the
 *    `source_record_type` enum has that label for this. The original's own refs
 *    follow, de-duplicated in first-appearance order, so a reversal of a Payment
 *    set is still traceable to that Payment without walking through
 *    `reverses_set_id`. `reverses_set_id` is the structural link Requirement 2.4
 *    asks for; the refs are the evidence trail.
 *
 * 3. **The reversal is dated as the original.** Requirement 2.4 does not name a
 *    date. Taking the original's `entry_date` means no `trialBalance` range can
 *    ever contain the original while excluding its reversal, so the pair nets to
 *    0 per account in every range either of them appears in. Dating it "today"
 *    would leave a range in which the erroneous set stands uncorrected, which is
 *    the failure the reversal exists to prevent.
 *
 * A set that balanced still balances with its sides exchanged — Σdebit and
 * Σcredit swap, and they were equal — so the reversal cannot be rejected as
 * unbalanced unless the store misreported the original. The read-back is
 * cross-checked against its own declared totals and `entry_count` for exactly
 * that reason, and a disagreement raises rather than posting a reversal of
 * something that was never there.
 *
 * The `actor` argument of design.md's signature is used rather than the
 * constructor-bound one: a correction is attributable to whoever requested it,
 * which is what `ledger_entry_sets.created_by` records.
 *
 * ## Scope
 *
 * Property P1 (`numRuns: 1000`) is **task 8.5**, P2 (derivation idempotency) is
 * **task 8.6**, P13 (trial balance self-balance) is **task 8.7**, and P14
 * (reversal preservation) is **task 24.2**.
 */

import { type Paise, subtract, sum } from '@/calc/calculation-service';
import type { Actor, TenantId } from '@/config/configuration-service';
import { formatIstIso } from '@/format/ist';
import { encodePaise } from '@/wire/paise-wire';
import {
  type AccountKind,
  assertDateOnly,
  assertDraftWellFormed,
  type DateOnly,
  type LedgerEntrySetDraft,
  type PostingSource,
  postingDraftFor,
  type SourceRecordType,
  type SourceRef,
  totalCreditPaise,
  totalDebitPaise,
} from './posting-rules';

/* -------------------------------------------------------------------------- */
/* design.md's PostResult                                                     */
/* -------------------------------------------------------------------------- */

/**
 * design.md's `PostResult`, field for field.
 *
 * `created` is `false` for the idempotent no-op of Requirement 2.8, and then
 * `set_id` is the identifier of the **retained** set rather than of a new one.
 * `postSet` reports it too, not only `postFromSource`: the derivation identity is
 * carried by any draft with `source_refs`, so a set posted twice through `postSet`
 * hits the same constraint and gets the same answer. There is one no-op path, not
 * two.
 */
export type PostResult =
  | { readonly ok: true; readonly set_id: string; readonly created: boolean }
  | {
      readonly ok: false;
      readonly kind: 'unbalanced';
      /** `Σdebit − Σcredit`, signed: positive when debit-heavy. */
      readonly imbalance_paise: Paise;
      /** The Source_Record identifiers involved (Requirement 2.6). */
      readonly source_refs: readonly SourceRef[];
    };

/**
 * One account of a trial balance (Requirement 2.5).
 *
 * Every figure is integer paise. `total_debit_paise` and `total_credit_paise` are
 * both `>= 0n` and never both `0n` — an account with no entry in the range does
 * not get a row. `closing_balance_paise` is signed by the account's kind:
 * `debits − credits` for `asset` and `expense`, `credits − debits` for
 * `liability`, `equity` and `income`. `kind` is reported alongside so a caller can
 * see which of the two rules produced the closing figure without looking the
 * account up again.
 */
export interface TrialBalanceRow {
  readonly account_code: string;
  /** The `account_kind` the closing sign rule was applied for. */
  readonly kind: AccountKind;
  readonly total_debit_paise: Paise;
  readonly total_credit_paise: Paise;
  readonly closing_balance_paise: Paise;
}

/**
 * The trial balance of Requirement 2.5, over the **inclusive** range `from..to`.
 *
 * `rows` holds one row per account with at least 1 Ledger_Entry dated in the
 * range, each account exactly once, ordered by `account_code` so the result is
 * deterministic. A range with no entries yields `rows: []`, whose two grand totals
 * are `0n` — see {@link trialBalanceDebitTotalPaise}.
 */
export interface TrialBalance {
  readonly from: DateOnly;
  readonly to: DateOnly;
  readonly rows: readonly TrialBalanceRow[];
}

/**
 * Σ of every row's debit total. `0n` for an empty range.
 *
 * Requirement 2.5 requires this to equal {@link trialBalanceCreditTotalPaise}
 * exactly, which holds because every persisted set balances (Requirement 2.7) and
 * a date range selects whole entries, never parts of them. Provided as a helper so
 * `get_trial_balance` (task 12.3) does not rewrite the summation.
 */
export function trialBalanceDebitTotalPaise(balance: TrialBalance): Paise {
  return sum(balance.rows.map((row) => row.total_debit_paise));
}

/** Σ of every row's credit total. `0n` for an empty range. */
export function trialBalanceCreditTotalPaise(balance: TrialBalance): Paise {
  return sum(balance.rows.map((row) => row.total_credit_paise));
}

/** design.md's `SemanticLedger`. */
export interface SemanticLedger {
  /** Idempotent derivation from one stored Source_Record (Requirement 2.8). */
  postFromSource(tenantId: TenantId, source: SourceRef): Promise<PostResult>;
  /** Persist a drafted set, or reject it in whole (Requirement 2.1, 2.2, 2.6). */
  postSet(tenantId: TenantId, draft: LedgerEntrySetDraft): Promise<PostResult>;
  /**
   * Correction by reversal only (Requirement 2.4): a **new** set, per-account
   * amounts equal, sides exchanged, linked by `reverses_set_id`, with every
   * original Ledger_Entry left exactly as it was. `actor` is who requested the
   * correction and becomes the new set's `created_by`.
   */
  reverseSet(tenantId: TenantId, setId: string, actor: Actor): Promise<PostResult>;
  /** Per-account totals over an inclusive date range (Requirement 2.5). */
  trialBalance(tenantId: TenantId, from: DateOnly, to: DateOnly): Promise<TrialBalance>;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Thrown when a posting request is malformed in a way `PostResult` cannot carry. */
export class SemanticLedgerError extends Error {
  override readonly name = 'SemanticLedgerError';
}

/* -------------------------------------------------------------------------- */
/* Persistence seam                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One `ledger_entries` row, with its `ledger_entry_sources` rows attached.
 *
 * The links travel with the entry rather than in a parallel list so a store
 * cannot write the entry and omit the link: they are one value, inserted in one
 * transaction (Requirement 2.2).
 */
export interface LedgerEntryWrite {
  readonly account_code: string;
  readonly side: 'debit' | 'credit';
  readonly amount_paise: Paise;
  readonly entry_date: DateOnly;
  /** 1-based, matching `ledger_entries.line_no CHECK (line_no >= 1)`. */
  readonly line_no: number;
  /** At least 1 Source_Record link for this entry (Requirement 2.2). */
  readonly sources: readonly SourceRef[];
}

/**
 * One `ledger_entry_sets` row and every entry under it: the whole unit of work,
 * so the store has everything it needs to write the set in a single transaction.
 *
 * `total_debit_paise` and `total_credit_paise` are already equal — `postSet`
 * verified that before building this — and `entry_count` already matches
 * `entries.length`. Both are still stated explicitly because the schema stores
 * them and both database barriers compare against them.
 */
export interface LedgerSetWrite {
  readonly tenant_id: TenantId;
  readonly entry_date: DateOnly;
  /** The derivation identity: the first `source_refs` entry, `null` for a set with none. */
  readonly source_record_type: SourceRecordType | null;
  readonly source_record_id: string | null;
  /**
   * Requirement 2.4's reversal link: the set this one reverses, `null` otherwise.
   * Non-`null` implies both derivation identity columns are `null` — see
   * `writeFor` and the module doc comment.
   */
  readonly reverses_set_id: string | null;
  readonly entry_count: number;
  readonly total_debit_paise: Paise;
  readonly total_credit_paise: Paise;
  /** `ledger_entry_sets.created_by`: a User identifier, an Agent name, or `policy_engine`. */
  readonly created_by: string;
  readonly entries: readonly LedgerEntryWrite[];
}

/**
 * The name of the derivation-identity constraint on `ledger_entry_sets`:
 * `UNIQUE (tenant_id, source_record_type, source_record_id)`, the idempotency key
 * of Requirement 2.8.
 *
 * Declared here so every store adapter matches the same string, and matches it
 * **by name**. A store that treated any SQLSTATE `23505` as idempotency would
 * report an unrelated unique violation as a successful no-op; a store that stopped
 * recognising this name because the constraint was renamed must fail rather than
 * quietly start writing a second set per Source_Record.
 */
export const LEDGER_SET_DERIVATION_UNIQ = 'ledger_set_derivation_uniq';

/**
 * What a store reports back.
 *
 * Two rejections arrive as values rather than exceptions, so each lands in exactly
 * one place in the service instead of being caught in two:
 *
 * - `unbalanced` — a database balance barrier aborted the transaction. It means
 *   the write was attempted and 0 Ledger_Entries persisted, and it funnels into
 *   the same rejection path as the application-level check.
 * - `duplicate_derivation` — `ledger_set_derivation_uniq` rejected the set because
 *   this Tenant already has one derived from this Source_Record. The whole
 *   transaction is gone with it, so nothing was written; `set_id` is the
 *   **retained** set, which the store reads back after the conflict so the caller
 *   gets a usable identifier rather than just "already there". `constraint` is
 *   stated so the value carries the evidence that the match was by name.
 *
 * Anything else — a connection fault, a missing account, a different unique
 * violation — is a failure and the store throws.
 */
export type LedgerWriteOutcome =
  | { readonly ok: true; readonly set_id: string }
  | {
      readonly ok: false;
      readonly kind: 'unbalanced';
      /** `Σdebit − Σcredit` as the barrier saw it. */
      readonly imbalance_paise: Paise;
    }
  | {
      readonly ok: false;
      readonly kind: 'duplicate_derivation';
      /** The set that already exists for this `(tenant, type, id)`. Retained, not replaced. */
      readonly set_id: string;
      readonly constraint: typeof LEDGER_SET_DERIVATION_UNIQ;
    };

/**
 * One stored Source_Record, as `postFromSource` needs it: a `razorpay_objects` row
 * reduced to the fields a posting rule reads.
 *
 * Nothing here is computed by the store. `amount_paise`, `fee_paise` and
 * `gst_on_fee_paise` are the integer-paise projections of the verbatim Razorpay
 * payload (Requirement 1.7), `null` where the object type does not carry that
 * figure, and the two identifier fields come straight out of the payload. The
 * store may read them from the projected columns or from `payload`, but it must not
 * scale, round or derive them.
 */
export interface LedgerSourceRecord {
  readonly type: SourceRecordType;
  /** `razorpay_objects.razorpay_id`. */
  readonly id: string;
  /**
   * `created_at_rzp` as an ISO-8601 instant. The set's `entry_date` is its IST
   * calendar date, computed in this module — see the module doc comment.
   */
  readonly created_at_rzp: string;
  /** Gross for a Payment, refunded amount for a Refund, received amount for a Settlement. */
  readonly amount_paise: Paise | null;
  readonly fee_paise: Paise | null;
  readonly gst_on_fee_paise: Paise | null;
  /** `payload->>'payment_id'` for a Refund: the refunded Payment (Requirement 2.9). */
  readonly refunded_payment_id: string | null;
  /** The Settlement_Recon_Report for a Settlement, when ingested (Requirement 2.10). */
  readonly settlement_recon_report_id: string | null;
}

/**
 * One persisted `ledger_entries` row with its `ledger_entry_sources` rows, read
 * back so a reversal can be drafted from it (Requirement 2.4).
 *
 * Read-only in the strongest sense available: this is the *only* thing
 * `reverseSet` does with the original, and there is no store method that could
 * write it back. `amount_paise` is the stored `paise_positive` amount, so it is
 * always `> 0` and direction is `side`.
 */
export interface PersistedLedgerEntry {
  readonly account_code: string;
  readonly side: 'debit' | 'credit';
  readonly amount_paise: Paise;
  readonly entry_date: DateOnly;
  /** 1-based `ledger_entries.line_no`. Orders the reversal's entries. */
  readonly line_no: number;
  /** Every `ledger_entry_sources` row for this entry. At least 1 (Requirement 2.2). */
  readonly sources: readonly SourceRef[];
}

/**
 * One persisted `ledger_entry_sets` row and every entry under it.
 *
 * The declared totals and `entry_count` are reported alongside the entries so
 * `reverseSet` can cross-check the read-back against them: a persisted set always
 * balances (Requirement 2.7), so a set whose entries disagree with its own header
 * means the store answered wrongly, and reversing it would post a mirror of
 * something that is not there.
 */
export interface PersistedLedgerSet {
  readonly id: string;
  readonly tenant_id: TenantId;
  readonly entry_date: DateOnly;
  readonly source_record_type: SourceRecordType | null;
  readonly source_record_id: string | null;
  /** Non-`null` when this set is itself a reversal. Reversing a reversal is allowed. */
  readonly reverses_set_id: string | null;
  readonly entry_count: number;
  readonly total_debit_paise: Paise;
  readonly total_credit_paise: Paise;
  readonly entries: readonly PersistedLedgerEntry[];
}

/** The inclusive date range of one trial balance query, for one Tenant. */
export interface TrialBalanceQuery {
  readonly tenant_id: TenantId;
  /** Inclusive lower bound. Guaranteed a real calendar date, and `<= to`. */
  readonly from: DateOnly;
  /** Inclusive upper bound. */
  readonly to: DateOnly;
}

/**
 * One account's summed debits and credits over a date range, as the store
 * aggregated them.
 *
 * Both totals are `>= 0n` because `amount_paise` is `paise_positive` and direction
 * is carried by `side`; they are summed separately, never as one signed column. An
 * account with no entry in the range is **absent** from the result rather than
 * present with two zeros, so the store's query joins from `ledger_entries` and does
 * not left-join from the chart of accounts. `kind` comes from
 * `chart_of_accounts.kind` and is what the closing sign rule is applied for.
 */
export interface AccountPeriodTotals {
  readonly account_code: string;
  readonly kind: AccountKind;
  readonly total_debit_paise: Paise;
  readonly total_credit_paise: Paise;
}

/**
 * Persistence for a Ledger_Entry set. Injected rather than imported so `postSet`
 * is unit-testable with no database, and so the transaction boundary is the
 * adapter's concern.
 *
 * **There is no PostgREST adapter here, deliberately.** A set is three inserts —
 * `ledger_entry_sets`, `ledger_entries`, `ledger_entry_sources` — and PostgREST
 * gives each request its own transaction, so the three could not commit or abort
 * together and the deferred barrier could never fire across them. An atomic
 * write therefore needs either a single SQL function (`app.post_ledger_set`) or a
 * pooled SQL connection; both are additions outside task 8.3, and writing a
 * three-request adapter that looked atomic would be worse than not writing one.
 * The same tables are also `FORCE ROW LEVEL SECURITY` with no policies until task
 * 26.1, so PostgREST matches zero rows for every role today anyway.
 * `test/db/ledger-postset.test.ts` implements this interface over a real
 * transactional SQL session, which is where the atomicity guarantee is actually
 * proven.
 */
export interface LedgerStore {
  /**
   * Write the set and every entry and link, in one transaction.
   *
   * A `ledger_set_derivation_uniq` violation — SQLSTATE `23505` with that
   * constraint name, and only that name — is reported as
   * `{ ok: false, kind: 'duplicate_derivation', set_id }`, with `set_id` read back
   * from the existing set. Any other unique violation is a failure and throws.
   */
  insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome>;

  /**
   * The stored Source_Record for `ref`, or `null` when this Tenant has none.
   *
   * This is what closes the gap between design.md's
   * `postFromSource(tenantId, source: SourceRef)` and the posting rules' need for
   * amounts and a date: the amounts come from the stored `razorpay_objects` row,
   * never from the caller and never inferred. `null` is "not ingested", which the
   * service raises on rather than treating as nothing to do.
   */
  findSourceRecord(tenantId: TenantId, ref: SourceRef): Promise<LedgerSourceRecord | null>;

  /**
   * The persisted set `setId` and every entry and Source_Record link under it, or
   * `null` when this Tenant has no such set.
   *
   * `reverseSet`'s read seam, and read-only: the original is the input to a new
   * insert and is never written back. The Tenant is part of the lookup rather than
   * a check applied afterwards, so a set belonging to another Tenant is
   * indistinguishable from one that does not exist — the same fail-closed shape
   * `findSourceRecord` has. Entries must arrive with their `line_no` and their
   * links; the order does not matter, `reverseSet` sorts by `line_no`.
   */
  findSet(tenantId: TenantId, setId: string): Promise<PersistedLedgerSet | null>;

  /**
   * Per-account debit and credit totals over the inclusive range, one row per
   * account holding at least 1 Ledger_Entry in it, each account once.
   *
   * The summation belongs here rather than in the service: it is a `GROUP BY` over
   * `BIGINT` served by `ledger_entries_account_date_idx`, and pulling every entry
   * into TypeScript to add it up would be both slower and no more exact. The totals
   * must arrive as `bigint` — digit text out of the driver, never `Number(...)`.
   * The closing balance is not computed here; the service signs it per `kind`.
   */
  trialBalanceTotals(query: TrialBalanceQuery): Promise<readonly AccountPeriodTotals[]>;
}

/* -------------------------------------------------------------------------- */
/* Audit seam                                                                 */
/* -------------------------------------------------------------------------- */

/** The Audit_Event types this module appends. */
export type LedgerAuditEventType = 'ledger_set_rejected';

/**
 * One Audit_Event to append.
 *
 * `sourceRefs` carries Source_Record type and identifier only, never a payload
 * or a credential (Requirement 13.2). `payload` carries the imbalance and the
 * declared totals as digit strings, because `bigint` has no JSON
 * representation and a monetary value must not pass through a float.
 */
export interface LedgerAuditEvent {
  readonly tenantId: TenantId;
  readonly eventType: LedgerAuditEventType;
  readonly actor: Actor;
  /** `audit_events.outcome`. A rejected write is `blocked`. */
  readonly outcome: 'blocked';
  /** `audit_events.source_record_refs` (Requirement 2.6, 13.2). */
  readonly sourceRefs: readonly SourceRef[];
  readonly payload: Readonly<Record<string, unknown>>;
  /** UTC, ISO-8601 to millisecond precision (Requirement 13.1). */
  readonly occurredAt: string;
}

/**
 * Where the rejection Audit_Event goes — **on its own connection**, so it
 * commits whether or not the posting transaction did. See the module doc comment
 * for why this is a TypeScript seam rather than
 * `app.append_audit_event_autonomous`, and for the task 25.1 hand-off.
 */
export interface LedgerAuditSink {
  append(event: LedgerAuditEvent): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

export interface SemanticLedgerDeps {
  readonly store: LedgerStore;
  /** Must append on a connection independent of {@link store} (see the module doc). */
  readonly audit: LedgerAuditSink;
  /**
   * Who is posting. design.md's `postSet(tenantId, draft)` carries no actor, and
   * that signature is kept exactly, so the actor is bound at construction — one
   * service instance per request scope. It becomes `created_by` on the set and
   * the actor of the rejection Audit_Event, both of which are `NOT NULL`.
   */
  readonly actor: Actor;
  /** Injectable clock, so `occurred_at` is assertable. Defaults to the wall clock. */
  readonly now?: () => Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a rejection was caught. Recorded on the Audit_Event, not on `PostResult`. */
type RejectionOrigin = 'before_insert' | 'at_commit';

/**
 * The account kinds whose closing balance is `debits − credits`. Every other kind
 * closes `credits − debits`.
 *
 * Not exported: property P13 (task 8.7) asserts this rule, and a test that imported
 * the rule from the implementation would assert nothing. `DEFAULT_CHART_OF_ACCOUNTS`
 * in `./posting-rules` records which kind each account is and why.
 */
const DEBIT_NORMAL_KINDS: ReadonlySet<AccountKind> = new Set<AccountKind>([
  'asset',
  'expense',
]);

/** The closing balance of one account, signed by its kind (Requirement 2.5). */
function closingBalancePaise(kind: AccountKind, debit: Paise, credit: Paise): Paise {
  return DEBIT_NORMAL_KINDS.has(kind) ? subtract(debit, credit) : subtract(credit, debit);
}

/**
 * The Source_Record refs of a persisted set's entries, de-duplicated on
 * `(type, id)` in first-appearance order by `line_no`.
 *
 * `ledger_entry_sources` is `PRIMARY KEY (entry_id, source_record_type,
 * source_record_id)`, so a repeated ref on a reversal entry would be a duplicate
 * key rather than a harmless extra row. First-appearance order rather than sorted
 * order keeps the reversal's refs reading the way the original's do — for a Refund
 * set, the Refund before the refunded Payment.
 */
function distinctSourceRefs(
  entries: readonly PersistedLedgerEntry[],
): readonly SourceRef[] {
  const seen = new Set<string>();
  const refs: SourceRef[] = [];
  for (const entry of [...entries].sort((a, b) => a.line_no - b.line_no)) {
    for (const ref of entry.sources) {
      const key = `${ref.type}\u0000${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ type: ref.type, id: ref.id });
    }
  }
  return refs;
}

/**
 * A set read back for reversal must agree with its own header.
 *
 * Every persisted set balances and declares its own totals and `entry_count`
 * (Requirement 2.1, 2.7), so a read-back that disagrees means the store answered
 * wrongly — a partial entry list, entries from a second set, a `line_no`
 * collision. Reversing that would post a mirror of something that is not there,
 * and because the reversal balances whenever the original did, `postSet` would
 * accept it without complaint. So it is caught here rather than trusted.
 *
 * @throws {SemanticLedgerError}
 */
function assertPersistedSetConsistent(set: PersistedLedgerSet): void {
  function fault(detail: string): never {
    throw new SemanticLedgerError(
      `Ledger_Entry set ${set.id} was read back inconsistently: ${detail}. A persisted set ` +
        `always balances and declares its own totals (Requirement 2.1, 2.7), so this is a ` +
        `store fault and reversing it would mirror entries that are not there`,
    );
  }

  if (set.entries.length !== set.entry_count) {
    fault(`${set.entries.length} entries read against a declared entry_count of ${set.entry_count}`);
  }
  const lineNos = new Set(set.entries.map((entry) => entry.line_no));
  if (lineNos.size !== set.entries.length) {
    fault('two entries share a line_no, which `UNIQUE (set_id, line_no)` forbids');
  }
  for (const entry of set.entries) {
    if (entry.sources.length === 0) {
      fault(
        `the entry on ${entry.account_code} carries no Source_Record link, and Requirement 2.2 ` +
          `gives every Ledger_Entry at least 1`,
      );
    }
    if (entry.entry_date !== set.entry_date) {
      fault(
        `the entry on ${entry.account_code} is dated ${entry.entry_date} against the set's ` +
          `${set.entry_date}`,
      );
    }
  }

  const debit = sum(
    set.entries.filter((e) => e.side === 'debit').map((e) => e.amount_paise),
  );
  const credit = sum(
    set.entries.filter((e) => e.side === 'credit').map((e) => e.amount_paise),
  );
  if (debit !== set.total_debit_paise || credit !== set.total_credit_paise) {
    fault(
      `its entries total ${debit} debit and ${credit} credit against declared ` +
        `${set.total_debit_paise} and ${set.total_credit_paise}`,
    );
  }
  if (debit !== credit) {
    fault(`its entries are unbalanced by ${subtract(debit, credit)} paise`);
  }
}

/** The IST calendar date of an instant: `entry_date` for a derived set. */
function istEntryDate(instant: string): DateOnly {
  // `formatIstIso` yields `YYYY-MM-DDTHH:MM:SS+05:30` off a fixed +05:30 offset.
  return formatIstIso(instant).slice(0, 10);
}

/**
 * A stored Source_Record projected onto the input a posting rule takes.
 *
 * Pure, so the projection is unit-testable with no database, and the only place the
 * `razorpay_objects` shape meets `PostingSource`. An absent `fee_paise` or
 * `gst_on_fee_paise` is `0n`: Razorpay omits the figure when there is none, and the
 * Payment rule already drops a 0-paise component instead of posting it.
 *
 * @throws {SemanticLedgerError} for a Source_Record type with no posting rule,
 * or for a stored row missing a figure its rule requires.
 */
export function postingSourceFrom(record: LedgerSourceRecord): PostingSource {
  const entryDate = istEntryDate(record.created_at_rzp);

  function requireAmount(field: string): Paise {
    if (record.amount_paise === null) {
      throw new SemanticLedgerError(
        `stored ${record.type} ${record.id} carries no ${field}; a Ledger_Entry amount is ` +
          `read from the Source_Record and is never inferred (Requirement 2.3)`,
      );
    }
    return record.amount_paise;
  }

  switch (record.type) {
    case 'payment':
      return {
        type: 'payment',
        payment_id: record.id,
        entry_date: entryDate,
        amount_paise: requireAmount('gross amount'),
        fee_paise: record.fee_paise ?? 0n,
        gst_on_fee_paise: record.gst_on_fee_paise ?? 0n,
      };
    case 'refund': {
      if (record.refunded_payment_id === null) {
        throw new SemanticLedgerError(
          `stored refund ${record.id} names no refunded Payment; Requirement 2.9 requires ` +
            `both the Refund and the refunded Payment as Source_Record links`,
        );
      }
      return {
        type: 'refund',
        refund_id: record.id,
        payment_id: record.refunded_payment_id,
        entry_date: entryDate,
        amount_paise: requireAmount('refund amount'),
      };
    }
    case 'settlement':
      return {
        type: 'settlement',
        settlement_id: record.id,
        settlement_recon_report_id: record.settlement_recon_report_id,
        entry_date: entryDate,
        received_amount_paise: requireAmount('received amount'),
      };
    case 'transfer':
      return {
        type: 'transfer',
        transfer_id: record.id,
        entry_date: entryDate,
        amount_paise: requireAmount('transfer amount'),
      };
    case 'transfer_reversal':
      return {
        type: 'transfer_reversal',
        transfer_reversal_id: record.id,
        entry_date: entryDate,
        reversed_amount_paise: requireAmount('reversed amount'),
      };
    default:
      throw new SemanticLedgerError(
        `no posting rule for Source_Record type ${JSON.stringify(record.type)}: ` +
          `payment, refund, settlement, transfer, and transfer_reversal are derivable. ` +
          `Reporting this as an idempotent no-op would claim ${record.id} is posted ` +
          `when no Ledger_Entry exists for it`,
      );
  }
}

export function createSemanticLedger(deps: SemanticLedgerDeps): SemanticLedger {
  const { store, audit, actor } = deps;
  const clock = deps.now ?? ((): Date => new Date());

  function requireTenant(tenantId: TenantId, operation: string): TenantId {
    if (!UUID_RE.test(tenantId)) {
      throw new SemanticLedgerError(
        `${operation} requires a Tenant identifier as a UUID, got ${JSON.stringify(tenantId)}; ` +
          `an unscoped ledger read or write must be impossible to issue by accident`,
      );
    }
    return tenantId;
  }

  /**
   * Record the rejection and return the error response. Both halves of
   * Requirement 2.6, in the one place every barrier funnels into.
   */
  async function reject(
    tenantId: TenantId,
    draft: LedgerEntrySetDraft,
    imbalance: Paise,
    origin: RejectionOrigin,
    totals: { readonly debit: Paise; readonly credit: Paise },
    // Who asked for the write: the bound actor for `postSet`, the caller's for
    // `reverseSet`, whose signature carries one (design.md).
    by: Actor,
  ): Promise<PostResult> {
    await audit.append({
      tenantId,
      eventType: 'ledger_set_rejected',
      actor: by,
      outcome: 'blocked',
      // Type and identifier only: the Source_Records the amounts were read from.
      sourceRefs: draft.source_refs.map((ref) => ({ type: ref.type, id: ref.id })),
      payload: {
        reason: 'unbalanced',
        // Digit text, never a float. Signed: positive when debit-heavy.
        imbalance_paise: encodePaise(imbalance),
        total_debit_paise: encodePaise(totals.debit),
        total_credit_paise: encodePaise(totals.credit),
        entry_count: draft.entries.length,
        entry_date: draft.entry_date,
        entries_persisted: 0,
        /**
         * `before_insert` means no statement was issued at all; `at_commit`
         * means a database barrier aborted the transaction. Both persist 0
         * Ledger_Entries, and the distinction is worth keeping in the record
         * because the second one should be unreachable from `postSet`.
         */
        rejected_at: origin,
      },
      occurredAt: clock().toISOString(),
    });

    return {
      ok: false,
      kind: 'unbalanced',
      imbalance_paise: imbalance,
      source_refs: draft.source_refs,
    };
  }

  function writeFor(
    tenantId: TenantId,
    draft: LedgerEntrySetDraft,
    totals: { readonly debit: Paise; readonly credit: Paise },
    by: Actor,
  ): LedgerSetWrite {
    /**
     * The first ref is the derivation identity, the pair
     * `ledger_set_derivation_uniq` is declared on (see ./posting-rules) — **except
     * on a reversal set, which has none**. A reversal is not derived from a single
     * Razorpay Source_Record, which is why the two columns are nullable
     * (`20260101000003_semantic_ledger.sql`), and giving it the original's pair
     * would make `postSet` report the original back as an idempotent no-op instead
     * of writing the correction. `NULL` is distinct in a unique constraint, so two
     * reversals of one set are two independent sets — see the module doc comment.
     */
    const identity = draft.reverses_set_id === undefined ? draft.source_refs[0] : undefined;
    return {
      tenant_id: tenantId,
      entry_date: draft.entry_date,
      source_record_type: identity?.type ?? null,
      source_record_id: identity?.id ?? null,
      reverses_set_id: draft.reverses_set_id ?? null,
      entry_count: draft.entries.length,
      total_debit_paise: totals.debit,
      total_credit_paise: totals.credit,
      created_by: by.id,
      entries: draft.entries.map((entry, index) => ({
        account_code: entry.account_code,
        side: entry.side,
        amount_paise: entry.amount_paise,
        entry_date: draft.entry_date,
        line_no: index + 1,
        // Every entry linked to every ref, so "at least 1 link per entry"
        // (Requirement 2.2) holds for the whole set at once.
        sources: draft.source_refs.map((ref) => ({ type: ref.type, id: ref.id })),
      })),
    };
  }

  /**
   * The one posting path. `postSet` and `postFromSource` enter it with the bound
   * actor, `reverseSet` with the one its signature carries; nothing else differs,
   * so a reversal is validated, balanced, audited and inserted by exactly the code
   * a derived set is.
   */
  async function post(
    tenantId: TenantId,
    draft: LedgerEntrySetDraft,
    by: Actor,
    operation: string,
  ): Promise<PostResult> {
    requireTenant(tenantId, operation);

    // 2..20 entries, every amount > 0, at least 1 Source_Record ref, a real
    // entry_date. Raises PostingRuleError; balance is checked below, not here.
    assertDraftWellFormed(draft);

    // May raise PaiseRangeError for a side whose running total leaves the
    // paise range — see the module doc comment. Nothing has been issued yet.
    const debit = totalDebitPaise(draft);
    const credit = totalCreditPaise(draft);
    const imbalance = subtract(debit, credit);

    if (imbalance !== 0n) {
      // No transaction, no statement: the strongest form of "persist 0
      // Ledger_Entries" (Requirement 2.6).
      return reject(tenantId, draft, imbalance, 'before_insert', { debit, credit }, by);
    }

    const outcome = await store.insertSet(writeFor(tenantId, draft, { debit, credit }, by));
    if (outcome.ok) {
      return { ok: true, set_id: outcome.set_id, created: true };
    }
    if (outcome.kind === 'duplicate_derivation') {
      // Requirement 2.8: the existing set is retained, the rejected transaction
      // wrote nothing, so 0 additional Ledger_Entries exist and every account
      // balance is unchanged. A success with `created: false`, not an error, and
      // nothing to audit — no write was refused.
      return { ok: true, set_id: outcome.set_id, created: false };
    }
    // A database barrier caught what the balance check above says cannot happen,
    // so the write is a store-level fault. The transaction aborted and 0
    // Ledger_Entries persisted, and the caller gets the same result shape.
    return reject(
      tenantId,
      draft,
      outcome.imbalance_paise,
      'at_commit',
      { debit, credit },
      by,
    );
  }

  function postSet(tenantId: TenantId, draft: LedgerEntrySetDraft): Promise<PostResult> {
    return post(tenantId, draft, actor, 'postSet');
  }

  return {
    postSet,

    async postFromSource(tenantId: TenantId, source: SourceRef): Promise<PostResult> {
      requireTenant(tenantId, 'postFromSource');
      if (source.id.trim().length === 0) {
        throw new SemanticLedgerError(
          `postFromSource needs a Source_Record identifier, got ${JSON.stringify(source.id)}`,
        );
      }

      // The amounts and the date come from the stored Razorpay object, verbatim.
      const stored = await store.findSourceRecord(tenantId, source);
      if (stored === null) {
        throw new SemanticLedgerError(
          `no stored ${source.type} ${source.id} for Tenant ${tenantId}: a Ledger_Entry set is ` +
            `derived from an ingested Source_Record, so there is nothing to post from`,
        );
      }

      // Raises for a Source_Record type with no posting table rather than silently
      // reporting a no-op.
      const draft = postingDraftFor(postingSourceFrom(stored));
      // One posting path: the derivation identity travels on the draft, and
      // `ledger_set_derivation_uniq` decides whether this is the first derivation.
      return postSet(tenantId, draft);
    },

    async trialBalance(
      tenantId: TenantId,
      from: DateOnly,
      to: DateOnly,
    ): Promise<TrialBalance> {
      requireTenant(tenantId, 'trialBalance');
      // The same real-calendar-date rule a draft's entry_date is held to.
      assertDateOnly(from, 'from');
      assertDateOnly(to, 'to');
      if (from > to) {
        // `YYYY-MM-DD` compares lexicographically as it does chronologically.
        // Requirement 2.5 is scoped to a range whose start is on or before its end;
        // an inverted range is a caller fault, not an empty result.
        throw new SemanticLedgerError(
          `trialBalance needs a range whose start date is on or before its end date, got ` +
            `${from}..${to}`,
        );
      }

      const totals = await store.trialBalanceTotals({ tenant_id: tenantId, from, to });

      const seen = new Set<string>();
      const rows: TrialBalanceRow[] = [];
      for (const account of totals) {
        if (seen.has(account.account_code)) {
          // Requirement 2.5 gives each in-range account exactly one row. The store
          // groups by account, so a repeat is a store fault and must not be
          // flattened into a plausible-looking trial balance.
          throw new SemanticLedgerError(
            `trialBalance received two rows for account ${account.account_code} over ` +
              `${from}..${to}; each account holding entries in the range appears exactly once`,
          );
        }
        seen.add(account.account_code);
        if (account.total_debit_paise === 0n && account.total_credit_paise === 0n) {
          // Every entry amount is `paise_positive`, so an account with a row here
          // held at least one entry and cannot total 0 on both sides. Two zeros
          // means the store returned an account with no entry in range, which
          // Requirement 2.5 excludes from the result entirely.
          throw new SemanticLedgerError(
            `trialBalance received account ${account.account_code} with no debits and no ` +
              `credits over ${from}..${to}; an account with no Ledger_Entry in range has no row`,
          );
        }
        rows.push({
          account_code: account.account_code,
          kind: account.kind,
          total_debit_paise: account.total_debit_paise,
          total_credit_paise: account.total_credit_paise,
          closing_balance_paise: closingBalancePaise(
            account.kind,
            account.total_debit_paise,
            account.total_credit_paise,
          ),
        });
      }
      // Deterministic order regardless of what the store returned.
      rows.sort((a, b) => a.account_code.localeCompare(b.account_code, 'en'));

      return { from, to, rows };
    },

    async reverseSet(
      tenantId: TenantId,
      setId: string,
      by: Actor,
    ): Promise<PostResult> {
      requireTenant(tenantId, 'reverseSet');
      if (!UUID_RE.test(setId)) {
        // `ledger_entry_sets.id` is a UUID, and `reverses_set_id` is a foreign key
        // onto it. A malformed identifier is a caller fault, not a missing set.
        throw new SemanticLedgerError(
          `reverseSet requires a Ledger_Entry set identifier as a UUID, got ` +
            `${JSON.stringify(setId)}`,
        );
      }

      // Read-only. This is the whole of what `reverseSet` does with the original:
      // Requirement 2.4's "retain every original Ledger_Entry unchanged" holds
      // because the correction is an insert and there is no other statement.
      const original = await store.findSet(tenantId, setId);
      if (original === null) {
        throw new SemanticLedgerError(
          `no Ledger_Entry set ${setId} for Tenant ${tenantId}: a correction reverses a ` +
            `persisted set, so there is nothing to reverse`,
        );
      }
      assertPersistedSetConsistent(original);

      // Per-account amounts equal, sides exchanged (Requirement 2.4). Ordered by
      // the original's `line_no` so the reversal's own line numbers mirror it.
      const entries = [...original.entries]
        .sort((a, b) => a.line_no - b.line_no)
        .map((entry) => ({
          account_code: entry.account_code,
          side: entry.side === 'debit' ? ('credit' as const) : ('debit' as const),
          amount_paise: entry.amount_paise,
        }));

      const draft: LedgerEntrySetDraft = {
        // The original set leads: the reversal's amounts were read from it, and
        // `source_record_type` has a `ledger_entry_set` label for exactly this.
        // The original's own refs follow so the trail to the Razorpay object
        // survives without walking `reverses_set_id`.
        source_refs: [
          { type: 'ledger_entry_set', id: original.id },
          ...distinctSourceRefs(original.entries),
        ],
        // Dated as the original, so no trial balance range holds the original
        // without its correction — see the module doc comment.
        entry_date: original.entry_date,
        entries,
        reverses_set_id: original.id,
      };

      // The same path a derived set takes. `reverses_set_id` makes `writeFor` write
      // a NULL derivation identity, so reversing twice yields two independent
      // reversal sets rather than an idempotent no-op.
      return post(tenantId, draft, by, 'reverseSet');
    },
  };
}
