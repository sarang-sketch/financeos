/**
 * design.md's `Page<N>`, declared once (task 12.4).
 * Requirements 4.10, 4.11, 12.9.
 *
 * design.md's Financial_Tool catalogue names the type five times — `page: Page<100>`
 * on `get_unsettled_payments` and `get_missing_accruals`, `page: Page<50>` on
 * `list_exceptions_by_category`, `source_page: Page<500>` on
 * `get_exception_evidence`, and `page: Page<100>` on `AuditService.sourceHistory` —
 * and **never declares it**. That is the same gap it has for `ExaminedCounts` and
 * `DateRange`, which tasks 12.1 and 12.2 closed in `./settlement-scope.ts`. This
 * module closes it for the pages, and is reported as a finding rather than presented
 * as design.md's own words.
 *
 * ## Decision: a page is an offset and a size, both stated, neither defaulted
 *
 * > **`Page<N>` is `{ offset: number; limit: number }` with `offset >= 0` and
 * > `1 <= limit <= N`. `N` is the *maximum* page size, not the fixed one.**
 *
 * Four things decided it:
 *
 * 1. **`N` reads as a ceiling everywhere design.md uses it.** Requirement 12.2 says
 *    "pages of at most 500 identifiers per page" and Requirement 12.5 "pages of at
 *    most 100 identifiers per page". `Page<100>` is therefore "at most 100", and a
 *    caller asking for 25 is asking a legal question.
 * 2. **Offset, not a cursor.** A keyset cursor needs a cursor type, an encoding and a
 *    stability contract that design.md names nowhere, and the two tools that take a
 *    `Page<100>` here must also report `total` over the whole result set
 *    (Requirement 4.10, 4.11 report a list, and the task text asks for totals). A
 *    tool that already knows the whole ordered result set can slice it, and an
 *    offset over a **total** order is exactly as deterministic as a keyset walk.
 *    `@/evidence/chain-builder` pages *identifiers* by keyset, because there the
 *    ordered set lives in the database and the walk is unbounded; that difference is
 *    why the two are not the same mechanism.
 * 3. **Both fields are required.** Task 12.2 fixed the house stance on a bounded
 *    argument: `limit` is required and out-of-range is a `schema_violation` naming
 *    the argument, never a runtime clamp. A defaulted `offset` would be the same
 *    silent answering of a question the caller did not ask, one page along.
 * 4. **`offset` is bounded too** (see {@link MAX_PAGE_OFFSET}), because Requirement
 *    12.9 wants every argument bounded and an unbounded offset is a scan request.
 *
 * ## What an offset page does and does not promise
 *
 * Within one invocation the answer is a function of the in-scope set: the tool orders
 * the whole result set under a **total** order, reports `total` as its size, and
 * returns the `[offset, offset + limit)` window of it. So a page boundary never
 * depends on the order a store returned rows in.
 *
 * Across invocations it promises nothing, and cannot: rows ingested between two
 * requests shift the window. That is what the Evidence_Chain `as_of` is for
 * (Requirement 12.4's 15-minute re-invocation), and it is why `total` is reported
 * beside every page — a caller can tell "100 of 4,312" from "100 of 100" and knows
 * when the set moved under it.
 *
 * ## Money
 *
 * Nothing here touches money. `offset`, `limit` and `total` are counts, so they are
 * `number`, and none is named in a way the ESLint money rule reads as monetary.
 * {@link pageOf} is a pure slice: it copies row references and computes no figure.
 */

import { z } from 'zod';

/**
 * The phantom carrier for `N`.
 *
 * `Page<100>` and `Page<50>` have to be *different* types or the parameter is
 * decoration — a 500-identifier page could then be handed to a tool that admits 100.
 * TypeScript cannot express "an integer no greater than 100" as the type of a
 * `number`, so the ceiling travels as a phantom property that exists only in the type
 * system: it is optional, never written, and absent from every value at runtime.
 */
