/**
 * SET-9281 — design.md's settlement worked example as a typed module (task 7.2).
 *
 * Consumed by task 11.3 (the worked-example test that drives `reconcileSettlement`),
 * task 9.3 (property P6, evidence chain replay), task 8.5 (property P1, ledger set
 * balance) and task 16.1 (the end-to-end demo path). Requirements 4.2, 4.3, 4.4, 4.5,
 * 12.8.
 *
 * Every monetary value here is `Paise` — `bigint`, integer paise, never `number`, never
 * a float (Requirement 15.1, 15.8). The ESLint money rules in `eslint.config.mjs` are
 * scoped to `src/**`, so they do not police this file; the discipline is kept anyway,
 * because a fixture that reached a `number` would hand every consumer a wrong figure
 * with a confident type.
 *
 * ## Why the figures are `bigint` literals rather than read from `razorpay-seed.json`
 *
 * Task 7.1 writes `test/fixtures/razorpay-seed.json`, which carries the same figures as
 * decimal strings. This module restates them as `bigint` literals rather than parsing
 * that file at runtime, for three reasons:
 *
 *   1. **Neither file is silently authoritative.** Two independent statements of the
 *      same figures, plus an equality test between them, catches an edit to either one.
 *      A runtime read makes the JSON authoritative and this module a view of it, so a
 *      wrong figure in the JSON would propagate into every consumer as a *passing* test.
 *   2. **The literals are reviewable against design.md.** `84260000n` sitting in the
 *      source is checkable by eye against design.md's table; `fromWire(seed.…)` is not.
 *   3. **No parse step between the fixture and its consumers.** A `bigint` literal cannot
 *      fail at runtime, cannot be range-rejected, and needs no `try`. The JSON path would
 *      put `JSON.parse` and `fromWire` — and their failure modes — inside every test that
 *      only wanted a number to compare against.
 *
 * The agreement test lives in `set-9281.fixture.test.ts` beside this file: it reads the
 * JSON, converts with `fromWire`, and asserts figure-for-figure equality with this
 * module, so the two cannot drift.
 *
 * ## `figure_paise`: one chain, twelve steps, two named checkpoints
 *
 * design.md says the Evidence_Chain persisted for this Settlement "has one step per
 * operation" and that replaying "those twelve steps … reproduces `0n` for the residual
 * and `2320000n` for the Difference". That is **one** chain, not two. Requirement 12.8
 * ties replay to *the presented figure*, and `evidence_chains` stores exactly one
 * `figure_paise` per chain, so the chain's figure is the value its terminal step
 * produces — the residual. The Difference is an intermediate of the same chain, the
 * result of step {@link DIFFERENCE_STEP_INDEX}, and the Expected Amount is the result of
 * step {@link EXPECTED_AMOUNT_STEP_INDEX}. A consumer wanting the Difference reads that
 * step's `result_paise`; it does not need a second chain, and this fixture does not
 * invent one. If task 9.1 or 12.1 later decides to persist a separate Difference chain,
 * it is the 1..8 prefix of these steps with `figure_paise = 2320000n`.
 *
 * ## The one place design.md leaves a gap: signed adjustments
 *
 * Requirement 4.2 takes the **signed** sum of adjustments, and design.md's fixed step
 * sequence spends one step on `sum(adjustments)` followed by `add` — not `subtract` —
 * which only reaches `84260000n` if the summed adjustment operands are already negative
 * for a debit. Razorpay's recon line does not carry a signed amount: it carries a
 * positive `amount` with the direction in `debit` versus `credit`. Turning that into a
 * signed value is arithmetic, and the twelve-step sequence has no step for it.
 *
 * So the signed value is treated as a **field read**, not a step: each adjustment operand
 * cites the line's `signed_amount`, the FinanceOS-side projection `credit − debit`, which
 * is the same projection `scripts/seed-razorpay-testmode.ts` applies when it fills
 * `recon_report_lines.adjustments` with `-300000` for a `debit: "300000"` line. The
 * projection happens at the ingestion boundary, before the chain. {@link SOURCE_RECORDS}
 * carries `amount`, `debit`, `credit` and `signed_amount` for every adjustment line so a
 * replay interpreter can read either convention, and the fixture self-check asserts
 * `signed_amount === credit − debit`. Reported, not resolved: design.md specifies neither
 * a signed field on the recon line nor the extra `negate`/`subtract` steps that would
 * make the sign explicit in the chain.
 *
 * ## Types
 *
 * `EvidenceOperation`, `EvidenceOperand`, `EvidenceStep` and `EvidenceChain` are
 * transcriptions of design.md's "Shared types used throughout" block. Task 9.1 landed
 * `src/evidence/chain-builder.ts`, which owns them, so this file imports them from there
 * and keeps no second copy; they are re-exported below so a consumer importing them from
 * this fixture still compiles. `SourceRef` and `SourceRecordType` live in
 * `src/ledger/posting-rules.ts` (task 8.1) and are imported from there.
 *
 * `ReconReportLines`, `ReconStatus`, `SettlementRecon` and `ExaminedCounts` were
 * transcriptions of design.md's reconciliation block on the same terms, and are now
 * imported from `src/agents/reconciliation/reconcile-settlement.ts` (task 11.1), which owns
 * them. They too are re-exported below. The figures in this file are unchanged by that
 * move; what changes is that `SET_9281.recon` is now typed by the very interface
 * `reconcileSettlement` returns, so a drift between the two is a compile error.
 *
 * The twelve-step chain below fit those shapes with no change: `EvidenceChain` carries
 * `produced_by` alongside design.md's seven fields, matching the `NOT NULL`
 * `evidence_chains.produced_by` column, and the operand union is identical. What is NOT
 * shared is `EvidenceSourceRecord`, which stays local: it is what a *replay* needs to see
 * of a Source_Record, and no production module reads it.
 *
 * ## Provenance
 *
 * Both Settlements are **synthetic**. Razorpay exposes no create endpoint for a
 * Settlement or a Settlement_Recon_Report, so task 7.1 builds them locally and this
 * module mirrors its identifiers exactly. Nothing here was retrieved from Razorpay.
 */

