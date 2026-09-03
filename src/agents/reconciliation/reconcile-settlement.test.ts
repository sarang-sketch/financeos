/**
 * Unit tests for `reconcile-settlement.ts` (task 11.1).
 *
 * SCOPE. Property P3 is **task 11.2** and the SET-9281 worked example is **task
 * 11.3**; neither is written here, and this file deliberately states no `numRuns`
 * property and imports no fixture. What it covers is the branch structure of this
 * module: the two `unreconciled` paths, the three residual signs with their statuses
 * and directions, both adjustment conventions, the shortfall aggregation and its
 * Requirement 4.13 exclusion, the persistence validation funnel, and the paise range
 * boundary.
 *
 * Every figure here is a `bigint` literal. Nothing is computed in a test to compare
 * against a computation — a test that recomputed the expression under test would
 * assert nothing.
 */

import { describe, expect, it, vi } from 'vitest';

import { PAISE_MAX, PaiseRangeError } from '@/calc/paise';

import {
  assertReconPersistable,
  createSettlementReconciler,
  DIFFERENCE_DECOMPOSES_EXACTLY,
  examinedCounts,
  expectedAmount,
  type ExaminedCounts,
  type ReconReportLines,
  reconcileSettlement,
  type SettlementRecon,
  type SettlementReconPersistInput,
  SettlementReconError,
  type SettlementReconStore,
  type SettlementReconWrite,
  settlementReconWriteFor,
  signedAdjustmentPaise,
  totalShortfall,
} from './reconcile-settlement';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const CHAIN = '33333333-3333-4333-8333-333333333333';

/** A report with every list defaulting to empty, so each test states only what it varies. */
function report(lines: Partial<ReconReportLines> = {}): ReconReportLines {
  return {
    payments: [],
    refunds: [],
    chargebacks: [],
    adjustments: [],
    fees: [],
    gst_on_fees: [],
    ...lines,
  };
}

const COUNTS: ExaminedCounts = {
  payments_counted: 1,
  refunds_counted: 0,
  chargebacks_counted: 0,
  adjustments_counted: 0,
};

function persistInput(
  recon: SettlementRecon,
  overrides: Partial<SettlementReconPersistInput> = {},
): SettlementReconPersistInput {
  return {
    recon,
    recon_report_id: 'setlrcn_1',
    settlement_date: '2026-07-28',
    examined: COUNTS,
    evidence_chain_id: CHAIN,
    run_id: RUN,
    ...overrides,
  };
}

/** A store that records what it was handed and reports a successful insert. */
function recordingStore(created = true): {
  readonly store: SettlementReconStore;
  readonly writes: SettlementReconWrite[];
} {
  const writes: SettlementReconWrite[] = [];
  return {
    writes,
    store: {
      upsertReconciliation: vi.fn(async (write: SettlementReconWrite) => {
        writes.push(write);
        return { ok: true as const, reconciliation_id: 'rec-1', created };
      }),
    },
  };
}

describe('expectedAmount (Requirement 4.2)', () => {
  it('is payments minus refunds minus chargebacks plus the signed adjustment sum', () => {
    expect(
      expectedAmount(
        report({
          payments: [52000000n, 30000000n, 8000000n],
          refunds: [4500000n],
          chargebacks: [750000n],
          adjustments: [-300000n, -190000n],
        }),
      ),
    ).toBe(84260000n);
  });

  it('adds a credit adjustment and subtracts a debit adjustment through the same sum', () => {
    const base = { payments: [1000000n] };
    expect(expectedAmount(report({ ...base, adjustments: [25000n] }))).toBe(1025000n);
    expect(expectedAmount(report({ ...base, adjustments: [-25000n] }))).toBe(975000n);
    expect(expectedAmount(report({ ...base, adjustments: [25000n, -25000n] }))).toBe(1000000n);
  });

  it('reads only the lines the report enumerates, ignoring fee and GST lines', () => {
    // Requirement 4.2: Expected Amount is composed of payments, refunds,
    // chargebacks and adjustments. The fee lines belong to the decomposition.
    expect(
      expectedAmount(report({ payments: [1000000n], fees: [50000n], gst_on_fees: [9000n] })),
    ).toBe(1000000n);
  });

  it('raises rather than wrapping when a running total leaves the paise range', () => {
    expect(() => expectedAmount(report({ payments: [PAISE_MAX, 1n] }))).toThrow(PaiseRangeError);
  });
});

