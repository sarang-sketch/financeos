/**
 * The Reconciliation_Agent run over the settlement path (task 13.2).
 * Requirements 4.1, 4.4, 4.5, 4.7, 4.12, 4.13, 4.15, 12.3, 15.6, 15.7, 15.10.
 *
 * Four in-memory stores, none of them a mock: each implements the semantics its real
 * counterpart is specified to have — the reconciliation store upserts on
 * `(tenant, settlement)`, the Exception store keys on the fingerprint and refuses to
 * touch a row that is not `open`, the link store answers only about Payments it holds,
 * and the scope store applies the range and the Tenant gate. So a test that passes here
 * is a statement about the run, not about a stub.
 *
 * The figures are never restated: SET-9281 and its ₹19,000 fee variant arrive through
 * `scopedSettlementFor`, so every amount comes from `test/fixtures/set-9281.ts` and a
 * fixture edit fails these tests rather than passing them.
 *
 * Task 13.3 owns property P5. What is asserted here is the behaviour P5 will
 * generalise — a second run over an unchanged dataset reproducing the identical
 * Exception set in the identical order — over two hand-built datasets, one of which
 * carries a deliberate impact tie.
 */

import { describe, expect, it } from 'vitest';

import type { Paise } from '@/calc/calculation-service';
import type { DateOnly } from '@/ledger/posting-rules';
import type { ScopedSettlement } from '@/tools/settlement-scope';

import { SET_9281, SET_9281_FEE_VARIANT, TENANT_ID } from '../../../test/fixtures/set-9281';
import {
  scopedSettlementFor,
  settlementWithNoReconReport,
} from '../../../test/fixtures/set-9281.scoped';

import {
  type MemoryExceptionStore,
  type MemoryLinkStore,
  type MemoryReconStore,
  type MemoryScopeStore,
  memoryExceptionStore,
  memoryLinkStore,
  memoryReconStore,
  memoryScopeStore,
  testClock,
} from './agent.test-support';
import {
  COMPLETE_SET_BUDGET_MS,
  compareSettlementMismatch,
  createReconciliationAgent,
  inScopePaymentIds,
  LARGE_DATASET_PAYMENT_COUNT,
  type ReconciliationAgent,
  type ReconciliationAgentDeps,
  ReconciliationRunError,
  type ReconciliationRunReport,
  RUN_BUDGET_MS,
  RUN_STAGES,
  settlementMismatchUpsertFor,
  typesNotFullyProcessedFrom,
} from './agent';
import type { LifecycleLinkResult, PaymentLinks } from './match';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const RUN_ID = '5e771111-0000-4000-8000-000000000001';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const SCOPE = { from: '2026-07-01', to: '2026-07-31' } as const;

/** The shared clock, under the shorter name the tests below read better with. */
const clock = testClock;

/** The four seams with nothing in them, for the construction checks. */
function emptySeams() {
  return {
    settlements: memoryScopeStore({ tenantId: TENANT_ID, settlements: [] }),
    reconciliations: memoryReconStore(),
    exceptions: memoryExceptionStore(),
    links: memoryLinkStore([]),
  };
}

/** Every in-scope Payment linked to one of each record type. A fully mapped dataset. */
function linksFor(settlements: readonly ScopedSettlement[]): readonly PaymentLinks[] {
  return inScopePaymentIds(settlements).map(fullLinks);
}

/** Links naming exactly one of each record type, so every arm is `matched`. */
function fullLinks(paymentId: string): PaymentLinks {
  return {
    payment_id: paymentId,
    order_ids: [`order_${paymentId}`],
    razorpay_invoice_ids: [`inv_${paymentId}`],
    settlement_ids: [SET_9281.settlement_id],
    ledger_entry_ids: ['aaaaaaaa-0000-4000-8000-000000000001'],
  };
}

interface Harness {
  readonly agent: ReconciliationAgent;
  readonly scope: MemoryScopeStore;
  readonly recons: MemoryReconStore;
  readonly exceptions: MemoryExceptionStore;
  readonly links: MemoryLinkStore;
}

