/**
 * Task 8.3: `postSet`, against an injectable store and audit sink.
 *
 * The point of the fakes is that they can answer a question a real database
 * cannot: **was a statement issued at all?** Requirement 2.6's atomic rejection
 * is satisfied here by never attempting the write, and the only way to assert
 * "never attempted" is to count the calls the store received. A database test can
 * assert that 0 rows persisted, which is a weaker statement — it holds equally
 * for a write that was attempted and rolled back. `test/db/ledger-postset.test.ts`
 * covers the rows-on-disk half against real Postgres.
 *
 * What is asserted here:
 *
 * 1. A balanced draft posts: one write, correct declared totals and entry count,
 *    1-based line numbers, and every entry carrying every Source_Record ref.
 * 2. An imbalanced draft returns `{ ok: false, kind: 'unbalanced', ... }` with
 *    the exact signed `imbalance_paise` and the draft's `source_refs`, issues
 *    **no** store call, and appends exactly one `ledger_set_rejected`
 *    Audit_Event.
 * 3. A store-reported (commit-time) rejection funnels into the same result and
 *    the same Audit_Event, marked `at_commit`.
 * 4. 2..20 entries and every amount `> 0` are enforced before anything is
 *    attempted: `PostingRuleError`, no write, no Audit_Event.
 * 5. A draft that balances while a partial sum leaves the paise range raises
 *    `PaiseRangeError` and writes nothing — the documented decision, see the
 *    module doc comment of `./semantic-ledger`.
 * 6. A store-reported `duplicate_derivation` is a success with `created: false`
 *    naming the retained set, and audits nothing (Requirement 2.8). The
 *    `postFromSource` half of that is in
 *    `./semantic-ledger.postfromsource.test.ts`. `reverseSet` (task 24.1) is in
 *    `./semantic-ledger.reverse.test.ts`.
 *
 * **Validates: Requirements 2.1, 2.2, 2.6, 2.7**
 */

import { describe, expect, it } from 'vitest';

import { PAISE_MAX, type Paise, PaiseRangeError } from '@/calc/calculation-service';
import type { Actor } from '@/config/configuration-service';
import {
  ACCOUNT,
  type LedgerEntrySetDraft,
  paymentPostingDraft,
  PostingRuleError,
  refundPostingDraft,
  type SourceRef,
} from './posting-rules';
import {
  createSemanticLedger,
  type LedgerAuditEvent,
  type LedgerAuditSink,
  LEDGER_SET_DERIVATION_UNIQ,
  type LedgerSetWrite,
  type LedgerStore,
  type LedgerWriteOutcome,
  SemanticLedgerError,
} from './semantic-ledger';

const TENANT = '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const SET_ID = '9c8b7a65-4321-4dcb-9876-0fedcba98765';
const DATE = '2026-02-14';
const NOW = '2026-02-14T09:30:00.000Z';

const ACTOR: Actor = { kind: 'user', id: 'usr_operator_1' };

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

interface RecordingStore extends LedgerStore {
  readonly writes: readonly LedgerSetWrite[];
}

/**
 * `findSourceRecord` and `trialBalanceTotals` are the seams task 8.4 added; the
 * `postSet` tests in this section never reach them, so they reject rather than
 * returning something a test could accidentally pass on.
 * `src/ledger/semantic-ledger.postfromsource.test.ts` and
 * `src/ledger/semantic-ledger.trialbalance.test.ts` exercise them.
 */
function recordingStore(outcome?: LedgerWriteOutcome): RecordingStore {
  const writes: LedgerSetWrite[] = [];
  return {
    writes,
    async insertSet(write) {
      writes.push(write);
      return outcome ?? { ok: true, set_id: SET_ID };
    },
    findSourceRecord() {
      return Promise.reject(new Error('findSourceRecord is not used by the postSet tests'));
    },
    findSet() {
      return Promise.reject(new Error('findSet is not used by the postSet tests'));
    },
    trialBalanceTotals() {
      return Promise.reject(new Error('trialBalanceTotals is not used by the postSet tests'));
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
    async append(event) {
      events.push(event);
    },
  };
}

function ledgerWith(store: LedgerStore, audit: LedgerAuditSink) {
  return createSemanticLedger({
    store,
    audit,
    actor: ACTOR,
    now: () => new Date(NOW),
  });
}

/* -------------------------------------------------------------------------- */
/* Drafts                                                                    */
/* -------------------------------------------------------------------------- */

const REFS: readonly SourceRef[] = [
  { type: 'refund', id: 'rfnd_8Ai2Uq' },
  { type: 'payment', id: 'pay_8Ai2Up' },
];

/** A 4-entry Payment set: gross 100000, fee 2360, GST 424. */
function balancedPayment(): LedgerEntrySetDraft {
  return paymentPostingDraft({
    payment_id: 'pay_8Ai2Up',
    entry_date: DATE,
    amount_paise: 100_000n,
    fee_paise: 2_360n,
    gst_on_fee_paise: 424n,
  });
}

/** A 2-entry Refund set carrying both Source_Record refs. */
function balancedRefund(): LedgerEntrySetDraft {
  return refundPostingDraft({
    refund_id: 'rfnd_8Ai2Uq',
    payment_id: 'pay_8Ai2Up',
    entry_date: DATE,
    amount_paise: 40_000n,
  });
}

/**
 * A draft the posting rules cannot produce: the sides disagree by
 * `debit − credit`. Built directly, because that is the only way to reach the
 * rejection path — every rule balances by construction (property P1).
 */
function imbalanced(debit: Paise, credit: Paise): LedgerEntrySetDraft {
  return {
    source_refs: REFS,
    entry_date: DATE,
    entries: [
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'debit', amount_paise: debit },
      { account_code: ACCOUNT.REVENUE, side: 'credit', amount_paise: credit },
    ],
  };
}

