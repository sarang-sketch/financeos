/**
 * The **identity** half of `exception-fingerprint.ts`: what `exceptionFingerprint`
 * hashes, what it refuses to hash, and what it is deliberately blind to (task 11.5).
 *
 * `exceptionFingerprint` is a pure function — no clock, no database, no session — so
 * this file has no store, no `pg.ts` and no fixture. It is the whole of Requirement
 * 4.15's first half: *"a condition in the same Exception_Category referencing the same
 * set of Source_Record identifiers"* is one Exception, whatever the run computed for
 * its impact and whenever it ran.
 *
 * Three things here are pinned rather than merely exercised:
 *
 * 1. **The encoding.** design.md fixes the hashed string, so every assertion about it
 *    recomputes `createHash('sha256')` over the four segments **in this file** and
 *    compares. Asserting against a digest the module itself produced would pin
 *    nothing: it would pass after any encoding change, which is exactly the change
 *    that silently re-identifies every Exception ever written.
 * 2. **The sort key.** "Sorted" is not enough — the refs are sorted on **type then
 *    id**, and a pair whose `id`-then-`type` order differs is used so a plausible
 *    wrong sort fails here instead of quietly producing a second identity for one
 *    condition.
 * 3. **The range-scoped list is exhaustive.** The module doc comment argues, category
 *    by category, why each of the 14 `EXCEPTION_CATEGORIES` labels is or is not
 *    scoped by a reconciliation date range, and hands this file the job of asserting
 *    it. `RANGE_SCOPED_BY_LABEL` below is that argument transcribed as a
 *    `Record<ExceptionCategory, boolean>`: a 15th label added to the enum without a
 *    decision about its scoping is a **compile** error there and a failing assertion
 *    here, so the decision cannot be skipped.
 *
 * What this file does **not** cover, because it is already covered:
 *
 * - the upsert statement, the row mapping and the pre-statement rejections —
 *   `./exception-fingerprint.upsert.test.ts` (task 11.4);
 * - one row per identity over real Postgres, `first_detected_at` unchanged,
 *   `last_detected_at` advanced, a resolved Exception neither reopened nor touched —
 *   `test/db/exception-upsert.test.ts` (task 11.4).
 *
 * The one thing added to the resolved-Exception story is the *identity-level* fact
 * underneath both of those: the re-detection resolves to the **same fingerprint** as
 * the resolved row. That is what makes `WHERE exceptions.lifecycle_state = 'open'`
 * reachable at all — a different fingerprint would insert a second row and the guard
 * would never be consulted.
 *
 * Requirements: 4.15; 7.10 for the range-scoped categories.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  assertRefIdentifier,
  canonicalSourceRefs,
  EXCEPTION_CATEGORIES,
  type ExceptionCategory,
  ExceptionFingerprintError,
  exceptionFingerprint,
  type ExceptionScope,
  type ExceptionUpsertInput,
  exceptionScopeSegment,
  exceptionWriteFor,
  isRangeScopedCategory,
  RANGE_SCOPED_CATEGORIES,
  sourceRefsSegment,
} from '@/agents/exception-fingerprint';
import { PostingRuleError, type SourceRef } from '@/ledger/posting-rules';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

/** The module doc comment's worked example: the SET-9282 `settlement_mismatch`. */
const WORKED_REFS: readonly SourceRef[] = [
  { type: 'settlement', id: 'setl_SYNTHETIC9282' },
  { type: 'settlement_recon_report', id: 'setlrcn_SYNTHETIC9282' },
];

const JULY: ExceptionScope = { from: '2026-07-01', to: '2026-07-31' };

/**
 * design.md's hashed string, built here from its four segments and hashed here.
 *
 * Deliberately does not import a single helper from the module under test — not
 * `sourceRefsSegment`, not `exceptionScopeSegment`. A test that borrows the encoding
 * it is checking cannot detect an encoding change.
 */
function hashOf(tenantId: string, category: string, refs: string, scope: string): string {
  return createHash('sha256').update(`${tenantId}|${category}|${refs}|${scope}`, 'utf8').digest('hex');
}

/** `type:id` per ref, sorted on **type then id**, joined with `,` — restated, not imported. */
function refsSegment(refs: readonly SourceRef[]): string {
  return [...refs]
    .map((ref) => `${ref.type}:${ref.id}`)
    .sort()
    .join(',');
}