import type {
  ExaminedCounts,
  ReconReportLines,
  ReconStatus,
  SettlementRecon,
} from '@/agents/reconciliation/reconcile-settlement';
import type { Paise } from '@/calc/paise';
import type {
  EvidenceChain,
  EvidenceOperand,
  EvidenceOperation,
  EvidenceStep,
} from '@/evidence/chain-builder';
import type { SourceRef } from '@/ledger/posting-rules';

// ---------------------------------------------------------------------------
// Evidence_Chain shapes (design.md, "Shared types used throughout")
//
// Owned by `src/evidence/chain-builder.ts` (task 9.1) and re-exported here, so
// there is exactly one declaration of each and every consumer that used to take
// them from this fixture still compiles.
// ---------------------------------------------------------------------------

export type { EvidenceChain, EvidenceOperand, EvidenceOperation, EvidenceStep };

/**
 * A Source_Record as a replay interpreter needs to see it: the monetary fields the chain
 * cites, keyed by field name. Only monetary fields appear, so the map is
 * `Record<string, Paise>` and no reader has to discriminate a type.
 */
export interface EvidenceSourceRecord {
  readonly ref: SourceRef;
  readonly fields: Readonly<Record<string, Paise>>;
  /** `evidence_chain_sources.record_updated_at`, the left side of the stale comparison. */
  readonly record_updated_at: string;
}

// ---------------------------------------------------------------------------
// Reconciliation shapes (design.md, "Settlement Expected Amount and the
// three-way Difference decomposition")
//
// Owned by `src/agents/reconciliation/reconcile-settlement.ts` (task 11.1) and
// re-exported here, on the same terms as the Evidence_Chain shapes above: one
// declaration in the codebase, and every consumer that used to take them from
// this fixture still compiles. This is also what makes the assertion in task
// 11.3 a type-checked comparison against the function under test rather than
// against a look-alike shape.
// ---------------------------------------------------------------------------

export type { ExaminedCounts, ReconReportLines, ReconStatus, SettlementRecon };

