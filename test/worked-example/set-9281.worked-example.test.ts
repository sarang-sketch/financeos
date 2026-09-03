/**
 * SET-9281 — design.md's settlement worked example, end to end (task 11.3, extended by
 * task 13.2).
 * Requirements 4.3, 4.4, 4.5, 4.12, 4.15, 12.8. Properties P3, P6.
 *
 * This is the one case a reader of design.md will click on, so it is the one case
 * proven here on the real production path rather than on a look-alike: the figures
 * come out of `reconcileSettlement`, the chain goes through
 * `composeEvidenceChain` → `evidenceChainWriteFor` → the JSONB round trip →
 * `parseEvidenceOperands`, and the replay reads what came **back out**.
 *
 * ## What this file adds over what already passes
 *
 * | Already proven | Where | What is left |
 * |---|---|---|
 * | the three residual signs, the no-tolerance rule, the shortfall aggregation, the row mapping | `src/agents/reconciliation/reconcile-settlement.test.ts` (11.1) | all of it on **synthetic** reports (`setl_zero`, `setl_short`, …). Nothing drives design.md's figures |
 * | the twelve steps replay to `0n`, `2320000n` at step 8, `66100n` for the variant | `test/evidence/replay-interpreter.test.ts` (9.2) | the replay is of the **in-memory fixture object**. Nothing had been persisted |
 * | the SET-9281 chain persists to real Postgres and reads back field for field | `test/db/evidence-chain.test.ts` (9.1) | the read-back chain is compared against the fixture but **never replayed** — `grep -r replay test/db` matches nothing |
 *
 * So the gap this file closes is the join of the three: design.md's stated figures,
 * produced by the function the tool calls, with the chain **replayed out of
 * persistence** rather than out of the fixture. A chain that round-tripped into a
 * shape that still compares equal but no longer replays would pass every one of the
 * three suites above and fail here.
 *
 * ## Persisted through the in-memory store, not through Postgres
 *
 * `createMemoryEvidenceStore` (task 9.3) is the store, so this file stays in the
 * `unit` project — stage 3, in process, no database, no network. The reasoning:
 *
 *   1. **The round trip a replay depends on is entirely TypeScript.**
 *      `evidenceChainWriteFor` renames `index` to `step_index` and turns every
 *      `Paise` into an integer string through `toWire`; the operands cross as JSON
 *      **text** and come back as a parsed value; `parseEvidenceOperands` and
 *      `fromWire` decode them. All four run here, unchanged, and the memory store
 *      hands the integer strings back untouched so the decode is the builder's.
 *   2. **The SQL half is already proven, against a real transactional session.**
 *      `test/db/evidence-chain.test.ts` writes this exact chain to Supabase local
 *      and reads the header, the twelve steps, the operands and all 8 identifiers
 *      back. Restating it here would buy a slower copy of a covered fact — and,
 *      since several db suites commit rows they cannot clean up, a fresh fixture
 *      Tenant plus more uncleanable rows for no additional assurance.
 *   3. **The acceptance anchor should be the fastest test in the repo.** It is the
 *      figure everyone looks at; it should run on every save, not behind Docker.
 *
 * `test/db/evidence-chain.test.ts` remains the place the atomic three-table write
 * is proven. What is *not* covered anywhere is a replay of a chain read back out of
 * **real** Postgres; that is worth a line in a future db suite and is stated here
 * rather than left implicit.
 *
 * ## The Exception half, as of task 13.2
 *
 * The task text asks for "a `settlement_mismatch` Exception with impact `66100n`".
 * When this file was written no Exception could be created at all — 11.1 deliberately
 * creates none and task 11.4 owns only the fingerprint and the upsert — so the two
 * Exception blocks asserted everything that existed then (the category the fixture
 * states, `residualImpactPaise` as the impact, the direction, the status) and carried a
 * marker naming task 13.2 as the owner of the row itself.
 *
 * **Task 13.2 has landed and both blocks are extended.** `runOver` drives
 * `createReconciliationAgent` over the worked examples through the in-memory
 * implementations of the two upsert statements, so the assertions are now about rows:
 * SET-9281 leaves **zero** `settlement_mismatch` rows — on a first run, on a re-run,
 * and beside a Settlement that does mismatch — while the ₹19,000 fee variant creates
 * exactly one, field for field against `SET_9281_FEE_VARIANT.exception`, and a re-run
 * updates that one row rather than opening a second (Requirement 4.15).
 *
 * The half that matters most was assertable from the start and still is: Requirement
 * 4.4's **no Exception for a zero residual** is `residualImpactPaise(recon) === null`,
 * which is precisely "there is no Exception to create".
 *
 * ## Money
 *
 * Integer paise in `bigint`, always. No `Number(...)` on a monetary value, no
 * `toFixed`, no `Intl.NumberFormat`. "Difference explained" is `residual === 0n`
 * with no tolerance band (Requirement 4.4).
 */