/** A fingerprint for `category`, with a scope exactly where the category takes one. */
function fingerprintOf(
  category: ExceptionCategory,
  refs: readonly SourceRef[] = WORKED_REFS,
  tenantId: string = TENANT,
): string {
  return exceptionFingerprint({
    tenant_id: tenantId,
    category,
    source_refs: refs,
    ...(isRangeScopedCategory(category) ? { scope: JULY } : {}),
  });
}

/**
 * The ₹19,000-fee SET-9282 condition, in the shape `exceptionWriteFor` takes, so the
 * fields that are **outside** the identity can be varied one at a time. The same
 * condition `test/db/exception-upsert.test.ts` re-detects across two runs.
 */
const CONDITION: ExceptionUpsertInput = {
  category: 'settlement_mismatch',
  source_refs: [
    { type: 'settlement_recon_report', id: 'setlrcn_SYNTHETIC9282', role: 'recon_report' },
    { type: 'settlement', id: 'setl_SYNTHETIC9282', role: 'settlement' },
  ],
  impact_paise: 66100n,
  direction: 'shortfall',
  detail: { failing_rule: 'residual_nonzero', residual_paise: '66100', payments_counted: 3 },
  evidence_chain_id: '55555555-5555-4555-8555-555555555555',
  detected_at: '2026-07-28T10:00:00.000Z',
};

const fingerprintFor = (input: ExceptionUpsertInput): string =>
  exceptionWriteFor(TENANT, input).fingerprint;

/* -------------------------------------------------------------------------- */

