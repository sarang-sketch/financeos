/**
 * The independent Evidence_Chain replay interpreter (task 9.2). Requirement 12.8.
 *
 * Walks an ordered `EvidenceStep[]` over the Source_Records the steps cite and
 * returns a `bigint`. Property P6 (task 9.3) calls it and asserts
 * `replayed === chain.figure_paise`.
 *
 * ## What this module imports, and why every import is a contract
 *
 * There is **exactly one import statement**, it is `import type`, and it is
 * erased by the compiler — this module has no runtime dependency on `src/` at
 * all:
 *
 * | Imported | Why it is a contract, not an implementation |
 * |---|---|
 * | `EvidenceStep`, `EvidenceOperand`, `EvidenceOperation`, `SourceRef` (type-only, from `@/evidence/chain-builder`) | Shapes. They describe the persisted rows of `evidence_chain_steps` and carry no behaviour. Transcribing them locally instead would mean a schema change could not break this file — a silent divergence is worse than a coupling that the compiler polices. |
 *
 * Deliberately **not** imported, because importing any of them would make P6 a
 * tautology — both sides would compute the same wrong answer identically and the
 * property would pass on a broken system:
 *
 *   - `src/calc/calculation-service.ts` — no `sum`, no `add`, no `subtract`, no
 *     `roundHalfUpToPaisa`, no `applyRate`. Every arithmetic operation below is
 *     written from scratch with plain `bigint` operators.
 *   - `src/calc/paise.ts` — not even `assertInRange`. The paise range is
 *     restated as {@link REPLAY_PAISE_MIN} / {@link REPLAY_PAISE_MAX} from
 *     Requirement 15.1's stated bounds, and {@link inPaiseRange} is this
 *     module's own guard. A second guard can drift from the first; that is the
 *     point — if it drifts, one of the two is wrong and P6 says so.
 *   - `src/evidence/chain-builder.ts`'s *runtime* exports — no
 *     `EVIDENCE_OPERATIONS`, no `composeEvidenceChain`, no validation. Totality
 *     over the 9 operations is enforced by the compiler here (the `never`-typed
 *     default case in {@link evaluateStep}), not by reading the builder's array.
 *   - `src/tools/**`, `src/agents/**` — the producers. Nothing from them.
 *
 * **The one thing taken from the tools' side, taken as text and not as code:**
 * the rounding rule. `src/calc/calculation-service.ts` documents the house rule
 * as *half up, where negative half rounds away from zero* (−0.5 → −1n), chosen
 * for double-entry symmetry. That doc comment was read as a **specification**
 * and {@link roundHalfAwayFromZero} below reimplements it. So a bug in the
 * *rule itself* — as opposed to a bug in either implementation of it — is
 * invisible to P6, because both sides would be wrong in the same direction.
 * That is a real limit of this property and is stated here rather than left for
 * a reader to discover.
 *
 * ## Operation semantics, and which of them design.md actually states
 *
 * design.md fixes the 9 labels and no arity table, no operand order, and no
 * rounding mode. Task 9.1 pinned only the four arities that are beyond doubt
 * (`subtract` 2, `divide` 2, `negate` 1, `compare` 2) and left the rest here.
 * Everything below marked **decided** is this module's choice, reported as a
 * finding rather than presented as specified:
 *
 * | Operation | Operands | Semantics | Source |
 * |---|---|---|---|
 * | `sum` | 1..n | left-to-right `+` fold | **decided** (arity). SET-9281 step 2 sums one Refund line, so the floor is 1, not 2 |
 * | `add` | 1..n | left-to-right `+` fold | **decided**. Arithmetically identical to `sum`; see below |
 * | `subtract` | 2 | `operands[0] − operands[1]` | order stated by design.md's worked example (step 3 is payments − refunds) |
 * | `multiply` | 2..n | left-to-right `*` fold | **decided** |
 * | `divide` | 2 | `operands[0] / operands[1]`, numerator first, rounded half away from zero | **decided** — design.md states neither order nor rounding mode |
 * | `round_half_up` | 2 | `operands[0] / operands[1]`, numerator first, rounded half away from zero | **decided** — identical to `divide`; see below |
 * | `negate` | 1 | `−operands[0]` | arity from 9.1; sign is the only reading |
 * | `select` | 1 | identity: the operand's value unchanged | **decided** — design.md states no selector |
 * | `compare` | 2 | `operands[0] === operands[1]`, a boolean | **decided** — design.md states no comparator |
 *
 * Three of those need their reasoning written down:
 *
 * **`add` versus `sum`.** design.md gives two labels and states no difference.
 * They fold identically here. Enforcing a distinction — `sum` for an aggregate
 * over enumerated source lines, `add` for combining two running values — would
 * mean rejecting a legitimate chain over a naming choice nobody documented, and
 * rejecting a legitimate chain is the one failure worse than accepting an
 * odd one, because it makes P6 unrunnable rather than false.
 *
 * **`divide` versus `round_half_up`.** Same problem, sharper: two labels, one
 * operation, no stated difference. They apply the same rounding rule here.
 * Implementing a *different* rule for each — truncation for one, half-up for the
 * other — would make a figure depend on which label the producing tool picked,
 * and `bigint /` truncating toward zero is, as `calculation-service.ts` says,
 * neither half-up nor half-down. One rule, both labels, until design.md
 * distinguishes them.
 *
 * **`select` takes exactly one operand.** A selector protocol (operand 0 as an
 * index into the rest) is not in design.md, and inventing one would let a
 * multi-operand `select` replay to a *plausible* value chosen by a rule the
 * producing tool never agreed to. A multi-operand `select` is therefore
 * rejected loudly, which forces the semantics into design.md instead of into
 * this file.
 *
 * ## The record-access seam, and how a `field` is resolved
 *
 * Task 9.1's largest reported gap: **nothing persists a mapping from a cited
 * `field` name to a value.** `evidence_chain_sources` stores `(type, id, field)`
 * and no value, and nothing maps `field` onto a column or JSON path of
 * `razorpay_objects`. A replay therefore cannot be given only a chain; it must
 * be given the records too, which is the "over the referenced Source_Records"
 * half of Requirement 12.8.
 *
 * The seam is one function: {@link SourceRecordLookup}, from a {@link SourceRef}
 * to a {@link ReplaySourceRecord} — a flat `Readonly<Record<string, bigint>>` of
 * that record's monetary fields — or `undefined`. Field resolution is an
 * **exact own-property lookup** on that map, guarded by `Object.hasOwn` so
 * `toString` or `constructor` cannot resolve to something that is not a field,
 * and the value must be a `bigint` in paise range. Nothing is derived, inferred,
 * or defaulted:
 *
 *   - **`signed_amount` is a field read, not arithmetic.** SET-9281's adjustment
 *     steps cite `signed_amount`, the `credit − debit` projection applied at the
 *     ingestion boundary, because design.md's fixed twelve-step sequence has no
 *     step that derives a sign. This interpreter resolves it like any other key
 *     and **never computes it from `credit` and `debit`** — deriving it would be
 *     arithmetic the chain does not state, which is exactly the class of hidden
 *     step P6 exists to rule out. A record that omits `signed_amount` while a
 *     step cites it is an `unresolvable_field` rejection, not a fallback.
 *   - The other fields visible today are `amount`, `fee`, `tax`, `fees`,
 *     `debit`, `credit`. None is special-cased either.
 *
 * ## `compare` and `select` results
 *
 * `evidence_chain_steps.result_paise` is the only result column and is `NULL`
 * for a step with no single monetary result, so **a `compare` outcome is
 * unstorable**: a replay can recompute the comparison and has nothing to check
 * it against. Consequences, all deliberate:
 *
 *   - A `compare` step's value is a boolean, carried in
 *     {@link ReplayOutcome.step_results} so a later step can read it, and never
 *     compared against `result_paise`.
 *   - A `compare` step that *declares* a non-null `result_paise` is rejected
 *     (`non_monetary_result_stated`). A boolean has no paise value, so a stated
 *     one is a contradiction, not a value to trust.
 *   - A boolean reaching an arithmetic operand is rejected
 *     (`non_monetary_operand`), never coerced to `0n`/`1n`.
 *   - A boolean terminal step is rejected (`non_monetary_terminal_step`):
 *     Requirement 12.8 replays to a figure, and `evidence_chains.figure_paise`
 *     is `NOT NULL`.
 *   - **So a wrong comparator inside a producing tool is invisible to P6.**
 *     Stated, not solved.
 *
 * `select`'s result carries whatever kind its operand had, and is checked
 * against `result_paise` when it is monetary and one is stated.
 *
 * ## Gaplessness and backward-only references are re-checked, not trusted
 *
 * Migration `20260101000006`'s FINDING 2: the database constrains
 * `step_index >= 1` and uniqueness only. Gapless `1..n` and backward-only
 * `{ kind: 'step' }` references are enforced by `composeEvidenceChain` **in
 * TypeScript only**, so a chain read straight from the database — or handed here
 * by a generator, which is what 9.3 will do — can violate both. An interpreter
 * that trusted them would be a *partial function* on exactly those chains: no
 * value to read, and P6 undefined rather than failing. Both are therefore
 * re-checked here ({@link replaySteps}), and there is no option to switch the
 * check off.
 *
 * ## Range checking: results and source fields, not literals
 *
 * Every step result and every resolved source field is range-checked against
 * the paise bounds and rejected, never saturated: a result is stored in the
 * `paise` domain, and a Source_Record field is money by definition (the seam
 * carries monetary fields only).
 *
 * A **literal** is format-checked but not range-checked, because the
 * interpreter cannot tell a monetary literal from a unitless scalar — a rate
 * divisor of `10000` is not money, and `applyRate`'s scaled numerator reaches
 * ~3 × 10^19, five orders of magnitude above the paise ceiling. Range-checking
 * literals would reject those outright. A monetary literal that is out of range
 * still fails, one step later, when the result it produces is checked.
 *
 * Which surfaces a further finding: **design.md states no way to represent
 * `applyRate` in a chain.** Its unrounded product is not storable in
 * `result_paise` (the `paise` domain), so `multiply` then `divide` cannot
 * express it, and `round_half_up` takes a numerator and a denominator with no
 * room for a rate. Reported, not invented.
 *
 * ## Replay is exact only while the cited records are unchanged
 *
 * Requirement 12.8 says "as of the chain's `as_of` timestamp", but nothing
 * versions the cited values: `evidence_chain_sources` stores a
 * `record_updated_at` and no value, and `razorpay_objects` holds only the
 * current row. This interpreter replays over whatever the seam hands it **now**.
 * If a cited record changed after the chain was composed, the replay is a
 * statement about the current values, not about the values as of `as_of`, and
 * nothing here can tell the two apart. A point-in-time replay needs a versioned
 * value store that the schema does not have. Stated, not solved.
 *
 * ## Failure is explicit and typed
 *
 * A replay that silently returns a plausible number is the failure mode this
 * module is designed against. {@link replaySteps} returns a discriminated
 * {@link ReplayOutcome} — never a bare number, never `undefined`, never `0n` as
 * a stand-in — and {@link ReplayFailure} names 16 distinct rejections.
 *
 * ## Money
 *
 * `bigint` only. No `Number(...)` on a monetary value, no `toFixed`, no float,
 * no `Math.*`. A literal operand is a decimal string parsed with `BigInt(...)`
 * after a strict `/^-?[0-9]+$/` test — rejection, not coercion. The money
 * ESLint rules are scoped to `src/**` and do not police this file; the
 * discipline is kept anyway.
 */

