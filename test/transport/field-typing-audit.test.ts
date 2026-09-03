/**
 * The field-typing audit, TypeScript side (task 29.3). CI stage 7.
 *
 * design.md's money wire contract states the rule this file enforces: "Every
 * monetary field on the wire carries a `_paise` suffix and is typed `string` in the
 * transport schema. The suffix is what makes the rule mechanically checkable: the
 * transport schema tests can enumerate every `_paise` field in every payload shape
 * and assert its declared type is `string`."
 *
 * So this is not a test of one schema. It is a test of the *set* of schemas, and it
 * is the reason a new monetary field typed as a number fails in CI stage 7 rather
 * than at runtime with a rounded figure nobody can trace. `tests/test_transport_field_typing_audit.py`
 * is the same assertion against the Python mirror.
 *
 * The negative controls matter as much as the positive assertion. An audit that
 * passes because it found nothing is worse than no audit, so this file also proves
 * that the audit **fails** on a `_paise` field typed as a number, on one typed as a
 * bigint, on a coerced string, on a monetary field hidden inside a `z.record`, and
 * on an empty registry.
 *
 * Task 29.7 owns the rest of CI stage 7 — the JSON-number rejection matrix, the
 * cross-runtime round-trip over the shared vectors, and the four endpoint contracts.
 * Nothing here pre-empts it.
 *
 * Validates: Requirements 15.1, 15.8
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { paiseWire, TransportSchemaError } from '@/wire/paise-schema';
import {
  isMonetaryFieldName,
  paiseFieldTypingViolations,
  paiseLeavesOf,
  TRANSPORT_BOUNDARIES,
  TRANSPORT_SCHEMAS,
  transportLeavesOf,
  type TransportSchemaEntry,
} from '@/wire/transport-schemas';

/** A registry of one, so a negative control is audited exactly as the real one is. */
function entryFor(schema: z.ZodType): readonly TransportSchemaEntry[] {
  return [{ name: 'specimen', boundary: 'tool', direction: 'to_python', schema }];
}

/**
 * The one registered payload that declares no monetary field at all: the Gateway
 * reports token counts and latency, and TypeScript computes the price.
 */
const MONEY_FREE_BY_DESIGN = 'POST /internal/model-requests (request)';

describe('every _paise field in every transport schema is declared string', () => {
  it('finds no violation across the registry', () => {
    expect(paiseFieldTypingViolations()).toEqual([]);
  });

  it('audits at least one schema at each of the three boundaries money crosses', () => {
    // An empty registry, or one that quietly lost a boundary, would satisfy the
    // assertion above by finding nothing. design.md names three places money
    // crosses; each must be represented or the audit is not auditing them.
    for (const boundary of TRANSPORT_BOUNDARIES) {
      expect(
        TRANSPORT_SCHEMAS.filter((entry) => entry.boundary === boundary).length,
        `no transport schema registered for the ${boundary} boundary`,
      ).toBeGreaterThan(0);
    }
  });

  it('finds a monetary field in every registered schema but the one that carries none by design', () => {
    // A schema with no `_paise` field is audited vacuously, so each one has to be
    // accounted for rather than assumed. There is exactly one, and its emptiness is
    // the contract: the Gateway posts measurements and TypeScript prices them, so a
    // body carrying `cost_paise` is an unrecognised key on a strict object rather
    // than a field with a wrong type (Requirement 11.8).
    expect(TRANSPORT_SCHEMAS.some((entry) => entry.name === MONEY_FREE_BY_DESIGN)).toBe(true);

    for (const entry of TRANSPORT_SCHEMAS) {
      const found = paiseLeavesOf(entry).length;
      if (entry.name === MONEY_FREE_BY_DESIGN) {
        expect(found, `${entry.name} declares a monetary field it must not`).toBe(0);
        continue;
      }
      expect(found, `${entry.name} declares no _paise field`).toBeGreaterThan(0);
    }
  });

  it('reaches figure_paise and every step result_paise inside the returned envelope', () => {
    const envelope = TRANSPORT_SCHEMAS.find((entry) =>
      entry.name.startsWith('ToolResult<'),
    ) as TransportSchemaEntry;
    const paths = paiseLeavesOf(envelope).map((leaf) => leaf.path);

    // The success branch of the union is `|0`. Both output figures and both
    // evidence figures are reached through it.
    expect(paths).toContain('|0.evidence.figure_paise');
    expect(paths).toContain('|0.evidence.steps[].result_paise');
    expect(paths).toContain('|0.value.total_debit_paise');
    expect(paths).toContain('|0.value.total_credit_paise');
  });

  it('reaches the allowed value set the validator compares against', () => {
    const request = TRANSPORT_SCHEMAS.find(
      (entry) => entry.name === 'ResponseValidator.validate (request)',
    ) as TransportSchemaEntry;
    const leaves = paiseLeavesOf(request);

    // The leaf is the array *element*; the field name that carries the suffix is
    // the array's own key, which is what the audit keys on.
    expect(leaves.map((leaf) => leaf.path)).toEqual(['allowed_values_paise[]']);
    expect(leaves[0]?.field).toBe('allowed_values_paise');
    expect(leaves[0]?.type).toBe('string');
  });

  it('reaches both metering payloads, including the cost the Gateway does not compute', () => {
    const monetary = TRANSPORT_SCHEMAS.filter((entry) => entry.boundary === 'metering').flatMap(
      (entry) => paiseLeavesOf(entry).map((leaf) => leaf.path),
    );

    expect(monetary).toEqual(
      expect.arrayContaining(['cap_paise', 'month_to_date_paise', 'cost_paise']),
    );
  });

});