/** The Exception Requirement 4.5 requires, or `null` where Requirement 4.4 forbids one. */
export interface ExpectedException {
  readonly category: 'settlement_mismatch';
  /** The absolute value of the residual (Requirement 4.5). */
  readonly impact_paise: Paise;
  readonly direction: 'unexplained_shortfall' | 'unexplained_excess';
  readonly lifecycle_state: 'open';
  /** At least 1 Source_Record identifier (Requirement 4.12). */
  readonly source_refs: readonly SourceRef[];
}

/** One worked example: the input, the expected output, and the evidence for it. */
export interface WorkedExample {
  /** design.md's / the seed fixture's display name. */
  readonly display_name: string;
  readonly settlement_id: string;
  readonly recon_report_id: string;
  /** `YYYY-MM-DD`. */
  readonly settlement_date: string;
  /** The Settlement object's own amount: what landed in the bank. */
  readonly received_paise: Paise;
  readonly lines: ReconReportLines;
  /** What `reconcileSettlement(settlement_id, received_paise, lines)` must return. */
  readonly recon: SettlementRecon;
  readonly exception: ExpectedException | null;
  readonly examined: ExaminedCounts;
  /** The Source_Records the chain reads, so a replay has something to read. */
  readonly records: readonly EvidenceSourceRecord[];
  readonly chain: EvidenceChain;
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** The Tenant both Settlements belong to, matching `razorpay-seed.json`. */
export const TENANT_ID = '11111111-1111-4111-8111-111111111111';

/** The Financial_Tool that composes the per-Settlement chain (task 12.1). */
export const PRODUCED_BY = 'get_settlement_reconciliation';

/** Twelve steps, no more and no fewer (design.md, Requirement 12.8). */
export const STEP_COUNT = 12;

/**
 * The twelve operations in the order design.md fixes them:
 * `sum(payments)`, `sum(refunds)`, `subtract`, `sum(chargebacks)`, `subtract`,
 * `sum(adjustments)`, `add`, `subtract(received)`, `sum(fees)`, `sum(gst_on_fees)`,
 * `subtract`, `subtract`.
 *
 * Step 7 is `add`, not `subtract`, because Requirement 4.2 takes the *signed* sum of
 * adjustments. See the module doc comment on `signed_amount`.
 */
export const EXPECTED_OPERATION_SEQUENCE: readonly EvidenceOperation[] = [
  'sum', // 1  Σ payments
  'sum', // 2  Σ refunds
  'subtract', // 3  payments − refunds
  'sum', // 4  Σ chargebacks
  'subtract', // 5  − chargebacks
  'sum', // 6  signed Σ adjustments
  'add', // 7  + adjustments  → Expected Amount
  'subtract', // 8  − received      → Difference
  'sum', // 9  Σ fee lines
  'sum', // 10 Σ GST-on-fee lines
  'subtract', // 11 Difference − fee
  'subtract', // 12 − GST         → residual
];

/** The step whose `result_paise` is the Expected Amount (Requirement 4.2). */
export const EXPECTED_AMOUNT_STEP_INDEX = 7;

/** The step whose `result_paise` is the Difference (Requirement 4.2). */
export const DIFFERENCE_STEP_INDEX = 8;

/** The terminal step, whose `result_paise` is the residual and the chain's figure. */
export const RESIDUAL_STEP_INDEX = 12;

/** The field names the chain cites. `signed_amount` is the projection `credit − debit`. */
export const FIELD = {
  amount: 'amount',
  fee: 'fee',
  tax: 'tax',
  debit: 'debit',
  credit: 'credit',
  signed_amount: 'signed_amount',
} as const;

// ---------------------------------------------------------------------------
// Construction helpers
//
// These build structure, never figures: every monetary value is passed in as an
// explicit literal below and none is computed here. Both chains are built by the
// same function so the twelve operations and the operand shapes are identical by
// construction, and only the identifiers and the stated results differ.
// ---------------------------------------------------------------------------

const reconRef = (id: string): SourceRef => ({ type: 'settlement_recon_report', id });
const settlementRef = (id: string): SourceRef => ({ type: 'settlement', id });

const src = (ref: SourceRef, field: string): EvidenceOperand => ({
  kind: 'source',
  ref,
  field,
});

const prior = (index: number): EvidenceOperand => ({ kind: 'step', index });

/**
 * One Source_Record as the chain reads it. The annotation is what keeps the field maps
 * open: written inline, an array of object literals with differing keys infers a union
 * with `signed_amount?: undefined` members, which no longer matches
 * `Record<string, Paise>`.
 */
const record = (
  ref: SourceRef,
  fields: Readonly<Record<string, Paise>>,
  recordUpdatedAt: string,
): EvidenceSourceRecord => ({ ref, fields, record_updated_at: recordUpdatedAt });

/** Freezes a fixture so a consumer cannot mutate it for the next consumer. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** The identifiers of one Settlement's recon report lines and Settlement object. */
interface ExampleIds {
  readonly settlement: string;
  readonly paymentLines: readonly [string, string, string];
  readonly refundLine: string;
  readonly chargebackLine: string;
  readonly adjustmentLines: readonly [string, string];
}

/**
 * The twelve step results, stated. Named rather than positional so a transposed pair is a
 * compile error rather than a silently wrong chain.
 */
interface StepResults {
  readonly sumPayments: Paise;
  readonly sumRefunds: Paise;
  readonly lessRefunds: Paise;
  readonly sumChargebacks: Paise;
  readonly lessChargebacks: Paise;
  readonly sumAdjustments: Paise;
  readonly expected: Paise;
  readonly difference: Paise;
  readonly sumFees: Paise;
  readonly sumGst: Paise;
  readonly differenceLessFee: Paise;
  readonly residual: Paise;
}

function buildSteps(ids: ExampleIds, r: StepResults): readonly EvidenceStep[] {
  const [pay1, pay2, pay3] = ids.paymentLines;
  const [adj1, adj2] = ids.adjustmentLines;
  const payRefs = [reconRef(pay1), reconRef(pay2), reconRef(pay3)];

  return [
    {
      index: 1,
      operation: 'sum',
      operands: payRefs.map((ref) => src(ref, FIELD.amount)),
      result_paise: r.sumPayments,
      note: 'Σ Payment amounts enumerated in the Settlement_Recon_Report (Requirement 4.2)',
    },
    {
      index: 2,
      operation: 'sum',
      operands: [src(reconRef(ids.refundLine), FIELD.amount)],
      result_paise: r.sumRefunds,
      note: 'Σ Refund amounts enumerated in the report',
    },
    {
      index: 3,
      operation: 'subtract',
      operands: [prior(1), prior(2)],
      result_paise: r.lessRefunds,
      note: 'payments − refunds',
    },
    {
      index: 4,
      operation: 'sum',
      operands: [src(reconRef(ids.chargebackLine), FIELD.amount)],
      result_paise: r.sumChargebacks,
      note: 'Σ chargeback amounts enumerated in the report',
    },
    {
      index: 5,
      operation: 'subtract',
      operands: [prior(3), prior(4)],
      result_paise: r.lessChargebacks,
      note: '− chargebacks',
    },
    {
      index: 6,
      operation: 'sum',
      operands: [
        src(reconRef(adj1), FIELD.signed_amount),
        src(reconRef(adj2), FIELD.signed_amount),
      ],
      result_paise: r.sumAdjustments,
      note: 'signed Σ adjustments: negative for a debit line, so the sum is negative here',
    },
    {
      index: 7,
      operation: 'add',
      operands: [prior(5), prior(6)],
      result_paise: r.expected,
      note: 'Expected Amount (Requirement 4.2). `add`, because the adjustment sum is signed',
    },
    {
      index: 8,
      operation: 'subtract',
      operands: [prior(7), src(settlementRef(ids.settlement), FIELD.amount)],
      result_paise: r.difference,
      note: 'Difference = Expected Amount − received amount (Requirement 4.2)',
    },
    {
      index: 9,
      operation: 'sum',
      operands: payRefs.map((ref) => src(ref, FIELD.fee)),
      result_paise: r.sumFees,
      note: 'Razorpay_Fee component: Σ fee lines in the report (Requirement 4.3)',
    },
    {
      index: 10,
      operation: 'sum',
      operands: payRefs.map((ref) => src(ref, FIELD.tax)),
      result_paise: r.sumGst,
      note: 'GST_On_Fee component: Σ GST-on-fee lines in the report (Requirement 4.3)',
    },
    {
      index: 11,
      operation: 'subtract',
      operands: [prior(8), prior(9)],
      result_paise: r.differenceLessFee,
      note: 'Difference − Razorpay_Fee component',
    },
    {
      index: 12,
      operation: 'subtract',
      operands: [prior(11), prior(10)],
      result_paise: r.residual,
      note: 'unexplained residual = Difference − fee − GST (Requirement 4.3). The chain figure',
    },
  ];
}

/** The 8 distinct Source_Records the twelve steps read, in first-reference order. */
function buildSources(ids: ExampleIds): readonly SourceRef[] {
  return [
    ...ids.paymentLines.map(reconRef),
    reconRef(ids.refundLine),
    reconRef(ids.chargebackLine),
    ...ids.adjustmentLines.map(reconRef),
    settlementRef(ids.settlement),
  ];
}

// ---------------------------------------------------------------------------
// SET-9281 — the zero-residual worked example (Requirement 4.4)
//
//     Σpayments      52000000 + 30000000 + 8000000  =  90000000
//     − Σrefunds     − 4500000                      =  85500000
//     − Σchargebacks − 750000                       =  84750000
//     + Σadjustments + (−300000 + −190000)          =  84260000  ← Expected Amount
//     − received     − 81940000                     =   2320000  ← Difference
//     − Σfees        − 1966100                      =    353900
//     − Σgst         − 353900                       =         0  ← residual
//
// 1966100n + 353900n = 2320000n, so the residual is exactly 0n. Requirement 4.4
// admits no tolerance band: "difference explained" means the residual *equals*
// 0 paise. Status `difference_explained`, direction `not_applicable`, and **no
// Exception is created**.
// ---------------------------------------------------------------------------

const IDS_9281: ExampleIds = {
  settlement: 'setl_SYNTHETIC9281',
  paymentLines: ['pay_SYNTHETIC92811', 'pay_SYNTHETIC92812', 'pay_SYNTHETIC92813'],
  refundLine: 'rfnd_SYNTHETIC92811',
  chargebackLine: 'disp_SYNTHETIC92811',
  adjustmentLines: ['adj_SYNTHETIC92811', 'adj_SYNTHETIC92812'],
};

/** `settled_at` of every line and `created_at` of the Settlement: 1785196800 Unix seconds. */
const AS_OF_9281 = '2026-07-28T00:00:00.000Z';

export const SET_9281: WorkedExample = deepFreeze({
  display_name: 'SET-9281',
  settlement_id: IDS_9281.settlement,
  recon_report_id: 'setlrcn_SYNTHETIC9281',
  settlement_date: '2026-07-28',
  received_paise: 81940000n,
  lines: {
    payments: [52000000n, 30000000n, 8000000n],
    refunds: [4500000n],
    chargebacks: [750000n],
    adjustments: [-300000n, -190000n],
    fees: [1040000n, 600000n, 326100n],
    gst_on_fees: [187200n, 108000n, 58700n],
  },
  recon: {
    settlement_id: IDS_9281.settlement,
    expected_paise: 84260000n,
    received_paise: 81940000n,
    difference_paise: 2320000n,
    fee_component_paise: 1966100n,
    gst_component_paise: 353900n,
    residual_paise: 0n,
    status: 'difference_explained',
    direction: 'not_applicable',
  },
  // Requirement 4.4: no Exception for a zero residual.
  exception: null,
  examined: {
    payments_counted: 3,
    refunds_counted: 1,
    chargebacks_counted: 1,
    adjustments_counted: 2,
  },
  records: [
    record(
      reconRef('pay_SYNTHETIC92811'),
      { amount: 52000000n, fee: 1040000n, tax: 187200n, debit: 0n, credit: 50772800n },
      AS_OF_9281,
    ),
    record(
      reconRef('pay_SYNTHETIC92812'),
      { amount: 30000000n, fee: 600000n, tax: 108000n, debit: 0n, credit: 29292000n },
      AS_OF_9281,
    ),
    record(
      reconRef('pay_SYNTHETIC92813'),
      { amount: 8000000n, fee: 326100n, tax: 58700n, debit: 0n, credit: 7615200n },
      AS_OF_9281,
    ),
    record(
      reconRef('rfnd_SYNTHETIC92811'),
      { amount: 4500000n, fee: 0n, tax: 0n, debit: 4500000n, credit: 0n },
      AS_OF_9281,
    ),
    record(
      reconRef('disp_SYNTHETIC92811'),
      { amount: 750000n, fee: 0n, tax: 0n, debit: 750000n, credit: 0n },
      AS_OF_9281,
    ),
    // The two adjustments are debit lines: Razorpay keeps `amount` positive and carries
    // the direction in `debit`, so `signed_amount` — the projection `credit − debit` —
    // is negative. Step 6 sums `signed_amount`, which is why step 7 is `add`.
    record(
      reconRef('adj_SYNTHETIC92811'),
      { amount: 300000n, fee: 0n, tax: 0n, debit: 300000n, credit: 0n, signed_amount: -300000n },
      AS_OF_9281,
    ),
    record(
      reconRef('adj_SYNTHETIC92812'),
      { amount: 190000n, fee: 0n, tax: 0n, debit: 190000n, credit: 0n, signed_amount: -190000n },
      AS_OF_9281,
    ),
    // The Settlement object: `amount` is the received amount; `fees` and `tax` mirror the
    // report totals. Step 8 reads `amount`.
    record(
      settlementRef(IDS_9281.settlement),
      { amount: 81940000n, fees: 1966100n, tax: 353900n },
      AS_OF_9281,
    ),
  ],
  chain: {
    evidence_chain_id: '92810000-0000-4281-8281-000000009281',
    // The residual, the result of step 12. See the module doc comment.
    figure_paise: 0n,
    sources: buildSources(IDS_9281),
    source_count: 8,
    steps: buildSteps(IDS_9281, {
      sumPayments: 90000000n,
      sumRefunds: 4500000n,
      lessRefunds: 85500000n,
      sumChargebacks: 750000n,
      lessChargebacks: 84750000n,
      sumAdjustments: -490000n,
      expected: 84260000n,
      difference: 2320000n,
      sumFees: 1966100n,
      sumGst: 353900n,
      differenceLessFee: 353900n,
      residual: 0n,
    }),
    as_of: AS_OF_9281,
    produced_by: PRODUCED_BY,
  },
});

// ---------------------------------------------------------------------------
// The ₹19,000 fee variant (Requirement 4.5)
//
// design.md: "Had the report enumerated a fee of ₹19,000.00 instead, the residual
// would be 2320000n − 1900000n − 353900n = 66100n." Task 7.1 realised that variant
// as a second Settlement, SET-9282, with its own identifiers and settlement date;
// this fixture mirrors those identifiers so the same figures serve the unit path
// and the end-to-end path.
//
// Every figure above the fee line is SET-9281's unchanged. The report enumerates a
// fee of 1900000 while still enumerating 353900 of GST on it — that inconsistency
// is the anomaly under test, not a transcription slip. Residual 66100n > 0n, so:
// status `mismatch`, direction `unexplained_shortfall`, and a `settlement_mismatch`
// Exception with impact 66100n referencing the Settlement and the report.
// ---------------------------------------------------------------------------

const IDS_9282: ExampleIds = {
  settlement: 'setl_SYNTHETIC9282',
  paymentLines: ['pay_SYNTHETIC92821', 'pay_SYNTHETIC92822', 'pay_SYNTHETIC92823'],
  refundLine: 'rfnd_SYNTHETIC92821',
  chargebackLine: 'disp_SYNTHETIC92821',
  adjustmentLines: ['adj_SYNTHETIC92821', 'adj_SYNTHETIC92822'],
};

const RECON_REPORT_ID_9282 = 'setlrcn_SYNTHETIC9282';

/** `settled_at` of every line and `created_at` of the Settlement: 1785283200 Unix seconds. */
const AS_OF_9282 = '2026-07-29T00:00:00.000Z';

export const SET_9281_FEE_VARIANT: WorkedExample = deepFreeze({
  display_name: 'SET-9282',
  settlement_id: IDS_9282.settlement,
  recon_report_id: RECON_REPORT_ID_9282,
  settlement_date: '2026-07-29',
  received_paise: 81940000n,
  lines: {
    payments: [52000000n, 30000000n, 8000000n],
    refunds: [4500000n],
    chargebacks: [750000n],
    adjustments: [-300000n, -190000n],
    fees: [1000000n, 580000n, 320000n],
    gst_on_fees: [180000n, 104400n, 69500n],
  },
  recon: {
    settlement_id: IDS_9282.settlement,
    expected_paise: 84260000n,
    received_paise: 81940000n,
    difference_paise: 2320000n,
    fee_component_paise: 1900000n,
    gst_component_paise: 353900n,
    residual_paise: 66100n,
    status: 'mismatch',
    direction: 'unexplained_shortfall',
  },
  exception: {
    category: 'settlement_mismatch',
    impact_paise: 66100n,
    direction: 'unexplained_shortfall',
    lifecycle_state: 'open',
    // Requirement 4.5: the Settlement identifier and the Settlement_Recon_Report identifier.
    source_refs: [
      settlementRef(IDS_9282.settlement),
      reconRef(RECON_REPORT_ID_9282),
    ],
  },
  examined: {
    payments_counted: 3,
    refunds_counted: 1,
    chargebacks_counted: 1,
    adjustments_counted: 2,
  },
  records: [
    record(
      reconRef('pay_SYNTHETIC92821'),
      { amount: 52000000n, fee: 1000000n, tax: 180000n, debit: 0n, credit: 50820000n },
      AS_OF_9282,
    ),
    record(
      reconRef('pay_SYNTHETIC92822'),
      { amount: 30000000n, fee: 580000n, tax: 104400n, debit: 0n, credit: 29315600n },
      AS_OF_9282,
    ),
    record(
      reconRef('pay_SYNTHETIC92823'),
      { amount: 8000000n, fee: 320000n, tax: 69500n, debit: 0n, credit: 7610500n },
      AS_OF_9282,
    ),
    record(
      reconRef('rfnd_SYNTHETIC92821'),
      { amount: 4500000n, fee: 0n, tax: 0n, debit: 4500000n, credit: 0n },
      AS_OF_9282,
    ),
    record(
      reconRef('disp_SYNTHETIC92821'),
      { amount: 750000n, fee: 0n, tax: 0n, debit: 750000n, credit: 0n },
      AS_OF_9282,
    ),
    record(
      reconRef('adj_SYNTHETIC92821'),
      { amount: 300000n, fee: 0n, tax: 0n, debit: 300000n, credit: 0n, signed_amount: -300000n },
      AS_OF_9282,
    ),
    record(
      reconRef('adj_SYNTHETIC92822'),
      { amount: 190000n, fee: 0n, tax: 0n, debit: 190000n, credit: 0n, signed_amount: -190000n },
      AS_OF_9282,
    ),
    record(
      settlementRef(IDS_9282.settlement),
      { amount: 81940000n, fees: 1900000n, tax: 353900n },
      AS_OF_9282,
    ),
  ],
  chain: {
    evidence_chain_id: '92820000-0000-4282-8282-000000009282',
    figure_paise: 66100n,
    sources: buildSources(IDS_9282),
    source_count: 8,
    steps: buildSteps(IDS_9282, {
      sumPayments: 90000000n,
      sumRefunds: 4500000n,
      lessRefunds: 85500000n,
      sumChargebacks: 750000n,
      lessChargebacks: 84750000n,
      sumAdjustments: -490000n,
      expected: 84260000n,
      difference: 2320000n,
      sumFees: 1900000n,
      sumGst: 353900n,
      differenceLessFee: 420000n,
      residual: 66100n,
    }),
    as_of: AS_OF_9282,
    produced_by: PRODUCED_BY,
  },
});

/** Both worked examples: the zero-residual one first, then the ₹19,000 fee variant. */
export const WORKED_EXAMPLES: readonly WorkedExample[] = deepFreeze([
  SET_9281,
  SET_9281_FEE_VARIANT,
]);

/** Looks a Source_Record up by ref within one example. Returns `undefined` when absent. */
export function findRecord(
  example: WorkedExample,
  ref: SourceRef,
): EvidenceSourceRecord | undefined {
  return example.records.find((r) => r.ref.type === ref.type && r.ref.id === ref.id);
}