import type {
  EvidenceOperand,
  EvidenceOperation,
  EvidenceStep,
  SourceRef,
} from '@/evidence/chain-builder';

/* -------------------------------------------------------------------------- */
/* The paise range, restated                                                  */
/* -------------------------------------------------------------------------- */

/** The signed paise floor (Requirement 15.1, 15.8). Restated, not imported. */
export const REPLAY_PAISE_MIN = -99999999999999n;

/** The signed paise ceiling (Requirement 15.1, 15.8). Restated, not imported. */
export const REPLAY_PAISE_MAX = 99999999999999n;

/** This module's own range guard. See the module doc comment on why it is not shared. */
export function inPaiseRange(value: bigint): boolean {
  return value >= REPLAY_PAISE_MIN && value <= REPLAY_PAISE_MAX;
}

/** A monetary literal on the wire and inside `operands` JSONB: a decimal string. */
const DECIMAL_INTEGER = /^-?[0-9]+$/;

/* -------------------------------------------------------------------------- */
/* The record-access seam                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A Source_Record as a replay needs to see it: the monetary fields it exposes,
 * keyed by the exact `field` name a step cites, in integer paise.
 *
 * Structurally satisfied by `test/fixtures/set-9281.ts`'s `EvidenceSourceRecord`
 * without adaptation.
 */
