// Self-check for `test/fixtures/set-9281.ts` (task 7.2).
//
// A fixture nothing checks is a set of numbers with a confident type. This file is what
// makes the fixture trustworthy to its consumers — tasks 8.5, 9.3, 11.3 and 16.1 — by
// asserting four things:
//
//   1. The reconciliation figures satisfy Requirement 4.2, 4.3, 4.4 and 4.5 arithmetic,
//      with the residual exactly `0n` for SET-9281 and no tolerance band anywhere.
//   2. The twelve-step Evidence_Chain is well formed: `index` 1..12 gapless, every step
//      operand backward-only, `source_count` matching the source list.
//   3. The chain replays: walking the steps over the fixture's Source_Records reproduces
//      every stated `result_paise`, `2320000n` at the Difference step and the chain's
//      `figure_paise` at the terminal step (Requirement 12.8).
//   4. Every figure agrees with `razorpay-seed.json` (task 7.1), so the two statements of
//      the worked example cannot drift and neither is silently authoritative.
//
// The replay walk below is deliberately local and about twenty lines long. It is NOT the
// independent replay interpreter of task 9.2 (`test/evidence/replay-interpreter.ts`) —
// that one is P6's instrument and this file must not pre-empt it. This walk exists only
// to prove the fixture's own stated results are self-consistent.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Paise } from '@/calc/paise';
import type { SourceRef } from '@/ledger/posting-rules';
import { fromWire } from '@/wire/paise-wire';

import {
  DIFFERENCE_STEP_INDEX,
  type EvidenceOperand,
  type EvidenceOperation,
  EXPECTED_AMOUNT_STEP_INDEX,
  EXPECTED_OPERATION_SEQUENCE,
  findRecord,
  RESIDUAL_STEP_INDEX,
  SET_9281,
  SET_9281_FEE_VARIANT,
  STEP_COUNT,
  WORKED_EXAMPLES,
  type WorkedExample,
} from './set-9281';

// ---------------------------------------------------------------------------
// A local replay walk. Not task 9.2's interpreter.
// ---------------------------------------------------------------------------

function operandValue(
  example: WorkedExample,
  operand: EvidenceOperand,
  priorResults: readonly Paise[],
): Paise {
  switch (operand.kind) {
    case 'source': {
      const record = findRecord(example, operand.ref);
      if (record === undefined) {
        throw new Error(`no Source_Record for ${operand.ref.type}:${operand.ref.id}`);
      }
      const value = record.fields[operand.field];
      if (value === undefined) {
        throw new Error(`${operand.ref.id} carries no field ${operand.field}`);
      }
      return value;
    }
    case 'step': {
      const value = priorResults[operand.index - 1];
      if (value === undefined) {
        throw new Error(`step ${operand.index} has no result yet`);
      }
      return value;
    }
    case 'literal':
      return BigInt(operand.value);
  }
}

/**
 * The three operations these chains use. Any other label is a failure rather than a
 * fallthrough: a partial interpreter would turn a wrong chain into a passing test.
 */
function apply(
  operation: EvidenceOperation,
  values: readonly Paise[],
  stepIndex: number,
): Paise {
  switch (operation) {
    case 'sum':
    case 'add':
      return values.reduce((total, operand) => total + operand, 0n);
    case 'subtract': {
      const [minuend, subtrahend] = values;
      if (minuend === undefined || subtrahend === undefined || values.length !== 2) {
        throw new Error(`step ${stepIndex}: subtract takes exactly 2 operands`);
      }
      return minuend - subtrahend;
    }
    default:
      throw new Error(`step ${stepIndex}: unexpected operation ${operation}`);
  }
}

/** Walks the chain in `index` order and returns each step's replayed value. */
function replay(example: WorkedExample): readonly Paise[] {
  const results: Paise[] = [];
  for (const step of example.chain.steps) {
    const values = step.operands.map((operand) => operandValue(example, operand, results));
    results.push(apply(step.operation, values, step.index));
  }
  return results;
}

function sumOf(values: readonly Paise[]): Paise {
  return values.reduce((total, value) => total + value, 0n);
}

function stepResult(example: WorkedExample, index: number): Paise {
  const step = example.chain.steps.find((s) => s.index === index);
  if (step === undefined || step.result_paise === null) {
    throw new Error(`step ${index} is absent or non-monetary`);
  }
  return step.result_paise;
}