describe('signedAdjustmentPaise', () => {
  it('projects Razorpay credit-versus-debit onto the signed value the report sums', () => {
    expect(signedAdjustmentPaise({ debit: 300000n, credit: 0n })).toBe(-300000n);
    expect(signedAdjustmentPaise({ debit: 0n, credit: 300000n })).toBe(300000n);
    // A line with both nets; `credit - debit` is the whole definition.
    expect(signedAdjustmentPaise({ debit: 100000n, credit: 40000n })).toBe(-60000n);
  });

  it('feeds expectedAmount identically to a signed literal', () => {
    const projected = [
      signedAdjustmentPaise({ debit: 300000n, credit: 0n }),
      signedAdjustmentPaise({ debit: 190000n, credit: 0n }),
    ];
    expect(expectedAmount(report({ payments: [90000000n], adjustments: projected }))).toBe(
      expectedAmount(report({ payments: [90000000n], adjustments: [-300000n, -190000n] })),
    );
  });
});

describe('reconcileSettlement: unreconciled (Requirement 4.13)', () => {
  const ALL_FIGURES = [
    'expected_paise',
    'difference_paise',
    'fee_component_paise',
    'gst_component_paise',
    'residual_paise',
  ] as const;

  it('yields unreconciled with all five figures null for an absent report', () => {
    const recon = reconcileSettlement('setl_absent', 81940000n, null);
    for (const figure of ALL_FIGURES) {
      expect(recon[figure]).toBeNull();
    }
    expect(recon.status).toBe('unreconciled');
    expect(recon.direction).toBe('not_applicable');
    // Read from the Settlement object, so it survives an absent report.
    expect(recon.received_paise).toBe(81940000n);
  });

  it('yields unreconciled for a report enumerating 0 Payments, even with other lines', () => {
    const recon = reconcileSettlement(
      'setl_empty',
      500n,
      report({ refunds: [100n], fees: [10n], gst_on_fees: [2n], adjustments: [7n] }),
    );
    for (const figure of ALL_FIGURES) {
      expect(recon[figure]).toBeNull();
    }
    expect(recon.status).toBe('unreconciled');
  });

  it('counts the enumerated lines of an empty-payment report and zero for an absent one', () => {
    expect(examinedCounts(null)).toEqual({
      payments_counted: 0,
      refunds_counted: 0,
      chargebacks_counted: 0,
      adjustments_counted: 0,
    });
    expect(
      examinedCounts(report({ refunds: [1n, 2n], chargebacks: [3n], adjustments: [4n, 5n, 6n] })),
    ).toEqual({
      payments_counted: 0,
      refunds_counted: 2,
      chargebacks_counted: 1,
      adjustments_counted: 3,
    });
  });
});