import { describe, expect, it } from 'vitest';

import { exceptionDirectionFor } from '@/agents/exception-fingerprint';
import {
  createReconciliationAgent,
  inScopePaymentIds,
  type ReconciliationRunReport,
} from '@/agents/reconciliation/agent';
import {
  type MemoryExceptionStore,
  type MemoryReconStore,
  memoryExceptionStore,
  memoryLinkStore,
  memoryReconStore,
  memoryScopeStore,
} from '@/agents/reconciliation/agent.test-support';
import {
  examinedCounts,
  reconcileSettlement,
  residualDirection,
  residualImpactPaise,
  type SettlementRecon,
  settlementReconWriteFor,
} from '@/agents/reconciliation/reconcile-settlement';
import {
  composeEvidenceChain,
  createEvidenceChainBuilder,
  type EvidenceChainInput,
  type EvidenceChainView,
  evidenceChainWriteFor,
  type EvidenceSourceCitation,
} from '@/evidence/chain-builder';

import { monetaryStepResult, recordLookupFromRecords, replaySteps } from '../evidence/replay-interpreter';
import { scopedSettlementFor } from '../fixtures/set-9281.scoped';
import {
  DIFFERENCE_STEP_INDEX,
  EXPECTED_AMOUNT_STEP_INDEX,
  EXPECTED_OPERATION_SEQUENCE,
  findRecord,
  RESIDUAL_STEP_INDEX,
  SET_9281,
  SET_9281_FEE_VARIANT,
  STEP_COUNT,
  TENANT_ID,
  type WorkedExample,
} from '../fixtures/set-9281';
import { createMemoryEvidenceStore } from '../property/evidence-chain-memory-store';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** The Reconciliation_Agent run that would have computed these rows (task 13.2). */
const RUN_ID = '5e771111-0000-4000-8000-000000000001';

/** The five figures Requirement 4.4 records against the Settlement identifier. */
const RECORDED_FIGURES = [
  'expected_paise',
  'received_paise',
  'difference_paise',
  'fee_component_paise',
  'gst_component_paise',
] as const;

/** Drives the function under test from the fixture, with no figure restated. */
function reconcile(example: WorkedExample): SettlementRecon {
  return reconcileSettlement(example.settlement_id, example.received_paise, example.lines);
}

/** The run timestamp, and a settlement date range both worked examples fall inside. */
const RUN_AT = '2026-07-30T09:15:00.000Z';
const RUN_SCOPE = { from: '2026-07-01', to: '2026-07-31' } as const;

interface RunOutcome {
  readonly report: ReconciliationRunReport;
  readonly exceptions: MemoryExceptionStore;
  readonly recons: MemoryReconStore;
}

/**
 * A Reconciliation_Agent run over the worked examples, on the production path (task
 * 13.2).
 *
 * The Settlements arrive through `scopedSettlementFor`, so every figure still comes from
 * `test/fixtures/set-9281.ts` and nothing is restated. The stores are the in-memory
 * implementations of the real statements' semantics — one Exception row per fingerprint,
 * `first_detected_at` written once, one reconciliation row per `(tenant, settlement)` —
 * so "zero `settlement_mismatch` rows" and "the created row" below are statements about
 * rows rather than about intentions.
 *
 * `reuse` runs a second time over the same stores, which is what makes a re-run a
 * re-run (Requirement 4.15).
 */
