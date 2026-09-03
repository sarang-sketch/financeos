/**
 * Generators for property P6 (task 9.3): Tenant datasets of Source_Records, and
 * well-formed Evidence_Chains composed over them.
 *
 * ## Why this module exists, and what it is *not*
 *
 * design.md's P6 generator input is `arbitraryTenantDataset`, "then every
 * read-only tool in the catalogue invoked over it". **The catalogue is empty**:
 * the 17 read-only tools are tasks 12.x, and `src/tools/registry.ts` (task 10.1)
 * registers no production tool. So the literal generator cannot be written yet,
 * and a P6 that iterated the catalogue alone would be a property over zero
 * inputs — green, and worth nothing.
 *
 * This module supplies the half that *is* provable today: chains generated
 * directly against the persisted `EvidenceStep` schema and pushed through 9.1's
 * composition funnel. `test/property/tool-catalogue.ts` supplies the other half,
 * driven by the registry so it starts doing work the moment a tool registers.
 *
 * The dataset arbitrary here is deliberately **not** called
 * `arbitraryTenantDataset`. That name belongs to the shared, richer dataset P5,
 * P7 and P8 will need (Payments, Refunds, Settlements with recon reports, Route
 * splits, Invoices — tasks 13.x onward), and claiming it for a
 * `(ref, fields, updated_at)` triple would leave the later author with a name
 * that means something narrower than it says.
 * {@link arbitraryEvidenceTenantDataset} is what an Evidence_Chain actually reads:
 * a set of Source_Record identifiers, each exposing monetary fields
 * (Requirement 12.2), which is the same seam the replay interpreter of task 9.2
 * resolves ({@link ReplaySourceRecord}).
 *
 * ## The generated chain is the *tools'* side of P6
 *
 * P6 compares two independent computations of one figure. So the two sides here
 * are kept apart on purpose:
 *
 * | Side | Code |
 * |---|---|
 * | producer (stands in for a Financial_Tool) | this module, computing each `result_paise` through **`@/calc/calculation-service`** — the production `sum`, `add`, `subtract` and `roundHalfUpToPaisa` — plus `@/evidence/chain-builder`'s funnel |
 * | replay | `test/evidence/replay-interpreter.ts`, which imports neither |
 *
 * That is what makes the rounding clause load bearing: a `divide` or
 * `round_half_up` step's stated result comes from `roundHalfUpToPaisa`, and the
 * interpreter's comes from its own reimplementation of the rule. `multiply` and
 * `negate` have no Calculation_Service counterpart, so those two steps are
 * folded with plain `bigint` operators here and the comparison for them is
 * structural rather than arithmetic. Stated rather than left to be assumed.
 *
 * ## Every generated chain is one the interpreter accepts, by construction
 *
 * A chain the interpreter *refuses* is a generator bug, not a P6 failure, and
 * the two must be distinguishable. Rather than generate freely and filter, this
 * module only ever emits shapes inside the intersection of both contracts:
 *
 *   - `step_index` is assigned `1..n` in array order, and a `{ kind: 'step' }`
 *     operand only ever cites an index already built — gapless and backward-only
 *     hold structurally (both are TypeScript-only invariants; migration
 *     FINDING 2).
 *   - Arities are taken from 9.2's pinned table, which is stricter than 9.1's:
 *     `subtract`/`divide`/`round_half_up`/`compare` take exactly 2, `negate` and
 *     **`select` exactly 1** (a multi-operand `select` is rejected there), `sum`
 *     and `add` 1..n, `multiply` 2..n.
 *   - A `compare` step carries `result_paise: null` (a boolean has no paise
 *     value), is never used as an operand (a boolean reaching arithmetic is
 *     rejected), and is never terminal (a boolean terminal step is rejected):
 *     {@link buildChain} appends a `select` of the last monetary step if a
 *     `compare` would otherwise land last.
 *   - Every `{ kind: 'source' }` operand is cited in `sources` with the record's
 *     own `record_updated_at`, so the funnel's citation check passes and the
 *     replay seam can resolve the field. `signed_amount` is generated as a
 *     **stored field** on adjustment-shaped records, never derived, matching
 *     9.2's seam exactly.
 *   - Literals are decimal strings. Denominators are drawn away from `0n`.
 *   - Results stay inside the paise range: field magnitudes and operand counts
 *     are bounded so the widest fold cannot approach the ceiling, and any step
 *     whose computed result would still leave {@link SAFE_RESULT_CEILING}
 *     degrades to `select` on its input, which is in range by induction. No
 *     `fc.pre`, no filter — a rejected draw would bias the distribution and hide
 *     the shapes that matter.
 *
 * ## Breadth: the >500-source case is drawn on purpose
 *
 * Requirement 12.2 pages source identifiers at most 500 per page, so a chain
 * with 500 or fewer identifiers never exercises a second page.
 * {@link arbitraryEvidenceChainCase} therefore draws an explicit weighted
 * `breadth`: `narrow` (1..8 identifiers) and `wide`, whose size comes from
 * `fc.constantFrom(501, 1000)` — one past the boundary, and two full pages. The
 * weights are fixed rather than left to `fc.array` sizing, and P6 asserts the
 * observed counts afterwards, so "more than 500" cannot silently stop occurring.
 *
 * ## Money
 *
 * `bigint` throughout. Every literal is `String(bigint)`; nothing passes through
 * `Number(...)`, `toFixed` or a float.
 */