/** A draft with `entries.length` entries, all balanced in pairs. */
function withEntryCount(count: number): LedgerEntrySetDraft {
  return {
    source_refs: REFS,
    entry_date: DATE,
    entries: Array.from({ length: count }, (_unused, index) => ({
      account_code: index % 2 === 0 ? ACCOUNT.SETTLEMENT_PENDING : ACCOUNT.REVENUE,
      side: index % 2 === 0 ? ('debit' as const) : ('credit' as const),
      amount_paise: 500n,
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* 1. The balanced path                                                       */
/* -------------------------------------------------------------------------- */

describe('a balanced draft', () => {
  it('posts one set and reports it created', async () => {
    const store = recordingStore();
    const audit = recordingSink();

    const result = await ledgerWith(store, audit).postSet(TENANT, balancedPayment());

    expect(result).toEqual({ ok: true, set_id: SET_ID, created: true });
    expect(store.writes).toHaveLength(1);
    expect(audit.events).toEqual([]);
  });

  it('declares totals that agree, and an entry count that matches the entries', async () => {
    const store = recordingStore();
    await ledgerWith(store, recordingSink()).postSet(TENANT, balancedPayment());

    const [write] = store.writes;
    expect(write?.total_debit_paise).toBe(100_000n);
    expect(write?.total_credit_paise).toBe(100_000n);
    expect(write?.entry_count).toBe(4);
    expect(write?.entries).toHaveLength(4);
    expect(write?.tenant_id).toBe(TENANT);
    expect(write?.entry_date).toBe(DATE);
    expect(write?.created_by).toBe(ACTOR.id);
    expect(write?.reverses_set_id).toBeNull();
  });

  it('takes the first Source_Record ref as the derivation identity', async () => {
    const store = recordingStore();
    // The Refund set leads with the Refund, not the refunded Payment.
    await ledgerWith(store, recordingSink()).postSet(TENANT, balancedRefund());

    const [write] = store.writes;
    expect(write?.source_record_type).toBe('refund');
    expect(write?.source_record_id).toBe('rfnd_8Ai2Uq');
  });

  it('numbers the entry lines from 1, in draft order', async () => {
    const store = recordingStore();
    await ledgerWith(store, recordingSink()).postSet(TENANT, balancedPayment());

    const entries = store.writes[0]?.entries ?? [];
    expect(entries.map((e) => e.line_no)).toEqual([1, 2, 3, 4]);
    expect(entries.map((e) => e.account_code)).toEqual([
      ACCOUNT.SETTLEMENT_PENDING,
      ACCOUNT.RAZORPAY_FEE_EXPENSE,
      ACCOUNT.GST_INPUT_CREDIT,
      ACCOUNT.REVENUE,
    ]);
    expect(entries.every((e) => e.entry_date === DATE)).toBe(true);
    expect(entries.every((e) => e.amount_paise > 0n)).toBe(true);
  });

  it('links every entry to every Source_Record ref (Requirement 2.2)', async () => {
    const store = recordingStore();
    const draft = balancedRefund();
    await ledgerWith(store, recordingSink()).postSet(TENANT, draft);

    const entries = store.writes[0]?.entries ?? [];
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      // At least 1 is the requirement; every ref is what postSet writes.
      expect(entry.sources.length).toBeGreaterThanOrEqual(1);
      expect(entry.sources).toEqual([
        { type: 'refund', id: 'rfnd_8Ai2Uq' },
        { type: 'payment', id: 'pay_8Ai2Up' },
      ]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The rejection path, before any statement                                */
/* -------------------------------------------------------------------------- */

describe('an imbalanced draft', () => {
  it('returns the unbalanced result with the exact signed imbalance', async () => {
    const store = recordingStore();
    const draft = imbalanced(100_000n, 90_000n);

    const result = await ledgerWith(store, recordingSink()).postSet(TENANT, draft);

    expect(result).toEqual({
      ok: false,
      kind: 'unbalanced',
      imbalance_paise: 10_000n,
      source_refs: REFS,
    });
  });

  it('reports a negative imbalance when the credit side is heavier', async () => {
    const result = await ledgerWith(recordingStore(), recordingSink()).postSet(
      TENANT,
      imbalanced(90_000n, 100_000n),
    );

    expect(result).toMatchObject({ ok: false, imbalance_paise: -10_000n });
  });

  it('issues no store call at all, so nothing is even attempted', async () => {
    const store = recordingStore();
    await ledgerWith(store, recordingSink()).postSet(TENANT, imbalanced(3n, 1n));

    expect(store.writes).toEqual([]);
  });

  it('appends exactly one ledger_set_rejected Audit_Event carrying the imbalance', async () => {
    const audit = recordingSink();
    await ledgerWith(recordingStore(), audit).postSet(TENANT, imbalanced(100_000n, 90_000n));

    expect(audit.events).toHaveLength(1);
    const [event] = audit.events;
    expect(event?.eventType).toBe('ledger_set_rejected');
    expect(event?.tenantId).toBe(TENANT);
    expect(event?.actor).toEqual(ACTOR);
    expect(event?.outcome).toBe('blocked');
    expect(event?.occurredAt).toBe(NOW);
    expect(event?.payload).toEqual({
      reason: 'unbalanced',
      // Digit text: a monetary value never passes through a float.
      imbalance_paise: '10000',
      total_debit_paise: '100000',
      total_credit_paise: '90000',
      entry_count: 2,
      entry_date: DATE,
      entries_persisted: 0,
      rejected_at: 'before_insert',
    });
  });

  it('records the Source_Record identifiers involved, type and id only', async () => {
    const audit = recordingSink();
    await ledgerWith(recordingStore(), audit).postSet(TENANT, imbalanced(5n, 4n));

    expect(audit.events[0]?.sourceRefs).toEqual([
      { type: 'refund', id: 'rfnd_8Ai2Uq' },
      { type: 'payment', id: 'pay_8Ai2Up' },
    ]);
  });

  it('propagates an audit failure rather than rejecting with no record', async () => {
    const failing: LedgerAuditSink = {
      append() {
        return Promise.reject(new Error('audit sink unavailable'));
      },
    };
    const store = recordingStore();

    await expect(
      ledgerWith(store, failing).postSet(TENANT, imbalanced(2n, 1n)),
    ).rejects.toThrow('audit sink unavailable');
    // Still nothing written: the failure is in the recording, not in the ledger.
    expect(store.writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. A rejection reported by the database barriers                           */
/* -------------------------------------------------------------------------- */

describe('a store-reported rejection at commit', () => {
  const barrierRejected: LedgerWriteOutcome = {
    ok: false,
    kind: 'unbalanced',
    imbalance_paise: 10n,
  };

  it('funnels into the same unbalanced result', async () => {
    const store = recordingStore(barrierRejected);
    const result = await ledgerWith(store, recordingSink()).postSet(TENANT, balancedRefund());

    expect(result).toEqual({
      ok: false,
      kind: 'unbalanced',
      imbalance_paise: 10n,
      source_refs: [
        { type: 'refund', id: 'rfnd_8Ai2Uq' },
        { type: 'payment', id: 'pay_8Ai2Up' },
      ],
    });
    // The write WAS attempted here, unlike the application-level rejection.
    expect(store.writes).toHaveLength(1);
  });

  it('appends the Audit_Event marked at_commit', async () => {
    const audit = recordingSink();
    await ledgerWith(recordingStore(barrierRejected), audit).postSet(TENANT, balancedRefund());

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.payload).toMatchObject({
      reason: 'unbalanced',
      imbalance_paise: '10',
      rejected_at: 'at_commit',
      entries_persisted: 0,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Structural enforcement, before anything is attempted                    */
/* -------------------------------------------------------------------------- */

describe('structural enforcement', () => {
  async function expectRejectedDraft(draft: LedgerEntrySetDraft): Promise<void> {
    const store = recordingStore();
    const audit = recordingSink();

    await expect(ledgerWith(store, audit).postSet(TENANT, draft)).rejects.toBeInstanceOf(
      PostingRuleError,
    );
    // A structural fault is not a ledger rejection: nothing attempted, nothing audited.
    expect(store.writes).toEqual([]);
    expect(audit.events).toEqual([]);
  }

  it('accepts a set of exactly 2 entries', async () => {
    const store = recordingStore();
    const result = await ledgerWith(store, recordingSink()).postSet(TENANT, withEntryCount(2));
    expect(result).toMatchObject({ ok: true });
  });

  it('accepts a set of exactly 20 entries', async () => {
    const store = recordingStore();
    const result = await ledgerWith(store, recordingSink()).postSet(TENANT, withEntryCount(20));
    expect(result).toMatchObject({ ok: true });
    expect(store.writes[0]?.entry_count).toBe(20);
  });

  it('rejects a set of 1 entry', async () => {
    await expectRejectedDraft({
      source_refs: REFS,
      entry_date: DATE,
      entries: [{ account_code: ACCOUNT.REVENUE, side: 'credit', amount_paise: 100n }],
    });
  });

  it('rejects a set of 21 entries', async () => {
    await expectRejectedDraft(withEntryCount(21));
  });

  it('rejects a 0-paise entry amount', async () => {
    await expectRejectedDraft(imbalanced(100n, 0n));
  });

  it('rejects a negative entry amount', async () => {
    await expectRejectedDraft(imbalanced(100n, -100n));
  });

  it('rejects a draft with no Source_Record ref, since no entry could be linked', async () => {
    await expectRejectedDraft({ ...imbalanced(100n, 100n), source_refs: [] });
  });

  it('rejects an entry_date that is not a real calendar date', async () => {
    await expectRejectedDraft({ ...imbalanced(100n, 100n), entry_date: '2026-02-30' });
  });

  it('rejects a Tenant identifier that is not a UUID, before touching the draft', async () => {
    const store = recordingStore();
    const audit = recordingSink();

    await expect(
      ledgerWith(store, audit).postSet('tenant-1', balancedPayment()),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.writes).toEqual([]);
    expect(audit.events).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Balanced, but a partial sum outside the paise range                     */
/* -------------------------------------------------------------------------- */

describe('a draft that balances while a side total leaves the paise range', () => {
  /** 2 debits and 2 credits of PAISE_MAX: balanced, but each side sums to 2 x PAISE_MAX. */
  const overflowing: LedgerEntrySetDraft = {
    source_refs: REFS,
    entry_date: DATE,
    entries: [
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'debit', amount_paise: PAISE_MAX },
      { account_code: ACCOUNT.SETTLEMENT_PENDING, side: 'debit', amount_paise: PAISE_MAX },
      { account_code: ACCOUNT.REVENUE, side: 'credit', amount_paise: PAISE_MAX },
      { account_code: ACCOUNT.REVENUE, side: 'credit', amount_paise: PAISE_MAX },
    ],
  };

  it('raises PaiseRangeError rather than reporting a 0-paise imbalance', async () => {
    // The set is not unbalanced, it is unstoreable: `total_debit_paise` is the
    // `paise` domain and has no room for the total. See ./semantic-ledger.
    await expect(
      ledgerWith(recordingStore(), recordingSink()).postSet(TENANT, overflowing),
    ).rejects.toBeInstanceOf(PaiseRangeError);
  });

  it('writes nothing and audits nothing: a rejected argument, not a rejected write', async () => {
    const store = recordingStore();
    const audit = recordingSink();

    await expect(
      ledgerWith(store, audit).postSet(TENANT, overflowing),
    ).rejects.toBeInstanceOf(PaiseRangeError);
    expect(store.writes).toEqual([]);
    expect(audit.events).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. A duplicate derivation reported by the store                            */
/* -------------------------------------------------------------------------- */

describe('a set whose derivation identity already exists', () => {
  const duplicate: LedgerWriteOutcome = {
    ok: false,
    kind: 'duplicate_derivation',
    set_id: SET_ID,
    constraint: LEDGER_SET_DERIVATION_UNIQ,
  };

  it('is a success with created false, naming the retained set (Requirement 2.8)', async () => {
    const result = await ledgerWith(recordingStore(duplicate), recordingSink()).postSet(
      TENANT,
      balancedRefund(),
    );
    expect(result).toEqual({ ok: true, set_id: SET_ID, created: false });
  });

  it('appends no Audit_Event: a successful no-op refused no write', async () => {
    const audit = recordingSink();
    await ledgerWith(recordingStore(duplicate), audit).postSet(TENANT, balancedRefund());
    expect(audit.events).toEqual([]);
  });
});

/* `reverseSet` (task 24.1) has its own file: ./semantic-ledger.reverse.test.ts */