async function runOver(
  examples: readonly WorkedExample[],
  reuse?: Pick<RunOutcome, 'exceptions' | 'recons'>,
): Promise<RunOutcome> {
  const settlements = examples.map(scopedSettlementFor);
  const exceptions = reuse?.exceptions ?? memoryExceptionStore();
  const recons = reuse?.recons ?? memoryReconStore();
  const agent = createReconciliationAgent({
    tenantId: TENANT_ID,
    settlements: memoryScopeStore({ tenantId: TENANT_ID, settlements }),
    reconciliations: recons,
    exceptions,
    // Every enumerated Payment is known and links to nothing: four not-matched markers,
    // which is a read fact rather than an unread Payment, so the run is complete.
    links: memoryLinkStore(
      inScopePaymentIds(settlements).map((id) => ({
        payment_id: id,
        order_ids: [],
        razorpay_invoice_ids: [],
        settlement_ids: [],
        ledger_entry_ids: [],
      })),
    ),
    newRunId: () => RUN_ID,
    now: () => new Date(RUN_AT),
  });
  return { report: await agent.run(RUN_SCOPE), exceptions, recons };
}

/**
 * The citations the twelve steps imply: one per `{ kind: 'source' }` operand,
 * carrying the `record_updated_at` of the record it names. 14 pairs, 8 identifiers.
 */
function citationsFromSteps(example: WorkedExample): readonly EvidenceSourceCitation[] {
  const citations: EvidenceSourceCitation[] = [];
  for (const step of example.chain.steps) {
    for (const operand of step.operands) {
      if (operand.kind !== 'source') {
        continue;
      }
      const record = findRecord(example, operand.ref);
      if (record === undefined) {
        throw new Error(
          `the fixture cites ${operand.ref.type} ${operand.ref.id} but carries no record for it`,
        );
      }
      citations.push({
        ref: operand.ref,
        field: operand.field,
        record_updated_at: record.record_updated_at,
      });
    }
  }
  return citations;
}

function chainInputFor(example: WorkedExample): EvidenceChainInput {
  return {
    produced_by: example.chain.produced_by,
    figure_paise: example.chain.figure_paise,
    steps: example.chain.steps,
    sources: citationsFromSteps(example),
  };
}

/**
 * Composes, **persists** and reads the chain back — through `evidenceChainWriteFor`,
 * the JSONB round trip and `parseEvidenceOperands`. What comes out is a decoded
 * `EvidenceChainView`, not the fixture object.
 */
async function persistAndRead(example: WorkedExample): Promise<EvidenceChainView> {
  const builder = createEvidenceChainBuilder({
    store: createMemoryEvidenceStore(),
    tenantId: TENANT_ID,
  });

  const result = await builder.build(chainInputFor(example));
  if (!result.ok) {
    throw new Error(`the ${example.display_name} chain did not compose: ${JSON.stringify(result)}`);
  }

  const view = await builder.read(result.evidence.evidence_chain_id);
  if (view === null) {
    throw new Error(`the persisted ${example.display_name} chain could not be read back`);
  }
  return view;
}

/* -------------------------------------------------------------------------- */
/* The identity design.md rests on                                            */
/* -------------------------------------------------------------------------- */

