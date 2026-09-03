/**
 * Tests for the independent replay interpreter (task 9.2). Requirement 12.8.
 *
 * Collected by the `unit` Vitest project: the interpreter is pure, so its tests
 * are stage 3 — in process, no database, no network.
 *
 * `EVIDENCE_OPERATIONS` is imported here, unlike in `replay-interpreter.ts`, and
 * that is deliberate. The independence rule of task 9.2 is about the
 * *interpreter*: it must not import arithmetic that could make P6 a tautology.
 * A **test** reading the closed label set to prove the interpreter is total over
 * it is the opposite of a tautology — it is what makes a tenth label added to
 * the enum fail here instead of replaying to `undefined`.
 */

import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_OPERATIONS,
  type EvidenceOperation,
  type EvidenceStep,
  type SourceRef,
} from '@/evidence/chain-builder';

import {
  DIFFERENCE_STEP_INDEX,
  EXPECTED_AMOUNT_STEP_INDEX,
  RESIDUAL_STEP_INDEX,
  SET_9281,
  SET_9281_FEE_VARIANT,
  STEP_COUNT,
} from '../fixtures/set-9281';
import {
  monetaryStepResult,
  recordLookupFromRecords,
  replayFigure,
  replaySteps,
  ReplayError,
  type ReplayFailureKind,
  type ReplaySourceRecord,
  type SourceRecordLookup,
} from './replay-interpreter';

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const REF: SourceRef = { type: 'payment', id: 'pay_ONE' };
const OTHER: SourceRef = { type: 'settlement', id: 'setl_ONE' };

/** One record exposing `amount`, `fee` and a deliberately signed field. */
const RECORDS: readonly (ReplaySourceRecord & { readonly ref: SourceRef })[] = [
  { ref: REF, fields: { amount: 5000n, fee: 100n, signed_amount: -300n, credit: 0n, debit: 300n } },
  { ref: OTHER, fields: { amount: 4900n } },
];

const lookup: SourceRecordLookup = recordLookupFromRecords(RECORDS);

const src = (field: string, ref: SourceRef = REF) =>
  ({ kind: 'source', ref, field }) as const;
const lit = (value: string) => ({ kind: 'literal', value }) as const;
const prior = (index: number) => ({ kind: 'step', index }) as const;

/** One step, indexes assigned by position, `result_paise` left unstated. */
function chain(...steps: readonly Omit<EvidenceStep, 'index'>[]): readonly EvidenceStep[] {
  return steps.map((step, position) => ({ ...step, index: position + 1 }));
}

/** The recomputed figure, or a thrown assertion naming the refusal. */
function figureOf(steps: readonly EvidenceStep[], seam: SourceRecordLookup = lookup): bigint {
  return replayFigure(steps, { lookup: seam });
}

/** The refusal kind, or a thrown assertion if the replay unexpectedly succeeded. */
function refusalOf(
  steps: readonly EvidenceStep[],
  seam: SourceRecordLookup = lookup,
): ReplayFailureKind {
  const outcome = replaySteps(steps, { lookup: seam });
  if (outcome.ok) {
    throw new Error(`expected a refusal, but the replay returned ${outcome.figure_paise}`);
  }
  return outcome.failure.kind;
}

/* -------------------------------------------------------------------------- */
/* design.md's worked example                                                 */
/* -------------------------------------------------------------------------- */

