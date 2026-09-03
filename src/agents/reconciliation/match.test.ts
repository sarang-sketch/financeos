/**
 * Unit tests for `match.ts` (task 13.1).
 *
 * SCOPE. Property P5 is **task 13.3** and the `ambiguous_match` Exception is **task
 * 13.5**; neither is written here, and this file states no `numRuns` property. What it
 * covers is the classification table of Requirement 4.1 and 4.14 — the three outcomes
 * per record type, the Ledger_Entries arm that has no ambiguous state, the
 * canonicalisation that makes a result a function of the set, the total order, the
 * agreement with `get_unsettled_payments`' candidate count, the ref projections, the
 * store seam, and the source-level barrier against amount- or date-based inference.
 *
 * Nothing here computes a matched identifier to compare against a computed one: every
 * expectation is a literal.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { isUnsettled, type ScopedPayment } from '@/tools/get-unsettled-payments';

import {
  ambiguousCandidateRefs,
  ambiguousTypes,
  candidateCount,
  canonicalLinkIds,
  classifyLedgerEntries,
  classifyLink,
  createLifecycleMatcher,
  invoiceCandidateCount,
  isAmbiguousMatch,
  LIFECYCLE_RECORD_TYPES,
  type LifecycleLinkResult,
  type LifecycleLinkStore,
  LifecycleMatchError,
  lifecycleMatchOrderKey,
  matchedSourceRefs,
  matchLifecycle,
  matchPaymentLifecycle,
  NOT_MATCHED,
  notMatchedTypes,
  type PaymentLinks,
  settlementCandidateCount,
} from './match';

const TENANT = '11111111-1111-4111-8111-111111111111';

/** Links with every list empty, so each test states only the links it varies. */
function links(overrides: Partial<PaymentLinks> = {}): PaymentLinks {
  return {
    payment_id: 'pay_p1',
    order_ids: [],
    razorpay_invoice_ids: [],
    settlement_ids: [],
    ledger_entry_ids: [],
    ...overrides,
  };
}

function storeOf(result: LifecycleLinkResult): LifecycleLinkStore {
  return { readLinks: vi.fn(async () => result) };
}

/* -------------------------------------------------------------------------- */
/* Requirement 4.1: the marker, the match, and nothing in between             */
/* -------------------------------------------------------------------------- */

describe('classifyLink (Requirement 4.1, 4.14)', () => {
  it('reports the not-matched marker for a record type with no stored link', () => {
    expect(classifyLink([], 'settlement_ids')).toEqual({ kind: 'not_matched' });
    expect(classifyLink([], 'settlement_ids')).toBe(NOT_MATCHED);
  });

  it('reports the matched identifier when one stored link names one record', () => {
    expect(classifyLink(['setl_9281'], 'settlement_ids')).toEqual({
      kind: 'matched',
      id: 'setl_9281',
    });
  });

  it('reports ambiguity with every candidate when two or more records are named', () => {
    expect(classifyLink(['setl_9282', 'setl_9281'], 'settlement_ids')).toEqual({
      kind: 'ambiguous',
      candidate_ids: ['setl_9281', 'setl_9282'],
    });
  });

  it('collapses a repeated identifier to one match rather than an ambiguity', () => {
    // A join fan-out naming one Settlement twice describes one link. Reporting two
    // would manufacture a Requirement 4.14 Exception out of the query plan.
    expect(classifyLink(['setl_9281', 'setl_9281'], 'settlement_ids')).toEqual({
      kind: 'matched',
      id: 'setl_9281',
    });
  });

  it('rejects an identifier that could collide two Exception fingerprints', () => {
    // The barrier is `assertRefIdentifier`; a link identifier carrying a fingerprint
    // separator is rejected here rather than after task 13.5 has hashed it.
    expect(() => classifyLink(['setl_a,setl_b'], 'settlement_ids')).toThrow(LifecycleMatchError);
    expect(() => classifyLink([''], 'settlement_ids')).toThrow(LifecycleMatchError);
    expect(() => classifyLink([' setl_9281'], 'settlement_ids')).toThrow(LifecycleMatchError);
  });

  it('names the field and the position in the rejection', () => {
    expect(() => classifyLink(['ok_1', 'bad:id'], 'pay_p1.settlement_ids')).toThrow(
      /pay_p1\.settlement_ids\[1\]/,
    );
  });
});