export interface ReplaySourceRecord {
  readonly fields: Readonly<Record<string, bigint>>;
}

/**
 * The seam: resolve one cited Source_Record, or `undefined` when it cannot be
 * read. Nothing wider — the interpreter needs no query, no client, no Tenant.
 */
export type SourceRecordLookup = (ref: SourceRef) => ReplaySourceRecord | undefined;

/**
 * Builds a {@link SourceRecordLookup} over an array of records keyed by
 * `(type, id)`. A later duplicate of the same identifier is a caller fault and
 * the first wins, so the lookup cannot depend on array order.
 */
export function recordLookupFromRecords(
  records: readonly (ReplaySourceRecord & { readonly ref: SourceRef })[],
): SourceRecordLookup {
  const byKey = new Map<string, ReplaySourceRecord>();
  for (const record of records) {
    const key = `${record.ref.type}\u0000${record.ref.id}`;
    if (!byKey.has(key)) {
      byKey.set(key, record);
    }
  }
  return (ref) => byKey.get(`${ref.type}\u0000${ref.id}`);
}

/* -------------------------------------------------------------------------- */
/* Values, failures, outcome                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What one step evaluates to. Two kinds, because `compare` yields a boolean and
 * `evidence_chain_steps.result_paise` cannot hold one — see the module doc.
 */
