// Feature: financeos-control-tower, Property 15: Money wire round-trip — for all paise
// values `p` in the signed range −99999999999999 to 99999999999999, serializing `p` on
// one runtime and parsing it on the other reproduces `p` exactly, in both directions; and
// for all monetary fields, a payload carrying a JSON number in a `_paise` field is
// rejected with a schema violation naming the field rather than coerced.
//
// **Validates: Requirements 15.1, 15.8**
//
// P15 is owned by **both** runtimes. This is the fast-check half; the Hypothesis half is
// `tests/property/test_money_wire.py`. Both read ONE committed file —
// `fixtures/wire/money-wire-vectors.json` — not two copies of it.
//
// ## What is asserted in-process, and what is asserted across processes
//
// Read this before trusting a green run, because the distinction is the whole reason the
// fixture exists.
//
// **In-process, here.** `fromWire(toWire(p)) === p` for every generated `p`; `toWire`
// raising on every out-of-range value; the range-free pair round-tripping every
// above-2^53 value; and every malformed `_paise` payload being rejected by the Zod
// transport schema with the offending field named.
//
// **Across processes, through the shared fixture.** There is no Python interpreter in
// this test run, so `pyParse(tsSerialize(p))` is not evaluated here as a function
// composition. It is asserted as a *chain through one committed artifact*, and each link
// is checked in the runtime that owns it:
//
//   link 1 (here)                    `toWire(BigInt(v.paise)) === v.wire`
//   link 2 (tests/property/…py)      `from_wire(v.wire) == int(v.paise)`
//   ⇒ composite                      `pyParse(tsSerialize(p)) == p`
//
//   link 3 (tests/property/…py)      `to_wire(int(v.paise)) == v.wire`
//   link 4 (here)                    `fromWire(v.wire) === BigInt(v.paise)`
//   ⇒ composite                      `BigInt(pySerialize(p)) === p`
//
// `v.wire` is a byte string in a committed file, so the composition is sound: the string
// link 2 parses is character-for-character the string link 1 produced. What this cannot
// catch is a fixture whose `wire` field is wrong in a way both runtimes reproduce — which
// is why `wire` is never trusted on its own and is always checked against an independently
// computed `p.toString()`. Live process-to-process exchange over the real internal
// endpoints is task 29.7's `test/transport/`, once 29.5 and 29.6 exist to be called.
//
// **Coverage, not omission.** A generated value outside the fixture is asserted only on
// the side that drew it. The fixture is what makes the *boundary* values symmetric, so
// `covers every constant the generator is biased toward` below is load-bearing: adding a
// constant to the generator without adding it to the fixture fails here, which forces it
// into the file the Python suite reads.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PAISE_MAX, PAISE_MIN, type Paise, PaiseRangeError } from '@/calc/paise';
import {
  decodePaise,
  encodePaise,
  fromWire,
  toWire,
  WireError,
} from '@/wire/paise-wire';
import { modelCostCapResponseWire, modelRequestResponseWire } from '@/wire/metering-transport';
import {
  evidenceChainWire,
  postReconciliationAdjustmentInputWire,
  postReconciliationAdjustmentResultWire,
} from '@/wire/tool-transport';
import { paiseLeavesOf, TRANSPORT_SCHEMAS } from '@/wire/transport-schemas';
import { responseValidatorRequestWire, validationResultWire } from '@/wire/validator-transport';

/* -------------------------------------------------------------------------- */
/* The shared fixture                                                         */
/* -------------------------------------------------------------------------- */

const FIXTURE_PATH = fileURLToPath(
  new URL('../../fixtures/wire/money-wire-vectors.json', import.meta.url),
);

/**
 * The fixture's own shape, declared rather than assumed.
 *
 * A `strictObject` on purpose: a key renamed on the Python side and not here would
 * otherwise show up as an assertion silently iterating an empty list, which is exactly the
 * "green suite by omission" this property is written against.
 */
