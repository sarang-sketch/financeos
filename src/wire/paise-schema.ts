/**
 * The one Zod declaration of a monetary field on the wire (task 29.3).
 * Requirements 15.1, 15.8.
 *
 * Every `_paise` field in every transport schema under `src/wire/` is this schema,
 * or this schema wrapped in `.nullable()` / `z.array(...)`. There is no second
 * spelling, so "every monetary field is a decimal string" is a property of one
 * declaration rather than a habit spread across a dozen files.
 *
 * ## Rejection, not coercion
 *
 * `z.string()`, never `z.coerce.string()`. design.md's money wire contract is
 * explicit about why, and the reason is worth restating where the temptation
 * lives: `z.coerce.string()` turns `84260000` into `"84260000"` and looks like it
 * fixed something. What it actually does is launder a value that `JSON.parse`
 * already rounded. `JSON.parse('{"figure_paise":900719925474099300}')` yields
 * `900719925474099300`, a double one unit away from the digits that were sent, and
 * coercion would hand that on as a confident-looking string. Rejecting means a
 * serialization mistake fails at the boundary with a schema violation naming the
 * field, instead of silently changing a figure a User will later read as fact.
 *
 * {@link assertNoCoercion} makes that a checked fact rather than a convention, and
 * `test/transport/field-typing-audit.test.ts` runs it over every registered schema.
 *
 * ## Range is deliberately not checked here
 *
 * The schema checks the *shape* — optional minus sign, then digits. It does not
 * check `-99999999999999 .. 99999999999999`, because the range guard lives in
 * `@/calc/paise` and is applied by `fromWire` when the string becomes a `Paise`.
 * Keeping them apart is what lets the transport suite assert the format guard and
 * the range guard as separate facts, and it is what lets the range-free
 * `encodePaise` / `decodePaise` pair carry the above-2^53 magnitudes P15 needs
 * without a second schema.
 */

import { z } from 'zod';

/**
 * The only accepted wire shape for money: optional minus sign, then digits.
 *
 * Character-for-character the pattern in `./paise-wire.ts` and in
 * `financeos/wire/paise.py`. Three copies of one regex is two too many, but the
 * three runtimes cannot share a literal, so the transport audit asserts they agree
 * instead.
 */
export const PAISE_WIRE_PATTERN = /^-?[0-9]+$/;

/**
 * A monetary field on the wire. Not coerced, not defaulted, not transformed.
 *
 * Zod schemas are immutable, so one shared instance is safe and gives the audit a
 * single identity to look for.
 */
export const paiseWire = z.string().regex(PAISE_WIRE_PATTERN);

/**
 * A monetary field that may be absent as a value rather than as a key:
 * `EvidenceStep.result_paise` is `null` for a `compare` or a non-monetary
 * `select`, and `ValidationResult.parsed_paise` is `null` for a token that could
 * not be normalised at all.
 *
 * `null`, not `undefined`, and not an omitted key: a step with no monetary result
 * is a fact the wire states, and JSON has a spelling for it.
 */
export const nullablePaiseWire = paiseWire.nullable();

/** A list of monetary fields — the shape `allowed_values_paise` arrives in. */
export function paiseWireArray(options?: { readonly max?: number }): z.ZodArray<typeof paiseWire> {
  const array = z.array(paiseWire);
  return options?.max === undefined ? array : array.max(options.max);
}

/** The decoded form of {@link paiseWire}: a decimal string, still unparsed. */
export type PaiseWireField = z.infer<typeof paiseWire>;

/**
 * Thrown by {@link assertNoCoercion} when a transport schema declares a coercing
 * string. Its own class so the audit failure reads as a contract violation rather
 * than as a generic assertion.
 */
export class TransportSchemaError extends Error {
  override readonly name = 'TransportSchemaError';
}

/**
 * Refuse a `z.coerce.string()` anywhere a `_paise` field is declared.
 *
 * Zod 4 records coercion as `coerce === true` on the string schema's definition
 * record, so this is an introspection of the declaration rather than a probe of its
 * behaviour — a coercing schema is caught even when no payload has exercised it.
 *
 * The definition is read through `_zod.def` and narrowed structurally, exactly as
 * `@/tools/registry` reads it: Zod's `$ZodTypeDef` is a union that does not
 * discriminate usefully, and it declares no `coerce`, so the compiler rejects a
 * direct annotation. Narrowing from `unknown` is what makes the read type-safe
 * rather than asserted.
 */
export function assertNoCoercion(schema: z.ZodType, path: string): void {
  const rawDef = (schema as { readonly _zod?: { readonly def?: unknown } })._zod?.def;
  const def: { readonly coerce?: boolean } =
    typeof rawDef === 'object' && rawDef !== null ? rawDef : {};
  if (def.coerce === true) {
    throw new TransportSchemaError(
      `${path} is declared with coercion; a monetary field must reject a JSON number, ` +
        `not convert one (Requirement 15.1, 15.8)`,
    );
  }
}
