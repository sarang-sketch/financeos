/**
 * The Evidence_Chains a settlement Financial_Tool composes (task 12.1).
 *
 * The load-bearing assertion is the first one: the twelve steps composed here are
 * compared **step for step** against `test/fixtures/set-9281.ts`'s chain — the same
 * operations in the same order, the same operands, the same results — because that
 * fixture is design.md's worked example and `test/worked-example/`,
 * `test/db/evidence-chain.test.ts` and `test/db/settlement-reconciliation.test.ts`
 * all assert `produced_by = 'get_settlement_reconciliation'` against it.
 *
 * `note` is deliberately not compared: it is prose for a human reading a drill-down,
 * it is not replayed, and holding this module to the fixture's exact wording would
 * make a clearer comment a test failure.
 */

import { describe, expect, it } from 'vitest';

import { composeEvidenceChain } from '@/evidence/chain-builder';
import { reconcileSettlement } from '@/agents/reconciliation/reconcile-settlement';

import {
  EXPECTED_OPERATION_SEQUENCE,
  SET_9281,
  SET_9281_FEE_VARIANT,
  STEP_COUNT,
  type EvidenceStep,
} from '../../test/fixtures/set-9281';
import {
  scopedSettlementFor,
  settlementWithNoReconReport,
} from '../../test/fixtures/set-9281.scoped';

import {
  ABSOLUTE_DIFFERENCE_STEP_COUNT,
  absoluteDifferencePaise,
  contributesToTotalShortfall,
  DIFFERENCE_PREFIX_STEP_COUNT,
  hasNonZeroDifference,
  MAX_ABSOLUTE_DIFFERENCE_CONTRIBUTORS,
  totalAbsoluteDifferenceChain,
  DIFFERENCE_STEP_INDEX,
  EXPECTED_AMOUNT_STEP_INDEX,
  MAX_TOTAL_SHORTFALL_CONTRIBUTORS,
  reconciledSettlementChain,
  RESIDUAL_STEP_INDEX,
  SettlementEvidenceError,
  settlementStepBlock,
  totalShortfallChain,
  unreconciledSettlementChain,
} from './settlement-evidence';
import type { ScopedSettlement } from './settlement-scope';

const PRODUCED_BY = 'get_settlement_reconciliation';

/** What is replayed: everything but the prose. */
const replayable = (
  step: EvidenceStep,
): Pick<EvidenceStep, 'index' | 'operation' | 'operands' | 'result_paise'> => ({
  index: step.index,
  operation: step.operation,
  operands: step.operands,
  result_paise: step.result_paise,
});

function pairFor(example: typeof SET_9281): {
  readonly settlement: ScopedSettlement;
  readonly recon: ReturnType<typeof reconcileSettlement>;
} {
  const settlement = scopedSettlementFor(example);
  return {
    settlement,
    recon: reconcileSettlement(example.settlement_id, example.received_paise, example.lines),
  };
}