export type ReplayValue =
  | { readonly kind: 'money'; readonly paise: bigint }
  | { readonly kind: 'boolean'; readonly value: boolean };

/** One step's recomputed value, in `step_index` order. */
export interface ReplayStepResult {
  readonly index: number;
  readonly operation: EvidenceOperation;
  readonly value: ReplayValue;
}

/** Every way a replay can refuse to produce a figure. Never a plausible number. */
export type ReplayFailureKind =
  /** No steps at all: there is nothing to replay and no terminal result. */
  | 'empty_chain'
  /** `step_index` is not gapless `1..n` in order (migration FINDING 2). */
  | 'step_index_not_gapless'
  /** The `operation` label is outside the 9 of the `evidence_operation` enum. */
  | 'unknown_operation'
  /** The operand count is outside what the operation admits. */
  | 'arity'
  /** An operand object is none of the three `kind`s design.md defines. */
  | 'unknown_operand_kind'
  /** A `literal` operand's `value` is not a string (a JSON number, say). */
  | 'non_string_literal'
  /** A `literal` operand's `value` is a string that is not a decimal integer. */
  | 'malformed_literal'
  /** A `step` operand cites its own index or a higher one (migration FINDING 2). */
  | 'forward_step_reference'
  /** A `step` operand's `index` is not a 1-based ordinal. */
  | 'invalid_step_reference'
  /** The seam could not resolve a cited Source_Record. */
  | 'missing_record'
  /** The record resolved, but exposes no such field. `signed_amount` included. */
  | 'unresolvable_field'
  /** The field resolved to something that is not a `bigint`. */
  | 'non_monetary_field'
  /** A boolean reached an arithmetic operand. Never coerced. */
  | 'non_monetary_operand'
  /** A `divide` or `round_half_up` denominator of `0n`. */
  | 'division_by_zero'
  /** A step result or a resolved source field is outside the paise range. */
  | 'out_of_range'
  /** A step's stated `result_paise` disagrees with the recomputed value. */
  | 'result_disagreement'
  /** A `compare` step declares a `result_paise`. A boolean has no paise value. */
  | 'non_monetary_result_stated'
  /** The terminal step produced a boolean; `figure_paise` is `NOT NULL`. */
  | 'non_monetary_terminal_step';

/** A typed rejection: the kind, where it happened, and a readable reason. */
export interface ReplayFailure {
  readonly kind: ReplayFailureKind;
  /** The `step_index` the rejection is about, or `null` for a whole-chain one. */
  readonly step_index: number | null;
  /** The 0-based operand position, where the rejection is about one operand. */
  readonly operand_position: number | null;
  readonly message: string;
}

/**
 * The result of a replay. `ok: true` carries the terminal figure **and** every
 * intermediate, so a caller can assert on the Difference at step 8 as well as
 * the residual at step 12 (design.md's worked example).
 */