import fc from 'fast-check';

import { add, roundHalfUpToPaisa, subtract, sum } from '@/calc/calculation-service';
import { type Paise } from '@/calc/paise';
import type {
  EvidenceChainInput,
  EvidenceOperand,
  EvidenceSourceCitation,
  EvidenceStep,
  SourceRecordType,
  SourceRef,
} from '@/evidence/chain-builder';

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The largest magnitude a generated Source_Record field carries: ₹10,00,000.
 *
 * Chosen against the widest fold this module can draw — 1000 identifiers summed
 * in one step — so that step reaches at most 10^12, two orders of magnitude
 * inside the 99999999999999 paise ceiling, leaving room for the steps that
 * follow.
 */
export const MAX_FIELD_MAGNITUDE_PAISE: Paise = 1_000_000_000n;

/**
 * The ceiling a generated step result must respect. A drawn operation whose
 * result would exceed it degrades to `select` rather than being redrawn.
 *
 * Below `PAISE_MAX` on purpose: a chain that only *just* fits would make P6
 * report a range rejection — a fault of this generator — as a replay failure.
 */
export const SAFE_RESULT_CEILING: Paise = 50_000_000_000_000n;

/** The identifier count of a `wide` draw. 501 crosses the page boundary; 1000 is two full pages. */
export const WIDE_SOURCE_COUNTS: readonly number[] = [501, 1000] as const;

/** Identifier counts of a `narrow` draw. */
const NARROW_MIN = 1;
const NARROW_MAX = 8;

/** How many steps follow the opening aggregate. 0 keeps the one-step chain in play. */
const MAX_EXTRA_STEPS = 5;

/* -------------------------------------------------------------------------- */
/* Datasets                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One generated Source_Record, in the exact shape 9.2's replay seam consumes:
 * `{ ref, fields }` satisfies `ReplaySourceRecord & { ref }`, so
 * `recordLookupFromRecords(dataset.records)` takes it with no adaptation.
 */
export interface GeneratedSourceRecord {
  readonly ref: SourceRef;
  /** Monetary fields, keyed by the exact name a step cites. Never empty. */
  readonly fields: Readonly<Record<string, Paise>>;
  /** ISO-8601 UTC, ms precision, as the record stood when the chain was composed. */
  readonly record_updated_at: string;
}

/** What a Financial_Tool would read over. Records are distinct by `(type, id)`. */
export interface EvidenceTenantDataset {
  readonly records: readonly GeneratedSourceRecord[];
}

/**
 * The record types a chain cites. Not all 13: these are the ones a monetary
 * figure in Slice 1 is actually composed from, and a mix of types is what makes
 * the pagination order — `source_record_type` then `source_record_id` — have two
 * levels to get wrong rather than one.
 */