const refKey = (ref: SourceRef): string => `${ref.type}:${ref.id}`;

// ---------------------------------------------------------------------------
// `razorpay-seed.json` (task 7.1), read as untyped JSON and narrowed by hand
// ---------------------------------------------------------------------------

// `Json[]` rather than `readonly Json[]`: `Array.isArray` does not narrow a readonly
// array out of a union, so the mutable element type is what keeps `obj` well typed.
type Json = string | number | boolean | null | Json[] | { readonly [k: string]: Json };

function obj(value: Json | undefined, where: string): { readonly [k: string]: Json } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${where} is not an object`);
  }
  return value;
}

function arr(value: Json | undefined, where: string): readonly Json[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where} is not an array`);
  }
  return value;
}

function str(value: Json | undefined, where: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${where} is not a string`);
  }
  return value;
}

/** A monetary field of the seed: a decimal string, decoded through the wire contract. */
function money(value: Json | undefined, where: string): Paise {
  return fromWire(str(value, where), where);
}

function moneyList(value: Json | undefined, where: string): readonly Paise[] {
  return arr(value, where).map((element, i) => money(element, `${where}[${i}]`));
}

const SEED: Json = JSON.parse(
  readFileSync(new URL('./razorpay-seed.json', import.meta.url), 'utf8'),
) as Json;

/** The seed's entry for one Settlement, located by identifier rather than by position. */
function seedSettlement(settlementId: string): { readonly [k: string]: Json } {
  const settlements = arr(
    obj(obj(SEED, 'seed')['part_b_synthetic'], 'part_b_synthetic')['settlements'],
    'settlements',
  );
  const found = settlements
    .map((entry, i) => obj(entry, `settlements[${i}]`))
    .find((entry) => entry['settlement_id'] === settlementId);
  if (found === undefined) {
    throw new Error(`razorpay-seed.json has no settlement ${settlementId}`);
  }
  return found;
}

/** The seed's recon report line payloads for one Settlement, keyed by `entity_id`. */
function seedReconLines(
  settlementId: string,
): ReadonlyMap<string, { readonly [k: string]: Json }> {
  const objects = obj(seedSettlement(settlementId)['objects'], 'objects');
  const lines = arr(objects['recon_report_lines'], 'recon_report_lines');
  const byEntity = new Map<string, { readonly [k: string]: Json }>();
  for (const [i, line] of lines.entries()) {
    const payload = obj(obj(line, `recon_report_lines[${i}]`)['payload'], 'payload');
    byEntity.set(str(payload['entity_id'], 'entity_id'), payload);
  }
  return byEntity;
}

// ---------------------------------------------------------------------------

describe.each(WORKED_EXAMPLES.map((example) => [example.display_name, example] as const))(
  '%s reconciliation figures',
  (_name, example) => {
    const { lines, recon } = example;

    it('computes the Expected Amount by Requirement 4.2, signed adjustments included', () => {
      const expected =
        sumOf(lines.payments) -
        sumOf(lines.refunds) -
        sumOf(lines.chargebacks) +
        sumOf(lines.adjustments);

      expect(sumOf(lines.adjustments)).toBe(-490000n); // signed: both lines are debits
      expect(expected).toBe(84260000n);
      expect(recon.expected_paise).toBe(expected);
    });

    it('decomposes the Difference exactly (Requirement 4.3)', () => {
      expect(recon.difference_paise).toBe(84260000n - example.received_paise);
      expect(recon.fee_component_paise).toBe(sumOf(lines.fees));
      expect(recon.gst_component_paise).toBe(sumOf(lines.gst_on_fees));

      const { difference_paise, fee_component_paise, gst_component_paise, residual_paise } =
        recon;
      if (
        difference_paise === null ||
        fee_component_paise === null ||
        gst_component_paise === null ||
        residual_paise === null
      ) {
        throw new Error('a worked example never has a null figure');
      }
      expect(residual_paise).toBe(difference_paise - fee_component_paise - gst_component_paise);
      // difference = fee + gst + residual, exact, no rounding step in the path
      expect(fee_component_paise + gst_component_paise + residual_paise).toBe(difference_paise);
    });

    it('sets status and direction off the residual with no tolerance band', () => {
      const residual = recon.residual_paise;
      expect(typeof residual).toBe('bigint');
      expect(recon.status).toBe(residual === 0n ? 'difference_explained' : 'mismatch');
      expect(recon.direction).toBe(
        residual === 0n
          ? 'not_applicable'
          : (residual ?? 0n) > 0n
            ? 'unexplained_shortfall'
            : 'unexplained_excess',
      );
    });

    it('creates an Exception exactly when the residual is non-zero', () => {
      const residual = recon.residual_paise ?? 0n;
      if (residual === 0n) {
        expect(example.exception).toBeNull(); // Requirement 4.4
        return;
      }
      const exception = example.exception;
      if (exception === null) {
        throw new Error('a non-zero residual requires an Exception (Requirement 4.5)');
      }
      expect(exception.category).toBe('settlement_mismatch');
      expect(exception.impact_paise).toBe(residual < 0n ? -residual : residual);
      expect(exception.direction).toBe(recon.direction);
      expect(exception.lifecycle_state).toBe('open');
      // Requirement 4.5: the Settlement identifier and the Settlement_Recon_Report identifier.
      expect(exception.source_refs.map(refKey)).toEqual([
        `settlement:${example.settlement_id}`,
        `settlement_recon_report:${example.recon_report_id}`,
      ]);
    });

    it('reports every figure against the Settlement identifier (Requirement 4.4)', () => {
      expect(recon.settlement_id).toBe(example.settlement_id);
      expect(recon.received_paise).toBe(example.received_paise);
      expect(example.examined.payments_counted).toBe(lines.payments.length);
      expect(example.examined.refunds_counted).toBe(lines.refunds.length);
      expect(example.examined.chargebacks_counted).toBe(lines.chargebacks.length);
      expect(example.examined.adjustments_counted).toBe(lines.adjustments.length);
    });
  },
);

describe.each(WORKED_EXAMPLES.map((example) => [example.display_name, example] as const))(
  '%s twelve-step Evidence_Chain',
  (_name, example) => {
    const { chain } = example;

    it('holds exactly twelve steps, indexed 1..12 gapless', () => {
      expect(chain.steps).toHaveLength(STEP_COUNT);
      expect(chain.steps.map((step) => step.index)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]);
    });

    it('runs the operations in design.md order', () => {
      expect(chain.steps.map((step) => step.operation)).toEqual([
        ...EXPECTED_OPERATION_SEQUENCE,
      ]);
    });

    it('references only strictly lower step indexes', () => {
      // The schema does not enforce this (migration 6, FINDING 2), so the chain has to be
      // correct by construction and this is where that is asserted.
      for (const step of chain.steps) {
        for (const operand of step.operands) {
          if (operand.kind === 'step') {
            expect(operand.index).toBeGreaterThanOrEqual(1);
            expect(operand.index).toBeLessThan(step.index);
          }
        }
      }
    });

    it('cites at least one operand per step, and a monetary result on every step', () => {
      for (const step of chain.steps) {
        expect(step.operands.length).toBeGreaterThanOrEqual(1);
        expect(typeof step.result_paise).toBe('bigint');
      }
    });

    it('carries a source list matching source_count, with no duplicate identifier', () => {
      expect(chain.source_count).toBe(chain.sources.length);
      expect(chain.source_count).toBeGreaterThanOrEqual(1);
      expect(new Set(chain.sources.map(refKey)).size).toBe(chain.source_count);
    });

    it('cites only Source_Records the fixture carries, and carries no uncited record', () => {
      const cited = new Set<string>();
      for (const step of chain.steps) {
        for (const operand of step.operands) {
          if (operand.kind === 'source') {
            cited.add(refKey(operand.ref));
            expect(findRecord(example, operand.ref)).toBeDefined();
          }
        }
      }
      expect([...cited].sort()).toEqual([...chain.sources.map(refKey)].sort());
      expect(example.records.map((record) => refKey(record.ref)).sort()).toEqual(
        [...chain.sources.map(refKey)].sort(),
      );
    });

    it('sets as_of to ISO-8601 UTC with millisecond precision, at or after every record', () => {
      expect(chain.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(chain.as_of).toISOString()).toBe(chain.as_of);
      for (const record of example.records) {
        expect(Date.parse(record.record_updated_at)).toBeLessThanOrEqual(
          Date.parse(chain.as_of),
        );
      }
    });

    it('projects signed_amount as credit minus debit on every adjustment line', () => {
      const adjustments = example.records.filter(
        (record) => record.fields['signed_amount'] !== undefined,
      );
      expect(adjustments).toHaveLength(2);
      for (const record of adjustments) {
        const { signed_amount, credit, debit } = record.fields;
        expect(signed_amount).toBe((credit ?? 0n) - (debit ?? 0n));
      }
    });

    it('replays to every stated result, the Difference at step 8 and the figure at step 12', () => {
      const replayed = replay(example);

      expect(replayed).toHaveLength(STEP_COUNT);
      for (const step of example.chain.steps) {
        expect(replayed[step.index - 1]).toBe(step.result_paise);
      }

      expect(stepResult(example, EXPECTED_AMOUNT_STEP_INDEX)).toBe(84260000n);
      expect(stepResult(example, DIFFERENCE_STEP_INDEX)).toBe(2320000n);
      expect(stepResult(example, DIFFERENCE_STEP_INDEX)).toBe(example.recon.difference_paise);
      expect(stepResult(example, RESIDUAL_STEP_INDEX)).toBe(example.recon.residual_paise);
      // Requirement 12.8: the replayed figure equals the presented figure, exactly.
      expect(replayed[RESIDUAL_STEP_INDEX - 1]).toBe(chain.figure_paise);
    });
  },
);

describe('the worked-example figures design.md states', () => {
  it('states SET-9281 as expected 84260000, received 81940000, difference 2320000', () => {
    expect(SET_9281.recon.expected_paise).toBe(84260000n);
    expect(SET_9281.recon.received_paise).toBe(81940000n);
    expect(SET_9281.recon.difference_paise).toBe(2320000n);
    expect(SET_9281.recon.fee_component_paise).toBe(1966100n);
    expect(SET_9281.recon.gst_component_paise).toBe(353900n);
    expect(1966100n + 353900n).toBe(2320000n);
    // Requirement 4.4 admits no tolerance band: the residual *equals* zero.
    expect(SET_9281.recon.residual_paise).toBe(0n);
    expect(SET_9281.recon.status).toBe('difference_explained');
    expect(SET_9281.recon.direction).toBe('not_applicable');
    expect(SET_9281.exception).toBeNull();
    expect(SET_9281.chain.figure_paise).toBe(0n);
  });

  it('states the fee variant as fee 1900000 and residual 66100', () => {
    expect(SET_9281_FEE_VARIANT.recon.fee_component_paise).toBe(1900000n);
    expect(SET_9281_FEE_VARIANT.recon.gst_component_paise).toBe(353900n);
    expect(2320000n - 1900000n - 353900n).toBe(66100n);
    expect(SET_9281_FEE_VARIANT.recon.residual_paise).toBe(66100n);
    expect(SET_9281_FEE_VARIANT.recon.status).toBe('mismatch');
    expect(SET_9281_FEE_VARIANT.recon.direction).toBe('unexplained_shortfall');
    expect(SET_9281_FEE_VARIANT.exception?.impact_paise).toBe(66100n);
    expect(SET_9281_FEE_VARIANT.chain.figure_paise).toBe(66100n);
  });
});

describe.each(WORKED_EXAMPLES.map((example) => [example.display_name, example] as const))(
  '%s agrees with razorpay-seed.json',
  (_name, example) => {
    const entry = seedSettlement(example.settlement_id);
    const expectedRecon = obj(entry['expected_recon'], 'expected_recon');
    const seedLines = obj(entry['recon_report_lines'], 'recon_report_lines');

    it('agrees on the identifiers and the settlement date', () => {
      expect(str(entry['display_name'], 'display_name')).toBe(example.display_name);
      expect(str(entry['recon_report_id'], 'recon_report_id')).toBe(example.recon_report_id);
      expect(str(entry['settlement_date'], 'settlement_date')).toBe(example.settlement_date);
    });

    it('agrees on all seven reconciliation figures and the status pair', () => {
      expect(money(expectedRecon['expected_paise'], 'expected_paise')).toBe(
        example.recon.expected_paise,
      );
      expect(money(expectedRecon['received_paise'], 'received_paise')).toBe(
        example.recon.received_paise,
      );
      expect(money(expectedRecon['difference_paise'], 'difference_paise')).toBe(
        example.recon.difference_paise,
      );
      expect(money(expectedRecon['fee_component_paise'], 'fee_component_paise')).toBe(
        example.recon.fee_component_paise,
      );
      expect(money(expectedRecon['gst_component_paise'], 'gst_component_paise')).toBe(
        example.recon.gst_component_paise,
      );
      expect(money(expectedRecon['residual_paise'], 'residual_paise')).toBe(
        example.recon.residual_paise,
      );
      expect(str(expectedRecon['status'], 'status')).toBe(example.recon.status);
      expect(str(expectedRecon['direction'], 'direction')).toBe(example.recon.direction);
    });

    it('agrees on the Exception expectation and the examined counts', () => {
      expect(expectedRecon['creates_exception']).toBe(example.exception !== null);
      expect(expectedRecon['exception_category']).toBe(example.exception?.category ?? null);
      const impact = expectedRecon['exception_impact_paise'];
      expect(impact === null ? null : money(impact, 'exception_impact_paise')).toBe(
        example.exception?.impact_paise ?? null,
      );
      expect(expectedRecon['payments_counted']).toBe(example.examined.payments_counted);
      expect(expectedRecon['refunds_counted']).toBe(example.examined.refunds_counted);
      expect(expectedRecon['chargebacks_counted']).toBe(example.examined.chargebacks_counted);
      expect(expectedRecon['adjustments_counted']).toBe(example.examined.adjustments_counted);
    });

    it('agrees line for line on all six ReconReportLines arrays', () => {
      expect(moneyList(seedLines['payments'], 'payments')).toEqual([...example.lines.payments]);
      expect(moneyList(seedLines['refunds'], 'refunds')).toEqual([...example.lines.refunds]);
      expect(moneyList(seedLines['chargebacks'], 'chargebacks')).toEqual([
        ...example.lines.chargebacks,
      ]);
      expect(moneyList(seedLines['adjustments'], 'adjustments')).toEqual([
        ...example.lines.adjustments,
      ]);
      expect(moneyList(seedLines['fees'], 'fees')).toEqual([...example.lines.fees]);
      expect(moneyList(seedLines['gst_on_fees'], 'gst_on_fees')).toEqual([
        ...example.lines.gst_on_fees,
      ]);
    });

    it('agrees on every cited recon report line payload, and on as_of', () => {
      const payloads = seedReconLines(example.settlement_id);

      for (const record of example.records) {
        if (record.ref.type !== 'settlement_recon_report') {
          continue;
        }
        const payload = payloads.get(record.ref.id);
        if (payload === undefined) {
          throw new Error(`razorpay-seed.json has no recon line ${record.ref.id}`);
        }
        expect(money(payload['amount'], 'amount')).toBe(record.fields['amount']);
        expect(money(payload['fee'], 'fee')).toBe(record.fields['fee']);
        expect(money(payload['tax'], 'tax')).toBe(record.fields['tax']);
        expect(money(payload['debit'], 'debit')).toBe(record.fields['debit']);
        expect(money(payload['credit'], 'credit')).toBe(record.fields['credit']);

        const settledAt = payload['settled_at'];
        if (typeof settledAt !== 'number') {
          throw new Error('settled_at is not a number');
        }
        // Unix seconds, and not money — the one place a JSON number is correct here.
        expect(new Date(settledAt * 1000).toISOString()).toBe(record.record_updated_at);
        expect(record.record_updated_at).toBe(example.chain.as_of);
      }
    });

    it('agrees on the Settlement object amount, fees and tax', () => {
      const settlement = obj(
        obj(obj(entry['objects'], 'objects')['settlement'], 'settlement')['payload'],
        'payload',
      );
      const record = findRecord(example, {
        type: 'settlement',
        id: example.settlement_id,
      });
      if (record === undefined) {
        throw new Error('the fixture carries no Settlement Source_Record');
      }
      expect(money(settlement['amount'], 'amount')).toBe(record.fields['amount']);
      expect(money(settlement['fees'], 'fees')).toBe(record.fields['fees']);
      expect(money(settlement['tax'], 'tax')).toBe(record.fields['tax']);
      // The received amount reconciliation compares the Expected Amount against.
      expect(record.fields['amount']).toBe(example.received_paise);
    });
  },
);