describe('canonicalLinkIds', () => {
  it('is a function of the set: order in does not change order out', () => {
    const forwards = canonicalLinkIds(['a', 'b', 'c'], 'ids');
    const backwards = canonicalLinkIds(['c', 'b', 'a'], 'ids');
    expect(forwards).toEqual(['a', 'b', 'c']);
    expect(backwards).toEqual(forwards);
  });

  it('sorts ascending by identifier, the house tie-break', () => {
    expect(canonicalLinkIds(['setl_9282', 'setl_9280', 'setl_9281'], 'ids')).toEqual([
      'setl_9280',
      'setl_9281',
      'setl_9282',
    ]);
  });
});

describe('classifyLedgerEntries', () => {
  it('reports the not-matched marker when no Ledger_Entry references the Payment', () => {
    // Requirement 4.10's condition, represented rather than acted on: the Exception is
    // task 13.5's.
    expect(classifyLedgerEntries([], 'ledger_entry_ids')).toEqual({ kind: 'not_matched' });
  });

  it('reports many entries as matched, because a balanced set is the normal case', () => {
    expect(classifyLedgerEntries(['e2', 'e1'], 'ledger_entry_ids')).toEqual({
      kind: 'matched',
      entry_ids: ['e1', 'e2'],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* One Payment, four record types                                             */
/* -------------------------------------------------------------------------- */

describe('matchPaymentLifecycle', () => {
  it('maps all four record types from stored links only', () => {
    expect(
      matchPaymentLifecycle(
        links({
          payment_id: 'pay_SYNTHETIC92811',
          order_ids: ['order_SYNTHETIC92811'],
          razorpay_invoice_ids: ['inv_9281'],
          settlement_ids: ['setl_SYNTHETIC9281'],
          ledger_entry_ids: ['e_b', 'e_a'],
        }),
      ),
    ).toEqual({
      payment_id: 'pay_SYNTHETIC92811',
      order: { kind: 'matched', id: 'order_SYNTHETIC92811' },
      razorpay_invoice: { kind: 'matched', id: 'inv_9281' },
      settlement: { kind: 'matched', id: 'setl_SYNTHETIC9281' },
      ledger_entries: { kind: 'matched', entry_ids: ['e_a', 'e_b'] },
    });
  });

  it('carries a not-matched marker per record type with no linked record', () => {
    const match = matchPaymentLifecycle(links({ order_ids: ['order_p1'] }));
    expect(match.order).toEqual({ kind: 'matched', id: 'order_p1' });
    expect(match.razorpay_invoice).toEqual({ kind: 'not_matched' });
    expect(match.settlement).toEqual({ kind: 'not_matched' });
    expect(match.ledger_entries).toEqual({ kind: 'not_matched' });
    expect(notMatchedTypes(match)).toEqual(['razorpay_invoice', 'settlement', 'ledger_entries']);
  });

  it('accounts for every one of the four record types', () => {
    const match = matchPaymentLifecycle(links());
    expect([...notMatchedTypes(match)]).toEqual([...LIFECYCLE_RECORD_TYPES]);
  });

  it('rejects a malformed Payment identifier', () => {
    expect(() => matchPaymentLifecycle(links({ payment_id: '' }))).toThrow(LifecycleMatchError);
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism (Requirement 4.15, what property P5 observes)                  */
/* -------------------------------------------------------------------------- */

describe('matchLifecycle determinism', () => {
  const dataset: readonly PaymentLinks[] = [
    links({ payment_id: 'pay_c', settlement_ids: ['setl_2'] }),
    links({ payment_id: 'pay_a', settlement_ids: ['setl_1', 'setl_2'] }),
    links({ payment_id: 'pay_b' }),
  ];

  it('orders results by ascending Payment identifier', () => {
    expect(matchLifecycle(dataset).map(lifecycleMatchOrderKey)).toEqual([
      'pay_a',
      'pay_b',
      'pay_c',
    ]);
  });

  it('reproduces the identical result in the identical order for a shuffled re-run', () => {
    const first = matchLifecycle(dataset);
    const second = matchLifecycle([...dataset].reverse());
    expect(second).toEqual(first);
  });

  it('rejects two entries for one Payment rather than merging their link sets', () => {
    expect(() =>
      matchLifecycle([
        links({ payment_id: 'pay_a', settlement_ids: ['setl_1'] }),
        links({ payment_id: 'pay_a', settlement_ids: ['setl_2'] }),
      ]),
    ).toThrow(/appears twice/);
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 4.14, and the agreement with get_unsettled_payments            */
/* -------------------------------------------------------------------------- */

describe('candidate counts and ambiguity (Requirement 4.11, 4.14)', () => {
  it('counts what the stored links name: 0, 1, or every candidate', () => {
    expect(candidateCount(NOT_MATCHED)).toBe(0);
    expect(candidateCount({ kind: 'matched', id: 'x' })).toBe(1);
    expect(candidateCount({ kind: 'ambiguous', candidate_ids: ['x', 'y', 'z'] })).toBe(3);
  });

  it('agrees with ScopedPayment.settlement_candidate_count for all three cases', () => {
    // The count is the one definition both this module and `get_unsettled_payments`
    // read. `isUnsettled` there is `count === 0` on a captured Payment.
    const cases: readonly [readonly string[], number, boolean][] = [
      [[], 0, true],
      [['setl_1'], 1, false],
      [['setl_1', 'setl_2'], 2, false],
    ];
    for (const [settlementIds, expectedCount, expectedUnsettled] of cases) {
      const match = matchPaymentLifecycle(links({ settlement_ids: settlementIds }));
      expect(settlementCandidateCount(match)).toBe(expectedCount);

      const scoped: ScopedPayment = {
        payment_id: match.payment_id,
        status_rzp: 'captured',
        created_on: '2026-04-01',
        amount_paise: 1n,
        record_updated_at: '2026-04-01T00:00:00.000Z',
        settlement_candidate_count: settlementCandidateCount(match),
      };
      expect(isUnsettled(scoped)).toBe(expectedUnsettled);
    }
  });

  it('classifies two or more Settlements or Invoices as ambiguous, and nothing else', () => {
    const twoSettlements = matchPaymentLifecycle(links({ settlement_ids: ['setl_1', 'setl_2'] }));
    const twoInvoices = matchPaymentLifecycle(
      links({ razorpay_invoice_ids: ['inv_1', 'inv_2'] }),
    );
    const twoOrders = matchPaymentLifecycle(links({ order_ids: ['order_1', 'order_2'] }));

    expect(isAmbiguousMatch(twoSettlements)).toBe(true);
    expect(isAmbiguousMatch(twoInvoices)).toBe(true);
    // Requirement 4.14 names Settlements and Razorpay_Invoices only (finding 3).
    expect(isAmbiguousMatch(twoOrders)).toBe(false);
    expect(ambiguousTypes(twoOrders)).toEqual(['order']);
    expect(invoiceCandidateCount(twoInvoices)).toBe(2);
  });

  it('keeps ambiguous distinguishable from not-matched', () => {
    const none = matchPaymentLifecycle(links());
    const two = matchPaymentLifecycle(links({ settlement_ids: ['setl_1', 'setl_2'] }));
    expect(none.settlement.kind).toBe('not_matched');
    expect(two.settlement.kind).toBe('ambiguous');
    expect(notMatchedTypes(two)).not.toContain('settlement');
  });
});

/* -------------------------------------------------------------------------- */
/* Ref projections for tasks 13.2 and 13.5                                    */
/* -------------------------------------------------------------------------- */

describe('source ref projections', () => {
  it('cites the Payment and each singly-matched Razorpay record, type then id', () => {
    const match = matchPaymentLifecycle(
      links({
        order_ids: ['order_1'],
        razorpay_invoice_ids: ['inv_1'],
        settlement_ids: ['setl_1'],
        ledger_entry_ids: ['e_1'],
      }),
    );
    expect(matchedSourceRefs(match)).toEqual([
      { type: 'order', id: 'order_1' },
      { type: 'payment', id: 'pay_p1' },
      { type: 'razorpay_invoice', id: 'inv_1' },
      { type: 'settlement', id: 'setl_1' },
    ]);
  });

  it('cites no candidate for an ambiguous type, because none of them is the match', () => {
    const match = matchPaymentLifecycle(
      links({ order_ids: ['order_1'], settlement_ids: ['setl_2', 'setl_1'] }),
    );
    expect(matchedSourceRefs(match)).toEqual([
      { type: 'order', id: 'order_1' },
      { type: 'payment', id: 'pay_p1' },
    ]);
    expect(ambiguousCandidateRefs(match)).toEqual([
      { type: 'payment', id: 'pay_p1' },
      { type: 'settlement', id: 'setl_1' },
      { type: 'settlement', id: 'setl_2' },
    ]);
  });

  it('offers no ambiguity refs when the match is not ambiguous by 4.14', () => {
    expect(ambiguousCandidateRefs(matchPaymentLifecycle(links()))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The read seam                                                              */
/* -------------------------------------------------------------------------- */

describe('createLifecycleMatcher', () => {
  it('passes the bound Tenant and the canonical in-scope set to the store', async () => {
    const store = storeOf({ payments: [links({ payment_id: 'pay_a' })] });
    const matcher = createLifecycleMatcher({ store, tenantId: TENANT });

    await matcher.match(['pay_b', 'pay_a', 'pay_a']);

    expect(store.readLinks).toHaveBeenCalledWith({
      tenant_id: TENANT,
      payment_ids: ['pay_a', 'pay_b'],
    });
  });

  it('separates a Payment with no links read from one with four not-matched markers', async () => {
    const store = storeOf({ payments: [links({ payment_id: 'pay_a' })] });
    const matcher = createLifecycleMatcher({ store, tenantId: TENANT });

    const result = await matcher.match(['pay_a', 'pay_b']);

    expect(result.matches.map((match) => match.payment_id)).toEqual(['pay_a']);
    expect(notMatchedTypes(result.matches[0]!)).toEqual([...LIFECYCLE_RECORD_TYPES]);
    expect(result.payments_not_read).toEqual(['pay_b']);
  });

  it('passes unreadable records through for task 13.2 to report', async () => {
    const store = storeOf({
      payments: [links({ payment_id: 'pay_a' })],
      unreadable: [{ type: 'settlement', id: 'setl_x' }],
    });
    const result = await createLifecycleMatcher({ store, tenantId: TENANT }).match(['pay_a']);
    expect(result.unreadable).toEqual([{ type: 'settlement', id: 'setl_x' }]);
  });

  it('rejects an answer about a Payment outside the requested scope', async () => {
    const store = storeOf({ payments: [links({ payment_id: 'pay_z' })] });
    await expect(
      createLifecycleMatcher({ store, tenantId: TENANT }).match(['pay_a']),
    ).rejects.toThrow(/not in the requested/);
  });

  it('refuses an empty in-scope set rather than reporting a mapping of nothing', async () => {
    const store = storeOf({ payments: [] });
    await expect(createLifecycleMatcher({ store, tenantId: TENANT }).match([])).rejects.toThrow(
      LifecycleMatchError,
    );
    expect(store.readLinks).not.toHaveBeenCalled();
  });

  it('requires the session Tenant as a UUID, never inferred', () => {
    expect(() =>
      createLifecycleMatcher({ store: storeOf({ payments: [] }), tenantId: 'tenant-1' }),
    ).toThrow(LifecycleMatchError);
  });
});

/* -------------------------------------------------------------------------- */
/* The barrier: no amount-based and no date-based inference exists here        */
/* -------------------------------------------------------------------------- */

describe('no amount-based or date-based inference (Requirement 4.1)', () => {
  /** `match.ts` with its comments and string literals removed, leaving only code. */
  function moduleCode(): string {
    const source = readFileSync(new URL('./match.ts', import.meta.url), 'utf8');
    return source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  }

  it('names no monetary and no temporal token anywhere in its code', () => {
    // The rule Requirement 4.1 exists to enforce, asserted structurally: a function
    // cannot infer from a figure or an instant it was never handed. Prose and error
    // messages are stripped first, so the doc comment may discuss what the code may
    // not do.
    const code = moduleCode();
    // The strip must leave the code behind, or the assertions below would be vacuous.
    expect(code).toMatch(/export function settlementCandidateCount/);
    expect(code).toMatch(/export function matchPaymentLifecycle/);
    const forbidden = [
      /\bamounts?\b/i,
      /\bpaise\b/i,
      /\bdates?\b/i,
      /\bDate\b/,
      /_at\b/,
      /\bfees?\b/i,
      /\bcurrency\b/i,
      /\bcreated\b/i,
      /\bsettled\b/i,
    ];
    for (const pattern of forbidden) {
      expect(code).not.toMatch(pattern);
    }
  });

  it('imports nothing from the Calculation Service', () => {
    // Read raw: an import specifier is a string literal, so the stripped code above
    // could not see one.
    const source = readFileSync(new URL('./match.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from '@\/calc/);
  });
});