describe('reconcileSettlement: the three residual signs (Requirement 4.3, 4.4, 4.5)', () => {
  it('explains a Difference that is exactly fee plus GST', () => {
    const recon = reconcileSettlement(
      'setl_zero',
      81940000n,
      report({
        payments: [90000000n],
        refunds: [4500000n],
        chargebacks: [750000n],
        adjustments: [-490000n],
        fees: [1966100n],
        gst_on_fees: [353900n],
      }),
    );
    expect(recon.expected_paise).toBe(84260000n);
    expect(recon.difference_paise).toBe(2320000n);
    expect(recon.fee_component_paise).toBe(1966100n);
    expect(recon.gst_component_paise).toBe(353900n);
    expect(recon.residual_paise).toBe(0n);
    expect(recon.status).toBe('difference_explained');
    expect(recon.direction).toBe('not_applicable');
  });

  it('reports a positive residual as an unexplained shortfall', () => {
    const recon = reconcileSettlement(
      'setl_short',
      81940000n,
      report({
        payments: [90000000n],
        refunds: [4500000n],
        chargebacks: [750000n],
        adjustments: [-490000n],
        fees: [1900000n],
        gst_on_fees: [353900n],
      }),
    );
    expect(recon.residual_paise).toBe(66100n);
    expect(recon.status).toBe('mismatch');
    expect(recon.direction).toBe('unexplained_shortfall');
  });

  it('reports a negative residual as an unexplained excess', () => {
    const recon = reconcileSettlement(
      'setl_excess',
      81940000n,
      report({
        payments: [90000000n],
        refunds: [4500000n],
        chargebacks: [750000n],
        adjustments: [-490000n],
        fees: [2000000n],
        gst_on_fees: [353900n],
      }),
    );
    expect(recon.residual_paise).toBe(-33900n);
    expect(recon.status).toBe('mismatch');
    expect(recon.direction).toBe('unexplained_excess');
  });

  it('decomposes a zero Difference too, so every reconciled row carries the invariant', () => {
    const recon = reconcileSettlement('setl_flat', 1000000n, report({ payments: [1000000n] }));
    expect(recon.difference_paise).toBe(0n);
    expect(recon.fee_component_paise).toBe(0n);
    expect(recon.gst_component_paise).toBe(0n);
    expect(recon.residual_paise).toBe(0n);
    expect(recon.status).toBe('difference_explained');
  });

  it('treats one paisa as a mismatch: there is no tolerance band', () => {
    const off = reconcileSettlement(
      'setl_1p',
      999999n,
      report({ payments: [1000000n], fees: [0n], gst_on_fees: [0n] }),
    );
    expect(off.residual_paise).toBe(1n);
    expect(off.status).toBe('mismatch');
    expect(off.direction).toBe('unexplained_shortfall');
  });

  it('raises rather than reporting a figure when the Difference leaves the paise range', () => {
    expect(() => reconcileSettlement('setl_range', -PAISE_MAX, report({ payments: [PAISE_MAX] })))
      .toThrow(PaiseRangeError);
  });
});

describe('totalShortfall (Requirement 4.7, 4.13)', () => {
  const shortfall = reconcileSettlement(
    'setl_b',
    81940000n,
    report({ payments: [84260000n], fees: [1900000n], gst_on_fees: [353900n] }),
  );
  const excess = reconcileSettlement(
    'setl_c',
    81940000n,
    report({ payments: [84260000n], fees: [2000000n], gst_on_fees: [353900n] }),
  );
  const explained = reconcileSettlement(
    'setl_a',
    81940000n,
    report({ payments: [84260000n], fees: [1966100n], gst_on_fees: [353900n] }),
  );
  const unreconciled = reconcileSettlement('setl_d', 5000n, null);

  it('sums the shortfalls and the excesses apart, netting neither', () => {
    const agg = totalShortfall([shortfall, excess, explained]);
    expect(agg.total_shortfall_paise).toBe(66100n);
    expect(agg.total_excess_paise).toBe(33900n);
    expect(agg.residual_nonzero_count).toBe(2);
    expect(agg.shortfall_settlement_ids).toEqual(['setl_b']);
    expect(agg.excess_settlement_ids).toEqual(['setl_c']);
  });

  it('excludes an unreconciled Settlement from both figures and reports it separately', () => {
    const agg = totalShortfall([shortfall, unreconciled]);
    expect(agg.total_shortfall_paise).toBe(66100n);
    expect(agg.residual_nonzero_count).toBe(1);
    expect(agg.shortfall_settlement_ids).not.toContain('setl_d');
    expect(agg.excess_settlement_ids).not.toContain('setl_d');
    expect(agg.unreconciled_settlement_ids).toEqual(['setl_d']);
  });

  it('does not count a fully explained Settlement into the shortfall', () => {
    const agg = totalShortfall([explained]);
    expect(agg.total_shortfall_paise).toBe(0n);
    expect(agg.residual_nonzero_count).toBe(0);
    expect(agg.shortfall_settlement_ids).toEqual([]);
  });

  it('is a function of the set, not of the arrival order', () => {
    expect(totalShortfall([shortfall, excess, explained, unreconciled])).toEqual(
      totalShortfall([unreconciled, explained, excess, shortfall]),
    );
  });

  it('is zero over no Settlements at all', () => {
    const agg = totalShortfall([]);
    expect(agg.total_shortfall_paise).toBe(0n);
    expect(agg.total_excess_paise).toBe(0n);
    expect(agg.residual_nonzero_count).toBe(0);
  });
});