const CITED_TYPES: readonly SourceRecordType[] = [
  'payment',
  'refund',
  'settlement',
  'settlement_recon_report',
  'razorpay_invoice',
] as const;

/**
 * The field shapes a record exposes.
 *
 * `adjustment` carries `debit`, `credit` **and** the stored `signed_amount`
 * projection, because design.md's twelve-step chain has no step that derives a
 * sign and the interpreter refuses to compute one: `signed_amount` is a field
 * read or it is an `unresolvable_field` rejection.
 */
type FieldShape = 'amount_only' | 'amount_fee' | 'amount_fee_tax' | 'adjustment';

const FIELD_SHAPES: readonly FieldShape[] = [
  'amount_only',
  'amount_fee',
  'amount_fee_tax',
  'adjustment',
] as const;

const ISO_MS_EPOCH = Date.UTC(2026, 0, 1);

/** ISO-8601 UTC to ms precision, which is what the funnel's `assertIsoUtcMs` admits. */
function isoMsAt(offsetMinutes: number): string {
  return new Date(ISO_MS_EPOCH + offsetMinutes * 60_000).toISOString();
}

const arbitraryFieldValue: fc.Arbitrary<Paise> = fc.bigInt({
  min: -MAX_FIELD_MAGNITUDE_PAISE,
  max: MAX_FIELD_MAGNITUDE_PAISE,
});

/** Boundary values fast-check would otherwise reach only by chance. */
const arbitraryFieldPaise: fc.Arbitrary<Paise> = fc.oneof(
  { weight: 6, arbitrary: arbitraryFieldValue },
  { weight: 1, arbitrary: fc.constantFrom<Paise>(0n, 1n, -1n, MAX_FIELD_MAGNITUDE_PAISE) },
);

function fieldsFor(
  shape: FieldShape,
  values: readonly Paise[],
): Readonly<Record<string, Paise>> {
  // `noUncheckedIndexedAccess`: every read is defaulted, and the caller draws 4.
  const [a = 0n, b = 0n, c = 0n, d = 0n] = values;
  switch (shape) {
    case 'amount_only':
      return { amount: a };
    case 'amount_fee':
      return { amount: a, fee: b };
    case 'amount_fee_tax':
      return { amount: a, fee: b, tax: c };
    case 'adjustment':
      // The projection is stored, not derived. See the module doc comment.
      return { debit: a < 0n ? -a : a, credit: b < 0n ? -b : b, signed_amount: d };
  }
}

/**
 * A dataset of exactly `size` distinct Source_Record identifiers.
 *
 * Identifiers are fixed-width and index-derived rather than drawn, for two
 * reasons: `(type, id)` must be distinct or the funnel collapses citations and
 * `source_count` stops equalling `size`, and a fixed width makes the collated
 * `source_record_id` order the numeric order, which is what
 * `test/db/evidence-chain.test.ts` relies on too.
 */
export function evidenceTenantDatasetOfSize(size: number): fc.Arbitrary<EvidenceTenantDataset> {
  return fc
    .array(
      fc.record({
        type: fc.constantFrom(...CITED_TYPES),
        shape: fc.constantFrom(...FIELD_SHAPES),
        values: fc.array(arbitraryFieldPaise, { minLength: 4, maxLength: 4 }),
        updatedAtOffsetMinutes: fc.integer({ min: 0, max: 10_000 }),
      }),
      { minLength: size, maxLength: size },
    )
    .map((drawn) => ({
      records: drawn.map((record, index) => ({
        ref: {
          type: record.type,
          id: `${record.type}_p6_${String(index).padStart(6, '0')}`,
        },
        fields: fieldsFor(record.shape, record.values),
        record_updated_at: isoMsAt(record.updatedAtOffsetMinutes),
      })),
    }));
}

