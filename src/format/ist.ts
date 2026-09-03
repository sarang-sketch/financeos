/**
 * Indian Standard Time rendering to whole-second precision (Requirement 3.10).
 *
 * **Fixed offset, not `Intl`.** IST is UTC+05:30 year-round with no daylight
 * saving, so the offset is a constant and integer arithmetic on the epoch is
 * exact. Two reasons to prefer it over
 * `Intl.DateTimeFormat` with `timeZone: 'Asia/Kolkata'`:
 *
 * 1. **It cannot silently degrade.** A Node build without full ICU resolves an
 *    unknown `timeZone` inconsistently across environments; a timestamp that
 *    renders correctly in CI and in the host's local zone in production is a
 *    failure nobody notices. `+05:30` is the same number everywhere.
 * 2. **The output shape is ours.** `Intl` emits locale-dependent separators and
 *    ordering, and pulling the pieces back out of `formatToParts` to rebuild a
 *    fixed shape is more code than the arithmetic it replaces.
 *
 * Whole-second precision means milliseconds never appear in the output. They are
 * dropped, not rounded: the rendered second is the second the instant fell in.
 *
 * Pure and synchronous. No module state.
 */

/** IST is UTC+05:30. No daylight saving, so this is a constant, not a lookup. */
export const IST_OFFSET_MINUTES = 330;

const IST_OFFSET_MS = IST_OFFSET_MINUTES * 60 * 1000;

/** Anything that names an instant. A `string` is parsed as a date-time. */
export type Instant = Date | string | number;

function toEpochMs(instant: Instant): number {
  const d = instant instanceof Date ? instant : new Date(instant);
  const ms = d.getTime();
  if (Number.isNaN(ms)) {
    throw new RangeError(`not a valid instant: ${JSON.stringify(String(instant))}`);
  }
  return ms;
}

/**
 * The IST calendar breakdown of an instant. Obtained by shifting the epoch by
 * the fixed offset and reading UTC fields off the shifted instant, which is what
 * makes the arithmetic exact.
 */
function istFields(instant: Instant): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  const shifted = new Date(toEpochMs(instant) + IST_OFFSET_MS);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return {
    year: pad(shifted.getUTCFullYear(), 4),
    month: pad(shifted.getUTCMonth() + 1),
    day: pad(shifted.getUTCDate()),
    hour: pad(shifted.getUTCHours()),
    minute: pad(shifted.getUTCMinutes()),
    second: pad(shifted.getUTCSeconds()),
    // milliseconds deliberately absent: whole-second precision (Requirement 3.10)
  };
}

/**
 * Render an instant as IST wall-clock time to whole-second precision, for
 * display: `2024-03-14 21:35:07 IST`.
 */
export function formatIst(instant: Instant): string {
  const f = istFields(instant);
  return `${f.year}-${f.month}-${f.day} ${f.hour}:${f.minute}:${f.second} IST`;
}

/**
 * The same instant and precision in offset-qualified ISO 8601:
 * `2024-03-14T21:35:07+05:30`. For a machine-readable attribute alongside the
 * human-readable {@link formatIst} text.
 */
export function formatIstIso(instant: Instant): string {
  const f = istFields(instant);
  return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}:${f.second}+05:30`;
}
