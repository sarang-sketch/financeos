/**
 * The transport schema registry and the field-typing audit (task 29.3).
 * Requirements 15.1, 15.8.
 *
 * design.md's money wire contract ends with the sentence this module exists to
 * make true: "the transport schema tests can enumerate every `_paise` field in
 * every payload shape and assert its declared type is `string`". The `_paise`
 * suffix is the mechanism — a naming convention is only a convention until
 * something reads it — and {@link paiseFieldTypingViolations} is the reader.
 *
 * ## Why an audit rather than a type
 *
 * TypeScript can express "this field is a string". It cannot express "every field
 * whose *name* ends in `_paise`, anywhere in this schema tree, is a string", and it
 * cannot see the Python side at all. So the guarantee is asserted over the runtime
 * declarations instead: {@link TRANSPORT_SCHEMAS} names every payload shape that
 * crosses the boundary, {@link transportLeavesOf} walks each one to its leaves, and
 * the audit fails on any monetary leaf that is not a non-coercing string.
 *
 * The failure mode this catches is specific and cheap to commit: someone adds
 * `settlement_total_paise: z.number()` to a payload, every existing test passes,
 * and the value silently rounds the first time it exceeds 2^53 — or the first time
 * an unrounded `applyRate` product crosses, which is four orders of magnitude
 * sooner. Caught here it is a failing audit naming the field. Caught in production
 * it is a figure a User reads as fact.
 *
 * ## Registration is the load-bearing step
 *
 * A schema absent from {@link TRANSPORT_SCHEMAS} is not audited, so the registry is
 * where this discipline can actually be lost. Two things push back: the audit
 * refuses an empty registry and refuses a boundary with no entry, so deleting
 * coverage fails loudly rather than passing vacuously; and every entry names the
 * boundary it belongs to, so the three places design.md says money crosses are
 * visible as three groups rather than as a flat list nobody can check against the
 * document.
 *
 * ## The walk fails closed
 *
 * An unrecognised Zod node kind is a {@link TransportSchemaError}, not a skip. A
 * Zod upgrade that renames a definition field turns into a loud audit failure
 * instead of an audit that silently stops finding fields — which is the only
 * failure mode of a checker that would be worse than not having one.
 *
 * ## Scope
 *
 * This module holds no assertions of its own; `test/transport/field-typing-audit.test.ts`
 * runs it. The Python mirror is `financeos/wire/transport_models.py`, audited by
 * `tests/test_transport_field_typing_audit.py`. Cross-runtime **parity** — every
 * field the TypeScript schema declares being present in the Python model — is task
 * 29.7, which owns the shared fixture vectors both sides read.
 */

import type { z } from 'zod';

import { assertNoCoercion, TransportSchemaError } from './paise-schema';
import {
  evidenceChainWire,
  postReconciliationAdjustmentInputWire,
  postReconciliationAdjustmentResultWire,
} from './tool-transport';
import {
  modelCostCapResponseWire,
  modelRequestPayloadWire,
  modelRequestResponseWire,
} from './metering-transport';
import { responseValidatorRequestWire, validationResultWire } from './validator-transport';

/* -------------------------------------------------------------------------- */
/* The registry                                                               */
/* -------------------------------------------------------------------------- */

/**
 * design.md's three places money crosses TypeScript↔Python. Named as a closed set
 * so the audit can assert each one is covered.
 */
export const TRANSPORT_BOUNDARIES = ['tool', 'validator', 'metering'] as const;

export type TransportBoundary = (typeof TRANSPORT_BOUNDARIES)[number];

export interface TransportSchemaEntry {
  /** How the payload is referred to in design.md, for the audit's failure messages. */
  readonly name: string;
  readonly boundary: TransportBoundary;
  /** Which way the payload travels. Both directions carry money. */
  readonly direction: 'to_python' | 'to_typescript';
  readonly schema: z.ZodType;
}

/**
 * Every payload shape that crosses the runtime boundary.
 *
 * The tool entries are `post_reconciliation_adjustment`, which is the only
 * catalogue tool carrying money in its input as well as its output, plus the
 * `Evidence_Chain` on its own because it is embedded in every successful
 * `ToolResult` and is where `figure_paise` and every `result_paise` live. The
 * envelope is generic in `Out` ({@link postReconciliationAdjustmentResultWire} is
 * one instantiation), so the remaining catalogue entries add entries here without
 * adding an envelope.
 */
