/**
 * Indian_Number_Format rendering and parsing (Requirement 3.2, 3.3, 3.11, 15.2).
 *
 * Every function here works on `Paise` (`bigint`) and formats textually from
 * digits. There is no `Number(...)` on a monetary value, no `toFixed`, and no
 * `Intl.NumberFormat`: `Intl.NumberFormat` operates on `number` and would
 * reintroduce exactly the IEEE-754 hazard the money type discipline exists to
 * remove. Division is integer division on `bigint`, so a displayed value is
 * never a rounded approximation of a float (Requirement 15.2).
 *
 * `src/format` is outside the `MONEY_DIRS` ESLint scope, but the discipline is
 * the same: money is `Paise`, and `Paise` comes from `@/calc/paise`.
 *
 * Pure and synchronous. No module state.
 */

import { assertInRange, type Paise } from '@/calc/paise';

/** 1,00,000 rupees. The lakh band opens here (Requirement 3.3). */
const ONE_LAKH_RUPEES = 100_000n;

/** 1,00,00,000 rupees. The crore band opens here (Requirement 3.11). */
const ONE_CRORE_RUPEES = 10_000_000n;

/** Thrown when text is not a parseable Indian_Number_Format money string. */
export class InrParseError extends Error {
  override readonly name = 'InrParseError';
}

/** The shape after stripping sign, symbol and separators: digits, optional 1-2 decimals. */
const STRIPPED_BODY = /^[0-9]+(?:\.[0-9]{1,2})?$/;

/**
 * 2,2,3 grouping from the right: the last three digits form one group, and
 * every group before it is two digits (Requirement 3.2). A rupee value of three
 * digits or fewer is not grouped at all.
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) {
    return digits;
  }
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const pairs: string[] = [];
  for (let i = rest.length; i > 0; i -= 2) {
    pairs.unshift(rest.slice(Math.max(0, i - 2), i));
  }
  return `${pairs.join(',')},${last3}`;
}

/**
 * Render a paise value as INR in Indian_Number_Format: `₹` prefix, 2,2,3
 * grouping, always exactly 2 decimal places. The minus sign precedes the symbol,
 * so `-66100n` is `-₹661.00`.
 */
export function formatInr(p: Paise): string {
  assertInRange(p);

  const negative = p < 0n;
  const magnitude = negative ? -p : p;

  const rupees = magnitude / 100n; // integer division, exact
  const paise = magnitude % 100n;
  const paiseText = paise.toString().padStart(2, '0'); // always 2 decimal places

  return `${negative ? '-' : ''}₹${groupIndian(rupees.toString())}.${paiseText}`;
}

/**
 * The exact inverse of {@link formatInr}: `parseInr(formatInr(p)) === p` for
 * every paise value in the signed range (property P11).
 *
 * Tolerates an absent `₹`, absent comma separators, and a missing or short
 * decimal part, so `"1"`, `"₹1.0"` and `"₹1.00"` all parse to `100n`.
 */
export function parseInr(text: string): Paise {
  const t = text.trim();
  const negative = t.startsWith('-');
  const body = t.replace(/^-/, '').replace('₹', '').replace(/,/g, '').trim();

  if (!STRIPPED_BODY.test(body)) {
    throw new InrParseError(`not an INR money string: ${JSON.stringify(text)}`);
  }

  const dot = body.indexOf('.');
  const rupeePart = dot === -1 ? body : body.slice(0, dot);
  const paisePart = dot === -1 ? '00' : body.slice(dot + 1);

  // `.padEnd(2, '0')` handles a short decimal part ("1.5" -> 50 paise); the
  // `.slice(0, 2)` is belt-and-braces, the regex already bounds it to 2 digits.
  const magnitude =
    BigInt(rupeePart) * 100n + BigInt(paisePart.padEnd(2, '0').slice(0, 2));

  const value = negative ? -magnitude : magnitude;
  assertInRange(value);
  return value;
}

/**
 * `numerator * 100n / denominator` with half-up rounding on `bigint`, rendered
 * with the decimal point inserted textually. No float in the path.
 *
 * Negatives: rounding is applied to the magnitude, so a half rounds *away from
 * zero* (-0.005 -> "-0.01"), and the sign is re-applied to the text. That keeps
 * `|round(-x)| === |round(x)|`, which is what a magnitude-based display such as
 * {@link secondaryUnit} needs. `secondaryUnit` only ever passes a non-negative
 * numerator, so the negative branch exists for direct callers.
 */
export function twoDecimalsFromRatio(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) {
    throw new RangeError('twoDecimalsFromRatio: denominator is zero');
  }

  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const scaled = n * 100n; // two decimal places, exact
  let hundredths = scaled / d; // truncating integer division
  const remainder = scaled % d;
  if (remainder * 2n >= d) {
    hundredths += 1n; // half up on the magnitude
  }

  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  const sign = negative && hundredths !== 0n ? '-' : '';
  return `${sign}${whole}.${fraction}`;
}

/** The secondary lakh/crore display for a figure, or `none` when neither band applies. */
export interface SecondaryUnit {
  readonly unit: 'lakh' | 'crore' | 'none';
  readonly text: string | null;
}

/**
 * The secondary unit for a figure (Requirement 3.3, 3.11). Thresholds are on the
 * rupee value, not the paise value, and the two bands do not overlap: lakh when
 * `rupees >= 1,00,000` and `rupees < 1,00,00,000`, crore when
 * `rupees >= 1,00,00,000`, otherwise no secondary unit.
 */
export function secondaryUnit(p: Paise): SecondaryUnit {
  assertInRange(p);

  const magnitude = p < 0n ? -p : p;
  const rupees = magnitude / 100n;

  if (rupees >= ONE_CRORE_RUPEES) {
    return {
      unit: 'crore',
      text: `${twoDecimalsFromRatio(magnitude, ONE_CRORE_RUPEES * 100n)} Cr`,
    };
  }
  if (rupees >= ONE_LAKH_RUPEES) {
    return {
      unit: 'lakh',
      text: `${twoDecimalsFromRatio(magnitude, ONE_LAKH_RUPEES * 100n)} L`,
    };
  }
  return { unit: 'none', text: null };
}