export type ReplayOutcome =
  | {
      readonly ok: true;
      /** The terminal step's monetary result. What P6 compares to `figure_paise`. */
      readonly figure_paise: bigint;
      readonly step_results: readonly ReplayStepResult[];
    }
  | { readonly ok: false; readonly failure: ReplayFailure };

/** Options for {@link replaySteps}. The seam is required; nothing else is. */
export interface ReplayOptions {
  readonly lookup: SourceRecordLookup;
  /**
   * Compare each step's recomputed value against its stated `result_paise` and
   * reject on disagreement. Default `true`.
   *
   * Set `false` to recompute with the stated results **ignored entirely**, which
   * is how a caller proves the interpreter is not echoing the chain: a chain
   * carrying a tampered `result_paise` still replays to the true value.
   */
  readonly verifyStatedResults?: boolean;
}

/** Thrown by {@link replayFigure} and {@link monetaryStepResult}. */
export class ReplayError extends Error {
  override readonly name = 'ReplayError';
  readonly failure: ReplayFailure;

  constructor(failure: ReplayFailure) {
    const at =
      failure.step_index === null
        ? ''
        : ` at step ${failure.step_index}` +
          (failure.operand_position === null ? '' : ` operand ${failure.operand_position}`);
    super(`evidence replay refused (${failure.kind})${at}: ${failure.message}`);
    this.failure = failure;
  }
}

/* -------------------------------------------------------------------------- */
/* Arithmetic, written from scratch                                           */
/* -------------------------------------------------------------------------- */

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * `numerator / denominator` rounded **half away from zero**: −0.5 → −1n and
 * +0.5 → +1n.
 *
 * Reimplemented from the rule `src/calc/calculation-service.ts` documents (read
 * as a specification, not imported), which picks half-away-from-zero over
 * half-toward-+∞ so that `f(-v) === -f(v)` holds exactly and a reversing ledger
 * set cannot miss balance by one paisa.
 *
 * The tie is decided by comparing `2 × remainder` against the denominator, so no
 * fraction is ever formed and no `number` is ever involved. The caller has
 * already rejected a zero denominator.
 */
function roundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  const magnitudeNumerator = absolute(numerator);
  const magnitudeDenominator = absolute(denominator);

  let quotient = magnitudeNumerator / magnitudeDenominator; // exact, truncating
  if ((magnitudeNumerator % magnitudeDenominator) * 2n >= magnitudeDenominator) {
    quotient += 1n;
  }

  const resultIsNegative = (numerator < 0n) !== (denominator < 0n);
  return resultIsNegative ? -quotient : quotient;
}

/* -------------------------------------------------------------------------- */
/* Arity                                                                      */
/* -------------------------------------------------------------------------- */

interface Arity {
  readonly min: number;
  /** `null` for variadic. */
  readonly max: number | null;
}

/**
 * The arity of every operation. Only `subtract`, `divide`, `negate` and
 * `compare` are pinned by task 9.1; the rest are decided here — see the table in
 * the module doc comment.
 */
const ARITY: Readonly<Record<EvidenceOperation, Arity>> = {
  sum: { min: 1, max: null },
  add: { min: 1, max: null },
  subtract: { min: 2, max: 2 },
  multiply: { min: 2, max: null },
  divide: { min: 2, max: 2 },
  round_half_up: { min: 2, max: 2 },
  negate: { min: 1, max: 1 },
  select: { min: 1, max: 1 },
  compare: { min: 2, max: 2 },
};

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: ReplayFailure };

function refuse(
  kind: ReplayFailureKind,
  message: string,
  stepIndex: number | null = null,
  operandPosition: number | null = null,
): { readonly ok: false; readonly failure: ReplayFailure } {
  return {
    ok: false,
    failure: { kind, step_index: stepIndex, operand_position: operandPosition, message },
  };
}

const money = (paise: bigint): ReplayValue => ({ kind: 'money', paise });

