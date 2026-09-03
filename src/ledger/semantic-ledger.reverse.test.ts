/**
 * Task 24.1: `reverseSet`, against an injectable store.
 *
 * The fakes answer the question a database cannot: **which statements were
 * issued?** Requirement 2.4 wants the original retained unchanged, and the
 * strongest form of that is a store which exposes exactly one write method — so
 * "the original was not mutated" is provable by there being no statement that
 * could have mutated it, plus a deep-equality check on the persisted original
 * before and after. Task 24.2's property P14 covers the rows-on-disk half against
 * real Postgres.
 *
 * What is asserted here:
 *
 * 1. The reversal has the original's per-account amounts with `side` exchanged,
 *    the original's `entry_date`, mirrored 1-based line numbers, and
 *    `reverses_set_id` naming the original.
 * 2. The reversal set carries **no derivation identity**: `source_record_type`
 *    and `source_record_id` are `null`, so it cannot collide with the set it
 *    reverses on `ledger_set_derivation_uniq`.
 * 3. Its Source_Record links lead with `{ ledger_entry_set, <original> }` and
 *    then the original's own refs, de-duplicated, with every entry carrying every
 *    ref (Requirement 2.2).
 * 4. `created_by` is the actor `reverseSet` was called with, not the bound one.
 * 5. The original is byte-identical afterwards, and per account
 *    `netOf(original) + netOf(reversal) === 0n` — including a set posting several
 *    entries to one account on the same side and one posting to a single account
 *    on both sides.
 * 6. Reversing twice yields **two independent reversal sets**, both linked to the
 *    one original, which is still untouched.
 * 7. A reversal is itself reversible.
 * 8. A malformed Tenant, a malformed set identifier, an absent set, and a set
 *    belonging to another Tenant all raise and issue no write.
 * 9. A read-back that disagrees with its own header raises rather than posting a
 *    mirror of entries that are not there.
 * 10. A successful reversal appends no Audit_Event — nothing was refused.
 *
 * **Validates: Requirements 2.4, 5.17**
 */

import { describe, expect, it } from 'vitest';

import type { Paise } from '@/calc/calculation-service';
import type { Actor } from '@/config/configuration-service';
import { ACCOUNT, type SourceRef } from './posting-rules';
import {
  createSemanticLedger,
  type LedgerAuditEvent,
  type LedgerAuditSink,
  type LedgerSetWrite,
  type LedgerStore,
  type PersistedLedgerEntry,
  type PersistedLedgerSet,
  SemanticLedgerError,
} from './semantic-ledger';

const TENANT = '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const OTHER_TENANT = '11111111-2222-4333-8444-555555555555';
const ORIGINAL = '9c8b7a65-4321-4dcb-9876-0fedcba98765';
const DATE = '2026-02-14';

/** Bound at construction; must not become the reversal's `created_by`. */
const BOUND_ACTOR: Actor = { kind: 'agent', id: 'reconciliation_agent' };
/** The User who requested the correction (Requirement 2.4). */
const CORRECTING_ACTOR: Actor = { kind: 'user', id: 'usr_operator_1' };

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

interface ReverseStore extends LedgerStore {
  readonly writes: readonly LedgerSetWrite[];
  readonly lookups: readonly (readonly [string, string])[];
  /** New set identifiers handed out, in order. */
  readonly issued: readonly string[];
}

/**
 * A store holding persisted sets, scoped by Tenant.
 *
 * There is deliberately **no update or delete method**: the interface offers
 * `reverseSet` nothing that could touch the original, which is the structural half
 * of Requirement 2.4. `findSet` returns the stored object itself, so a
 * `reverseSet` that mutated what it read would show up in the snapshot comparison.
 */
function reverseStore(...sets: readonly PersistedLedgerSet[]): ReverseStore {
  const writes: LedgerSetWrite[] = [];
  const lookups: [string, string][] = [];
  const issued: string[] = [];
  let next = 0;
  return {
    writes,
    lookups,
    issued,
    insertSet(write) {
      writes.push(write);
      next += 1;
      const setId = `00000000-0000-4000-8000-00000000000${next}`;
      issued.push(setId);
      return Promise.resolve({ ok: true, set_id: setId });
    },
    findSet(tenantId, setId) {
      lookups.push([tenantId, setId]);
      // Tenant is part of the lookup, not a check applied afterwards: another
      // Tenant's set is indistinguishable from one that does not exist.
      const found = sets.find((s) => s.tenant_id === tenantId && s.id === setId);
      return Promise.resolve(found ?? null);
    },
    findSourceRecord() {
      return Promise.reject(new Error('findSourceRecord is not used by the reverseSet tests'));
    },
    trialBalanceTotals() {
      return Promise.reject(
        new Error('trialBalanceTotals is not used by the reverseSet tests'),
      );
    },
  };
}