describe('the audit fails on a monetary field that is not a decimal string', () => {
  it('rejects a _paise field declared as a number', () => {
    const findings = paiseFieldTypingViolations(
      entryFor(z.strictObject({ settlement_total_paise: z.number() })),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('settlement_total_paise is declared number');
  });

  it('rejects a _paise field declared as a bigint, which JSON.stringify cannot emit', () => {
    const findings = paiseFieldTypingViolations(
      entryFor(z.strictObject({ impact_paise: z.bigint() })),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('is declared bigint');
  });

  it('rejects a coerced string, which launders a value JSON.parse already rounded', () => {
    const findings = paiseFieldTypingViolations(
      entryFor(z.strictObject({ figure_paise: z.coerce.string() })),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('declared with coercion');
  });

  it('reports every offending field, not just the first', () => {
    const findings = paiseFieldTypingViolations(
      entryFor(
        z.strictObject({
          a_paise: z.number(),
          b_paise: z.number(),
          nested: z.strictObject({ c_paise: z.number() }),
        }),
      ),
    );

    expect(findings).toHaveLength(3);
  });

  it('finds a monetary field nested under an array, a union and an optional', () => {
    const findings = paiseFieldTypingViolations(
      entryFor(
        z.strictObject({
          rows: z.array(
            z.union([
              z.strictObject({ kind: z.literal('a'), amount_paise: paiseWire }),
              z.strictObject({ kind: z.literal('b'), amount_paise: z.number().optional() }),
            ]),
          ),
        }),
      ),
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('rows[]|1.amount_paise');
  });
});

describe('the walk fails closed rather than shrinking', () => {
  it('refuses a node kind it cannot enumerate, so a hidden monetary field is not missed', () => {
    // `z.record(z.string(), z.number())` could hold `figure_paise` at runtime with
    // nothing in the declaration to enumerate. Refusing is the only honest answer.
    expect(() =>
      transportLeavesOf(z.strictObject({ cells: z.record(z.string(), z.number()) }), 'specimen'),
    ).toThrow(TransportSchemaError);
  });

  it('refuses a node that is not a Zod schema at all', () => {
    expect(() => transportLeavesOf({} as unknown as z.ZodType, 'specimen')).toThrow(
      /is not a Zod schema/,
    );
  });

  it('visits a shared leaf instance once per path rather than once per instance', () => {
    // `paiseWire` is deliberately one shared object. Deduplicating by node identity
    // would find the first field and silently skip the rest — the failure mode that
    // would make this whole audit look green while checking one field.
    const leaves = transportLeavesOf(
      z.strictObject({ first_paise: paiseWire, second_paise: paiseWire }),
      'specimen',
    );

    expect(leaves.map((leaf) => leaf.path)).toEqual(['first_paise', 'second_paise']);
  });
});

describe('the suffix rule', () => {
  it('matches a monetary field name and nothing else', () => {
    expect(isMonetaryFieldName('figure_paise')).toBe(true);
    expect(isMonetaryFieldName('allowed_values_paise')).toBe(true);
    expect(isMonetaryFieldName('paise')).toBe(false);
    expect(isMonetaryFieldName('paise_figure')).toBe(false);
    expect(isMonetaryFieldName('latency_ms')).toBe(false);
  });
});