/** design.md's `arbitraryTenantDataset` as an Evidence_Chain reads it. See the module doc. */
export const arbitraryEvidenceTenantDataset: fc.Arbitrary<EvidenceTenantDataset> = fc
  .integer({ min: NARROW_MIN, max: NARROW_MAX })
  .chain(evidenceTenantDatasetOfSize);

/* -------------------------------------------------------------------------- */
/* Step plans                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One drawn step, before it knows its index or its operands' values.
 *
 * A plan rather than a step so the whole chain can be drawn first and evaluated
 * once, in order: a step's stated `result_paise` depends on the values of the
 * steps before it, and drawing a result would produce a chain that replays to
 * something else — which is a generator bug wearing a P6 failure's clothes.
 */
type StepPlan =
  | { readonly kind: 'add_literal'; readonly literal: Paise }
  | { readonly kind: 'subtract_literal'; readonly literal: Paise }
  | { readonly kind: 'multiply_literal'; readonly literal: Paise }
  | { readonly kind: 'divide_literal'; readonly literal: Paise }
  | { readonly kind: 'round_half_up_literal'; readonly literal: Paise }
  | { readonly kind: 'negate' }
  | { readonly kind: 'select' }
  | { readonly kind: 'sum_fields'; readonly picks: readonly number[] }
  | { readonly kind: 'subtract_field'; readonly pick: number }
  | { readonly kind: 'compare_field'; readonly pick: number };