describe('assertReconPersistable: what the database cannot check', () => {
  const good = reconcileSettlement(
    'setl_ok',
    81940000n,
    report({ payments: [84260000n], fees: [1966100n], gst_on_fees: [353900n] }),
  );

  it('accepts what reconcileSettlement produced', () => {
    expect(() => assertReconPersistable(persistInput(good))).not.toThrow();
  });

  it('rejects a mismatch row with all five figures null (migration FINDING 2)', () => {
    const nulled: SettlementRecon = {
      ...good,
      expected_paise: null,
      difference_paise: null,
      fee_component_paise: null,
      gst_component_paise: null,
      residual_paise: null,
      status: 'mismatch',
      direction: 'unexplained_shortfall',
    };
    expect(() => assertReconPersistable(persistInput(nulled))).toThrow(SettlementReconError);
  });

  it('rejects an unreconciled row that states a figure', () => {
    const unreconciled = reconcileSettlement('setl_u', 5000n, null);
    expect(() =>
      assertReconPersistable(persistInput({ ...unreconciled, expected_paise: 0n })),
    ).toThrow(/excluded from/);
  });

  it('rejects a decomposition that does not reconstruct the Difference', () => {
    expect(() =>
      assertReconPersistable(persistInput({ ...good, fee_component_paise: 1966099n })),
    ).toThrow(new RegExp(DIFFERENCE_DECOMPOSES_EXACTLY));
  });

  it('rejects "explained" with a non-zero residual, and "mismatch" with a zero one', () => {
    expect(() =>
      assertReconPersistable(
        persistInput({
          ...good,
          gst_component_paise: 353899n,
          residual_paise: 1n,
          status: 'difference_explained',
        }),
      ),
    ).toThrow(/no tolerance band/);
    expect(() =>
      assertReconPersistable(persistInput({ ...good, status: 'mismatch' })),
    ).toThrow(/no tolerance band/);
  });

  it('rejects a direction that disagrees with the sign of the residual', () => {
    expect(() =>
      assertReconPersistable(persistInput({ ...good, direction: 'unexplained_shortfall' })),
    ).toThrow(/direction/);
  });

  it('rejects a run id or evidence chain id that is not a UUID, and a bad settlement date', () => {
    expect(() => assertReconPersistable(persistInput(good, { run_id: 'run-1' }))).toThrow(
      /run_id/,
    );
    expect(() =>
      assertReconPersistable(persistInput(good, { evidence_chain_id: 'chain-1' })),
    ).toThrow(/evidence_chain_id/);
    expect(() =>
      assertReconPersistable(persistInput(good, { settlement_date: '2026-02-30' })),
    ).toThrow(/settlement_date/);
  });

  it('accepts an absent evidence chain, which the column allows', () => {
    expect(() =>
      assertReconPersistable(persistInput(good, { evidence_chain_id: null })),
    ).not.toThrow();
  });
});

describe('settlementReconWriteFor', () => {
  const good = reconcileSettlement(
    'setl_ok',
    81940000n,
    report({ payments: [84260000n], fees: [1966100n], gst_on_fees: [353900n] }),
  );

  it('encodes every figure as an integer string and keeps the counts as numbers', () => {
    const write = settlementReconWriteFor(TENANT, persistInput(good));
    expect(write).toEqual({
      tenant_id: TENANT,
      settlement_id: 'setl_ok',
      recon_report_id: 'setlrcn_1',
      settlement_date: '2026-07-28',
      expected_paise: '84260000',
      received_paise: '81940000',
      difference_paise: '2320000',
      fee_component_paise: '1966100',
      gst_component_paise: '353900',
      residual_paise: '0',
      status: 'difference_explained',
      payments_counted: 1,
      refunds_counted: 0,
      chargebacks_counted: 0,
      adjustments_counted: 0,
      evidence_chain_id: CHAIN,
      run_id: RUN,
    });
  });

  it('leaves the five figures null for an unreconciled Settlement but states the received amount', () => {
    const unreconciled = reconcileSettlement('setl_u', 81940000n, null);
    const write = settlementReconWriteFor(
      TENANT,
      persistInput(unreconciled, {
        recon_report_id: null,
        examined: {
          payments_counted: 0,
          refunds_counted: 0,
          chargebacks_counted: 0,
          adjustments_counted: 0,
        },
      }),
    );
    expect(write.expected_paise).toBeNull();
    expect(write.difference_paise).toBeNull();
    expect(write.fee_component_paise).toBeNull();
    expect(write.gst_component_paise).toBeNull();
    expect(write.residual_paise).toBeNull();
    expect(write.received_paise).toBe('81940000');
    expect(write.recon_report_id).toBeNull();
    expect(write.status).toBe('unreconciled');
  });

  it('encodes a negative residual with its sign', () => {
    const excess = reconcileSettlement(
      'setl_e',
      81940000n,
      report({ payments: [84260000n], fees: [2000000n], gst_on_fees: [353900n] }),
    );
    expect(settlementReconWriteFor(TENANT, persistInput(excess)).residual_paise).toBe('-33900');
  });
});