export const TRANSPORT_SCHEMAS: readonly TransportSchemaEntry[] = [
  {
    name: 'POST /internal/tools/post_reconciliation_adjustment (request)',
    boundary: 'tool',
    direction: 'to_typescript',
    schema: postReconciliationAdjustmentInputWire,
  },
  {
    name: 'ToolResult<PostReconciliationAdjustmentOutput> (response)',
    boundary: 'tool',
    direction: 'to_python',
    schema: postReconciliationAdjustmentResultWire,
  },
  {
    name: 'EvidenceChain (embedded in every successful ToolResult)',
    boundary: 'tool',
    direction: 'to_python',
    schema: evidenceChainWire,
  },
  {
    name: 'ResponseValidator.validate (request)',
    boundary: 'validator',
    direction: 'to_python',
    schema: responseValidatorRequestWire,
  },
  {
    name: 'ValidationResult (response)',
    boundary: 'validator',
    direction: 'to_typescript',
    schema: validationResultWire,
  },
  {
    name: 'GET /internal/model-cost-cap (response)',
    boundary: 'metering',
    direction: 'to_python',
    schema: modelCostCapResponseWire,
  },
  {
    name: 'POST /internal/model-requests (request)',
    boundary: 'metering',
    direction: 'to_typescript',
    schema: modelRequestPayloadWire,
  },
  {
    name: 'POST /internal/model-requests (response)',
    boundary: 'metering',
    direction: 'to_python',
    schema: modelRequestResponseWire,
  },
] as const;

/* -------------------------------------------------------------------------- */
/* Zod introspection                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The internals the walk reads: Zod 4's definition record.
 *
 * Declared structurally rather than imported, and read through `_zod.def`, exactly
 * as `@/tools/registry` does — Zod's own `$ZodTypeDef` union is not exported in a
 * shape that discriminates usefully. The fail-closed default is what makes reading
 * internals safe here.
 */
interface ZodDef {
  readonly type?: string;
  readonly shape?: Readonly<Record<string, unknown>>;
  readonly catchall?: unknown;
  readonly element?: unknown;
  readonly items?: readonly unknown[];
  readonly rest?: unknown;
  readonly options?: readonly unknown[];
  readonly left?: unknown;
  readonly right?: unknown;
  readonly innerType?: unknown;
  readonly in?: unknown;
  readonly getter?: () => unknown;
}

function defOf(schema: unknown): ZodDef | null {
  if (typeof schema !== 'object' || schema === null) {
    return null;
  }
  const internals = (schema as { readonly _zod?: { readonly def?: unknown } })._zod;
  const def = internals?.def;
  if (typeof def !== 'object' || def === null) {
    return null;
  }
  return def as ZodDef;
}

/** Guards against a genuinely recursive schema whose cycle the path stack misses. */
const MAX_WALK_DEPTH = 64;

/* -------------------------------------------------------------------------- */
/* The walk                                                                   */
/* -------------------------------------------------------------------------- */

/** One leaf of a transport schema: a node with no further schema inside it. */
export interface TransportLeaf {
  /** Dotted, `[]` for an array element, `|n` for a union branch: `evidence.steps[].result_paise`. */
  readonly path: string;
  /**
   * The nearest enclosing object key — the *field name*, which is what carries the
   * `_paise` suffix. `''` for a leaf at the root of a schema that is not an object.
   *
   * `allowed_values_paise` is the case this exists for: its leaf is the array's
   * element, at path `allowed_values_paise[]`, and the field name is still
   * `allowed_values_paise`.
   */
  readonly field: string;
  /** The Zod node kind at the leaf: `string`, `number`, `bigint`, `enum`, `literal`, … */
  readonly type: string;
  /** The leaf node itself, so a caller can inspect it further. */
  readonly schema: z.ZodType;
}

/**
 * Every leaf of one transport schema, in walk order.
 *
 * Shared leaf instances are visited once per path rather than once per instance:
 * `paiseWire` is deliberately a single shared schema object, so deduplicating by
 * node identity — as a plain `seen` set would — would find the first `_paise` field
 * and silently skip every other one. Cycles are prevented by a path-local stack and
 * a depth cap instead.
 *
 * @throws {TransportSchemaError} for a node kind the walk does not recognise, so a
 * Zod upgrade fails the audit rather than shrinking it.
 */