declare const PAGE_MAX_SIZE: unique symbol;

/**
 * design.md's `Page<N>`: a zero-based offset and a size of at most `MaxSize`.
 *
 * The bounds are enforced by {@link pageSchema} at parse time, before any connection
 * is opened. This interface carries the intent; the schema carries the check.
 */
export interface Page<MaxSize extends number> {
  /** How many ordered rows to skip. `0` is the first page. */
  readonly offset: number;
  /** How many rows to return. `1..MaxSize`, both inclusive. */
  readonly limit: number;
  /** Phantom. Never present at runtime; see {@link PAGE_MAX_SIZE}. */
  readonly [PAGE_MAX_SIZE]?: MaxSize;
}

/** design.md's `Page<100>`: the page size Requirement 4.10 and 4.11's lists use. */
export const MAX_PAGE_SIZE_100 = 100;

/**
 * The largest offset a request may state.
 *
 * A bound is required (Requirement 12.9), and the number has to come from somewhere,
 * so it is stated rather than implied: a million rows past the start of an anomaly
 * list is not a question an Agent or a User asks, and `total` is reported beside
 * every page precisely so a caller never has to walk blindly to find the end. An
 * offset beyond `total` is **not** an error — it returns zero rows and the true total
 * — so this ceiling refuses only a request that was never going to be answered.
 */
export const MAX_PAGE_OFFSET = 1_000_000;

/**
 * The Zod schema for a `Page<MaxSize>` argument.
 *
 * A strict object, so `page: { offset: 0, limit: 100, cursor: '...' }` is a
 * `schema_violation` naming `page.cursor` rather than a silently stripped key — the
 * registry audit in `./registry.ts` requires strictness at **every** object node, not
 * only the root.
 *
 * Out of range is a rejection, never a clamp: a caller that asked for 500 rows of a
 * 100-row page gets `page.limit` named, with no connection opened and the rejection
 * audited (Requirement 12.9). Clamping would answer a different question and then
 * report a `total` the caller could not interpret.
 *
 * @param maxSize design.md's `N`. A whole number `>= 1`.
 */
export function pageSchema(maxSize: number): z.ZodType<{ offset: number; limit: number }> {
  if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
    throw new RangeError(
      `a page size ceiling must be a whole number of at least 1, got ${String(maxSize)}`,
    );
  }
  return z.strictObject({
    offset: z.number().int().min(0).max(MAX_PAGE_OFFSET),
    limit: z.number().int().min(1).max(maxSize),
  });
}

/**
 * One page of an ordered result set, with the size of the **whole** set.
 *
 * `total` is deliberately not `rows.length`: a caller must be able to tell "100 of
 * 4,312" from "100 of 100", which is the whole point of reporting it.
 */
export interface PagedRows<Row> {
  readonly rows: readonly Row[];
  /** The size of the ordered result set, across every page. */
  readonly total: number;
}

/**
 * The `[offset, offset + limit)` window of an already-ordered result set.
 *
 * Pure and total. An offset at or past the end yields an empty window and the true
 * total, which is a legitimate answer rather than an error: the caller asked for a
 * page that exists in the numbering and holds nothing.
 *
 * `ordered` must already be in the tool's total order — this function does not sort,
 * because the order is the tool's decision and Requirement 4.15's determinism lives
 * there, not here.
 */
export function pageOf<Row>(ordered: readonly Row[], page: Page<number>): PagedRows<Row> {
  if (!Number.isSafeInteger(page.offset) || page.offset < 0) {
    throw new RangeError(`page.offset must be a non-negative whole number, got ${String(page.offset)}`);
  }
  if (!Number.isSafeInteger(page.limit) || page.limit < 1) {
    throw new RangeError(`page.limit must be a whole number of at least 1, got ${String(page.limit)}`);
  }
  return {
    rows: ordered.slice(page.offset, page.offset + page.limit),
    total: ordered.length,
  };
}
