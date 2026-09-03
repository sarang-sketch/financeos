/**
 * The money wire contract, TypeScript side.
 *
 * Every monetary value crossing the TypeScript↔Python boundary is a JSON string
 * of the integer paise value — `"84260000"`, not `84260000`. `JSON.stringify`
 * throws on a `bigint`, and `JSON.parse` produces an IEEE-754 double for every
 * numeric literal, so the string is the only sanctioned path (Requirement 15.1,
 * 15.8). `toWire` is the only sanctioned way a `Paise` leaves this process.
 *
 * Nothing crosses the runtime boundary until Slice 4, but the module exists from
 * Slice 1 because the transport schemas and property P15 build on it, and
 * because the rule has to be in place before the first boundary is written.
 *
 * Rejection, not coercion: a malformed value fails loudly here rather than being
 * quietly turned into a confident-looking string.
 */

import { assertInRange, assertPaise, type Paise } from '@/calc/paise';

/** A monetary value in transit. Always the decimal digits of an integer paise value. */
export type PaiseWire = string;

/** The only accepted wire shape: optional minus sign, then digits. */
const INTEGER_STRING = /^-?[0-9]+$/;

/**
 * Thrown when a wire value is not an integer string. Distinct from
 * `PaiseRangeError` so a transport violation is never confused with a range
 * violation — the transport tests assert those as separate facts.
 */
export class WireError extends Error {
  override readonly name = 'WireError';

  /** The offending field, when the caller named one. */
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.field = field;
  }
}

function assertIntegerString(s: PaiseWire, field?: string): void {
  if (typeof s !== 'string' || !INTEGER_STRING.test(s)) {
    throw new WireError(
      `monetary field${field === undefined ? '' : ` ${field}`} is not an integer string: ${JSON.stringify(s)}`,
      field,
    );
  }
}

/** bigint -> wire. Range-checked. The only sanctioned way a Paise leaves the process. */
export function toWire(v: Paise): PaiseWire {
  assertInRange(v);
  return v.toString(); // exact, no float anywhere in the path
}

/** wire -> bigint. Throws a WireError on a non-integer string, then range-checks. */
export function fromWire(s: PaiseWire, field?: string): Paise {
  assertIntegerString(s, field);
  const v = BigInt(s); // exact for any digit length
  assertInRange(v); // -99999999999999 .. 99999999999999
  return v;
}

/**
 * Range-free encode. Same integer-string encoding as {@link toWire} with no
 * range check, because `assertInRange` rejects magnitudes above 2^53 by design
 * and P15 must still prove the encoding survives them: an unrounded `applyRate`
 * product reaches roughly 3 × 10^19.
 */
export function encodePaise(v: Paise): PaiseWire {
  assertPaise(v);
  return v.toString();
}

/** Range-free decode. The exact inverse of {@link encodePaise}. */
export function decodePaise(s: PaiseWire, field?: string): Paise {
  assertIntegerString(s, field);
  return BigInt(s);
}