/** Resolves one operand to a value, or refuses. */
function resolveOperand(
  operand: EvidenceOperand,
  stepIndex: number,
  position: number,
  values: ReadonlyMap<number, ReplayValue>,
  lookup: SourceRecordLookup,
): Attempt<ReplayValue> {
  switch (operand.kind) {
    case 'source': {
      const record = lookup(operand.ref);
      if (record === undefined) {
        return refuse(
          'missing_record',
          `the Source_Record ${operand.ref.type} ${operand.ref.id} cited by this operand could ` +
            `not be resolved; a replay cannot read a field of a record it was not given`,
          stepIndex,
          position,
        );
      }
      const fields: Readonly<Record<string, bigint>> = record.fields;
      // Own-property only: `toString` and `constructor` are not fields.
      if (!Object.hasOwn(fields, operand.field)) {
        return refuse(
          'unresolvable_field',
          `${operand.ref.type} ${operand.ref.id} exposes no field ${JSON.stringify(operand.field)}. ` +
            `Nothing is derived or defaulted here — a cited field that is absent is a refusal, ` +
            `not a fallback (signed_amount included: it is a field read, never computed from ` +
            `credit and debit)`,
          stepIndex,
          position,
        );
      }
      const raw: unknown = fields[operand.field];
      if (typeof raw !== 'bigint') {
        return refuse(
          'non_monetary_field',
          `${operand.ref.type} ${operand.ref.id} field ${operand.field} is ${typeof raw}, not a ` +
            `bigint; money is integer paise in a bigint (Requirement 15.1, 15.8)`,
          stepIndex,
          position,
        );
      }
      if (!inPaiseRange(raw)) {
        return refuse(
          'out_of_range',
          `${operand.ref.type} ${operand.ref.id} field ${operand.field} is ${raw}, outside ` +
            `${REPLAY_PAISE_MIN}..${REPLAY_PAISE_MAX}`,
          stepIndex,
          position,
        );
      }
      return { ok: true, value: money(raw) };
    }

    case 'step': {
      if (!Number.isSafeInteger(operand.index) || operand.index < 1) {
        return refuse(
          'invalid_step_reference',
          `references step index ${String(operand.index)}, which is not a 1-based ordinal`,
          stepIndex,
          position,
        );
      }
      if (operand.index >= stepIndex) {
        return refuse(
          'forward_step_reference',
          `references step ${operand.index}, which is not a *preceding* step. The schema does not ` +
            `constrain this (migration FINDING 2), so it is re-checked here rather than trusted; ` +
            `a forward reference leaves a replay with no value to read`,
          stepIndex,
          position,
        );
      }
      const value = values.get(operand.index);
      if (value === undefined) {
        return refuse(
          'invalid_step_reference',
          `references step ${operand.index}, which produced no value`,
          stepIndex,
          position,
        );
      }
      return { ok: true, value };
    }

    case 'literal': {
      const raw: unknown = operand.value;
      if (typeof raw !== 'string') {
        return refuse(
          'non_string_literal',
          `carries a non-string literal (${typeof raw}); a monetary literal in JSONB must be a ` +
            `decimal string, because a JSON numeric literal parses back through an IEEE-754 double`,
          stepIndex,
          position,
        );
      }
      if (!DECIMAL_INTEGER.test(raw)) {
        return refuse(
          'malformed_literal',
          `carries the literal ${JSON.stringify(raw)}, which is not a decimal integer matching ` +
            `/^-?[0-9]+$/; rejection, not coercion`,
          stepIndex,
          position,
        );
      }
      // Not range-checked: a literal may be a unitless scalar (a rate divisor,
      // a count). See the module doc comment.
      return { ok: true, value: money(BigInt(raw)) };
    }

    default: {
      const unknown: never = operand;
      return refuse(
        'unknown_operand_kind',
        `states an unknown operand kind ${JSON.stringify((unknown as { kind?: unknown }).kind)}; ` +
          `design.md defines exactly three: source, step, literal`,
        stepIndex,
        position,
      );
    }
  }
}

/** Every operand as paise, refusing on the first boolean. */
function allMonetary(
  values: readonly ReplayValue[],
  stepIndex: number,
): Attempt<readonly bigint[]> {
  const paise: bigint[] = [];
  for (const [position, value] of values.entries()) {
    if (value.kind !== 'money') {
      return refuse(
        'non_monetary_operand',
        `resolved to a boolean where an arithmetic operand is required. A comparison outcome is ` +
          `never coerced to 0n or 1n`,
        stepIndex,
        position,
      );
    }
    paise.push(value.paise);
  }
  return { ok: true, value: paise };
}