interface RecordingSink extends LedgerAuditSink {
  readonly events: readonly LedgerAuditEvent[];
}

function recordingSink(): RecordingSink {
  const events: LedgerAuditEvent[] = [];
  return {
    events,
    append(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
}

function ledgerWith(store: LedgerStore, audit: LedgerAuditSink) {
  return createSemanticLedger({ store, audit, actor: BOUND_ACTOR });
}

/* -------------------------------------------------------------------------- */
/* Persisted fixtures                                                         */
/* -------------------------------------------------------------------------- */

const PAYMENT_REFS: readonly SourceRef[] = [{ type: 'payment', id: 'pay_8Ai2Up' }];

function entry(
  line_no: number,
  account_code: string,
  side: 'debit' | 'credit',
  amount_paise: Paise,
  sources: readonly SourceRef[] = PAYMENT_REFS,
): PersistedLedgerEntry {
  return { account_code, side, amount_paise, entry_date: DATE, line_no, sources };
}

/** Wrap entries into a persisted set, deriving the header from them. */
function persisted(
  entries: readonly PersistedLedgerEntry[],
  overrides: Partial<PersistedLedgerSet> = {},
): PersistedLedgerSet {
  const total = (side: 'debit' | 'credit'): Paise =>
    entries
      .filter((e) => e.side === side)
      .reduce((acc, e) => acc + e.amount_paise, 0n as Paise);
  return {
    id: ORIGINAL,
    tenant_id: TENANT,
    entry_date: DATE,
    source_record_type: 'payment',
    source_record_id: 'pay_8Ai2Up',
    reverses_set_id: null,
    entry_count: entries.length,
    total_debit_paise: total('debit'),
    total_credit_paise: total('credit'),
    entries,
    ...overrides,
  };
}

/** The 4-entry Payment set: gross 100000, fee 2360, GST 424, net 97216. */
function paymentSet(): PersistedLedgerSet {
  return persisted([
    entry(1, ACCOUNT.SETTLEMENT_PENDING, 'debit', 97_216n),
    entry(2, ACCOUNT.RAZORPAY_FEE_EXPENSE, 'debit', 2_360n),
    entry(3, ACCOUNT.GST_INPUT_CREDIT, 'debit', 424n),
    entry(4, ACCOUNT.REVENUE, 'credit', 100_000n),
  ]);
}

/**
 * A set that posts several entries to one account on the same side **and** posts
 * to one account on both sides — the two shapes design.md names for P14's
 * generator, so the per-account netting is exercised rather than assumed.
 */
function repeatedAccountSet(): PersistedLedgerSet {
  const refs: readonly SourceRef[] = [
    { type: 'transfer', id: 'trf_1' },
    { type: 'payment', id: 'pay_8Ai2Up' },
  ];
  return persisted([
    entry(1, ACCOUNT.SETTLEMENT_PENDING, 'debit', 500n, refs),
    entry(2, ACCOUNT.SETTLEMENT_PENDING, 'debit', 700n, refs),
    entry(3, ACCOUNT.SETTLEMENT_PENDING, 'credit', 200n, refs),
    entry(4, ACCOUNT.SELLER_PAYOUT_CLEARING, 'credit', 1_000n, refs),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Netting helper                                                             */
/* -------------------------------------------------------------------------- */

/** Σdebit − Σcredit for one account, over persisted entries or a write's entries. */
function netOf(
  entries: readonly { account_code: string; side: 'debit' | 'credit'; amount_paise: Paise }[],
  account: string,
): Paise {
  return entries
    .filter((e) => e.account_code === account)
    .reduce(
      (acc, e) => (e.side === 'debit' ? acc + e.amount_paise : acc - e.amount_paise),
      0n as Paise,
    );
}

function accountsOf(
  entries: readonly { account_code: string }[],
): readonly string[] {
  return [...new Set(entries.map((e) => e.account_code))];
}

/* -------------------------------------------------------------------------- */
/* 1. The reversal set itself                                                 */
/* -------------------------------------------------------------------------- */

describe('reverseSet builds the mirror of the original (Requirement 2.4)', () => {
  it('keeps every account and amount and exchanges every side', async () => {
    const original = paymentSet();
    const store = reverseStore(original);
    const result = await ledgerWith(store, recordingSink()).reverseSet(
      TENANT,
      ORIGINAL,
      CORRECTING_ACTOR,
    );

    expect(result).toEqual({ ok: true, set_id: store.issued[0], created: true });
    expect(store.writes).toHaveLength(1);
    const write = store.writes[0]!;

    expect(
      write.entries.map((e) => [e.line_no, e.account_code, e.side, e.amount_paise]),
    ).toEqual([
      [1, ACCOUNT.SETTLEMENT_PENDING, 'credit', 97_216n],
      [2, ACCOUNT.RAZORPAY_FEE_EXPENSE, 'credit', 2_360n],
      [3, ACCOUNT.GST_INPUT_CREDIT, 'credit', 424n],
      [4, ACCOUNT.REVENUE, 'debit', 100_000n],
    ]);
    // Σdebit and Σcredit swap, so a set that balanced still balances.
    expect(write.total_debit_paise).toBe(original.total_credit_paise);
    expect(write.total_credit_paise).toBe(original.total_debit_paise);
    expect(write.entry_count).toBe(original.entry_count);
  });

  it('links the new set to the original and dates it as the original', async () => {
    const store = reverseStore(paymentSet());
    await ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR);

    const write = store.writes[0]!;
    expect(write.reverses_set_id).toBe(ORIGINAL);
    expect(write.entry_date).toBe(DATE);
    expect(write.entries.every((e) => e.entry_date === DATE)).toBe(true);
    expect(write.tenant_id).toBe(TENANT);
  });

  it('carries no derivation identity, so it cannot collide with the original', async () => {
    const store = reverseStore(paymentSet());
    await ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR);

    // `ledger_set_derivation_uniq` is (tenant_id, source_record_type,
    // source_record_id). Reusing the original's pair would make postSet report the
    // original back as an idempotent no-op and write no reversal at all.
    expect(store.writes[0]!.source_record_type).toBeNull();
    expect(store.writes[0]!.source_record_id).toBeNull();
  });

  it('attributes the correction to the actor it was called with', async () => {
    const store = reverseStore(paymentSet());
    await ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR);

    expect(store.writes[0]!.created_by).toBe(CORRECTING_ACTOR.id);
    expect(store.writes[0]!.created_by).not.toBe(BOUND_ACTOR.id);
  });

  it('scopes the read by Tenant', async () => {
    const store = reverseStore(paymentSet());
    await ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR);

    expect(store.lookups).toEqual([[TENANT, ORIGINAL]]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Source_Record links                                                     */
/* -------------------------------------------------------------------------- */

describe('the reversal preserves the Source_Record links (Requirement 2.2, 2.4)', () => {
  it('leads with the reversed set and then the original refs, de-duplicated', async () => {
    const store = reverseStore(repeatedAccountSet());
    await ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR);

    const expected: readonly SourceRef[] = [
      { type: 'ledger_entry_set', id: ORIGINAL },
      { type: 'transfer', id: 'trf_1' },
      { type: 'payment', id: 'pay_8Ai2Up' },
    ];
    // Every entry linked to every ref, and each ref once — `ledger_entry_sources`
    // is PRIMARY KEY (entry_id, source_record_type, source_record_id).
    for (const written of store.writes[0]!.entries) {
      expect(written.sources).toEqual(expected);
    }
  });

  it('gives every entry at least 1 link', async () => {
    const store = reverseStore(paymentSet());
    await ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR);

    expect(store.writes[0]!.entries.every((e) => e.sources.length >= 1)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The original is untouched, and the pair nets to 0 per account           */
/* -------------------------------------------------------------------------- */

describe('the original is retained unchanged and the pair nets to 0 (Requirement 2.4)', () => {
  for (const [name, build] of [
    ['a 4-entry Payment set', paymentSet],
    ['a set repeating one account on both sides', repeatedAccountSet],
  ] as const) {
    it(`leaves ${name} byte-identical and nets it to 0 per account`, async () => {
      const original = build();
      const snapshot = structuredClone(original);
      const store = reverseStore(original);

      await ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR);

      // Field by field, links included: nothing about the original changed.
      expect(original).toEqual(snapshot);

      const reversal = store.writes[0]!.entries;
      for (const account of accountsOf(snapshot.entries)) {
        expect(netOf(snapshot.entries, account) + netOf(reversal, account)).toBe(0n);
      }
    });
  }
});

/* -------------------------------------------------------------------------- */
/* 4. Reversing twice, and reversing a reversal                               */
/* -------------------------------------------------------------------------- */

describe('reversing twice yields two independent reversal sets', () => {
  it('writes two sets, both linked to the one untouched original', async () => {
    const original = paymentSet();
    const snapshot = structuredClone(original);
    const store = reverseStore(original);
    const ledger = ledgerWith(store, recordingSink());

    const first = await ledger.reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR);
    const second = await ledger.reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR);

    // Two creations, not an idempotent no-op: a second correction is a second set.
    expect(first).toEqual({ ok: true, set_id: store.issued[0], created: true });
    expect(second).toEqual({ ok: true, set_id: store.issued[1], created: true });
    expect(first).not.toEqual(second);

    expect(store.writes).toHaveLength(2);
    for (const write of store.writes) {
      expect(write.reverses_set_id).toBe(ORIGINAL);
      // NULL is distinct in a unique constraint, which is what lets both land.
      expect(write.source_record_type).toBeNull();
      expect(write.source_record_id).toBeNull();
    }
    expect(store.writes[0]).toEqual(store.writes[1]);
    expect(original).toEqual(snapshot);
  });

  it('reverses a reversal, restoring the original designations', async () => {
    const reversal: PersistedLedgerSet = persisted(
      [
        entry(1, ACCOUNT.SETTLEMENT_PENDING, 'credit', 97_216n, [
          { type: 'ledger_entry_set', id: ORIGINAL },
        ]),
        entry(2, ACCOUNT.REVENUE, 'debit', 97_216n, [
          { type: 'ledger_entry_set', id: ORIGINAL },
        ]),
      ],
      {
        id: '5a5a5a5a-6b6b-4c4c-8d8d-9e9e9e9e9e9e',
        source_record_type: null,
        source_record_id: null,
        reverses_set_id: ORIGINAL,
      },
    );
    const store = reverseStore(reversal);

    await ledgerWith(store, recordingSink()).reverseSet(
      TENANT,
      reversal.id,
      CORRECTING_ACTOR,
    );

    expect(store.writes[0]!.reverses_set_id).toBe(reversal.id);
    expect(store.writes[0]!.entries.map((e) => [e.account_code, e.side])).toEqual([
      [ACCOUNT.SETTLEMENT_PENDING, 'debit'],
      [ACCOUNT.REVENUE, 'credit'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. What is refused, with nothing written                                   */
/* -------------------------------------------------------------------------- */

describe('reverseSet refuses what it cannot reverse', () => {
  it('raises for a Tenant identifier that is not a UUID', async () => {
    const store = reverseStore(paymentSet());
    await expect(
      ledgerWith(store, recordingSink()).reverseSet('tenant-1', ORIGINAL, CORRECTING_ACTOR),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.lookups).toHaveLength(0);
    expect(store.writes).toHaveLength(0);
  });

  it('raises for a set identifier that is not a UUID', async () => {
    const store = reverseStore(paymentSet());
    await expect(
      ledgerWith(store, recordingSink()).reverseSet(TENANT, 'set_1', CORRECTING_ACTOR),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.lookups).toHaveLength(0);
    expect(store.writes).toHaveLength(0);
  });

  it('raises for a set that does not exist', async () => {
    const store = reverseStore();
    await expect(
      ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.writes).toHaveLength(0);
  });

  it('raises for a set belonging to another Tenant', async () => {
    const store = reverseStore(paymentSet());
    await expect(
      ledgerWith(store, recordingSink()).reverseSet(
        OTHER_TENANT,
        ORIGINAL,
        CORRECTING_ACTOR,
      ),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.writes).toHaveLength(0);
  });

  it('raises when the read-back disagrees with its own declared totals', async () => {
    // A store fault: the reversal of a partial entry list balances, so postSet
    // would accept it without complaint. Caught before any statement instead.
    const broken = persisted(
      [
        entry(1, ACCOUNT.SETTLEMENT_PENDING, 'debit', 97_216n),
        entry(2, ACCOUNT.REVENUE, 'credit', 97_216n),
      ],
      { total_debit_paise: 100_000n, total_credit_paise: 100_000n },
    );
    const store = reverseStore(broken);

    await expect(
      ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.writes).toHaveLength(0);
  });

  it('raises when the read-back has fewer entries than it declares', async () => {
    const broken = persisted(
      [
        entry(1, ACCOUNT.SETTLEMENT_PENDING, 'debit', 97_216n),
        entry(2, ACCOUNT.REVENUE, 'credit', 97_216n),
      ],
      { entry_count: 4 },
    );
    const store = reverseStore(broken);

    await expect(
      ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.writes).toHaveLength(0);
  });

  it('raises when a read-back entry carries no Source_Record link', async () => {
    const broken = persisted([
      entry(1, ACCOUNT.SETTLEMENT_PENDING, 'debit', 97_216n, []),
      entry(2, ACCOUNT.REVENUE, 'credit', 97_216n),
    ]);
    const store = reverseStore(broken);

    await expect(
      ledgerWith(store, recordingSink()).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.writes).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Nothing to audit                                                        */
/* -------------------------------------------------------------------------- */

describe('a successful reversal refuses nothing', () => {
  it('appends no ledger_set_rejected Audit_Event', async () => {
    const store = reverseStore(paymentSet());
    const sink = recordingSink();
    await ledgerWith(store, sink).reverseSet(TENANT, ORIGINAL, CORRECTING_ACTOR);

    expect(sink.events).toHaveLength(0);
  });
});