describe('createSettlementReconciler', () => {
  it('binds the Tenant at construction and rejects one that is not a UUID', () => {
    expect(() =>
      createSettlementReconciler({ store: recordingStore().store, tenantId: 'tenant-1' }),
    ).toThrow(SettlementReconError);
  });

  it('reconciles and writes one row carrying the chain id, the counts and the run id', async () => {
    const { store, writes } = recordingStore();
    const reconciler = createSettlementReconciler({ store, tenantId: TENANT });

    const result = await reconciler.reconcile({
      settlement_id: 'setl_ok',
      recon_report_id: 'setlrcn_1',
      settlement_date: '2026-07-28',
      received_paise: 81940000n,
      report: report({
        payments: [52000000n, 30000000n, 8000000n],
        refunds: [4500000n],
        chargebacks: [750000n],
        adjustments: [-300000n, -190000n],
        fees: [1040000n, 600000n, 326100n],
        gst_on_fees: [187200n, 108000n, 58700n],
      }),
      evidence_chain_id: CHAIN,
      run_id: RUN,
    });

    expect(result.recon.residual_paise).toBe(0n);
    expect(result.examined).toEqual({
      payments_counted: 3,
      refunds_counted: 1,
      chargebacks_counted: 1,
      adjustments_counted: 2,
    });
    expect(result.created).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      tenant_id: TENANT,
      difference_paise: '2320000',
      fee_component_paise: '1966100',
      gst_component_paise: '353900',
      residual_paise: '0',
      payments_counted: 3,
      evidence_chain_id: CHAIN,
      run_id: RUN,
    });
  });

  it('reports a re-run as an update rather than a new row', async () => {
    const { store } = recordingStore(false);
    const reconciler = createSettlementReconciler({ store, tenantId: TENANT });
    const result = await reconciler.reconcile({
      settlement_id: 'setl_ok',
      recon_report_id: 'setlrcn_1',
      settlement_date: '2026-07-28',
      received_paise: 1000000n,
      report: report({ payments: [1000000n] }),
      evidence_chain_id: null,
      run_id: RUN,
    });
    expect(result.created).toBe(false);
  });

  it('issues no statement for a malformed result', async () => {
    const { store, writes } = recordingStore();
    const reconciler = createSettlementReconciler({ store, tenantId: TENANT });
    const good = reconcileSettlement('setl_ok', 1000000n, report({ payments: [1000000n] }));

    await expect(
      reconciler.persist(persistInput({ ...good, status: 'mismatch' })),
    ).rejects.toThrow(SettlementReconError);
    expect(writes).toHaveLength(0);
  });

  it('raises when the store reports a CHECK rejection the funnel already excludes', async () => {
    const reconciler = createSettlementReconciler({
      store: {
        upsertReconciliation: async () => ({
          ok: false as const,
          kind: 'malformed_row' as const,
          constraint: DIFFERENCE_DECOMPOSES_EXACTLY,
        }),
      },
      tenantId: TENANT,
    });
    const good = reconcileSettlement('setl_ok', 1000000n, report({ payments: [1000000n] }));
    await expect(reconciler.persist(persistInput(good))).rejects.toThrow(
      new RegExp(DIFFERENCE_DECOMPOSES_EXACTLY),
    );
  });
});