/**
 * Evaluates one step from its already-resolved operands.
 *
 * The `default` case assigns `operation` to a `never`-typed binding, so adding a
 * tenth label to `evidence_operation` **breaks the build here** rather than
 * silently returning `undefined` and turning P6 into a false pass.
 */
function evaluateStep(
  operation: EvidenceOperation,
  operands: readonly ReplayValue[],
  stepIndex: number,
): Attempt<ReplayValue> {
  switch (operation) {
    case 'sum':
    case 'add': {
      const resolved = allMonetary(operands, stepIndex);
      if (!resolved.ok) return resolved;
      let total = 0n;
      for (const value of resolved.value) {
        total += value;
      }
      return { ok: true, value: money(total) };
    }

    case 'subtract': {
      const resolved = allMonetary(operands, stepIndex);
      if (!resolved.ok) return resolved;
      const [minuend, subtrahend] = resolved.value as readonly [bigint, bigint];
      return { ok: true, value: money(minuend - subtrahend) };
    }

    case 'multiply': {
      const resolved = allMonetary(operands, stepIndex);
      if (!resolved.ok) return resolved;
      let product = 1n;
      for (const value of resolved.value) {
        product *= value;
      }
      return { ok: true, value: money(product) };
    }

    case 'divide':
    case 'round_half_up': {
      const resolved = allMonetary(operands, stepIndex);
      if (!resolved.ok) return resolved;
      const [numerator, denominator] = resolved.value as readonly [bigint, bigint];
      if (denominator === 0n) {
        return refuse(
          'division_by_zero',
          `states ${operation} with a zero denominator; there is no monetary value that answers ` +
            `"divided by nothing", and a silent 0n would replay as a confident wrong figure`,
          stepIndex,
          1,
        );
      }
      return { ok: true, value: money(roundHalfAwayFromZero(numerator, denominator)) };
    }

    case 'negate': {
      const resolved = allMonetary(operands, stepIndex);
      if (!resolved.ok) return resolved;
      const [value] = resolved.value as readonly [bigint];
      return { ok: true, value: money(-value) };
    }

    case 'select': {
      // Identity on its single operand: whatever kind it had, monetary or not.
      const [only] = operands as readonly [ReplayValue];
      return { ok: true, value: only };
    }

    case 'compare': {
      const resolved = allMonetary(operands, stepIndex);
      if (!resolved.ok) return resolved;
      const [left, right] = resolved.value as readonly [bigint, bigint];
      // Equality, not an ordering: design.md states no comparator, and the one
      // comparison this system makes — "the residual is 0 paise" — admits no
      // tolerance band and needs no direction convention.
      return { ok: true, value: { kind: 'boolean', value: left === right } };
    }

    default: {
      const unknown: never = operation;
      return refuse(
        'unknown_operation',
        `states operation ${JSON.stringify(String(unknown))}, which is not one of the 9 ` +
          `evidence_operation labels`,
        stepIndex,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The interpreter                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Replays an ordered `EvidenceStep[]` over the Source_Records the seam resolves
 * and returns the terminal figure with every intermediate (Requirement 12.8).
 *
 * Pure: no clock, no database, no module state, no mutation of the input.
 *
 * Checked on every call, because the database does not check them
 * (migration FINDING 2): `step_index` gapless `1..n` in order, and every
 * `{ kind: 'step' }` operand citing a strictly lower index.
 */
export function replaySteps(
  steps: readonly EvidenceStep[],
  options: ReplayOptions,
): ReplayOutcome {
  const { lookup } = options;
  const verify = options.verifyStatedResults ?? true;

  if (steps.length === 0) {
    return refuse(
      'empty_chain',
      'an Evidence_Chain states at least 1 computation step; the figure is the terminal step ' +
        'result and there is nothing to replay without one',
    );
  }

  const values = new Map<number, ReplayValue>();
  const results: ReplayStepResult[] = [];

  for (const [position, step] of steps.entries()) {
    const expected = position + 1;
    if (step.index !== expected) {
      return refuse(
        'step_index_not_gapless',
        `the step at position ${position} declares index ${String(step.index)}, expected ` +
          `${expected}: step indexes are 1-based, gapless and in order. The schema constrains ` +
          `step_index >= 1 and uniqueness only (migration FINDING 2), so this is re-checked here ` +
          `rather than trusted — a gap would leave a later operand with no value to read`,
        step.index,
      );
    }

    const arity = ARITY[step.operation] as Arity | undefined;
    if (arity === undefined) {
      return refuse(
        'unknown_operation',
        `states operation ${JSON.stringify(String(step.operation))}, which is not one of the 9 ` +
          `evidence_operation labels`,
        step.index,
      );
    }
    const count = step.operands.length;
    if (count < arity.min || (arity.max !== null && count > arity.max)) {
      const admits = arity.max === null ? `at least ${arity.min}` : `exactly ${arity.max}`;
      return refuse(
        'arity',
        `states ${step.operation} with ${count} operand(s); this interpreter admits ${admits}. ` +
          `design.md fixes no arity table, so the arity is pinned in this module's doc comment`,
        step.index,
      );
    }

    const resolved: ReplayValue[] = [];
    for (const [operandPosition, operand] of step.operands.entries()) {
      const attempt = resolveOperand(operand, step.index, operandPosition, values, lookup);
      if (!attempt.ok) return attempt;
      resolved.push(attempt.value);
    }

    const evaluated = evaluateStep(step.operation, resolved, step.index);
    if (!evaluated.ok) return evaluated;
    const value = evaluated.value;

    if (value.kind === 'money') {
      if (!inPaiseRange(value.paise)) {
        return refuse(
          'out_of_range',
          `recomputes to ${value.paise}, outside ${REPLAY_PAISE_MIN}..${REPLAY_PAISE_MAX}; a step ` +
            `result is stored in the paise domain, so it is rejected rather than saturated`,
          step.index,
        );
      }
      if (verify && step.result_paise !== null && step.result_paise !== value.paise) {
        return refuse(
          'result_disagreement',
          `states result_paise ${String(step.result_paise)} but recomputes to ${value.paise}, a ` +
            `difference of ${value.paise - step.result_paise}. Requirement 12.8 admits zero ` +
            `difference`,
          step.index,
        );
      }
    } else if (step.result_paise !== null) {
      return refuse(
        'non_monetary_result_stated',
        `states ${step.operation}, whose result is a boolean, yet declares result_paise ` +
          `${String(step.result_paise)}; result_paise is NULL for a step with no single monetary ` +
          `result, and a boolean has no paise value`,
        step.index,
      );
    }

    values.set(step.index, value);
    results.push({ index: step.index, operation: step.operation, value });
  }

  const terminal = results[results.length - 1];
  if (terminal === undefined || terminal.value.kind !== 'money') {
    return refuse(
      'non_monetary_terminal_step',
      'the terminal step produced a boolean; Requirement 12.8 replays to a figure in integer ' +
        'paise and evidence_chains.figure_paise is NOT NULL',
      terminal?.index ?? null,
    );
  }

  return { ok: true, figure_paise: terminal.value.paise, step_results: results };
}

/**
 * {@link replaySteps} reduced to the one value Requirement 12.8 names, raising
 * {@link ReplayError} instead of returning a failure. Convenience for a caller
 * that wants `replayed === chain.figure_paise` on one line.
 */
export function replayFigure(
  steps: readonly EvidenceStep[],
  options: ReplayOptions,
): bigint {
  const outcome = replaySteps(steps, options);
  if (!outcome.ok) {
    throw new ReplayError(outcome.failure);
  }
  return outcome.figure_paise;
}

/**
 * The monetary result of one step of a successful replay — design.md's worked
 * example reads the Difference at step 8 as well as the residual at step 12.
 *
 * @throws {ReplayError} when the step is absent or produced a boolean.
 */
export function monetaryStepResult(outcome: ReplayOutcome, index: number): bigint {
  if (!outcome.ok) {
    throw new ReplayError(outcome.failure);
  }
  const step = outcome.step_results.find((candidate) => candidate.index === index);
  if (step === undefined) {
    throw new ReplayError({
      kind: 'invalid_step_reference',
      step_index: index,
      operand_position: null,
      message: `the replay produced no step ${index}`,
    });
  }
  if (step.value.kind !== 'money') {
    throw new ReplayError({
      kind: 'non_monetary_operand',
      step_index: index,
      operand_position: null,
      message: `step ${index} states ${step.operation} and produced a boolean, not paise`,
    });
  }
  return step.value.paise;
}