describe('SET-9281, design.md’s twelve-step worked example', () => {
  const seam = recordLookupFromRecords(SET_9281.records);

  it('replays the twelve steps to 0n, the residual and the chain figure', () => {
    const outcome = replaySteps(SET_9281.chain.steps, { lookup: seam });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.step_results).toHaveLength(STEP_COUNT);
    expect(outcome.figure_paise).toBe(0n);
    // What property P6 (task 9.3) will assert.
    expect(outcome.figure_paise).toBe(SET_9281.chain.figure_paise);
  });

  it('reproduces 2320000n for the Difference at the intermediate step', () => {
    const outcome = replaySteps(SET_9281.chain.steps, { lookup: seam });

    expect(monetaryStepResult(outcome, DIFFERENCE_STEP_INDEX)).toBe(2320000n);
    expect(monetaryStepResult(outcome, EXPECTED_AMOUNT_STEP_INDEX)).toBe(84260000n);
    expect(monetaryStepResult(outcome, RESIDUAL_STEP_INDEX)).toBe(0n);
  });

  it('replays the ₹19,000 fee variant to 66100n', () => {
    const variantSeam = recordLookupFromRecords(SET_9281_FEE_VARIANT.records);

    expect(replayFigure(SET_9281_FEE_VARIANT.chain.steps, { lookup: variantSeam })).toBe(
      SET_9281_FEE_VARIANT.chain.figure_paise,
    );
  });

  it('reads signed_amount as a field rather than deriving credit − debit', () => {
    const adjustment = SET_9281.records.find((r) => r.ref.id === 'adj_SYNTHETIC92811');
    expect(adjustment?.fields.signed_amount).toBe(-300000n);

    // Step 6 sums the two `signed_amount` reads, so the sum is negative and
    // step 7 is `add`. Nothing in the interpreter computes the sign.
    const outcome = replaySteps(SET_9281.chain.steps, { lookup: seam });
    expect(monetaryStepResult(outcome, 6)).toBe(-490000n);
  });

  it('refuses when a record the chain cites is absent from the seam', () => {
    const partial = recordLookupFromRecords(SET_9281.records.slice(1));

    expect(refusalOf(SET_9281.chain.steps, partial)).toBe('missing_record');
  });
});

/* -------------------------------------------------------------------------- */
/* The 9 operations                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One replayable step per `evidence_operation` label. Keyed by the label so the
 * `EVIDENCE_OPERATIONS` coverage test below fails to compile — and then fails to
 * pass — if a tenth label is added to the enum.
 */
const SAMPLES: Readonly<Record<EvidenceOperation, readonly EvidenceStep[]>> = {
  sum: chain({ operation: 'sum', operands: [src('amount'), src('fee'), lit('900')], result_paise: null }),
  add: chain({ operation: 'add', operands: [lit('1200'), lit('-200')], result_paise: null }),
  subtract: chain({ operation: 'subtract', operands: [src('amount'), src('fee')], result_paise: null }),
  multiply: chain({ operation: 'multiply', operands: [lit('7'), lit('-6')], result_paise: null }),
  divide: chain({ operation: 'divide', operands: [lit('1000'), lit('4')], result_paise: null }),
  round_half_up: chain({
    operation: 'round_half_up',
    operands: [lit('1005'), lit('10')],
    result_paise: null,
  }),
  negate: chain({ operation: 'negate', operands: [src('amount')], result_paise: null }),
  select: chain({ operation: 'select', operands: [src('signed_amount')], result_paise: null }),
  // `compare` yields a boolean, which cannot be a terminal figure, so the
  // sample pairs it with a monetary terminal step.
  compare: chain(
    { operation: 'compare', operands: [src('amount'), src('amount')], result_paise: null },
    { operation: 'sum', operands: [lit('1')], result_paise: 1n },
  ),
};