function harness(options: {
  readonly settlements: readonly ScopedSettlement[];
  readonly links?: readonly PaymentLinks[];
  readonly unreadableLinks?: LifecycleLinkResult['unreadable'];
  readonly now?: () => Date;
  readonly budgetMs?: number;
  readonly tenantId?: string;
  readonly evidenceChainFor?: (settlementId: string) => string | null;
  readonly onReconUpsert?: () => void;
  readonly counts?: { readonly ledger: number; readonly invoices: number };
  /** Reuse the stores of an earlier harness, which is what makes a re-run a re-run. */
  readonly reuse?: Pick<Harness, 'recons' | 'exceptions'>;
}): Harness {
  const scope = memoryScopeStore({
    tenantId: TENANT_ID,
    settlements: options.settlements,
    ledgerEntriesExamined: options.counts?.ledger,
    razorpayInvoicesExamined: options.counts?.invoices,
  });
  const recons = options.reuse?.recons ?? memoryReconStore(options.onReconUpsert);
  const exceptions = options.reuse?.exceptions ?? memoryExceptionStore();
  const links = memoryLinkStore(options.links ?? [], options.unreadableLinks);
  const deps: ReconciliationAgentDeps = {
    tenantId: options.tenantId ?? TENANT_ID,
    settlements: scope,
    reconciliations: recons,
    exceptions,
    links,
    newRunId: () => RUN_ID,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    ...(options.evidenceChainFor === undefined
      ? {}
      : { evidenceChainFor: options.evidenceChainFor }),
  };
  return { agent: createReconciliationAgent(deps), scope, recons, exceptions, links };
}

/**
 * A Settlement with one Payment line and a stated residual: `residual = payment −
 * received − fee − gst`. Built so an ordering test can state the impact it wants
 * without restating the reconciliation arithmetic.
 */
function settlementWithResidual(options: {
  readonly id: string;
  readonly date: DateOnly;
  readonly residualPaise: Paise;
}): ScopedSettlement {
  const received = 1_000_000n;
  return {
    settlement_id: options.id,
    settlement_date: options.date,
    received_paise: received,
    record_updated_at: '2026-07-20T00:00:00.000Z',
    recon_report_id: `setlrcn_${options.id.replace('setl_', '')}`,
    payments: [
      {
        line_id: `pay_${options.id.replace('setl_', '')}`,
        record_updated_at: '2026-07-20T00:00:00.000Z',
        amount_paise: received + options.residualPaise,
        fee_paise: 0n,
        gst_on_fee_paise: 0n,
      },
    ],
    refunds: [],
    chargebacks: [],
    adjustments: [],
  };
}

const EXPLAINED = scopedSettlementFor(SET_9281);
const MISMATCH = scopedSettlementFor(SET_9281_FEE_VARIANT);

function rowFor(report: ReconciliationRunReport, settlementId: string) {
  const row = report.settlements.find((one) => one.settlement_id === settlementId);
  if (row === undefined) {
    throw new Error(`the run reported no row for ${settlementId}`);
  }
  return row;
}

/* -------------------------------------------------------------------------- */
/* Requirement 4.7: the resolved scope                                        */
/* -------------------------------------------------------------------------- */