export function transportLeavesOf(schema: z.ZodType, schemaName: string): readonly TransportLeaf[] {
  const leaves: TransportLeaf[] = [];
  const onPath = new Set<unknown>();

  function refuse(path: string, why: string): TransportSchemaError {
    return new TransportSchemaError(
      `${schemaName}: ${path === '' ? '(root)' : path} ${why} (Requirement 15.1, 15.8)`,
    );
  }

  function walk(node: unknown, path: string, field: string, depth: number): void {
    if (depth > MAX_WALK_DEPTH) {
      throw refuse(path, `is nested deeper than ${MAX_WALK_DEPTH} levels, so the walk stopped`);
    }
    const def = defOf(node);
    if (def === null || def.type === undefined) {
      throw refuse(path, 'is not a Zod schema, so nothing about it can be proven');
    }
    if (onPath.has(node)) {
      // A genuinely recursive schema. Audited once on the way in; the cycle adds
      // no field this walk has not already recorded.
      return;
    }
    onPath.add(node);
    try {
      switch (def.type) {
        case 'object': {
          for (const [key, child] of Object.entries(def.shape ?? {})) {
            walk(child, path === '' ? key : `${path}.${key}`, key, depth + 1);
          }
          return;
        }

        /* Wrappers: the field name and the path both carry through unchanged. */
        case 'optional':
        case 'nullable':
        case 'default':
        case 'prefault':
        case 'nonoptional':
        case 'readonly':
        case 'catch':
        case 'promise':
          walk(def.innerType, path, field, depth + 1);
          return;

        case 'pipe':
          // `.transform()` and `.pipe()`. The wire supplies the `in` side.
          walk(def.in, path, field, depth + 1);
          return;

        case 'lazy': {
          if (typeof def.getter !== 'function') {
            throw refuse(path, 'is a lazy schema with no getter');
          }
          walk(def.getter(), path, field, depth + 1);
          return;
        }

        case 'array':
          walk(def.element, `${path}[]`, field, depth + 1);
          return;

        case 'tuple': {
          (def.items ?? []).forEach((item, index) => {
            walk(item, `${path}[${index}]`, field, depth + 1);
          });
          if (def.rest !== undefined && def.rest !== null) {
            walk(def.rest, `${path}[]`, field, depth + 1);
          }
          return;
        }

        case 'union':
          (def.options ?? []).forEach((option, index) => {
            walk(option, `${path}|${index}`, field, depth + 1);
          });
          return;

        case 'intersection':
          walk(def.left, path, field, depth + 1);
          walk(def.right, path, field, depth + 1);
          return;

        /* Leaves. Anything with no schema inside it. */
        case 'string':
        case 'number':
        case 'bigint':
        case 'boolean':
        case 'date':
        case 'enum':
        case 'literal':
        case 'null':
        case 'undefined':
        case 'void':
        case 'nan':
        case 'never':
          leaves.push({ path, field, type: def.type, schema: node as z.ZodType });
          return;

        default:
          // Fail closed: `any`, `unknown`, `record`, `map`, `custom`, and anything a
          // later Zod adds. A node this walk cannot reason about is a node that
          // might hide a monetary field, and unproven is not accepted.
          throw refuse(
            path,
            `is a ${def.type} node, whose contents this audit cannot enumerate, so a ` +
              `monetary field inside it would go unchecked`,
          );
      }
    } finally {
      onPath.delete(node);
    }
  }

  walk(schema, '', '', 0);
  return leaves;
}

/* -------------------------------------------------------------------------- */
/* The field-typing audit                                                     */
/* -------------------------------------------------------------------------- */

/** The one declared type a monetary field on the wire may have. */
export const PAISE_WIRE_LEAF_TYPE = 'string';

/** design.md's mechanically checkable rule: money on the wire is named `*_paise`. */
export function isMonetaryFieldName(field: string): boolean {
  return field.endsWith('_paise');
}

/** Every monetary leaf of one schema. */
export function paiseLeavesOf(entry: TransportSchemaEntry): readonly TransportLeaf[] {
  return transportLeavesOf(entry.schema, entry.name).filter((leaf) =>
    isMonetaryFieldName(leaf.field),
  );
}

/**
 * The audit. One message per monetary field whose declared type is not a
 * non-coercing string; empty when every `_paise` field in every registered schema
 * is declared correctly.
 *
 * Returns findings rather than throwing so a single run reports every offending
 * field at once: a reviewer who typed three new fields as numbers should see three
 * names, not the first one.
 */
export function paiseFieldTypingViolations(
  entries: readonly TransportSchemaEntry[] = TRANSPORT_SCHEMAS,
): readonly string[] {
  const findings: string[] = [];
  for (const entry of entries) {
    for (const leaf of paiseLeavesOf(entry)) {
      if (leaf.type !== PAISE_WIRE_LEAF_TYPE) {
        findings.push(
          `${entry.name}: ${leaf.path} is declared ${leaf.type}; every monetary field on the ` +
            `wire is a decimal string, because JSON.parse produces a double for every numeric ` +
            `literal (Requirement 15.1, 15.8)`,
        );
        continue;
      }
      try {
        assertNoCoercion(leaf.schema, `${entry.name}: ${leaf.path}`);
      } catch (error) {
        findings.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return findings;
}