describe('reconciledSettlementChain against design.md\u2019s worked example', () => {
  for (const example of [SET_9281, SET_9281_FEE_VARIANT]) {
    it(`reproduces ${example.display_name}'s twelve steps exactly`, () => {
      const pair = pairFor(example);
      const chain = reconciledSettlementChain(PRODUCED_BY, pair.settlement, pair.recon);

      expect(chain.steps).toHaveLength(STEP_COUNT);
      expect(chain.steps.map((step) => step.operation)).toEqual(EXPECTED_OPERATION_SEQUENCE);
      // Step for step, operand for operand, result for result.
      expect(chain.steps.map(replayable)).toEqual(example.chain.steps.map(replayable));
      // The figure is the residual, the terminal step's result — not the Difference,
      // which is an intermediate of the same chain.
      expect(chain.figure_paise).toBe(example.chain.figure_paise);
      expect(chain.steps[EXPECTED_AMOUNT_STEP_INDEX - 1]?.result_paise).toBe(
        example.recon.expected_paise,
      );
      expect(chain.steps[DIFFERENCE_STEP_INDEX - 1]?.result_paise).toBe(
        example.recon.difference_paise,
      );
      expect(chain.steps[RESIDUAL_STEP_INDEX - 1]?.result_paise).toBe(example.recon.residual_paise);
    });

    it(`composes to ${example.display_name}'s 8 identifiers in first-citation order`, () => {
      const pair = pairFor(example);
      const draft = composeEvidenceChain(
        reconciledSettlementChain(PRODUCED_BY, pair.settlement, pair.recon),
      );
      expect(draft.sources).toEqual(example.chain.sources);
      expect(draft.source_count).toBe(example.chain.source_count);
      expect(draft.as_of).toBe(example.chain.as_of);
      expect(draft.produced_by).toBe(example.chain.produced_by);
      expect(draft.figure_paise).toBe(example.chain.figure_paise);
    });
  }

  it('refuses a chain whose steps disagree with the reported figures', () => {
    const pair = pairFor(SET_9281);
    expect(() =>
      reconciledSettlementChain(PRODUCED_BY, pair.settlement, {
        ...pair.recon,
        residual_paise: 1n,
      }),
    ).toThrow(/Requirement 12\.8 exists to prevent/);
  });

  it('refuses to state steps for a Settlement enumerating no Payment', () => {
    const empty: ScopedSettlement = { ...scopedSettlementFor(SET_9281), payments: [] };
    expect(() => settlementStepBlock(empty)).toThrow(SettlementEvidenceError);
  });
});

describe('an empty line list is a literal zero operand, not a zero-operand step', () => {
  it('states one literal 0 operand for a report with no refunds, chargebacks or adjustments', () => {
    const base = scopedSettlementFor(SET_9281);
    const bare: ScopedSettlement = {
      ...base,
      refunds: [],
      chargebacks: [],
      adjustments: [],
      received_paise: 90_000_000n - 1_966_100n - 353_900n,
    };
    const recon = reconcileSettlement(bare.settlement_id, bare.received_paise, {
      payments: bare.payments.map((line) => line.amount_paise),
      refunds: [],
      chargebacks: [],
      adjustments: [],
      fees: bare.payments.map((line) => line.fee_paise),
      gst_on_fees: bare.payments.map((line) => line.gst_on_fee_paise),
    });
    const chain = reconciledSettlementChain(PRODUCED_BY, bare, recon);

    for (const index of [2, 4, 6]) {
      expect(chain.steps[index - 1]?.operands).toEqual([{ kind: 'literal', value: '0' }]);
      expect(chain.steps[index - 1]?.result_paise).toBe(0n);
    }
    // Still a well-formed, storable chain: the residual is 0n and it replays.
    expect(composeEvidenceChain(chain).figure_paise).toBe(0n);
  });
});

describe('unreconciledSettlementChain (Requirement 4.13, 12.2)', () => {
  it('grounds received_paise, which is the only figure an unreconciled row has', () => {
    const absent = settlementWithNoReconReport({
      settlement_id: 'setl_SYNTHETICNONE1',
      settlement_date: '2026-07-30',
      received_paise: 4_500_000n,
      record_updated_at: '2026-07-30T00:00:00.000Z',
    });
    const draft = composeEvidenceChain(unreconciledSettlementChain(PRODUCED_BY, absent));
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]?.operation).toBe('sum');
    expect(draft.figure_paise).toBe(4_500_000n);
    expect(draft.sources).toEqual([{ type: 'settlement', id: 'setl_SYNTHETICNONE1' }]);
  });
});