const arbitraryStepPlan: fc.Arbitrary<StepPlan> = fc.oneof(
  fc.record({
    kind: fc.constant('add_literal' as const),
    literal: fc.bigInt({ min: -MAX_FIELD_MAGNITUDE_PAISE, max: MAX_FIELD_MAGNITUDE_PAISE }),
  }),
  fc.record({
    kind: fc.constant('subtract_literal' as const),
    literal: fc.bigInt({ min: -MAX_FIELD_MAGNITUDE_PAISE, max: MAX_FIELD_MAGNITUDE_PAISE }),
  }),
  fc.record({
    kind: fc.constant('multiply_literal' as const),
    // Small: a fold is the one operation that leaves the paise range fastest.
    literal: fc.bigInt({ min: -3n, max: 3n }),
  }),
  fc.record({
    kind: fc.constant('divide_literal' as const),
    // Away from 0n, and includes the divisors that produce an exact half.
    literal: fc.constantFrom<Paise>(-7n, -3n, -2n, 2n, 3n, 4n, 7n, 100n, 10_000n),
  }),
  fc.record({
    kind: fc.constant('round_half_up_literal' as const),
    literal: fc.constantFrom<Paise>(-4n, -2n, 2n, 3n, 8n, 10n, 10_000n),
  }),
  fc.constant({ kind: 'negate' as const }),
  fc.constant({ kind: 'select' as const }),
  fc.record({
    kind: fc.constant('sum_fields' as const),
    picks: fc.array(fc.nat(), { minLength: 1, maxLength: 3 }),
  }),
  fc.record({ kind: fc.constant('subtract_field' as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant('compare_field' as const), pick: fc.nat() }),
);

/* -------------------------------------------------------------------------- */
/* Chain construction                                                         */
/* -------------------------------------------------------------------------- */

/** How wide the generated chain's source set is. P6 asserts both occur. */
export type SourceBreadth = 'narrow' | 'wide';

/** One P6 input: the dataset, the chain composed over it, and how wide it is. */
export interface EvidenceChainCase {
  readonly dataset: EvidenceTenantDataset;
  /** Ready for `composeEvidenceChain`. Every invariant of the funnel holds. */
  readonly input: EvidenceChainInput;
  readonly breadth: SourceBreadth;
  /** `dataset.records.length`, which is the chain's distinct identifier count. */
  readonly expected_source_count: number;
}

/** The name a `produced_by` column would carry. Not a registered tool — see the module doc. */
export const GENERATED_PRODUCED_BY = 'p6_generated_chain';

const literalOperand = (value: Paise): EvidenceOperand => ({
  kind: 'literal',
  value: value.toString(),
});

const stepOperand = (index: number): EvidenceOperand => ({ kind: 'step', index });

interface CitedField {
  readonly record: GeneratedSourceRecord;
  readonly field: string;
  readonly value: Paise;
}

/** The `pick`-th `(record, field)` of the dataset, wrapped around. Never absent. */
function citedFieldAt(dataset: EvidenceTenantDataset, pick: number): CitedField {
  const records = dataset.records;
  const record = records[pick % records.length] ?? records[0];
  if (record === undefined) {
    // Unreachable: every dataset holds at least 1 record.
    throw new Error('evidence dataset is empty; every generated dataset holds at least 1 record');
  }
  const names = Object.keys(record.fields);
  const field = names[pick % names.length] ?? 'amount';
  return { record, field, value: record.fields[field] ?? 0n };
}

const inSafeRange = (value: Paise): boolean =>
  value >= -SAFE_RESULT_CEILING && value <= SAFE_RESULT_CEILING;

/**
 * Assemble a chain from a dataset and a list of drawn plans.
 *
 * Pure and total: for every dataset and every plan list it returns an
 * `EvidenceChainInput` that `composeEvidenceChain` accepts and the replay
 * interpreter admits. The chain's own arithmetic is the production
 * Calculation_Service's, except `multiply` and `negate`, which it has no
 * counterpart for.
 */
export function buildChain(
  dataset: EvidenceTenantDataset,
  plans: readonly StepPlan[],
): EvidenceChainInput {
  const steps: EvidenceStep[] = [];
  const citations: EvidenceSourceCitation[] = [];
  /** Monetary value per built step index. A `compare` step has none. */
  const values = new Map<number, Paise>();

  function cite(record: GeneratedSourceRecord, field: string): EvidenceOperand {
    citations.push({
      ref: record.ref,
      field,
      record_updated_at: record.record_updated_at,
    });
    return { kind: 'source', ref: record.ref, field };
  }

  /* Step 1: the opening aggregate over EVERY identifier in the dataset.
   *
   * This is what makes `source_count === dataset.records.length` and what makes
   * a `wide` draw actually produce more than 500 cited identifiers. One field
   * per record: the first, which every field shape has. */
  const openingOperands: EvidenceOperand[] = [];
  const openingValues: Paise[] = [];
  for (const record of dataset.records) {
    const field = Object.keys(record.fields)[0] ?? 'amount';
    openingOperands.push(cite(record, field));
    openingValues.push(record.fields[field] ?? 0n);
  }
  // `sum` from the Calculation_Service: range-checked, and the producer's own
  // arithmetic rather than the replay's.
  const openingResult = sum([...openingValues]);
  steps.push({
    index: 1,
    operation: 'sum',
    operands: openingOperands,
    result_paise: openingResult,
    note: 'Σ one monetary field of every cited Source_Record',
  });
  values.set(1, openingResult);

  let lastMonetaryIndex = 1;

  for (const plan of plans) {
    const index = steps.length + 1;
    const input = values.get(lastMonetaryIndex) ?? 0n;
    const priorOperand = stepOperand(lastMonetaryIndex);

    /** Fall back to the identity when a drawn operation would leave the safe range. */
    const degradeToSelect = (): void => {
      steps.push({
        index,
        operation: 'select',
        operands: [priorOperand],
        result_paise: input,
        note: 'identity: the drawn operation would have left the safe paise range',
      });
      values.set(index, input);
      lastMonetaryIndex = index;
    };

    const push = (
      operation: EvidenceStep['operation'],
      operands: readonly EvidenceOperand[],
      result: Paise,
    ): void => {
      if (!inSafeRange(result)) {
        degradeToSelect();
        return;
      }
      steps.push({ index, operation, operands, result_paise: result });
      values.set(index, result);
      lastMonetaryIndex = index;
    };

    switch (plan.kind) {
      case 'add_literal': {
        // `add` folds 1..n; two operands here, prior step then literal.
        push('add', [priorOperand, literalOperand(plan.literal)], add(input, plan.literal));
        break;
      }
      case 'subtract_literal': {
        push(
          'subtract',
          [priorOperand, literalOperand(plan.literal)],
          subtract(input, plan.literal),
        );
        break;
      }
      case 'multiply_literal': {
        // No Calculation_Service counterpart: folded with a bigint operator.
        push('multiply', [priorOperand, literalOperand(plan.literal)], input * plan.literal);
        break;
      }
      case 'divide_literal':
      case 'round_half_up_literal': {
        const operation = plan.kind === 'divide_literal' ? 'divide' : 'round_half_up';
        // The production rounding rule. The interpreter reimplements it, which is
        // what makes this step's stated result an independent claim.
        const rounded = roundHalfUpToPaisa(input, plan.literal);
        push(operation, [priorOperand, literalOperand(plan.literal)], rounded.result);
        break;
      }
      case 'negate': {
        push('negate', [priorOperand], -input);
        break;
      }
      case 'select': {
        push('select', [priorOperand], input);
        break;
      }
      case 'sum_fields': {
        const cited = plan.picks.map((pick) => citedFieldAt(dataset, pick));
        const operands = cited.map((c) => cite(c.record, c.field));
        push(
          'sum',
          [priorOperand, ...operands],
          sum([input, ...cited.map((c) => c.value)]),
        );
        break;
      }
      case 'subtract_field': {
        const cited = citedFieldAt(dataset, plan.pick);
        push(
          'subtract',
          [priorOperand, cite(cited.record, cited.field)],
          subtract(input, cited.value),
        );
        break;
      }
      case 'compare_field': {
        // A boolean: `result_paise` is null, the step is never referenced, and a
        // trailing `compare` is followed by the `select` appended below.
        const cited = citedFieldAt(dataset, plan.pick);
        steps.push({
          index,
          operation: 'compare',
          operands: [priorOperand, cite(cited.record, cited.field)],
          result_paise: null,
          note: 'equality; a boolean has no paise value',
        });
        break;
      }
    }
  }

  const terminal = steps[steps.length - 1];
  if (terminal === undefined || terminal.result_paise === null) {
    // A boolean terminal step is rejected by the interpreter and by the funnel,
    // so the chain ends on the last monetary value instead.
    const value = values.get(lastMonetaryIndex) ?? 0n;
    steps.push({
      index: steps.length + 1,
      operation: 'select',
      operands: [stepOperand(lastMonetaryIndex)],
      result_paise: value,
      note: 'the chain ends on a monetary step; figure_paise is NOT NULL',
    });
    values.set(steps.length, value);
    lastMonetaryIndex = steps.length;
  }

  const figure = values.get(lastMonetaryIndex) ?? 0n;

  return {
    produced_by: GENERATED_PRODUCED_BY,
    figure_paise: figure,
    steps,
    sources: citations,
  };
}

/**
 * design.md's P6 generator input, as far as it can be written today: a dataset
 * and a chain over it, with the >500-identifier case drawn deliberately.
 *
 * The `breadth` discriminator is drawn **first** and the data after it, so
 * shrinking reduces the field values and the step list before it collapses a
 * wide chain to a narrow one — a 501-identifier counterexample stays wide while
 * it is being minimised.
 */
export const arbitraryEvidenceChainCase: fc.Arbitrary<EvidenceChainCase> = fc
  .oneof(
    { weight: 3, arbitrary: fc.constant<SourceBreadth>('narrow') },
    { weight: 1, arbitrary: fc.constant<SourceBreadth>('wide') },
  )
  .chain((breadth) =>
    (breadth === 'narrow'
      ? fc.integer({ min: NARROW_MIN, max: NARROW_MAX })
      : fc.constantFrom(...WIDE_SOURCE_COUNTS)
    ).chain((size) =>
      fc
        .record({
          dataset: evidenceTenantDatasetOfSize(size),
          plans: fc.array(arbitraryStepPlan, { minLength: 0, maxLength: MAX_EXTRA_STEPS }),
        })
        .map(({ dataset, plans }) => ({
          dataset,
          input: buildChain(dataset, plans),
          breadth,
          expected_source_count: dataset.records.length,
        })),
    ),
  );