describe('the 9 evidence_operation labels', () => {
  it('is total over the closed label set', () => {
    for (const operation of EVIDENCE_OPERATIONS) {
      const steps = SAMPLES[operation];
      const outcome = replaySteps(steps, { lookup });

      expect(outcome.ok, `${operation} was refused`).toBe(true);
    }
    expect(Object.keys(SAMPLES)).toHaveLength(EVIDENCE_OPERATIONS.length);
  });

  it('sum folds every operand, including a single one', () => {
    expect(figureOf(SAMPLES.sum)).toBe(6000n); // 5000 + 100 + 900
    expect(
      figureOf(chain({ operation: 'sum', operands: [src('fee')], result_paise: 100n })),
    ).toBe(100n);
  });

  it('add folds identically to sum, design.md stating no difference', () => {
    expect(figureOf(SAMPLES.add)).toBe(1000n);
    expect(
      figureOf(chain({ operation: 'add', operands: [lit('1200'), lit('-200')], result_paise: null })),
    ).toBe(figureOf(chain({ operation: 'sum', operands: [lit('1200'), lit('-200')], result_paise: null })));
  });

  it('subtract takes operands[0] − operands[1] in order', () => {
    expect(figureOf(SAMPLES.subtract)).toBe(4900n);
    expect(
      figureOf(chain({ operation: 'subtract', operands: [src('fee'), src('amount')], result_paise: null })),
    ).toBe(-4900n);
  });

  it('multiply folds the product', () => {
    expect(figureOf(SAMPLES.multiply)).toBe(-42n);
    expect(
      figureOf(chain({ operation: 'multiply', operands: [lit('2'), lit('3'), lit('4')], result_paise: null })),
    ).toBe(24n);
  });

  it('divide takes the numerator first and rounds half away from zero', () => {
    expect(figureOf(SAMPLES.divide)).toBe(250n);
    // 7/2 = 3.5 → 4n, and the operand order is not commutative: 2/7 → 0n.
    expect(figureOf(chain({ operation: 'divide', operands: [lit('7'), lit('2')], result_paise: null }))).toBe(4n);
    expect(figureOf(chain({ operation: 'divide', operands: [lit('2'), lit('7')], result_paise: null }))).toBe(0n);
  });

  it('round_half_up applies the same rule as divide', () => {
    expect(figureOf(SAMPLES.round_half_up)).toBe(101n); // 100.5 → 101
    expect(
      figureOf(chain({ operation: 'round_half_up', operands: [lit('1005'), lit('10')], result_paise: null })),
    ).toBe(figureOf(chain({ operation: 'divide', operands: [lit('1005'), lit('10')], result_paise: null })));
  });

  it('negate flips the sign', () => {
    expect(figureOf(SAMPLES.negate)).toBe(-5000n);
    expect(figureOf(chain({ operation: 'negate', operands: [lit('-7')], result_paise: 7n }))).toBe(7n);
  });

  it('select passes its single operand through unchanged', () => {
    expect(figureOf(SAMPLES.select)).toBe(-300n);
  });

  it('compare yields a boolean equality, carried but never stored as paise', () => {
    const equal = replaySteps(SAMPLES.compare, { lookup });
    expect(equal.ok).toBe(true);
    if (!equal.ok) return;
    expect(equal.step_results[0]?.value).toStrictEqual({ kind: 'boolean', value: true });

    const unequal = replaySteps(
      chain(
        { operation: 'compare', operands: [src('amount'), src('fee')], result_paise: null },
        { operation: 'sum', operands: [lit('1')], result_paise: 1n },
      ),
      { lookup },
    );
    expect(unequal.ok).toBe(true);
    if (!unequal.ok) return;
    expect(unequal.step_results[0]?.value).toStrictEqual({ kind: 'boolean', value: false });
  });
});

/* -------------------------------------------------------------------------- */
/* The rounding boundary                                                      */
/* -------------------------------------------------------------------------- */

describe('half away from zero, the house rounding rule', () => {
  const divide = (numerator: string, denominator: string): bigint =>
    figureOf(
      chain({ operation: 'divide', operands: [lit(numerator), lit(denominator)], result_paise: null }),
    );

  it('rounds −0.5 to −1n and +0.5 to +1n', () => {
    expect(divide('-1', '2')).toBe(-1n);
    expect(divide('1', '2')).toBe(1n);
  });

  it('keeps sign symmetry across the boundary', () => {
    for (const numerator of ['1', '3', '5', '7', '1005', '99']) {
      expect(divide(`-${numerator}`, '2')).toBe(-divide(numerator, '2'));
    }
  });

  it('rounds a negative denominator the same way', () => {
    expect(divide('1', '-2')).toBe(-1n);
    expect(divide('-1', '-2')).toBe(1n);
  });

  it('leaves an exact quotient alone', () => {
    expect(divide('1000', '4')).toBe(250n);
    expect(divide('-1000', '4')).toBe(-250n);
  });
});

/* -------------------------------------------------------------------------- */
/* Rejections                                                                 */
/* -------------------------------------------------------------------------- */