describe('totalShortfallChain', () => {
  const nine = pairFor(SET_9281);
  const variant = pairFor(SET_9281_FEE_VARIANT);

  it('inlines 8 steps per contributor and sums their Difference results', () => {
    // Both worked examples have a positive Difference of 2320000n, so both contribute
    // even though SET-9281's residual is 0n. That is the decision recorded on the
    // tool: the total is the Difference, and a fully explained Settlement is still
    // money that did not arrive.
    expect(contributesToTotalShortfall(nine)).toBe(true);
    expect(contributesToTotalShortfall(variant)).toBe(true);

    const total = 2_320_000n + 2_320_000n;
    const draft = composeEvidenceChain(totalShortfallChain(PRODUCED_BY, [nine, variant], total));

    expect(draft.steps).toHaveLength(2 * DIFFERENCE_PREFIX_STEP_COUNT + 1);
    expect(draft.figure_paise).toBe(total);

    const terminal = draft.steps[draft.steps.length - 1];
    expect(terminal?.operation).toBe('sum');
    // The terminal step sums the two Difference steps, at absolute indexes 8 and 16.
    expect(terminal?.operands).toEqual([
      { kind: 'step', index: DIFFERENCE_PREFIX_STEP_COUNT },
      { kind: 'step', index: 2 * DIFFERENCE_PREFIX_STEP_COUNT },
    ]);
    // 16 identifiers: 7 report lines plus the Settlement, for each of two scopes.
    expect(draft.source_count).toBe(16);
  });

  it('refuses a total that disagrees with the summed Differences', () => {
    expect(() => totalShortfallChain(PRODUCED_BY, [nine], 1n)).toThrow(
      /summing the 1 contributing Differences produces 2320000/,
    );
  });

  it('grounds a zero total over a scope where nothing contributes', () => {
    // Received exactly the Expected Amount: Difference 0n, so nothing is missing.
    const settled: ScopedSettlement = { ...nine.settlement, received_paise: 84_260_000n };
    const recon = reconcileSettlement(settled.settlement_id, settled.received_paise, SET_9281.lines);
    const draft = composeEvidenceChain(
      totalShortfallChain(PRODUCED_BY, [{ settlement: settled, recon }], 0n),
    );
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]?.operands).toEqual([{ kind: 'literal', value: '0' }]);
    expect(draft.figure_paise).toBe(0n);
    // Still grounded: the examined Settlement is cited even though it contributed
    // nothing, which is what makes `as_of` the scope's newest record.
    expect(draft.sources).toEqual([{ type: 'settlement', id: settled.settlement_id }]);
  });

  it('refuses a figure over a scope holding no Settlement at all', () => {
    // `evidence_chains.source_count >= 1` makes an ungrounded zero unstorable, and
    // returning one anyway is what Requirement 12.2 forbids.
    expect(() => totalShortfallChain(PRODUCED_BY, [], 0n)).toThrow(/holds no Settlement/);
  });

  it('caps contributors at what a SMALLINT step_index can carry', () => {
    expect(MAX_TOTAL_SHORTFALL_CONTRIBUTORS).toBe(4095);
    const many = Array.from({ length: MAX_TOTAL_SHORTFALL_CONTRIBUTORS + 1 }, (_unused, index) => ({
      settlement: {
        ...nine.settlement,
        settlement_id: `setl_SYNTHETIC${String(index).padStart(6, '0')}`,
      },
      recon: { ...nine.recon, settlement_id: `setl_SYNTHETIC${String(index).padStart(6, '0')}` },
    }));
    expect(() => totalShortfallChain(PRODUCED_BY, many, 0n)).toThrow(
      /Narrow the scope rather than presenting a figure whose evidence is truncated/,
    );
  });
});