describe('the hashed string, exactly as design.md fixes it', () => {
  it('is sha256 over `tenant|category|refs|scope`, recomputed here from the segments', () => {
    // The module doc comment's worked value. Every segment is written out below rather
    // than derived from the module, so an "improvement" to the encoding fails here.
    const expected = hashOf(
      TENANT,
      'settlement_mismatch',
      'settlement:setl_SYNTHETIC9282,settlement_recon_report:setlrcn_SYNTHETIC9282',
      '',
    );
    expect(exceptionFingerprint({ tenant_id: TENANT, category: 'settlement_mismatch', source_refs: WORKED_REFS })).toBe(
      expected,
    );
  });

  it('is 64 lowercase hex characters', () => {
    // The width `exceptions.fingerprint` is declared at, and the form every copy of a
    // fingerprint in an audit payload or a Proposal target will carry.
    expect(fingerprintOf('settlement_mismatch')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the fourth separator when the scope segment is empty', () => {
    // The trailing `|` is always present — the scope segment is empty, never absent —
    // so the string has four segments for every category and a reader can count the
    // separators. Dropping it would be invisible to any test that only compares two
    // fingerprints to each other.
    const refs = refsSegment(WORKED_REFS);
    const fourSegments = hashOf(TENANT, 'settlement_mismatch', refs, '');
    const threeSegments = createHash('sha256')
      .update(`${TENANT}|settlement_mismatch|${refs}`, 'utf8')
      .digest('hex');

    expect(fingerprintOf('settlement_mismatch')).toBe(fourSegments);
    expect(fourSegments).not.toBe(threeSegments);
  });

  it('renders a range-scoped scope as `from..to` in the fourth segment', () => {
    const refs: readonly SourceRef[] = [{ type: 'linked_account', id: 'acc_SYNTHETIC01' }];
    expect(
      exceptionFingerprint({
        tenant_id: TENANT,
        category: 'seller_settlement_mismatch',
        source_refs: refs,
        scope: JULY,
      }),
    ).toBe(hashOf(TENANT, 'seller_settlement_mismatch', 'linked_account:acc_SYNTHETIC01', '2026-07-01..2026-07-31'));
  });
});

describe('the identity is the SET of Source_Record refs, not the list', () => {
  /** Four refs whose canonical order is none of the orders they are passed in. */
  const FOUR: readonly SourceRef[] = [
    { type: 'settlement', id: 'setl_SYNTHETIC9282' },
    { type: 'settlement_recon_report', id: 'setlrcn_SYNTHETIC9282' },
    { type: 'payment', id: 'pay_SYNTHETIC01' },
    { type: 'payment', id: 'pay_SYNTHETIC02' },
  ];

  it('is unchanged by every permutation of a multi-ref set', () => {
    const permutations: readonly (readonly SourceRef[])[] = [
      FOUR,
      [...FOUR].reverse(),
      // Rotations and interleavings, so the invariance is not just "a swap of two".
      [FOUR[3], FOUR[0], FOUR[2], FOUR[1]] as readonly SourceRef[],
      [FOUR[2], FOUR[3], FOUR[0], FOUR[1]] as readonly SourceRef[],
      [FOUR[1], FOUR[3], FOUR[2], FOUR[0]] as readonly SourceRef[],
    ];
    const digests = new Set(
      permutations.map((refs) =>
        exceptionFingerprint({ tenant_id: TENANT, category: 'ambiguous_match', source_refs: refs }),
      ),
    );
    // One identity, five argument orders. This is what makes P5's shuffled second run
    // land on the first run's rows.
    expect(digests.size).toBe(1);
  });

  it('is unchanged for refs that differ only in type, or only in id', () => {
    const onlyType: readonly SourceRef[] = [
      { type: 'refund', id: 'shared_SYNTHETIC01' },
      { type: 'payment', id: 'shared_SYNTHETIC01' },
    ];
    const onlyId: readonly SourceRef[] = [
      { type: 'payment', id: 'pay_SYNTHETIC02' },
      { type: 'payment', id: 'pay_SYNTHETIC01' },
    ];
    for (const refs of [onlyType, onlyId]) {
      const forward = exceptionFingerprint({
        tenant_id: TENANT,
        category: 'possible_duplicate_refund',
        source_refs: refs,
      });
      const backward = exceptionFingerprint({
        tenant_id: TENANT,
        category: 'possible_duplicate_refund',
        source_refs: [...refs].reverse(),
      });
      expect(forward).toBe(backward);
    }
  });

  it('sorts on type then id, not on id then type', () => {
    // The pair that separates the two: by type, `payment` precedes `refund`; by id,
    // `a_SYNTHETIC` precedes `b_SYNTHETIC`. The two sorts disagree, so "sorted somehow"
    // is not enough to pass.
    const refs: readonly SourceRef[] = [
      { type: 'refund', id: 'a_SYNTHETIC' },
      { type: 'payment', id: 'b_SYNTHETIC' },
    ];
    const typeThenId = 'payment:b_SYNTHETIC,refund:a_SYNTHETIC';
    const idThenType = 'refund:a_SYNTHETIC,payment:b_SYNTHETIC';

    expect(
      exceptionFingerprint({ tenant_id: TENANT, category: 'ambiguous_match', source_refs: refs }),
    ).toBe(hashOf(TENANT, 'ambiguous_match', typeThenId, ''));
    expect(hashOf(TENANT, 'ambiguous_match', idThenType, '')).not.toBe(
      hashOf(TENANT, 'ambiguous_match', typeThenId, ''),
    );
    // And the segment helper agrees with the digest, so the sort is one rule.
    expect(sourceRefsSegment(refs)).toBe(typeThenId);
  });

  it('collapses a record cited twice, because a repeat describes one link', () => {
    // `exception_source_records` admits one row per (exception, type, id), so citing a
    // record twice has described one link. Requirement 4.15 says "the same set".
    const once: readonly SourceRef[] = WORKED_REFS;
    const twice: readonly SourceRef[] = [WORKED_REFS[0], WORKED_REFS[1], WORKED_REFS[0]] as readonly SourceRef[];

    expect(
      exceptionFingerprint({ tenant_id: TENANT, category: 'settlement_mismatch', source_refs: twice }),
    ).toBe(
      exceptionFingerprint({ tenant_id: TENANT, category: 'settlement_mismatch', source_refs: once }),
    );
    expect(canonicalSourceRefs(twice)).toHaveLength(2);
  });

  it('rejects an Exception that cites no Source_Record at all (Requirement 4.12)', () => {
    // Without this, every Exception of one category for one Tenant would share one
    // fingerprint and collapse onto a single row.
    expect(() =>
      exceptionFingerprint({ tenant_id: TENANT, category: 'settlement_mismatch', source_refs: [] }),
    ).toThrow(ExceptionFingerprintError);
  });
});

describe('what is outside the identity (Requirement 4.15)', () => {
  const baseline = fingerprintFor(CONDITION);

  it('ignores the impact, however far the re-run moved it', () => {
    expect(fingerprintFor({ ...CONDITION, impact_paise: 77200n })).toBe(baseline);
    // Including the boundary: a zero impact is the same condition, differently valued.
    expect(fingerprintFor({ ...CONDITION, impact_paise: 0n, direction: 'not_applicable' })).toBe(baseline);
  });

  it('ignores the direction', () => {
    expect(fingerprintFor({ ...CONDITION, direction: 'excess' })).toBe(baseline);
    expect(fingerprintFor({ ...CONDITION, direction: 'not_applicable' })).toBe(baseline);
  });

  it('ignores detail entirely, including a rewritten failing rule', () => {
    expect(fingerprintFor({ ...CONDITION, detail: {} })).toBe(baseline);
    expect(
      fingerprintFor({
        ...CONDITION,
        detail: { failing_rule: 'residual_nonzero_v2', residual_paise: '-77200', payments_counted: 9 },
      }),
    ).toBe(baseline);
  });

  it('ignores the Evidence_Chain, present or absent', () => {
    expect(fingerprintFor({ ...CONDITION, evidence_chain_id: null })).toBe(baseline);
    expect(
      fingerprintFor({ ...CONDITION, evidence_chain_id: '99999999-9999-4999-8999-999999999999' }),
    ).toBe(baseline);
  });

  it('ignores every timestamp, which is the whole point of the fingerprint', () => {
    // `detected_at` is the run timestamp. If it entered the identity, each run would
    // open a fresh Exception for an unchanged condition — the duplicate Requirement
    // 4.15 exists to prevent.
    expect(fingerprintFor({ ...CONDITION, detected_at: '2026-07-29T04:30:00.000Z' })).toBe(baseline);
    expect(fingerprintFor({ ...CONDITION, detected_at: '2027-01-01T00:00:00.000Z' })).toBe(baseline);
  });

  it('ignores the role a record is cited under, and the contributing records', () => {
    // A relabelled link is the same link, and `context_refs` are linked but never
    // hashed (gap 4 in the module doc comment).
    expect(
      fingerprintFor({
        ...CONDITION,
        source_refs: CONDITION.source_refs.map((ref) => ({ ...ref, role: 'relabelled' })),
      }),
    ).toBe(baseline);
  });
});

describe('what is inside the identity', () => {
  it('separates two Tenants holding the identical condition', () => {
    // Belt-and-braces for the row (the unique key is per Tenant), load-bearing for the
    // value: a fingerprint travels into audit payloads unqualified by a Tenant, so two
    // Tenants must never share one.
    expect(fingerprintOf('settlement_mismatch', WORKED_REFS, OTHER_TENANT)).not.toBe(
      fingerprintOf('settlement_mismatch', WORKED_REFS, TENANT),
    );
  });

  it('gives all 14 categories distinct identities for one ref set', () => {
    const digests = new Set(EXCEPTION_CATEGORIES.map((category) => fingerprintOf(category)));
    // A `gst_anomaly` and a `settlement_mismatch` on the same Invoice are two
    // conditions, and they must not update each other's row.
    expect(digests.size).toBe(EXCEPTION_CATEGORIES.length);
  });

  it('changes when any ref changes', () => {
    const changedId: readonly SourceRef[] = [
      { type: 'settlement', id: 'setl_SYNTHETIC9281' },
      WORKED_REFS[1],
    ] as readonly SourceRef[];
    const extra: readonly SourceRef[] = [...WORKED_REFS, { type: 'payment', id: 'pay_SYNTHETIC01' }];

    expect(fingerprintOf('settlement_mismatch', changedId)).not.toBe(fingerprintOf('settlement_mismatch'));
    expect(fingerprintOf('settlement_mismatch', extra)).not.toBe(fingerprintOf('settlement_mismatch'));
  });

  it('rejects a Tenant identifier that is not a UUID', () => {
    expect(() =>
      exceptionFingerprint({ tenant_id: 'tenant-1', category: 'settlement_mismatch', source_refs: WORKED_REFS }),
    ).toThrow(ExceptionFingerprintError);
  });

  it('rejects a category outside the enum', () => {
    expect(() =>
      exceptionFingerprint({
        tenant_id: TENANT,
        category: 'settlement_mismatched' as ExceptionCategory,
        source_refs: WORKED_REFS,
      }),
    ).toThrow(ExceptionFingerprintError);
  });
});

/* -------------------------------------------------------------------------- */
/* Scope: only for the range-scoped categories                                */
/* -------------------------------------------------------------------------- */

/**
 * The module doc comment's per-category argument, transcribed as data.
 *
 * `Record<ExceptionCategory, boolean>` is the point: a 15th `exception_category`
 * label cannot be added to the enum without a line here, so "is this one scoped by a
 * reconciliation date range?" is a question the compiler asks. The assertions below
 * then check this table against `RANGE_SCOPED_CATEGORIES` **and** against the module's
 * behaviour, so a table that drifts from the code fails too.
 */
const RANGE_SCOPED_BY_LABEL: Record<ExceptionCategory, boolean> = {
  // Reconciliation (Requirement 4): the cited records are the condition.
  settlement_mismatch: false,
  possible_duplicate_refund: false,
  unmatched_credit_note: false,
  missing_accrual: false,
  ambiguous_match: false,
  // Compliance (Requirement 6): keyed on the record the finding was found on.
  gst_anomaly: false,
  missing_gst_information: false,
  invalid_gstin: false,
  itc_discrepancy: false,
  record_needing_review: false,
  // Marketplace (Requirement 7.10): the reconciliation date range is part of the
  // identity, because the same Linked_Account or Payment ref repeats across ranges.
  seller_settlement_mismatch: true,
  over_allocated_split: true,
  // Action pipeline (Requirement 5.12): a Proposal is verified and executed once.
  verification_failure: false,
  execution_failure: false,
};

describe('the range-scoped category list is exhaustive and agrees with the code', () => {
  it('accounts for every one of the 14 exception_category labels', () => {
    // The claim the module doc comment makes and delegates here: no label is left
    // undecided. Adding a label to the enum breaks the Record type above at compile
    // time; renaming or dropping one breaks this assertion.
    expect(Object.keys(RANGE_SCOPED_BY_LABEL).sort()).toEqual([...EXCEPTION_CATEGORIES].sort());
    expect(EXCEPTION_CATEGORIES).toHaveLength(14);
  });

  it('lists exactly the labels the table marks range-scoped', () => {
    const declared = Object.entries(RANGE_SCOPED_BY_LABEL)
      .filter(([, scoped]) => scoped)
      .map(([label]) => label)
      .sort();
    expect(declared).toEqual([...RANGE_SCOPED_CATEGORIES].sort());
    // And the predicate every caller uses agrees, label by label.
    for (const category of EXCEPTION_CATEGORIES) {
      expect(isRangeScopedCategory(category)).toBe(RANGE_SCOPED_BY_LABEL[category]);
    }
  });

  it('emits a scope segment for exactly those labels', () => {
    for (const category of EXCEPTION_CATEGORIES) {
      if (RANGE_SCOPED_BY_LABEL[category]) {
        expect(exceptionScopeSegment(category, JULY)).toBe('2026-07-01..2026-07-31');
      } else {
        expect(exceptionScopeSegment(category, undefined)).toBe('');
      }
    }
  });
});

describe('scope enters the fingerprint only for the range-scoped categories', () => {
  const SELLER_REFS: readonly SourceRef[] = [{ type: 'linked_account', id: 'acc_SYNTHETIC01' }];

  const scoped = (category: ExceptionCategory, scope: ExceptionScope): string =>
    exceptionFingerprint({ tenant_id: TENANT, category, source_refs: SELLER_REFS, scope });

  for (const category of RANGE_SCOPED_CATEGORIES) {
    describe(category, () => {
      it('requires a scope, because two ranges would otherwise collapse onto one Exception', () => {
        expect(() =>
          exceptionFingerprint({ tenant_id: TENANT, category, source_refs: SELLER_REFS }),
        ).toThrow(ExceptionFingerprintError);
        expect(() =>
          exceptionFingerprint({ tenant_id: TENANT, category, source_refs: SELLER_REFS }),
        ).toThrow(/scope is required/);
      });

      it('gives one fingerprint for two equal ranges', () => {
        // Two distinct objects, the same period. The identity is the dates, not the
        // object, so a re-run that rebuilt its range from scratch updates in place.
        expect(scoped(category, { from: '2026-07-01', to: '2026-07-31' })).toBe(
          scoped(category, { from: '2026-07-01', to: '2026-07-31' }),
        );
      });

      it('gives a different fingerprint for a one-day shift at either end', () => {
        const july = scoped(category, JULY);
        const laterStart = scoped(category, { from: '2026-07-02', to: '2026-07-31' });
        const laterEnd = scoped(category, { from: '2026-07-01', to: '2026-08-01' });
        // The same Linked_Account short in July and short again in August is two
        // conditions (Requirement 7.10); the refs alone cannot tell them apart.
        expect(laterStart).not.toBe(july);
        expect(laterEnd).not.toBe(july);
        expect(laterStart).not.toBe(laterEnd);
      });

      it('accepts a single-day range and rejects an inverted one', () => {
        expect(scoped(category, { from: '2026-07-01', to: '2026-07-01' })).toMatch(/^[0-9a-f]{64}$/);
        // An inverted range describes the same period as its reverse, so hashing the two
        // differently would open two Exceptions for one condition.
        expect(() => scoped(category, { from: '2026-07-31', to: '2026-07-01' })).toThrow(
          ExceptionFingerprintError,
        );
        expect(() => scoped(category, { from: '2026-07-31', to: '2026-07-01' })).toThrow(
          /inverted range/,
        );
      });
    });
  }

  it('rejects a scope on every other category rather than ignoring it', () => {
    // Ignoring it would let a caller believe it had scoped an identity when it had not.
    const others = EXCEPTION_CATEGORIES.filter((category) => !isRangeScopedCategory(category));
    expect(others).toHaveLength(12);
    for (const category of others) {
      expect(() => scoped(category, JULY)).toThrow(ExceptionFingerprintError);
      expect(() => scoped(category, JULY)).toThrow(/rejected rather than ignored/);
    }
  });

  /**
   * FINDING (task 11.5) — `exceptionScopeSegment`'s doc comment promises
   * `ExceptionFingerprintError` "when the range is malformed", but a malformed end is
   * checked by `assertDateOnly`, which throws `PostingRuleError` (a `RangeError`) from
   * `src/ledger/posting-rules.ts`. The rejection is correct and no wrong fingerprint is
   * produced, so nothing is patched from a test task — but a caller catching
   * `ExceptionFingerprintError` around a fingerprint computation, which is what the doc
   * comment invites, would let this one escape. Task 13.2 is the first such caller.
   *
   * The assertion below is the behaviour the doc comment states, and it genuinely
   * fails. When the wrap lands it will start passing, `it.fails` will report that as an
   * error, and this block and its companion come out together.
   */
  it.fails('reports an impossible calendar date as an ExceptionFingerprintError', () => {
    expect(() => scoped('seller_settlement_mismatch', { from: '2026-02-30', to: '2026-03-01' })).toThrow(
      ExceptionFingerprintError,
    );
  });

  it('currently reports it as a PostingRuleError instead (task 11.5 finding)', () => {
    // Pins the CAUSE of the `it.fails` above, so the finding is machine-checked rather
    // than only described. DELETE ME with it.
    const attempt = (): string =>
      scoped('seller_settlement_mismatch', { from: '2026-02-30', to: '2026-03-01' });
    expect(attempt).toThrow(PostingRuleError);
    expect(attempt).toThrow(/not a real calendar date/);
    // The rejection is real either way: 2026-02-30 is never hashed as an identity.
    expect(attempt).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* The injection barrier                                                      */
/* -------------------------------------------------------------------------- */

describe('the separator injection barrier', () => {
  const REJECTED: readonly (readonly [string, string])[] = [
    ['a segment separator', 'setl_A|setl_B'],
    ['a ref separator', 'setl_A,setl_B'],
    ['a type separator', 'settlement:setl_A'],
    ['a NUL, the joiner chain-builder keys on', 'setl_A\u0000setl_B'],
    ['a unit separator', 'setl_A\u001fsetl_B'],
    ['an interior newline', 'setl_A\nsetl_B'],
    ['a DEL', 'setl_A\u007f'],
    ['leading whitespace', ' setl_A'],
    ['trailing whitespace', 'setl_A '],
    ['nothing at all', ''],
  ];

  for (const [what, id] of REJECTED) {
    it(`rejects an identifier carrying ${what}`, () => {
      expect(() => assertRefIdentifier(id, 'source_refs[0].id')).toThrow(ExceptionFingerprintError);
      // And through the front door, so the barrier cannot be bypassed by the caller
      // every agent actually uses.
      expect(() =>
        exceptionFingerprint({
          tenant_id: TENANT,
          category: 'settlement_mismatch',
          source_refs: [{ type: 'settlement', id }],
        }),
      ).toThrow(ExceptionFingerprintError);
    });
  }

  it('is what stops two different ref sets hashing to one string', () => {
    // The reason the barrier matters, stated as an assertion rather than a comment.
    const injected: readonly SourceRef[] = [{ type: 'settlement', id: 'setl_A,settlement:setl_B' }];
    const genuine: readonly SourceRef[] = [
      { type: 'settlement', id: 'setl_A' },
      { type: 'settlement', id: 'setl_B' },
    ];
    // Under the encoding alone — no barrier — these two are indistinguishable, and the
    // two Exceptions would merge onto one row.
    expect(refsSegment(injected)).toBe(refsSegment(genuine));

    // With the barrier, the ambiguous input is unrepresentable and the honest one hashes.
    expect(() =>
      exceptionFingerprint({ tenant_id: TENANT, category: 'settlement_mismatch', source_refs: injected }),
    ).toThrow(/could hash identically/);
    expect(
      exceptionFingerprint({ tenant_id: TENANT, category: 'settlement_mismatch', source_refs: genuine }),
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the identifier shapes Razorpay actually issues', () => {
    // The barrier must reject ambiguity without rejecting real data: ASCII
    // alphanumerics and underscores, which is every Razorpay identifier.
    for (const id of ['setl_SYNTHETIC9282', 'pay_QrS3tUv5WxYz01', 'acc_01', 'A9']) {
      expect(assertRefIdentifier(id, 'source_refs[0].id')).toBe(id);
    }
  });

  it('rejects a type that is not a source_record_type label', () => {
    // `type` needs no separator defence — no enum label contains one — but it is still
    // checked, so a typo cannot become half of an identity.
    expect(() =>
      exceptionFingerprint({
        tenant_id: TENANT,
        category: 'settlement_mismatch',
        source_refs: [{ type: 'settlements' as SourceRef['type'], id: 'setl_A' }],
      }),
    ).toThrow(ExceptionFingerprintError);
  });
});

/* -------------------------------------------------------------------------- */
/* Stability, and the identity a resolved Exception is re-detected under      */
/* -------------------------------------------------------------------------- */

describe('stability', () => {
  it('gives the same digest for the same input, twice in one process', () => {
    // Cheap, and it is the property every other assertion here rests on.
    expect(fingerprintOf('settlement_mismatch')).toBe(fingerprintOf('settlement_mismatch'));
  });

  it('gives the same digest after unrelated calls, including ones that threw', () => {
    const before = fingerprintOf('seller_settlement_mismatch', [
      { type: 'linked_account', id: 'acc_SYNTHETIC01' },
    ]);
    fingerprintOf('gst_anomaly', [{ type: 'razorpay_invoice', id: 'inv_SYNTHETIC01' }]);
    expect(() =>
      exceptionFingerprint({ tenant_id: TENANT, category: 'settlement_mismatch', source_refs: [] }),
    ).toThrow();
    // No hash object, no accumulator and no cache is carried between calls.
    expect(
      fingerprintOf('seller_settlement_mismatch', [{ type: 'linked_account', id: 'acc_SYNTHETIC01' }]),
    ).toBe(before);
  });
});

describe('a re-detection of a resolved Exception resolves to the same identity', () => {
  it('so the open-only guard is the thing that declines it, not a second row', () => {
    // The behaviour — not reopened, not touched, reported — is proven by
    // `test/db/exception-upsert.test.ts` and `./exception-fingerprint.upsert.test.ts`.
    // What is asserted here is the identity underneath both: the run that re-detects a
    // resolved condition with a different impact, direction, detail, chain and
    // timestamp computes the SAME fingerprint, so it conflicts with the resolved row and
    // meets `WHERE exceptions.lifecycle_state = 'open'`. Were the fingerprint to differ
    // in any of those fields, the upsert would insert a second row and the guard would
    // never be consulted — the resolved Exception would be "reopened" as a duplicate.
    const reDetection: ExceptionUpsertInput = {
      ...CONDITION,
      impact_paise: 77200n,
      direction: 'excess',
      detail: { failing_rule: 'residual_nonzero', residual_paise: '-77200', payments_counted: 4 },
      evidence_chain_id: null,
      detected_at: '2026-07-29T04:30:00.000Z',
      // And the refs arrive in the other order, as a shuffled second run would send them.
      source_refs: [...CONDITION.source_refs].reverse(),
    };
    expect(fingerprintFor(reDetection)).toBe(fingerprintFor(CONDITION));
  });
});