describe('rejections are explicit and typed', () => {
  it('empty_chain: no steps at all', () => {
    expect(refusalOf([])).toBe('empty_chain');
  });

  it('step_index_not_gapless: indexes (1, 3)', () => {
    const steps: readonly EvidenceStep[] = [
      { index: 1, operation: 'sum', operands: [lit('1')], result_paise: 1n },
      { index: 3, operation: 'sum', operands: [prior(1)], result_paise: 1n },
    ];
    expect(refusalOf(steps)).toBe('step_index_not_gapless');
  });

  it('unknown_operation: a label outside the enum', () => {
    const steps = [
      { index: 1, operation: 'exponentiate' as EvidenceOperation, operands: [lit('2')], result_paise: null },
    ] as const;
    expect(refusalOf(steps)).toBe('unknown_operation');
  });

  it('arity: subtract with three operands, select with two', () => {
    expect(
      refusalOf(chain({ operation: 'subtract', operands: [lit('3'), lit('2'), lit('1')], result_paise: null })),
    ).toBe('arity');
    expect(
      refusalOf(chain({ operation: 'select', operands: [lit('0'), lit('9')], result_paise: null })),
    ).toBe('arity');
  });

  it('unknown_operand_kind: a fourth operand shape', () => {
    const steps = [
      {
        index: 1,
        operation: 'sum' as EvidenceOperation,
        operands: [{ kind: 'column', name: 'amount' }],
        result_paise: null,
      },
    ] as unknown as readonly EvidenceStep[];
    expect(refusalOf(steps)).toBe('unknown_operand_kind');
  });

  it('non_string_literal: a JSON number survived the round trip', () => {
    const steps = [
      { index: 1, operation: 'sum' as EvidenceOperation, operands: [{ kind: 'literal', value: 100 }], result_paise: null },
    ] as unknown as readonly EvidenceStep[];
    expect(refusalOf(steps)).toBe('non_string_literal');
  });

  it('malformed_literal: a decimal point, a space, an empty string', () => {
    for (const value of ['100.5', ' 100', '', '1e3', '+100', '0x10']) {
      expect(refusalOf(chain({ operation: 'sum', operands: [lit(value)], result_paise: null }))).toBe(
        'malformed_literal',
      );
    }
  });

  it('forward_step_reference: step 1 citing step 2, and a step citing itself', () => {
    expect(
      refusalOf(
        chain(
          { operation: 'sum', operands: [prior(2)], result_paise: null },
          { operation: 'sum', operands: [lit('1')], result_paise: 1n },
        ),
      ),
    ).toBe('forward_step_reference');
    expect(refusalOf(chain({ operation: 'sum', operands: [prior(1)], result_paise: null }))).toBe(
      'forward_step_reference',
    );
  });

  it('invalid_step_reference: a zero or fractional ordinal', () => {
    expect(refusalOf(chain({ operation: 'sum', operands: [prior(0)], result_paise: null }))).toBe(
      'invalid_step_reference',
    );
    expect(refusalOf(chain({ operation: 'sum', operands: [prior(1.5)], result_paise: null }))).toBe(
      'invalid_step_reference',
    );
  });

  it('missing_record: the seam resolves nothing for the cited ref', () => {
    expect(
      refusalOf(
        chain({
          operation: 'sum',
          operands: [src('amount', { type: 'refund', id: 'rfnd_ABSENT' })],
          result_paise: null,
        }),
      ),
    ).toBe('missing_record');
  });

  it('unresolvable_field: an absent field, including signed_amount', () => {
    expect(refusalOf(chain({ operation: 'sum', operands: [src('tax')], result_paise: null }))).toBe(
      'unresolvable_field',
    );
    // `OTHER` exposes `amount` only, so the projection is not derived from credit/debit.
    expect(
      refusalOf(chain({ operation: 'sum', operands: [src('signed_amount', OTHER)], result_paise: null })),
    ).toBe('unresolvable_field');
    // An inherited property is not a field either.
    expect(
      refusalOf(chain({ operation: 'sum', operands: [src('toString')], result_paise: null })),
    ).toBe('unresolvable_field');
  });

  it('non_monetary_field: a field that is not a bigint', () => {
    const seam: SourceRecordLookup = () =>
      ({ fields: { amount: 5000 } } as unknown as ReplaySourceRecord);

    expect(refusalOf(chain({ operation: 'sum', operands: [src('amount')], result_paise: null }), seam)).toBe(
      'non_monetary_field',
    );
  });

  it('non_monetary_operand: a comparison outcome reaching arithmetic', () => {
    expect(
      refusalOf(
        chain(
          { operation: 'compare', operands: [src('amount'), src('fee')], result_paise: null },
          { operation: 'sum', operands: [prior(1), lit('1')], result_paise: null },
        ),
      ),
    ).toBe('non_monetary_operand');
  });

  it('division_by_zero: a zero denominator', () => {
    expect(
      refusalOf(chain({ operation: 'divide', operands: [lit('100'), lit('0')], result_paise: null })),
    ).toBe('division_by_zero');
    expect(
      refusalOf(chain({ operation: 'round_half_up', operands: [lit('100'), lit('0')], result_paise: null })),
    ).toBe('division_by_zero');
  });

  it('out_of_range: a result above the paise ceiling, and a source field outside it', () => {
    expect(
      refusalOf(
        chain({ operation: 'multiply', operands: [lit('99999999999999'), lit('2')], result_paise: null }),
      ),
    ).toBe('out_of_range');

    const seam: SourceRecordLookup = () => ({ fields: { amount: 100000000000000n } });
    expect(refusalOf(chain({ operation: 'sum', operands: [src('amount')], result_paise: null }), seam)).toBe(
      'out_of_range',
    );
  });

  it('non_monetary_result_stated: a compare step declaring result_paise', () => {
    expect(
      refusalOf(
        chain(
          { operation: 'compare', operands: [src('amount'), src('amount')], result_paise: 1n },
          { operation: 'sum', operands: [lit('1')], result_paise: 1n },
        ),
      ),
    ).toBe('non_monetary_result_stated');
  });

  it('non_monetary_terminal_step: the chain ends on a comparison', () => {
    expect(
      refusalOf(chain({ operation: 'compare', operands: [src('amount'), src('amount')], result_paise: null })),
    ).toBe('non_monetary_terminal_step');
  });

  it('replayFigure throws a ReplayError carrying the typed failure', () => {
    try {
      figureOf(chain({ operation: 'divide', operands: [lit('1'), lit('0')], result_paise: null }));
      throw new Error('expected a ReplayError');
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayError);
      expect((error as ReplayError).failure.kind).toBe('division_by_zero');
      expect((error as ReplayError).failure.step_index).toBe(1);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The interpreter is not echoing the chain                                   */
/* -------------------------------------------------------------------------- */

describe('a stated result_paise that disagrees with the recomputed value', () => {
  /** SET-9281 with the Difference step overstated by one paisa. */
  const tampered: readonly EvidenceStep[] = SET_9281.chain.steps.map((step) =>
    step.index === DIFFERENCE_STEP_INDEX ? { ...step, result_paise: 2320001n } : step,
  );
  const seam = recordLookupFromRecords(SET_9281.records);

  it('is detected, naming the step and the difference', () => {
    const outcome = replaySteps(tampered, { lookup: seam });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.kind).toBe('result_disagreement');
    expect(outcome.failure.step_index).toBe(DIFFERENCE_STEP_INDEX);
    expect(outcome.failure.message).toContain('2320001');
    expect(outcome.failure.message).toContain('2320000');
  });

  it('is detected for a one-paisa error in the terminal figure too', () => {
    const terminalTampered = SET_9281.chain.steps.map((step) =>
      step.index === RESIDUAL_STEP_INDEX ? { ...step, result_paise: 1n } : step,
    );

    expect(refusalOf(terminalTampered, seam)).toBe('result_disagreement');
  });

  it('recomputes the true value with the stated results ignored, so it is not an echo', () => {
    const outcome = replaySteps(tampered, { lookup: seam, verifyStatedResults: false });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The chain *states* 2320001n at step 8; the interpreter computes 2320000n
    // from the Source_Records alone and reaches the true 0n residual.
    expect(monetaryStepResult(outcome, DIFFERENCE_STEP_INDEX)).toBe(2320000n);
    expect(outcome.figure_paise).toBe(0n);
  });

  it('reaches a different figure when a cited Source_Record value differs', () => {
    const altered = SET_9281.records.map((record) =>
      record.ref.id === 'pay_SYNTHETIC92811'
        ? { ...record, fields: { ...record.fields, amount: 52000001n } }
        : record,
    );

    const outcome = replaySteps(SET_9281.chain.steps, {
      lookup: recordLookupFromRecords(altered),
      verifyStatedResults: false,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.figure_paise).toBe(1n);
  });
});