describe('totalAbsoluteDifferenceChain (Requirement 4.6, task 12.2)', () => {
  const nine = pairFor(SET_9281);

  /** SET-9281 with more received than expected: Difference −500000n, an excess. */
  const excessPair = (): { readonly settlement: ScopedSettlement; readonly recon: ReturnType<typeof reconcileSettlement> } => {
    const settlement: ScopedSettlement = {
      ...nine.settlement,
      settlement_id: 'setl_SYNTHETICEXCESS',
      received_paise: 84_760_000n,
    };
    return {
      settlement,
      recon: reconcileSettlement(settlement.settlement_id, settlement.received_paise, SET_9281.lines),
    };
  };

  it('sums a shortfall and an excess as magnitudes, expressing |x| as a negate step', () => {
    const excess = excessPair();
    expect(excess.recon.difference_paise).toBe(-500_000n);
    expect(hasNonZeroDifference(excess)).toBe(true);
    expect(absoluteDifferencePaise(excess)).toBe(500_000n);

    // Absolute, so the two add rather than cancelling to 1820000n.
    const total = 2_320_000n + 500_000n;
    const draft = composeEvidenceChain(
      totalAbsoluteDifferenceChain(PRODUCED_BY, {
        contributors: [nine, excess],
        examined: [nine, excess],
        total_absolute_difference_paise: total,
      }),
    );
    expect(draft.figure_paise).toBe(total);

    // 8 steps for the positive contributor, 8 + a negate for the negative one, then
    // the terminal sum. `evidence_operation` has no `abs`; `negate` is how |x| is
    // expressed, and only where the sign makes it a real operation.
    expect(draft.steps).toHaveLength(2 * DIFFERENCE_PREFIX_STEP_COUNT + 2);
    const negations = draft.steps.filter((step) => step.operation === 'negate');
    expect(negations).toHaveLength(1);
    expect(negations[0]?.result_paise).toBe(500_000n);
    expect(negations[0]?.operands).toEqual([
      { kind: 'step', index: 2 * DIFFERENCE_PREFIX_STEP_COUNT },
    ]);

    const terminal = draft.steps[draft.steps.length - 1];
    expect(terminal?.operation).toBe('sum');
    // The positive contributor's step 8 directly, and the excess's negate step.
    expect(terminal?.operands).toEqual([
      { kind: 'step', index: DIFFERENCE_PREFIX_STEP_COUNT },
      { kind: 'step', index: 2 * DIFFERENCE_PREFIX_STEP_COUNT + 1 },
    ]);
  });

  it('grounds an empty remainder in the examined scope rather than in nothing', () => {
    const draft = composeEvidenceChain(
      totalAbsoluteDifferenceChain(PRODUCED_BY, {
        contributors: [],
        examined: [nine],
        total_absolute_difference_paise: 0n,
      }),
    );
    expect(draft.steps).toHaveLength(1);
    expect(draft.steps[0]?.operands).toEqual([{ kind: 'literal', value: '0' }]);
    expect(draft.figure_paise).toBe(0n);
    expect(draft.sources).toEqual([{ type: 'settlement', id: SET_9281.settlement_id }]);
  });

  it('refuses a contributor with no Difference or a Difference of zero', () => {
    const settled: ScopedSettlement = { ...nine.settlement, received_paise: 84_260_000n };
    const zero = {
      settlement: settled,
      recon: reconcileSettlement(settled.settlement_id, settled.received_paise, SET_9281.lines),
    };
    expect(hasNonZeroDifference(zero)).toBe(false);
    expect(() =>
      totalAbsoluteDifferenceChain(PRODUCED_BY, {
        contributors: [zero],
        examined: [zero],
        total_absolute_difference_paise: 0n,
      }),
    ).toThrow(/not a breakdown row/);
  });

  it('refuses a total that disagrees with the summed magnitudes', () => {
    expect(() =>
      totalAbsoluteDifferenceChain(PRODUCED_BY, {
        contributors: [nine],
        examined: [nine],
        total_absolute_difference_paise: 1n,
      }),
    ).toThrow(/summing the 1 contributing magnitudes produces 2320000/);
  });

  it('caps contributors lower than the shortfall chain, because of the negate step', () => {
    expect(ABSOLUTE_DIFFERENCE_STEP_COUNT).toBe(DIFFERENCE_PREFIX_STEP_COUNT + 1);
    expect(MAX_ABSOLUTE_DIFFERENCE_CONTRIBUTORS).toBe(3640);
    expect(MAX_ABSOLUTE_DIFFERENCE_CONTRIBUTORS).toBeLessThan(MAX_TOTAL_SHORTFALL_CONTRIBUTORS);
    const many = Array.from(
      { length: MAX_ABSOLUTE_DIFFERENCE_CONTRIBUTORS + 1 },
      (_unused, index) => {
        const id = `setl_SYNTHETIC${String(index).padStart(6, '0')}`;
        return {
          settlement: { ...nine.settlement, settlement_id: id },
          recon: { ...nine.recon, settlement_id: id },
        };
      },
    );
    expect(() =>
      totalAbsoluteDifferenceChain(PRODUCED_BY, {
        contributors: many,
        examined: many,
        total_absolute_difference_paise: 0n,
      }),
    ).toThrow(/Narrow the scope rather than presenting a figure whose evidence is truncated/);
  });
});