describe('SET-9281: the arithmetic identity (design.md, Requirement 4.3)', () => {
  it('states 1966100n + 353900n === 2320000n, so the residual is exactly zero', () => {
    // design.md's own sentence, as an assertion: the fee and the GST on it account
    // for the whole Difference.
    expect(1966100n + 353900n).toBe(2320000n);
    expect(2320000n - 1966100n - 353900n).toBe(0n);

    // And the same identity over the figures the function produced, so the literals
    // above cannot drift from the computed ones.
    const recon = reconcile(SET_9281);
    const fee = recon.fee_component_paise;
    const gst = recon.gst_component_paise;
    expect(fee).not.toBeNull();
    expect(gst).not.toBeNull();
    if (fee === null || gst === null) return;
    expect(fee + gst).toBe(recon.difference_paise);
    expect(recon.residual_paise).toBe(0n);
  });

  it('had the report enumerated ₹19,000.00 of fee, the residual would be 66100n', () => {
    expect(2320000n - 1900000n - 353900n).toBe(66100n);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4.2, 4.3, 4.4: the six figures                                 */
/* -------------------------------------------------------------------------- */

describe('SET-9281: reconcileSettlement produces design.md’s figures', () => {
  const recon = reconcile(SET_9281);

  it('computes every figure in design.md’s table, in integer paise', () => {
    expect(recon.expected_paise).toBe(84260000n); //        ₹8,42,600.00
    expect(recon.received_paise).toBe(81940000n); //        ₹8,19,400.00
    expect(recon.difference_paise).toBe(2320000n); //       ₹23,200.00
    expect(recon.fee_component_paise).toBe(1966100n); //    ₹19,661.00
    expect(recon.gst_component_paise).toBe(353900n); //     ₹3,539.00
    expect(recon.residual_paise).toBe(0n); //               ₹0.00
  });

  it('marks the Settlement difference explained, with no direction (Requirement 4.4)', () => {
    // Exactly `0n`. There is no tolerance band, and one paisa either way is a
    // mismatch — which `reconcile-settlement.test.ts` proves on a synthetic report.
    expect(recon.status).toBe('difference_explained');
    expect(recon.direction).toBe('not_applicable');
    expect(residualDirection(recon.residual_paise)).toBe('not_applicable');
  });

  it('records every figure against the Settlement identifier (Requirement 4.4)', () => {
    expect(recon.settlement_id).toBe('setl_SYNTHETIC9281');
    expect(recon.settlement_id).toBe(SET_9281.settlement_id);

    // "Recorded against the Settlement identifier" means all five travel on one
    // result keyed by that identifier — not that some are computed and dropped.
    for (const figure of RECORDED_FIGURES) {
      expect(recon[figure]).not.toBeNull();
    }
    expect(Object.fromEntries(RECORDED_FIGURES.map((f) => [f, recon[f]] as const))).toEqual({
      expected_paise: 84260000n,
      received_paise: 81940000n,
      difference_paise: 2320000n,
      fee_component_paise: 1966100n,
      gst_component_paise: 353900n,
    });
  });

  it('carries the figures onto the persisted row, as integer strings', () => {
    // The `settlement_reconciliations` row a store would upsert. Money leaves the
    // process only through `toWire`, so every figure is decimal text, never a number.
    const row = settlementReconWriteFor(TENANT_ID, {
      recon,
      recon_report_id: SET_9281.recon_report_id,
      settlement_date: SET_9281.settlement_date,
      examined: SET_9281.examined,
      evidence_chain_id: SET_9281.chain.evidence_chain_id,
      run_id: RUN_ID,
    });

    expect(row.settlement_id).toBe('setl_SYNTHETIC9281');
    expect(row.tenant_id).toBe(TENANT_ID);
    expect(row.expected_paise).toBe('84260000');
    expect(row.received_paise).toBe('81940000');
    expect(row.difference_paise).toBe('2320000');
    expect(row.fee_component_paise).toBe('1966100');
    expect(row.gst_component_paise).toBe('353900');
    expect(row.residual_paise).toBe('0');
    expect(row.status).toBe('difference_explained');
    expect(row.recon_report_id).toBe('setlrcn_SYNTHETIC9281');
  });

  it('counts the lines the report enumerated (Requirement 4.7)', () => {
    expect(examinedCounts(SET_9281.lines)).toEqual({
      payments_counted: 3,
      refunds_counted: 1,
      chargebacks_counted: 1,
      adjustments_counted: 2,
    });
    expect(examinedCounts(SET_9281.lines)).toEqual(SET_9281.examined);
  });

  it('agrees with the fixture field for field, so neither can drift', () => {
    // `SET_9281.recon` is typed by the very interface `reconcileSettlement` returns,
    // so a field added on one side is a compile error; this is the value check.
    expect(recon).toEqual(SET_9281.recon);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4.4: no Exception                                              */
/* -------------------------------------------------------------------------- */

describe('SET-9281: no Exception is created (Requirement 4.4)', () => {
  const recon = reconcile(SET_9281);

  /*
   * The honest form of "no Exception created" today. `reconcileSettlement` creates
   * no Exception for any Settlement — that is **task 13.2's** — so the assertable
   * statement is that there is nothing for 13.2 to create: `residualImpactPaise` is
   * the impact figure Requirement 4.5 gives the row, and it is `null` exactly when
   * no row is due.
   *
   * Task 13.2 extended this block, as the marker here required: the three tests below
   * the first two drive `createReconciliationAgent` over SET-9281 and assert **zero**
   * `settlement_mismatch` rows — on a first run, on a re-run, and when the Settlement
   * sits in the same run as one that does mismatch. A fully explained Settlement must
   * not raise an alarm.
   */
  it('has no impact figure to raise an Exception with', () => {
    expect(residualImpactPaise(recon)).toBeNull();
    expect(recon.residual_paise).toBe(0n);
    expect(recon.status).not.toBe('mismatch');
  });

  it('is stated by the fixture as expecting no Exception', () => {
    expect(SET_9281.exception).toBeNull();
  });

  it('leaves zero settlement_mismatch rows after a Reconciliation_Agent run', async () => {
    const { report, exceptions, recons } = await runOver([SET_9281]);

    // Requirement 4.4, on rows: nothing was written, and the upserter was never called.
    expect(exceptions.rows.size).toBe(0);
    expect(exceptions.writes).toEqual([]);
    expect(report.exceptions.detections).toEqual([]);
    expect(report.exceptions.created_count).toBe(0);

    // The five figures are still recorded against the Settlement identifier — "no
    // Exception" is not "no result" (Requirement 4.4).
    expect(recons.rows.size).toBe(1);
    expect(report.settlements[0]?.recon).toEqual(SET_9281.recon);
    expect(report.settlements[0]?.recon.status).toBe('difference_explained');
    expect(report.shortfall.total_shortfall_paise).toBe(0n);
    expect(report.incomplete).toBeNull();
  });

  it('still raises nothing on a re-run over the unchanged Settlement', async () => {
    const first = await runOver([SET_9281]);
    const second = await runOver([SET_9281], first);

    expect(second.exceptions.rows.size).toBe(0);
    // One reconciliation row, refreshed rather than duplicated (Requirement 4.15).
    expect(second.recons.rows.size).toBe(1);
    expect(second.report.settlements[0]?.created).toBe(false);
  });

  it('raises nothing even sharing a run with the Settlement that does mismatch', async () => {
    const { report, exceptions } = await runOver([SET_9281, SET_9281_FEE_VARIANT]);

    // Exactly one Exception across the run, and it is the other Settlement's.
    expect(report.exceptions.order).toEqual([SET_9281_FEE_VARIANT.settlement_id]);
    expect([...exceptions.rows.values()].map((row) => row.impact_paise)).toEqual(['66100']);
    expect(report.shortfall.shortfall_settlement_ids).toEqual([
      SET_9281_FEE_VARIANT.settlement_id,
    ]);
    // Both Settlements were reconciled; only one of them is an anomaly.
    expect(report.settlements).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4.5: the ₹19,000 fee variant                                   */
/* -------------------------------------------------------------------------- */

describe('the ₹19,000 fee variant: an unexplained shortfall (Requirement 4.5)', () => {
  const recon = reconcile(SET_9281_FEE_VARIANT);

  it('leaves 66100n unexplained, every figure above the fee line unchanged', () => {
    expect(recon.expected_paise).toBe(84260000n);
    expect(recon.received_paise).toBe(81940000n);
    expect(recon.difference_paise).toBe(2320000n);
    expect(recon.fee_component_paise).toBe(1900000n); // ₹19,000.00
    expect(recon.gst_component_paise).toBe(353900n);
    expect(recon.residual_paise).toBe(66100n); //        ₹661.00
  });

  it('is a mismatch classified as an unexplained shortfall', () => {
    expect(recon.status).toBe('mismatch');
    expect(recon.direction).toBe('unexplained_shortfall');
    expect(residualDirection(recon.residual_paise)).toBe('unexplained_shortfall');
  });

  /*
   * The Exception itself is **task 13.2's** to create and **task 11.4's** to
   * fingerprint and upsert. What exists today is the impact figure and the
   * classification, so those are asserted against the fixture's stated Exception.
   *
   * Task 13.2 extended this block, as the marker here required: the two tests after the
   * next one run `createReconciliationAgent` over the variant and assert the created row
   * field for field against `SET_9281_FEE_VARIANT.exception` — category
   * `settlement_mismatch`, `impact_paise` 66100n, `lifecycle_state` 'open', and both the
   * Settlement and the Settlement_Recon_Report identifier referenced (Requirement 4.5).
   */
  it('states the impact and classification the settlement_mismatch Exception will carry', () => {
    const expected = SET_9281_FEE_VARIANT.exception;
    expect(expected).not.toBeNull();
    if (expected === null) return;

    expect(expected.category).toBe('settlement_mismatch');
    // |residual| is the INR impact Requirement 4.5 names.
    expect(residualImpactPaise(recon)).toBe(66100n);
    expect(residualImpactPaise(recon)).toBe(expected.impact_paise);
    expect(recon.direction).toBe(expected.direction);
    expect(expected.lifecycle_state).toBe('open');
    expect(expected.source_refs.map((ref) => ref.id)).toEqual([
      SET_9281_FEE_VARIANT.settlement_id,
      SET_9281_FEE_VARIANT.recon_report_id,
    ]);
  });

  it('agrees with the fixture field for field', () => {
    expect(recon).toEqual(SET_9281_FEE_VARIANT.recon);
  });

  it('creates the settlement_mismatch row the fixture states (Requirement 4.5, 4.12)', async () => {
    const expected = SET_9281_FEE_VARIANT.exception;
    expect(expected).not.toBeNull();
    if (expected === null) return;

    const { report, exceptions } = await runOver([SET_9281_FEE_VARIANT]);

    expect(exceptions.rows.size).toBe(1);
    const [row] = [...exceptions.rows.values()];
    expect(row?.category).toBe(expected.category);
    // `|residual|` as integer paise, and the sign in `direction`.
    expect(row?.impact_paise).toBe('66100');
    expect(BigInt(row?.impact_paise ?? '0')).toBe(expected.impact_paise);
    expect(row?.direction).toBe(exceptionDirectionFor(expected.direction));
    expect(row?.state).toBe(expected.lifecycle_state);
    // Requirement 4.5's two references, Requirement 4.12's "at least 1" twice over.
    expect(
      row?.links.map((link) => ({ type: link.source_record_type, id: link.source_record_id })),
    ).toEqual(expected.source_refs);
    // Requirement 4.15: the run timestamp is the detection timestamp, and one run stamps
    // every Exception it touches identically.
    expect(row?.first_detected_at).toBe(report.run_at);
    expect(row?.last_detected_at).toBe(RUN_AT);

    // The same figures on the run's own report, as `Paise` rather than as text.
    expect(report.exceptions.created_count).toBe(1);
    expect(report.exceptions.detections[0]?.impact_paise).toBe(expected.impact_paise);
    expect(report.exceptions.detections[0]?.direction).toBe('shortfall');
    expect(report.shortfall.total_shortfall_paise).toBe(expected.impact_paise);
  });

  it('updates that one row on a re-run rather than opening a second (Requirement 4.15)', async () => {
    const first = await runOver([SET_9281_FEE_VARIANT]);
    const second = await runOver([SET_9281_FEE_VARIANT], first);

    expect(second.exceptions.rows.size).toBe(1);
    expect(second.report.exceptions.created_count).toBe(0);
    expect(second.report.exceptions.updated_count).toBe(1);
    const [row] = [...second.exceptions.rows.values()];
    // Written once, on the first detection.
    expect(row?.first_detected_at).toBe(RUN_AT);
    expect(row?.impact_paise).toBe('66100');
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 12.8: the persisted twelve steps replay                        */
/* -------------------------------------------------------------------------- */

describe('SET-9281: the persisted twelve-step Evidence_Chain (Requirement 12.8)', () => {
  it('persists twelve steps in design.md’s order, over 8 identifiers and 14 citations', () => {
    const draft = composeEvidenceChain(chainInputFor(SET_9281));
    const write = evidenceChainWriteFor(TENANT_ID, draft);

    // The write side: `index` became `step_index`, and every figure is integer text.
    expect(write.steps).toHaveLength(STEP_COUNT);
    expect(write.steps.map((step) => step.step_index)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(write.figure_paise).toBe('0');
    expect(write.steps.map((step) => step.result_paise)).toEqual([
      '90000000',
      '4500000',
      '85500000',
      '750000',
      '84750000',
      '-490000',
      '84260000',
      '2320000',
      '1966100',
      '353900',
      '353900',
      '0',
    ]);

    // 8 identifiers across 14 `(record, field)` citations (Requirement 12.2).
    expect(write.source_count).toBe(8);
    expect(write.sources).toHaveLength(14);
    expect(new Set(write.sources.map((s) => `${s.source_record_type}:${s.source_record_id}`)).size)
      .toBe(8);
  });

  it('reads back twelve steps whose operations are design.md’s fixed sequence', async () => {
    const view = await persistAndRead(SET_9281);

    expect(view.steps).toHaveLength(STEP_COUNT);
    expect(view.steps.map((step) => step.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // `sum, sum, subtract, sum, subtract, sum, add, subtract, sum, sum, subtract, subtract` —
    // the order 11.1's module doc maps step by step onto its own lines of code.
    expect(view.steps.map((step) => step.operation)).toEqual(EXPECTED_OPERATION_SEQUENCE);
    expect(view.source_count).toBe(8);
    expect(view.first_page.sources).toHaveLength(8);
    expect(view.produced_by).toBe('get_settlement_reconciliation');
    expect(view.figure_paise).toBe(0n);
  });

  it('replays to 0n for the residual and 2320000n for the Difference', async () => {
    const view = await persistAndRead(SET_9281);
    const outcome = replaySteps(view.steps, {
      lookup: recordLookupFromRecords(SET_9281.records),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The two figures design.md names, out of the persisted chain.
    expect(outcome.figure_paise).toBe(0n);
    expect(monetaryStepResult(outcome, DIFFERENCE_STEP_INDEX)).toBe(2320000n);
    expect(monetaryStepResult(outcome, RESIDUAL_STEP_INDEX)).toBe(0n);
    expect(monetaryStepResult(outcome, EXPECTED_AMOUNT_STEP_INDEX)).toBe(84260000n);

    // The replayed figure is the persisted header's figure, not the fixture's.
    expect(outcome.figure_paise).toBe(view.figure_paise);
    expect(outcome.step_results).toHaveLength(STEP_COUNT);
  });

  it('replays to the same figures the reconciliation function computed', async () => {
    const recon = reconcile(SET_9281);
    const outcome = replaySteps((await persistAndRead(SET_9281)).steps, {
      lookup: recordLookupFromRecords(SET_9281.records),
    });

    // The tie that makes the chain evidence *for these figures* rather than for a
    // plausible set of its own: the tool's arithmetic and the independent replay of
    // the persisted steps agree at all three checkpoints.
    expect(monetaryStepResult(outcome, EXPECTED_AMOUNT_STEP_INDEX)).toBe(recon.expected_paise);
    expect(monetaryStepResult(outcome, DIFFERENCE_STEP_INDEX)).toBe(recon.difference_paise);
    expect(monetaryStepResult(outcome, RESIDUAL_STEP_INDEX)).toBe(recon.residual_paise);
  });

  it('recomputes the same figures with the stated results ignored entirely', async () => {
    const view = await persistAndRead(SET_9281);
    const outcome = replaySteps(view.steps, {
      lookup: recordLookupFromRecords(SET_9281.records),
      // Nothing is read from `result_paise`: the interpreter is not echoing the chain.
      verifyStatedResults: false,
    });

    expect(monetaryStepResult(outcome, DIFFERENCE_STEP_INDEX)).toBe(2320000n);
    expect(monetaryStepResult(outcome, RESIDUAL_STEP_INDEX)).toBe(0n);
  });

  it('replays the persisted fee variant to 66100n, the Exception impact', async () => {
    const view = await persistAndRead(SET_9281_FEE_VARIANT);
    const outcome = replaySteps(view.steps, {
      lookup: recordLookupFromRecords(SET_9281_FEE_VARIANT.records),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.figure_paise).toBe(66100n);
    expect(outcome.figure_paise).toBe(view.figure_paise);
    expect(monetaryStepResult(outcome, DIFFERENCE_STEP_INDEX)).toBe(2320000n);
    expect(monetaryStepResult(outcome, RESIDUAL_STEP_INDEX)).toBe(
      residualImpactPaise(reconcile(SET_9281_FEE_VARIANT)),
    );
  });
});