const roundTripVector = z.strictObject({
  id: z.string().min(1),
  paise: z.string(),
  wire: z.string(),
  note: z.string().optional(),
});

const fixtureSchema = z.strictObject({
  $comment: z.array(z.string()),
  version: z.literal(1),
  property: z.literal('P15'),
  validates: z.array(z.string()),
  seeds: z.strictObject({
    $comment: z.string(),
    fast_check_seed: z.number().int(),
    fast_check_num_runs: z.number().int(),
    hypothesis_max_examples: z.number().int(),
    hypothesis_seed: z.number().int(),
  }),
  range: z.strictObject({ min: z.string(), max: z.string() }),
  boundary_constants: z.array(z.string()).min(1),
  in_range: z.array(roundTripVector).min(1),
  out_of_range: z.array(z.strictObject({ id: z.string().min(1), paise: z.string() })).min(1),
  above_two_pow_53: z.array(roundTripVector).min(1),
  malformed: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        json: z.string().min(1),
        why: z.string().min(1),
        accepted_when_nullable: z.boolean(),
      }),
    )
    .min(1),
  payloads: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        typescript_schema: z.string().min(1),
        python_model: z.string().min(1),
        boundary: z.enum(['tool', 'validator', 'metering']),
        body: z.unknown(),
        paise_paths: z
          .array(
            z.strictObject({
              path: z.string().min(1),
              field: z.string().min(1),
              nullable: z.boolean(),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
});

const FIXTURE = fixtureSchema.parse(JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')));

/** The committed fast-check seed, so any counterexample reproduces from this file alone. */
const SEED = FIXTURE.seeds.fast_check_seed;

/** design.md holds P12 and P15 to 1000 iterations; conftest.py's `thorough` profile is the mirror. */
const PARAMS = { numRuns: FIXTURE.seeds.fast_check_num_runs, seed: SEED } as const;

/* -------------------------------------------------------------------------- */
/* Generators                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * design.md's boundary constants, as `bigint`. The literals `0n`, `1n`, `-1n`, `99n`,
 * `100n` and both range extremes, read from the shared file rather than transcribed, so
 * the constant set the generator is biased toward and the constant set the Python
 * generator is biased toward cannot drift apart.
 */
const BOUNDARY_CONSTANTS: readonly Paise[] = FIXTURE.boundary_constants.map((c) => BigInt(c));

/**
 * The in-range arbitrary: the whole signed paise range, biased toward the boundary
 * constants. `fc.bigInt`, never `fc.integer` or `fc.double` — there is no number-valued
 * money arbitrary anywhere in this suite (design.md, Generators and arbitraries).
 */
const arbitraryInRangePaise: fc.Arbitrary<Paise> = fc.oneof(
  { arbitrary: fc.bigInt({ min: PAISE_MIN, max: PAISE_MAX }), weight: 3 },
  { arbitrary: fc.constantFrom(...BOUNDARY_CONSTANTS), weight: 1 },
);

/** One paisa past each extreme, out to the magnitude an unrounded rate product reaches. */
const arbitraryOutOfRangePaise: fc.Arbitrary<Paise> = fc.oneof(
  fc.bigInt({ min: PAISE_MAX + 1n, max: 10n ** 20n }),
  fc.bigInt({ min: -(10n ** 20n), max: PAISE_MIN - 1n }),
);

/**
 * design.md's second, separately generated set: magnitudes above 2^53, fed through the
 * range-free pair because `assertInRange` rejects them by design. This is the magnitude at
 * which a JSON-number implementation passes every other case in this file and silently
 * fails, and it is the magnitude an unrounded `applyRate` product actually reaches.
 */
const TWO_POW_53 = 9007199254740992n;
const arbitraryAboveTwoPow53: fc.Arbitrary<Paise> = fc.bigInt({
  min: TWO_POW_53,
  max: 10n ** 20n,
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

type Attempt<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Runs `fn` and reports whether it returned or raised. Nothing inside an `attempt`
 * asserts, so an assertion failure can never be mistaken for the raise under test, and
 * `ok: false` is positive evidence that no value came back at all.
 */
function attempt<T>(fn: () => T): Attempt<T> {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

type PathToken = string | number;

/** `evidence.steps[0].result_paise` -> `['evidence', 'steps', 0, 'result_paise']`. */
function tokensOf(path: string): readonly PathToken[] {
  const tokens: PathToken[] = [];
  for (const part of path.split('.')) {
    const [head, ...brackets] = part.split('[');
    if (head !== undefined && head !== '') tokens.push(head);
    for (const bracket of brackets) {
      const index = Number.parseInt(bracket.replace(']', ''), 10);
      if (Number.isNaN(index)) throw new Error(`fixture path ${path} has a malformed index`);
      tokens.push(index);
    }
  }
  if (tokens.length === 0) throw new Error(`fixture path ${path} is empty`);
  return tokens;
}

/** Reads one step, refusing a path the payload does not have rather than returning undefined. */
function stepInto(cursor: unknown, token: PathToken, path: string): unknown {
  if (typeof token === 'number') {
    if (!Array.isArray(cursor) || !(token in cursor)) {
      throw new Error(`fixture path ${path}: no element ${token} to step into`);
    }
    return cursor[token];
  }
  if (typeof cursor !== 'object' || cursor === null || !(token in cursor)) {
    throw new Error(`fixture path ${path}: no key ${token} to step into`);
  }
  return (cursor as Record<string, unknown>)[token];
}

/**
 * A structural copy of `body` with `value` at `path`.
 *
 * Refuses a path that does not already exist, so a fixture typo fails loudly instead of
 * quietly adding a key the schema would reject for the wrong reason — a rejection that
 * named `amount_pasie` would look like a pass.
 */
function withValueAt(body: unknown, path: string, value: unknown): unknown {
  const clone: unknown = structuredClone(body);
  const tokens = tokensOf(path);
  let cursor: unknown = clone;
  for (const token of tokens.slice(0, -1)) {
    cursor = stepInto(cursor, token, path);
  }
  const last = tokens[tokens.length - 1];
  if (last === undefined) throw new Error(`fixture path ${path} is empty`);
  // Assert the leaf exists before overwriting it.
  stepInto(cursor, last, path);
  if (typeof last === 'number') {
    (cursor as unknown[])[last] = value;
  } else {
    (cursor as Record<string, unknown>)[last] = value;
  }
  return clone;
}

/**
 * Every path Zod reported an issue at, flattened.
 *
 * `toolResultWire` and `validationResultWire` are `z.union`s, and a union failure in Zod 4
 * is one `invalid_union` issue at the root carrying the per-branch issues underneath. So
 * "the violation names the offending field" has to read through `issue.errors`; a check
 * that only looked at top-level `issue.path` would find `[]` and conclude nothing was
 * named.
 */
interface IssueLike {
  readonly path?: readonly PropertyKey[];
  readonly errors?: readonly (readonly IssueLike[])[];
}

function issueSegments(issues: readonly IssueLike[]): readonly (readonly string[])[] {
  const collected: (readonly string[])[] = [];
  for (const issue of issues) {
    if (issue.path !== undefined) collected.push(issue.path.map(String));
    for (const branch of issue.errors ?? []) collected.push(...issueSegments(branch));
  }
  return collected;
}

/** The Zod schema each fixture payload is held to. Fails closed on an unregistered id. */
const SCHEMA_BY_NAME: Readonly<Record<string, z.ZodType>> = {
  postReconciliationAdjustmentInputWire,
  postReconciliationAdjustmentResultWire,
  evidenceChainWire,
  responseValidatorRequestWire,
  validationResultWire,
  modelCostCapResponseWire,
  modelRequestResponseWire,
};

function schemaFor(name: string): z.ZodType {
  const schema = SCHEMA_BY_NAME[name];
  if (schema === undefined) {
    throw new Error(
      `the fixture names transport schema ${name}, which this suite does not import; ` +
        `a payload shape nobody parses is a payload shape nobody checks`,
    );
  }
  return schema;
}

/* -------------------------------------------------------------------------- */
/* The range constants agree with the shared statement of the range           */
/* -------------------------------------------------------------------------- */

describe('the paise range is one statement, read by both runtimes', () => {
  it('reads the same file the other runtime reads', () => {
    // `tests/property/test_money_wire.py` pins the same three values. If the file is ever
    // forked into a per-runtime copy, the copies drift and one of these fails.
    expect(FIXTURE.version).toBe(1);
    expect(FIXTURE.property).toBe('P15');
    expect(FIXTURE.validates).toEqual(['15.1', '15.8']);
  });

  it('matches the range the shared fixture states', () => {
    // If this fails, every other assertion in both suites is about a different range.
    expect(PAISE_MIN).toBe(BigInt(FIXTURE.range.min));
    expect(PAISE_MAX).toBe(BigInt(FIXTURE.range.max));
    expect(PAISE_MIN).toBe(-99999999999999n);
    expect(PAISE_MAX).toBe(99999999999999n);
  });

  it('covers every constant the generator is biased toward', () => {
    // The omission guard. A boundary constant added to `arbitraryInRangePaise` but not to
    // the fixture would be drawn here and never asserted on the Python side; this test is
    // what turns that into a failure rather than a silently one-sided property.
    const covered = new Set(FIXTURE.in_range.map((vector) => vector.paise));
    for (const constant of BOUNDARY_CONSTANTS) {
      expect(covered.has(constant.toString()), `${constant} is not a shared in-range vector`).toBe(
        true,
      );
    }
    for (const required of ['0', '1', '-1', '99', '100', FIXTURE.range.min, FIXTURE.range.max]) {
      expect(FIXTURE.boundary_constants).toContain(required);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The generated in-range round-trip                                          */
/* -------------------------------------------------------------------------- */

describe('Property 15: money wire round-trip, in-range values', () => {
  it('round-trips every generated in-range value through toWire and fromWire exactly', () => {
    fc.assert(
      fc.property(arbitraryInRangePaise, (p) => {
        expect(typeof p).toBe('bigint');

        const wire = toWire(p);

        // A decimal string, which is the only thing `JSON.stringify` will carry: it
        // throws on a bigint, and a JSON number would be a double on the far side.
        expect(typeof wire).toBe('string');
        expect(/^-?[0-9]+$/.test(wire)).toBe(true);
        // Character-for-character what Python's `str(v)` produces for the same integer.
        // This is link 1 of the cross-runtime chain, generalised past the fixture.
        expect(wire).toBe(p.toString());

        const parsed = fromWire(wire);
        expect(typeof parsed).toBe('bigint');
        expect(parsed).toBe(p);
      }),
      PARAMS,
    );
  });

  it('parses the exact byte string the Python side serialises, for every shared vector', () => {
    // Link 4 of the chain: `BigInt(pySerialize(p)) === p`. `tests/property/test_money_wire.py`
    // asserts `to_wire(int(v.paise)) == v.wire` over this same list, so the string parsed
    // here is the string Python emits.
    for (const vector of FIXTURE.in_range) {
      const p = BigInt(vector.paise);

      // Link 1: `pyParse(tsSerialize(p)) == p`, whose second half Python asserts.
      expect(toWire(p), `tsSerialize disagrees with ${vector.id}`).toBe(vector.wire);
      // The fixture's own `wire` field is never trusted on its own.
      expect(vector.wire).toBe(p.toString());

      expect(fromWire(vector.wire), `tsParse disagrees with ${vector.id}`).toBe(p);
    }

    expect(FIXTURE.in_range.length).toBeGreaterThanOrEqual(BOUNDARY_CONSTANTS.length);
  });
});

/* -------------------------------------------------------------------------- */
/* The range guard, asserted as its own fact                                  */
/* -------------------------------------------------------------------------- */

describe('Property 15: toWire raises rather than emitting a string out of range', () => {
  it('produces no string at all for any generated out-of-range value', () => {
    // Separate from the round-trip property on purpose: design.md wants the range guard
    // and the encoding guarantee asserted as two facts, because an implementation that
    // saturated at PAISE_MAX would satisfy the round-trip and lose the figure.
    fc.assert(
      fc.property(arbitraryOutOfRangePaise, (p) => {
        expect(p > PAISE_MAX || p < PAISE_MIN).toBe(true);

        const outcome = attempt(() => toWire(p));

        expect(outcome.ok).toBe(false);
        if (outcome.ok) return;
        expect(outcome.error).toBeInstanceOf(PaiseRangeError);
      }),
      PARAMS,
    );
  });

  it('rejects a well-formed decimal string one paisa past each extreme on the way in', () => {
    // The format guard passes and the range guard fails, which is why `WireError` and
    // `PaiseRangeError` are separate classes.
    for (const vector of FIXTURE.out_of_range) {
      const p = BigInt(vector.paise);
      expect(p > PAISE_MAX || p < PAISE_MIN, `${vector.id} is inside the range`).toBe(true);

      const out = attempt(() => toWire(p));
      expect(out.ok, `toWire emitted a string for ${vector.id}`).toBe(false);
      if (!out.ok) expect(out.error).toBeInstanceOf(PaiseRangeError);

      const back = attempt(() => fromWire(vector.paise));
      expect(back.ok, `fromWire accepted ${vector.id}`).toBe(false);
      if (!back.ok) expect(back.error).toBeInstanceOf(PaiseRangeError);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Above 2^53 — its own named test, not left to the generator                  */
/* -------------------------------------------------------------------------- */

describe('Property 15: the range-free pair survives magnitudes above 2^53', () => {
  it('round-trips every generated value from 2^53 to 10^20, in both signs', () => {
    fc.assert(
      fc.property(arbitraryAboveTwoPow53, (magnitude) => {
        expect(magnitude >= TWO_POW_53).toBe(true);
        // The range guard rejects these by design, which is the whole reason the
        // range-free pair exists rather than a second range.
        expect(attempt(() => toWire(magnitude)).ok).toBe(false);

        for (const p of [magnitude, -magnitude]) {
          const wire = encodePaise(p);
          expect(wire).toBe(p.toString());
          expect(decodePaise(wire)).toBe(p);
          // The assertion a JSON-number implementation fails: the digits survive a
          // magnitude a double cannot hold.
          expect(BigInt(wire)).toBe(p);
        }
      }),
      PARAMS,
    );
  });

  it('round-trips the shared above-2^53 vectors, including 2^53 + 1', () => {
    // 2^53 + 1 is the first integer an IEEE-754 double cannot represent:
    // `JSON.parse('9007199254740993')` yields 9007199254740992. Committed as a vector so
    // the Python suite asserts the same digits.
    const ids = new Set(FIXTURE.above_two_pow_53.map((vector) => vector.id));
    expect(ids.has('two_pow_53_plus_one')).toBe(true);
    expect(ids.has('unrounded_rate_product')).toBe(true);

    for (const vector of FIXTURE.above_two_pow_53) {
      const p = BigInt(vector.paise);
      const magnitude = p < 0n ? -p : p;
      expect(magnitude >= TWO_POW_53, `${vector.id} is not above 2^53`).toBe(true);

      expect(encodePaise(p), `encodePaise disagrees with ${vector.id}`).toBe(vector.wire);
      expect(decodePaise(vector.wire), `decodePaise disagrees with ${vector.id}`).toBe(p);
      expect(vector.wire).toBe(p.toString());

      // What a JSON-number implementation would have done to the same value, stated so
      // the failure mode this test exists for is visible rather than implied.
      const throughADouble = BigInt(Math.trunc(Number(vector.wire)));
      if (vector.id === 'two_pow_53_plus_one') expect(throughADouble).not.toBe(p);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Malformed payload rejection, per _paise field                              */
/* -------------------------------------------------------------------------- */

describe('Property 15: a malformed _paise field is a schema violation naming the field', () => {
  it('accepts every shared base payload unmodified', () => {
    // The control. Eight rejections mean nothing if the base payload was already invalid:
    // the suite would be green because everything fails, which is the failure mode that
    // looks most like success. This also checks the fixture is a payload BOTH runtimes
    // accept, since `tests/property/test_money_wire.py` asserts the same bodies.
    for (const payload of FIXTURE.payloads) {
      const result = schemaFor(payload.typescript_schema).safeParse(payload.body);
      expect(result.success, `${payload.id} is not a valid payload: ${result.error?.message}`).toBe(
        true,
      );
    }
  });

  it('pokes every _paise field the field-typing audit finds, and no field it does not', () => {
    // "Per `_paise` field" is only true if the field list is complete. The audit walker
    // from task 29.3 is the independent enumeration, so a monetary field added to a
    // transport schema without a fixture path fails here.
    const audited = new Set(
      TRANSPORT_SCHEMAS.flatMap((entry) => paiseLeavesOf(entry).map((leaf) => leaf.field)),
    );
    const poked = new Set(
      FIXTURE.payloads.flatMap((payload) => payload.paise_paths.map((field) => field.field)),
    );

    expect([...poked].sort()).toEqual([...audited].sort());
    expect(audited.size).toBeGreaterThan(0);
  });

  it('rejects all eight malformed values in every _paise field, naming the field', () => {
    // The eight cases design.md names, one each: a JSON number, a JSON float, a numeric
    // string with a decimal point, one with leading whitespace, one with a leading plus
    // sign, a non-numeric string, `null`, and a nested object.
    expect(FIXTURE.malformed).toHaveLength(8);

    for (const payload of FIXTURE.payloads) {
      const schema = schemaFor(payload.typescript_schema);

      for (const target of payload.paise_paths) {
        for (const malformed of FIXTURE.malformed) {
          // Parsed with the same JSON parser a real request would arrive through, so a
          // JSON number reaches the schema as the double `JSON.parse` produces.
          const value: unknown = JSON.parse(malformed.json);
          const body = withValueAt(payload.body, target.path, value);
          const where = `${payload.id}.${target.path} = ${malformed.id}`;
          const result = schema.safeParse(body);

          if (malformed.accepted_when_nullable && target.nullable) {
            // `null` in a nullable monetary field is a stated absence, not a violation:
            // an `EvidenceStep` that compared rather than computed has no figure, and the
            // wire says so. Asserting rejection here would be asserting a bug.
            expect(result.success, `${where} was rejected but null is declared valid`).toBe(true);
            continue;
          }

          expect(result.success, `${where} was accepted`).toBe(false);
          if (result.success) continue;

          // No coerced value is produced — not a stringified number, not a truncated
          // float, nothing. `safeParse` reports `data` only on success.
          expect(result.data).toBeUndefined();

          // The violation names the offending field.
          const segments = issueSegments(result.error.issues);
          expect(
            segments.some((path) => path.includes(target.field)),
            `${where}: no issue named ${target.field}; issues were ${JSON.stringify(segments)}`,
          ).toBe(true);
        }
      }
    }
  });

  it('rejects the same eight values at the helper, not only at the schema', () => {
    // The schema guards a payload; `fromWire` guards every other call site. Both, because
    // a value can reach `fromWire` from a source that never went through a schema.
    for (const malformed of FIXTURE.malformed) {
      const value: unknown = JSON.parse(malformed.json);
      const outcome = attempt(() => fromWire(value as string, 'figure_paise'));

      expect(outcome.ok, `fromWire accepted ${malformed.id}`).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.error).toBeInstanceOf(WireError);
      expect((outcome.error as WireError).field).toBe('figure_paise');
    }
  });
});
