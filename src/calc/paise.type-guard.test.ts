/**
 * The compile-time half of the money type discipline.
 *
 * Each `@ts-expect-error` below is a live guard, not a comment: if a `number`
 * ever becomes assignable where a `Paise` is required, the directive stops
 * suppressing anything and `tsc --noEmit` fails on the unused directive. So the
 * guard fails in both directions — it catches a widened type as loudly as a
 * broken one.
 */

import { describe, expect, it } from 'vitest';

import { assertInRange, isPaise, type Paise } from './paise';

/** A Paise sink. A `number` argument must not compile. */
function acceptsPaise(value: Paise): Paise {
  return value;
}

describe('money type discipline (compile-time)', () => {
  it('rejects a number where a Paise is required', () => {
    // @ts-expect-error a `number` is not assignable to `Paise` (bigint)
    const smuggled: Paise = acceptsPaise(84260000);

    // The type error above is the assertion. This confirms what got through at
    // runtime is exactly the hazard the compiler stopped: a `number`, not a Paise.
    expect(isPaise(smuggled)).toBe(false);
  });

  it('rejects a number at the range guard', () => {
    expect(() => {
      // @ts-expect-error `assertInRange` takes a `Paise`, never a `number`
      assertInRange(84260000);
    }).toThrow(TypeError);
  });

  it('accepts a bigint', () => {
    expect(acceptsPaise(84260000n)).toBe(84260000n);
  });
});