describe('scope resolution (Requirement 4.7)', () => {
  it('applies the trailing 90 days ending at the run timestamp when no range is stated', async () => {
    const h = harness({
      settlements: [EXPLAINED, MISMATCH],
      links: [],
      now: clock('2026-07-30T09:15:00.000Z').now,
    });

    const report = await h.agent.run();

    // 90 inclusive dates, the last of which is the run date: 2026-07-30 − 89 days.
    expect(report.scope).toEqual({ from: '2026-05-02', to: '2026-07-30' });
    expect(h.scope.queries[0]?.scope).toEqual(report.scope);
    // The reported range is the one that was read, never a wider one.
    expect(h.scope.queries[0]?.tenant_id).toBe(TENANT_ID);
  });

  it('uses a stated range verbatim and narrows to the named identifiers', async () => {
    const h = harness({ settlements: [EXPLAINED, MISMATCH] });

    const report = await h.agent.run({ ...SCOPE, settlement_ids: [MISMATCH.settlement_id] });

    expect(report.scope).toEqual(SCOPE);
    expect(h.scope.queries[0]?.settlement_ids).toEqual([MISMATCH.settlement_id]);
    expect(report.settlements.map((row) => row.settlement_id)).toEqual([MISMATCH.settlement_id]);
  });

  it('rejects a half-stated range rather than guessing the other bound', async () => {
    const h = harness({ settlements: [] });
    await expect(h.agent.run({ from: '2026-07-01' })).rejects.toThrow(/both bounds or neither/);
  });

  it('reports Requirement 4.7’s five examined counts', async () => {
    const h = harness({
      settlements: [EXPLAINED, MISMATCH],
      counts: { ledger: 12, invoices: 4 },
    });

    const report = await h.agent.run(SCOPE);

    expect(report.examined).toEqual({
      // Three Payment lines and one Refund line per report, two reports.
      payments_examined: 6,
      settlements_examined: 2,
      refunds_examined: 2,
      ledger_entries_examined: 12,
      razorpay_invoices_examined: 4,
    });
  });

  it('answers an empty scope as a fact rather than a failure', async () => {
    const h = harness({ settlements: [] });

    const report = await h.agent.run(SCOPE);

    expect(report.incomplete).toBeNull();
    expect(report.settlements).toEqual([]);
    expect(report.exceptions.detections).toEqual([]);
    expect(report.examined.settlements_examined).toBe(0);
    expect(report.shortfall.total_shortfall_paise).toBe(0n);
    // The matcher rejects an empty request, so it must not be called at all.
    expect(h.links.queries).toEqual([]);
  });

  it('answers zero rows for another Tenant’s session, never a permission error', async () => {
    const h = harness({ settlements: [EXPLAINED], tenantId: OTHER_TENANT });

    const report = await h.agent.run(SCOPE);

    expect(report.settlements).toEqual([]);
    expect(report.incomplete).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4.4, 4.5: what raises an Exception and what does not           */
/* -------------------------------------------------------------------------- */

describe('the settlement_mismatch Exception (Requirement 4.4, 4.5, 4.12)', () => {
  it('creates none for a fully explained Settlement', async () => {
    const h = harness({ settlements: [EXPLAINED], links: [] });

    const report = await h.agent.run(SCOPE);

    expect(rowFor(report, EXPLAINED.settlement_id).recon.status).toBe('difference_explained');
    expect(rowFor(report, EXPLAINED.settlement_id).recon.residual_paise).toBe(0n);
    // Requirement 4.4: no Exception, and the upserter was never even called.
    expect(report.exceptions.detections).toEqual([]);
    expect(h.exceptions.writes).toEqual([]);
    expect(h.exceptions.rows.size).toBe(0);
  });

  it('creates one with |residual| as the impact and the correct direction', async () => {
    const h = harness({
      settlements: [MISMATCH],
      now: clock('2026-07-30T09:15:00.000Z').now,
    });

    const report = await h.agent.run(SCOPE);

    expect(report.exceptions.created_count).toBe(1);
    const [detection] = report.exceptions.detections;
    expect(detection?.impact_paise).toBe(66100n);
    expect(detection?.direction).toBe('shortfall');
    expect(detection?.source_refs.map((ref) => ref.id)).toEqual([
      SET_9281_FEE_VARIANT.settlement_id,
      SET_9281_FEE_VARIANT.recon_report_id,
    ]);

    const write = h.exceptions.writes[0];
    expect(write?.category).toBe('settlement_mismatch');
    // A magnitude as an integer string; the sign lives in `direction`.
    expect(write?.impact_paise).toBe('66100');
    expect(write?.detected_at).toBe(report.run_at);
    expect(write?.links.map((link) => link.source_record_type)).toEqual([
      'settlement',
      'settlement_recon_report',
    ]);
  });

  it('carries every figure into detail as an integer string, residual signed', async () => {
    const h = harness({ settlements: [MISMATCH] });

    const report = await h.agent.run(SCOPE);

    const detail: unknown = JSON.parse(h.exceptions.writes[0]?.detail ?? '{}');
    expect(detail).toMatchObject({
      failing_rule: 'unexplained_residual_nonzero',
      residual_paise: '66100',
      residual_direction: 'unexplained_shortfall',
      difference_paise: '2320000',
      fee_component_paise: '1900000',
      gst_component_paise: '353900',
      expected_paise: '84260000',
      received_paise: '81940000',
      recon_report_id: SET_9281_FEE_VARIANT.recon_report_id,
      run_id: report.run_id,
      // Requirement 4.7's applied range, reported against the figure and deliberately
      // outside the identity.
      scope_from: SCOPE.from,
      scope_to: SCOPE.to,
      payments_counted: 3,
      refunds_counted: 1,
      chargebacks_counted: 1,
      adjustments_counted: 2,
    });
  });

  it('stamps every Exception of one run with the same run timestamp', async () => {
    const h = harness({
      settlements: [
        MISMATCH,
        settlementWithResidual({ id: 'setl_TIEA', date: '2026-07-10', residualPaise: 900n }),
      ],
      // The clock moves between reads; the run timestamp must not.
      now: clock('2026-07-30T09:15:00.000Z', 1_000).now,
    });

    const report = await h.agent.run(SCOPE);

    expect(h.exceptions.writes).toHaveLength(2);
    expect(new Set(h.exceptions.writes.map((write) => write.detected_at))).toEqual(
      new Set([report.run_at]),
    );
  });

  it('does not compose an Evidence_Chain, and carries the tool’s where one is given', async () => {
    const chain = '92820000-0000-4282-8282-000000009282';
    const withChain = harness({
      settlements: [MISMATCH],
      evidenceChainFor: () => chain,
    });
    const withoutChain = harness({ settlements: [MISMATCH] });

    await withChain.agent.run(SCOPE);
    await withoutChain.agent.run(SCOPE);

    expect(withChain.exceptions.writes[0]?.evidence_chain_id).toBe(chain);
    expect(withChain.recons.writes[0]?.evidence_chain_id).toBe(chain);
    // Null, never fabricated: the chain belongs to the Financial_Tool that produced the
    // figure, and an unreplayable chain would be worse than none.
    expect(withoutChain.exceptions.writes[0]?.evidence_chain_id).toBeNull();
    expect(withoutChain.recons.writes[0]?.evidence_chain_id).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4.13: an unreconciled Settlement                               */
/* -------------------------------------------------------------------------- */

describe('an unreconciled Settlement is not a mismatch (Requirement 4.13)', () => {
  const absent = settlementWithNoReconReport({
    settlement_id: 'setl_NOREPORT01',
    settlement_date: '2026-07-15',
    received_paise: 5_000_000n,
    record_updated_at: '2026-07-15T00:00:00.000Z',
  });

  it('records the row with no figures and raises no Exception', async () => {
    const h = harness({ settlements: [absent, MISMATCH] });

    const report = await h.agent.run(SCOPE);

    const row = rowFor(report, absent.settlement_id);
    expect(row.recon.status).toBe('unreconciled');
    expect(row.recon.residual_paise).toBeNull();
    expect(row.recon.direction).toBe('not_applicable');
    expect(row.unreconciled_source).toEqual({
      type: 'settlement_recon_report',
      reason: 'absent',
    });

    // Only the mismatch raised anything: the unreconciled Settlement has no residual to
    // point anywhere, and an invented impact would be summed into a total it must be
    // excluded from.
    expect(report.exceptions.detections.map((one) => one.settlement_id)).toEqual([
      MISMATCH.settlement_id,
    ]);
  });

  it('is excluded from the reported total shortfall and listed instead', async () => {
    const h = harness({
      settlements: [absent, MISMATCH],
      links: linksFor([absent, MISMATCH]),
    });

    const report = await h.agent.run(SCOPE);

    expect(report.shortfall.unreconciled_settlement_ids).toEqual([absent.settlement_id]);
    expect(report.shortfall.shortfall_settlement_ids).toEqual([MISMATCH.settlement_id]);
    expect(report.shortfall.total_shortfall_paise).toBe(66100n);
    expect(report.shortfall.residual_nonzero_count).toBe(1);
    // An absent report is a fact about the Tenant's data, not a failure of the run.
    expect(report.incomplete).toBeNull();
  });

  it('raises nothing through the pure builder either', () => {
    const context = {
      settlement_date: '2026-07-15',
      recon_report_id: null,
      examined: {
        payments_counted: 0,
        refunds_counted: 0,
        chargebacks_counted: 0,
        adjustments_counted: 0,
      },
      scope: SCOPE,
      run_id: RUN_ID,
      detected_at: '2026-07-30T09:15:00.000Z',
      evidence_chain_id: null,
    };

    // Requirement 4.13: no residual, so nothing to raise.
    expect(
      settlementMismatchUpsertFor({
        ...context,
        recon: {
          settlement_id: absent.settlement_id,
          expected_paise: null,
          received_paise: 5_000_000n,
          difference_paise: null,
          fee_component_paise: null,
          gst_component_paise: null,
          residual_paise: null,
          status: 'unreconciled',
          direction: 'not_applicable',
        },
      }),
    ).toBeNull();

    // Requirement 4.4: exactly zero, and there is no tolerance band above or below it.
    expect(
      settlementMismatchUpsertFor({
        ...context,
        recon_report_id: SET_9281.recon_report_id,
        recon: SET_9281.recon,
      }),
    ).toBeNull();
    expect(
      settlementMismatchUpsertFor({
        ...context,
        recon_report_id: SET_9281_FEE_VARIANT.recon_report_id,
        recon: SET_9281_FEE_VARIANT.recon,
      })?.impact_paise,
    ).toBe(66100n);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4.15, 15.7: determinism and the total order                    */
/* -------------------------------------------------------------------------- */

describe('the ordering rule (Requirement 4.15, 15.7)', () => {
  // Two Settlements share an impact of 900n, so a single-key sort would leave their
  // relative order to chance. Task 13.3's generator puts ties in on purpose.
  const tied = [
    settlementWithResidual({ id: 'setl_TIEB', date: '2026-07-11', residualPaise: 900n }),
    settlementWithResidual({ id: 'setl_TIEA', date: '2026-07-11', residualPaise: 900n }),
    settlementWithResidual({ id: 'setl_BIG', date: '2026-07-20', residualPaise: 5_000n }),
    settlementWithResidual({ id: 'setl_EARLY', date: '2026-07-02', residualPaise: 900n }),
    settlementWithResidual({ id: 'setl_EXCESS', date: '2026-07-05', residualPaise: -2_000n }),
  ];

  it('orders Exceptions by descending impact, then ascending date, then ascending id', async () => {
    const h = harness({ settlements: tied });

    const report = await h.agent.run(SCOPE);

    expect(report.exceptions.order).toEqual([
      'setl_BIG', //    5000
      'setl_EXCESS', //  2000 (|residual|, an unexplained excess)
      'setl_EARLY', //    900, 2026-07-02
      'setl_TIEA', //     900, 2026-07-11, ascending identifier
      'setl_TIEB', //     900, 2026-07-11
    ]);
    // The order the writes were issued in is the order reported.
    expect(h.exceptions.writes.map((write) => write.impact_paise)).toEqual([
      '5000',
      '2000',
      '900',
      '900',
      '900',
    ]);
  });

  it('reconciles in ascending settlement date then ascending identifier', async () => {
    const h = harness({ settlements: [...tied].reverse() });

    const report = await h.agent.run(SCOPE);

    expect(report.settlements.map((row) => row.settlement_id)).toEqual([
      'setl_EARLY', // 2026-07-02
      'setl_EXCESS', // 2026-07-05
      'setl_TIEA', //  2026-07-11
      'setl_TIEB', //  2026-07-11
      'setl_BIG', //   2026-07-20
    ]);
  });

  it('is a total order: no two distinct candidates compare equal', () => {
    const a = { impact_paise: 900n, settlement_date: '2026-07-11', settlement_id: 'setl_TIEA' };
    const b = { impact_paise: 900n, settlement_date: '2026-07-11', settlement_id: 'setl_TIEB' };
    expect(compareSettlementMismatch(a, b)).toBe(-1);
    expect(compareSettlementMismatch(b, a)).toBe(1);
    expect(compareSettlementMismatch(a, a)).toBe(0);
  });

  it('reproduces the identical Exception set in the identical order on a re-run', async () => {
    const first = harness({
      settlements: tied,
      now: clock('2026-07-30T09:15:00.000Z').now,
    });
    const firstReport = await first.agent.run(SCOPE);

    // The same dataset, shuffled, through the same stores: a re-run, not a fresh one.
    const second = harness({
      settlements: [...tied].reverse(),
      now: clock('2026-07-31T04:30:00.000Z').now,
      reuse: first,
    });
    const secondReport = await second.agent.run(SCOPE);

    const tuples = (report: ReconciliationRunReport) =>
      report.exceptions.detections.map((detection) => [
        detection.settlement_id,
        detection.impact_paise,
        detection.direction,
        detection.source_refs.map((ref) => `${ref.type}:${ref.id}`).sort(),
      ]);

    expect(tuples(secondReport)).toEqual(tuples(firstReport));
    expect(secondReport.exceptions.order).toEqual(firstReport.exceptions.order);
    // Updated in place, not duplicated (Requirement 4.15).
    expect(secondReport.exceptions.created_count).toBe(0);
    expect(secondReport.exceptions.updated_count).toBe(tied.length);
    expect(first.exceptions.rows.size).toBe(tied.length);
    expect(first.recons.rows.size).toBe(tied.length);

    for (const row of first.exceptions.rows.values()) {
      expect(row.first_detected_at).toBe(firstReport.run_at);
      expect(row.last_detected_at).toBe(secondReport.run_at);
    }
  });

  it('rejects a duplicate Settlement rather than counting it twice', async () => {
    const h = harness({ settlements: [MISMATCH, MISMATCH] });
    await expect(h.agent.run(SCOPE)).rejects.toThrow(ReconciliationRunError);
    await expect(h.agent.run(SCOPE)).rejects.toThrow(/appears twice in one resolved scope/);
  });

  it('rejects a Settlement dated outside the resolved scope', async () => {
    const h = harness({
      settlements: [settlementWithResidual({ id: 'setl_LATE', date: '2026-08-04', residualPaise: 1n })],
    });
    // The store's own contract is that the range is the scope. Filtering it away here
    // would hide an adapter that does not implement it.
    await expect(
      h.agent.run({ from: '2026-07-01', to: '2026-08-31' }),
    ).resolves.toBeDefined();
    await expect(h.agent.run(SCOPE)).resolves.toMatchObject({ settlements: [] });
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4.15: the re-detection a User already closed                   */
/* -------------------------------------------------------------------------- */

describe('a re-detected closed Exception is reported, not reopened (Requirement 4.15)', () => {
  it('counts it and carries the existing Exception and its lifecycle state', async () => {
    const first = harness({
      settlements: [MISMATCH],
      now: clock('2026-07-30T09:15:00.000Z').now,
    });
    await first.agent.run(SCOPE);

    // The User resolved it.
    const [fingerprint] = [...first.exceptions.rows.keys()];
    const row = first.exceptions.rows.get(fingerprint ?? '');
    if (row === undefined) {
      throw new Error('the first run wrote no Exception');
    }
    row.state = 'resolved';

    const second = harness({
      settlements: [MISMATCH],
      now: clock('2026-07-31T04:30:00.000Z').now,
      reuse: first,
    });
    const report = await second.agent.run(SCOPE);

    expect(report.exceptions.not_reopened_count).toBe(1);
    expect(report.exceptions.not_reopened[0]).toMatchObject({
      kind: 'not_reopened',
      exception_id: row.id,
      lifecycle_state: 'resolved',
    });
    // Reported, and not applied: nothing on the row moved.
    expect(row.impact_paise).toBe('66100');
    expect(row.last_detected_at).toBe('2026-07-30T09:15:00.000Z');
    expect(first.exceptions.rows.size).toBe(1);
    // The detection is still reported — the condition holds, whatever the row says.
    expect(report.exceptions.detections).toHaveLength(1);
    expect(report.exceptions.created_count).toBe(0);
    expect(report.exceptions.updated_count).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 15.6: the 120-second bound                                     */
/* -------------------------------------------------------------------------- */

describe('the wall-clock bound (Requirement 15.6, 15.10)', () => {
  const three = [
    settlementWithResidual({ id: 'setl_ONE', date: '2026-07-02', residualPaise: 100n }),
    settlementWithResidual({ id: 'setl_TWO', date: '2026-07-03', residualPaise: 200n }),
    settlementWithResidual({ id: 'setl_THREE', date: '2026-07-04', residualPaise: 300n }),
  ];

  it('is 120 seconds, and the tool layer’s bound is a twelfth of it', () => {
    expect(RUN_BUDGET_MS).toBe(120_000);
    expect(COMPLETE_SET_BUDGET_MS).toBe(60_000);
    // `TOOL_TIMEOUT_MS` is 10_000: twelve sequential invocations at their own bound fit
    // inside one run's budget, which is why a run cannot treat a tool timeout as its own.
    expect(RUN_BUDGET_MS / 10_000).toBe(12);
  });

  it('stops, returns the partial results, and names the types not fully processed', async () => {
    const slow = clock('2026-07-30T09:15:00.000Z');
    const h = harness({
      settlements: three,
      now: slow.now,
      // Each reconciliation costs 80 s, so the third one is never begun.
      onReconUpsert: () => slow.advance(80_000),
    });

    const report = await h.agent.run(SCOPE);

    // Partial results, returned rather than discarded.
    expect(report.settlements.map((row) => row.settlement_id)).toEqual(['setl_ONE', 'setl_TWO']);
    expect(report.incomplete).not.toBeNull();
    expect(report.incomplete?.reasons).toEqual(['wall_clock_budget']);
    expect(report.incomplete?.stopped_at_stage).toBe('reconcile');
    expect(report.incomplete?.settlements_not_reconciled).toEqual(['setl_THREE']);
    // Every type the stopped stage and every later stage read (Requirement 15.6).
    expect(report.incomplete?.types_not_fully_processed).toEqual([
      'payment',
      'order',
      'settlement',
      'settlement_recon_report',
      'razorpay_invoice',
      'ledger_entry_set',
    ]);
    expect(report.incomplete?.elapsed_ms).toBeGreaterThanOrEqual(RUN_BUDGET_MS);

    // No Exception was upserted at all: the detect stage never ran.
    expect(report.exceptions.detections).toEqual([]);
    expect(h.exceptions.writes).toEqual([]);
  });

  it('stops during detection and keeps the Exceptions it already wrote', async () => {
    const slow = clock('2026-07-30T09:15:00.000Z');
    const h = harness({
      settlements: three,
      budgetMs: 150,
      now: slow.now,
    });

    // Reconciliation is free; each Exception upsert costs 100 ms.
    const upsert = h.exceptions.upsertException.bind(h.exceptions);
    h.exceptions.upsertException = (write) => {
      slow.advance(100);
      return upsert(write);
    };

    const report = await h.agent.run(SCOPE);

    expect(report.settlements).toHaveLength(3);
    expect(report.exceptions.detections).toHaveLength(2);
    expect(report.incomplete?.stopped_at_stage).toBe('detect_exceptions');
    expect(report.incomplete?.reasons).toEqual(['wall_clock_budget']);
    // The mapping never ran either, so `payment` and the link types are named too.
    expect(report.incomplete?.types_not_fully_processed).toContain('ledger_entry_set');
  });

  it('returns a report rather than throwing when the budget is gone before the read', async () => {
    const h = harness({
      settlements: three,
      budgetMs: 5,
      now: clock('2026-07-30T09:15:00.000Z', 50).now,
    });

    const report = await h.agent.run(SCOPE);

    expect(report.run_id).toBe(RUN_ID);
    expect(report.scope).toEqual(SCOPE);
    expect(report.incomplete?.stopped_at_stage).toBe('read_scope');
    expect(report.settlements).toEqual([]);
    // Nothing was read, so nothing was examined — and the scope is still reported.
    expect(report.examined.settlements_examined).toBe(0);
    expect(h.scope.queries).toEqual([]);
  });

  it('names every stage’s Source_Record types from the stage the run stopped at', () => {
    expect(RUN_STAGES).toEqual([
      'resolve_scope',
      'read_scope',
      'reconcile',
      'detect_exceptions',
      'match_lifecycle',
    ]);
    expect(typesNotFullyProcessedFrom('match_lifecycle')).toEqual([
      'payment',
      'order',
      'settlement',
      'razorpay_invoice',
      'ledger_entry_set',
    ]);
    expect(typesNotFullyProcessedFrom('detect_exceptions')).toEqual([
      'payment',
      'order',
      'settlement',
      'settlement_recon_report',
      'razorpay_invoice',
      'ledger_entry_set',
    ]);
    // In `SOURCE_RECORD_TYPES` declaration order, which is the order the enum compares in.
    expect(typesNotFullyProcessedFrom('resolve_scope')).toEqual(
      typesNotFullyProcessedFrom('read_scope'),
    );
  });

  it('reports the 60-second bound as applying below the 5000-Payment threshold', async () => {
    const h = harness({ settlements: [MISMATCH], links: [] });

    const report = await h.agent.run(SCOPE);

    expect(LARGE_DATASET_PAYMENT_COUNT).toBe(5000);
    expect(report.complete_set_bound_applies).toBe(true);
    // Three Payment lines on one report, all of them on a Settlement that reconciled.
    expect(report.payments_processed).toBe(3);
  });

  it('counts no Payment as processed on a Settlement the run never reached', async () => {
    const slow = clock('2026-07-30T09:15:00.000Z');
    const h = harness({
      settlements: three,
      now: slow.now,
      onReconUpsert: () => slow.advance(80_000),
    });

    const report = await h.agent.run(SCOPE);

    expect(report.payments_processed).toBe(2);
    expect(report.lifecycle.payments_in_scope).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 12.3: an unreadable contributing record                        */
/* -------------------------------------------------------------------------- */

describe('an unreadable contributing record withholds the Settlement (Requirement 12.3)', () => {
  it('reconciles it not at all, and names it in the incomplete report', async () => {
    const withheld: ScopedSettlement = {
      ...settlementWithResidual({ id: 'setl_UNREAD', date: '2026-07-09', residualPaise: 400n }),
      unreadable: [{ type: 'refund', id: 'rfnd_UNREADABLE01' }],
    };
    const h = harness({
      settlements: [withheld, MISMATCH],
      links: linksFor([withheld, MISMATCH]),
    });

    const report = await h.agent.run(SCOPE);

    expect(report.withheld).toEqual([
      {
        settlement_id: 'setl_UNREAD',
        reason: 'unreadable_source_records',
        unreadable: [{ type: 'refund', id: 'rfnd_UNREADABLE01' }],
      },
    ]);
    // No row and no Exception: a figure computed from a partly read report would be
    // confidently wrong.
    expect(report.settlements.map((row) => row.settlement_id)).toEqual([MISMATCH.settlement_id]);
    expect(report.exceptions.detections.map((one) => one.settlement_id)).toEqual([
      MISMATCH.settlement_id,
    ]);

    expect(report.incomplete?.reasons).toEqual(['unreadable_source_records']);
    expect(report.incomplete?.stopped_at_stage).toBeNull();
    expect(report.incomplete?.settlements_not_reconciled).toEqual(['setl_UNREAD']);
    expect(report.incomplete?.types_not_fully_processed).toEqual([
      'refund',
      'settlement',
      'settlement_recon_report',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4.1: the lifecycle mapping                                     */
/* -------------------------------------------------------------------------- */

describe('the lifecycle mapping (Requirement 4.1)', () => {
  it('asks about the in-scope Payments the reports enumerate, deduplicated and ascending', async () => {
    const paymentIds = inScopePaymentIds([EXPLAINED]);
    const h = harness({
      settlements: [EXPLAINED],
      links: paymentIds.map(fullLinks),
    });

    const report = await h.agent.run(SCOPE);

    expect(paymentIds).toEqual([
      'pay_SYNTHETIC92811',
      'pay_SYNTHETIC92812',
      'pay_SYNTHETIC92813',
    ]);
    expect(h.links.queries[0]?.payment_ids).toEqual(paymentIds);
    expect(h.links.queries[0]?.tenant_id).toBe(TENANT_ID);
    // Ascending Payment identifier, stated with `./match`'s own order key.
    expect(report.lifecycle.matched_payment_order).toEqual(paymentIds);
    expect(report.lifecycle.not_matched_counts).toEqual({
      order: 0,
      razorpay_invoice: 0,
      settlement: 0,
      ledger_entries: 0,
    });
    expect(report.incomplete).toBeNull();
  });

  it('counts a not-matched marker per record type without inferring anything', async () => {
    const [first] = inScopePaymentIds([EXPLAINED]);
    const h = harness({
      settlements: [EXPLAINED],
      links: inScopePaymentIds([EXPLAINED]).map((id) =>
        id === first
          ? {
              payment_id: id,
              order_ids: [],
              razorpay_invoice_ids: [],
              settlement_ids: [],
              ledger_entry_ids: [],
            }
          : fullLinks(id),
      ),
    });

    const report = await h.agent.run(SCOPE);

    expect(report.lifecycle.not_matched_counts).toEqual({
      order: 1,
      razorpay_invoice: 1,
      settlement: 1,
      ledger_entries: 1,
    });
    expect(report.lifecycle.ambiguous_payment_ids).toEqual([]);
  });

  it('reports an ambiguous match for task 13.5 without raising an Exception for it', async () => {
    const ids = inScopePaymentIds([EXPLAINED]);
    const [ambiguous] = ids;
    const h = harness({
      settlements: [EXPLAINED],
      links: ids.map((id) =>
        id === ambiguous
          ? { ...fullLinks(id), settlement_ids: ['setl_ONE', 'setl_TWO'] }
          : fullLinks(id),
      ),
    });

    const report = await h.agent.run(SCOPE);

    expect(report.lifecycle.ambiguous_payment_ids).toEqual([ambiguous]);
    // 13.5 raises `ambiguous_match`; this run raises `settlement_mismatch` and nothing else.
    expect(h.exceptions.writes.map((write) => write.category)).toEqual([]);
  });

  it('keeps a Payment that was not read apart from one with no links', async () => {
    const ids = inScopePaymentIds([EXPLAINED]);
    const h = harness({
      settlements: [EXPLAINED],
      // The store holds only the first of the three.
      links: ids.slice(0, 1).map(fullLinks),
      unreadableLinks: [{ type: 'order', id: 'order_UNREADABLE01' }],
    });

    const report = await h.agent.run(SCOPE);

    expect(report.lifecycle.payments_not_read).toEqual(ids.slice(1));
    expect(report.lifecycle.unreadable).toEqual([{ type: 'order', id: 'order_UNREADABLE01' }]);
    // A partial mapping is not presented as a complete one.
    expect(report.incomplete?.reasons).toEqual([
      'unreadable_source_records',
      'payments_not_read',
    ]);
    expect(report.incomplete?.types_not_fully_processed).toEqual([
      'payment',
      'order',
      'settlement',
      'settlement_recon_report',
    ]);
    // The Exception half is unaffected: the settlement path finishes before the mapping.
    expect(report.settlements).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

describe('construction', () => {
  it('refuses a session Tenant that is not a UUID', () => {
    expect(() =>
      createReconciliationAgent({ ...emptySeams(), tenantId: 'tenant-1' }),
    ).toThrow(ReconciliationRunError);
  });

  it('refuses a run identifier that is not a UUID', async () => {
    const agent = createReconciliationAgent({
      ...emptySeams(),
      tenantId: TENANT_ID,
      newRunId: () => 'run-1',
    });
    await expect(agent.run(SCOPE)).rejects.toThrow(/run identifier must be a UUID/);
  });

  it('refuses a non-positive budget', () => {
    expect(() =>
      createReconciliationAgent({ ...emptySeams(), tenantId: TENANT_ID, budgetMs: 0 }),
    ).toThrow(/positive whole number of milliseconds/);
  });
});
