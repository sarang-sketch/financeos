/**
 * Task 8.4: `postFromSource`, against an injectable store.
 *
 * Requirement 2.8 is three claims about a *second* derivation from one
 * Source_Record: the existing set is retained, 0 additional Ledger_Entries are
 * created, and every account balance is unchanged. A fake store can prove all
 * three in a way a database cannot, because it can be asked what statements it
 * received: the balance map here is computed from the writes the store actually
 * accepted, so "unchanged" is a statement about what was written rather than about
 * what survived. `test/db/ledger-derivation-trial-balance.test.ts` does the same
 * against real Postgres and the real `ledger_set_derivation_uniq`.
 *
 * What is asserted:
 *
 * 1. A first derivation reads the stored Source_Record and posts the rule's draft:
 *    the amounts are the stored amounts, and `entry_date` is the IST calendar date
 *    of `created_at_rzp`.
 * 2. A second derivation returns `{ ok: true, created: false }` naming the retained
 *    set, accepts no write, and leaves the account balance map deep-equal.
 * 3. Stored Transfer and Transfer_Reversal records post their own amounts with exact links;
 *    a partial reversal never substitutes its original Transfer amount.
 * 4. An unstored Source_Record, a blank identifier and a non-UUID Tenant all raise
 *    before anything is attempted.
 * 5. The Refund and Settlement projections carry the Source_Record links
 *    Requirement 2.9 and 2.10 name.
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.8, 2.9, 2.10, 7.1, 7.2**
 */

import { describe, expect, it } from 'vitest';

import type { Paise } from '@/calc/calculation-service';
import type { Actor } from '@/config/configuration-service';
import { ACCOUNT, type SourceRef } from './posting-rules';
import {
  createSemanticLedger,
  type LedgerAuditEvent,
  type LedgerAuditSink,
  LEDGER_SET_DERIVATION_UNIQ,
  type LedgerSetWrite,
  type LedgerSourceRecord,
  type LedgerStore,
  postingSourceFrom,
  SemanticLedgerError,
} from './semantic-ledger';

const TENANT = '3f1a2b4c-5d6e-4f70-8192-a3b4c5d6e7f8';
const ACTOR: Actor = { kind: 'user', id: 'usr_operator_1' };

/** 2026-02-14T19:00:00Z is 2026-02-15 00:30 IST: the IST date is the NEXT day. */
const CREATED_AT = '2026-02-14T19:00:00.000Z';
const IST_DATE = '2026-02-15';

const PAYMENT: LedgerSourceRecord = {
  type: 'payment',
  id: 'pay_8Ai2Up',
  created_at_rzp: CREATED_AT,
  amount_paise: 100_000n,
  fee_paise: 2_360n,
  gst_on_fee_paise: 424n,
  refunded_payment_id: null,
  settlement_recon_report_id: null,
};

const REFUND: LedgerSourceRecord = {
  type: 'refund',
  id: 'rfnd_8Ai2Uq',
  created_at_rzp: CREATED_AT,
  amount_paise: 40_000n,
  fee_paise: null,
  gst_on_fee_paise: null,
  refunded_payment_id: 'pay_8Ai2Up',
  settlement_recon_report_id: null,
};

const SETTLEMENT: LedgerSourceRecord = {
  type: 'settlement',
  id: 'setl_8Ai2Ur',
  created_at_rzp: CREATED_AT,
  amount_paise: 97_216n,
  fee_paise: null,
  gst_on_fee_paise: null,
  refunded_payment_id: null,
  settlement_recon_report_id: 'setlrpt_8Ai2Us',
};

/* -------------------------------------------------------------------------- */
/* A store that enforces the derivation constraint in memory                  */
/* -------------------------------------------------------------------------- */

/**
 * `insertSet` keeps one set per `(source_record_type, source_record_id)` — the
 * same key `ledger_set_derivation_uniq` is declared on — and reports the second
 * attempt as `duplicate_derivation`, matched by constraint name. A rejected write
 * is not recorded at all, which is what makes {@link balancesOf} able to say
 * "nothing was written".
 */
function derivationStore(records: readonly LedgerSourceRecord[]): LedgerStore & {
  readonly writes: readonly LedgerSetWrite[];
  readonly lookups: readonly SourceRef[];
} {
  const writes: LedgerSetWrite[] = [];
  const lookups: SourceRef[] = [];
  const bySource = new Map<string, string>();
  let nextId = 1;

  return {
    writes,
    lookups,
    async insertSet(write) {
      const key = `${write.source_record_type ?? ''}:${write.source_record_id ?? ''}`;
      const existing = write.source_record_id === null ? undefined : bySource.get(key);
      if (existing !== undefined) {
        return {
          ok: false,
          kind: 'duplicate_derivation',
          set_id: existing,
          constraint: LEDGER_SET_DERIVATION_UNIQ,
        };
      }
      const setId = `set_${nextId++}`;
      if (write.source_record_id !== null) {
        bySource.set(key, setId);
      }
      writes.push(write);
      return { ok: true, set_id: setId };
    },
    findSourceRecord(_tenantId, ref) {
      lookups.push(ref);
      const found = records.find((r) => r.type === ref.type && r.id === ref.id);
      return Promise.resolve(found ?? null);
    },
    findSet() {
      return Promise.reject(
        new Error('findSet is reverseSet\u2019s seam, tested in ./semantic-ledger.reverse.test.ts'),
      );
    },
    trialBalanceTotals() {
      return Promise.reject(
        new Error('trialBalanceTotals is not used by the postFromSource tests'),
      );
    },
  };
}

function silentSink(): LedgerAuditSink & { readonly events: readonly LedgerAuditEvent[] } {
  const events: LedgerAuditEvent[] = [];
  return {
    events,
    async append(event) {
      events.push(event);
    },
  };
}

/**
 * Every account's `debit − credit` over the writes the store accepted. The shape
 * property P2 (task 8.6) compares before and after: `Map<string, bigint>`.
 */
function balancesOf(writes: readonly LedgerSetWrite[]): Map<string, Paise> {
  const balances = new Map<string, Paise>();
  for (const write of writes) {
    for (const entry of write.entries) {
      const signed = entry.side === 'debit' ? entry.amount_paise : -entry.amount_paise;
      balances.set(entry.account_code, (balances.get(entry.account_code) ?? 0n) + signed);
    }
  }
  return balances;
}

function ledgerWith(store: LedgerStore, audit: LedgerAuditSink) {
  return createSemanticLedger({ store, audit, actor: ACTOR });
}

/* -------------------------------------------------------------------------- */
/* 1. The first derivation                                                    */
/* -------------------------------------------------------------------------- */

describe('a first derivation from a stored Payment', () => {
  it('posts the rule draft and reports it created', async () => {
    const store = derivationStore([PAYMENT]);
    const result = await ledgerWith(store, silentSink()).postFromSource(TENANT, {
      type: 'payment',
      id: PAYMENT.id,
    });

    expect(result).toEqual({ ok: true, set_id: 'set_1', created: true });
    expect(store.lookups).toEqual([{ type: 'payment', id: PAYMENT.id }]);
    expect(store.writes).toHaveLength(1);
  });

  it('posts the stored amounts, with settlement_pending at gross minus fee minus GST', async () => {
    const store = derivationStore([PAYMENT]);
    await ledgerWith(store, silentSink()).postFromSource(TENANT, {
      type: 'payment',
      id: PAYMENT.id,
    });

    const entries = store.writes[0]?.entries ?? [];
    expect(
      entries.map((e) => [e.account_code, e.side, e.amount_paise] as const),
    ).toEqual([
      [ACCOUNT.SETTLEMENT_PENDING, 'debit', 97_216n],
      [ACCOUNT.RAZORPAY_FEE_EXPENSE, 'debit', 2_360n],
      [ACCOUNT.GST_INPUT_CREDIT, 'debit', 424n],
      [ACCOUNT.REVENUE, 'credit', 100_000n],
    ]);
    expect(store.writes[0]?.total_debit_paise).toBe(100_000n);
    expect(store.writes[0]?.total_credit_paise).toBe(100_000n);
  });

  it('dates the set on the IST calendar date of created_at_rzp', async () => {
    const store = derivationStore([PAYMENT]);
    await ledgerWith(store, silentSink()).postFromSource(TENANT, {
      type: 'payment',
      id: PAYMENT.id,
    });

    // 19:00 UTC is 00:30 IST the following day, so the ledger date is the IST one.
    expect(store.writes[0]?.entry_date).toBe(IST_DATE);
    expect(store.writes[0]?.entries.every((e) => e.entry_date === IST_DATE)).toBe(true);
  });

  it('takes the Source_Record as the derivation identity of the set', async () => {
    const store = derivationStore([PAYMENT]);
    await ledgerWith(store, silentSink()).postFromSource(TENANT, {
      type: 'payment',
      id: PAYMENT.id,
    });

    expect(store.writes[0]?.source_record_type).toBe('payment');
    expect(store.writes[0]?.source_record_id).toBe(PAYMENT.id);
  });

  it('omits a fee and GST that are absent from the stored Payment', async () => {
    const store = derivationStore([
      { ...PAYMENT, fee_paise: null, gst_on_fee_paise: null },
    ]);
    await ledgerWith(store, silentSink()).postFromSource(TENANT, {
      type: 'payment',
      id: PAYMENT.id,
    });

    // A 0-paise entry is not storeable, so the set is 2 entries rather than 4.
    expect(store.writes[0]?.entries).toHaveLength(2);
    expect(store.writes[0]?.entry_count).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The second derivation: retained, nothing written, balances unchanged    */
/* -------------------------------------------------------------------------- */

describe('a second derivation from the same Source_Record', () => {
  it('returns ok with created false, naming the retained set', async () => {
    const store = derivationStore([PAYMENT]);
    const ledger = ledgerWith(store, silentSink());
    const ref: SourceRef = { type: 'payment', id: PAYMENT.id };

    const first = await ledger.postFromSource(TENANT, ref);
    const second = await ledger.postFromSource(TENANT, ref);

    expect(first).toEqual({ ok: true, set_id: 'set_1', created: true });
    expect(second).toEqual({ ok: true, set_id: 'set_1', created: false });
  });

  it('writes nothing: exactly one accepted set and 0 additional Ledger_Entries', async () => {
    const store = derivationStore([PAYMENT]);
    const ledger = ledgerWith(store, silentSink());
    const ref: SourceRef = { type: 'payment', id: PAYMENT.id };

    await ledger.postFromSource(TENANT, ref);
    const entriesAfterFirst = store.writes.flatMap((w) => w.entries).length;
    await ledger.postFromSource(TENANT, ref);

    expect(store.writes).toHaveLength(1);
    expect(store.writes.flatMap((w) => w.entries).length).toBe(entriesAfterFirst);
  });

  it('leaves every account balance unchanged (the map P2 compares)', async () => {
    const store = derivationStore([PAYMENT, REFUND, SETTLEMENT]);
    const ledger = ledgerWith(store, silentSink());
    const refs: readonly SourceRef[] = [
      { type: 'payment', id: PAYMENT.id },
      { type: 'refund', id: REFUND.id },
      { type: 'settlement', id: SETTLEMENT.id },
    ];

    for (const ref of refs) {
      expect(await ledger.postFromSource(TENANT, ref)).toMatchObject({ created: true });
    }
    const before = balancesOf(store.writes);

    // The second pass arrives in a different order, as P2's generator does.
    for (const ref of [...refs].reverse()) {
      expect(await ledger.postFromSource(TENANT, ref)).toMatchObject({ created: false });
    }
    const after = balancesOf(store.writes);

    expect(after).toEqual(before);
    expect([...after.entries()].sort()).toEqual([
      // Payment: +97216 settlement_pending, Settlement moves it to bank, Refund -40000.
      [ACCOUNT.BANK, 97_216n],
      [ACCOUNT.GST_INPUT_CREDIT, 424n],
      [ACCOUNT.RAZORPAY_FEE_EXPENSE, 2_360n],
      [ACCOUNT.REVENUE, -60_000n],
      [ACCOUNT.SETTLEMENT_PENDING, -40_000n],
    ]);
  });

  it('appends no Audit_Event for the no-op', async () => {
    const store = derivationStore([PAYMENT]);
    const audit = silentSink();
    const ledger = ledgerWith(store, audit);
    const ref: SourceRef = { type: 'payment', id: PAYMENT.id };

    await ledger.postFromSource(TENANT, ref);
    await ledger.postFromSource(TENANT, ref);

    // `ledger_set_rejected` means a write was refused; this refused nothing.
    expect(audit.events).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Transfer and Transfer_Reversal derivation                               */
/* -------------------------------------------------------------------------- */

describe('stored Route Source_Records', () => {
  const transfer: LedgerSourceRecord = {
    type: 'transfer',
    id: 'trf_8Ai2Ut',
    created_at_rzp: CREATED_AT,
    amount_paise: 50_000n,
    fee_paise: null,
    gst_on_fee_paise: null,
    refunded_payment_id: null,
    settlement_recon_report_id: null,
  };
  const partialReversal: LedgerSourceRecord = {
    ...transfer,
    type: 'transfer_reversal',
    id: 'trfr_8Ai2Uv',
    amount_paise: 12_500n,
  };

  it('posts a Transfer with its own exact Source_Record link', async () => {
    const store = derivationStore([transfer]);
    await ledgerWith(store, silentSink()).postFromSource(TENANT, {
      type: 'transfer',
      id: transfer.id,
    });

    expect(store.writes[0]?.entries.map((entry) => [
      entry.account_code,
      entry.side,
      entry.amount_paise,
      entry.sources,
    ])).toEqual([
      [ACCOUNT.SELLER_PAYOUT_CLEARING, 'debit', 50_000n, [{ type: 'transfer', id: transfer.id }]],
      [ACCOUNT.SETTLEMENT_PENDING, 'credit', 50_000n, [{ type: 'transfer', id: transfer.id }]],
    ]);
  });

  it('posts a partial Transfer_Reversal at its own amount, not the Transfer amount', async () => {
    const store = derivationStore([partialReversal]);
    await ledgerWith(store, silentSink()).postFromSource(TENANT, {
      type: 'transfer_reversal',
      id: partialReversal.id,
    });

    expect(store.writes[0]?.entries.map((entry) => [
      entry.account_code,
      entry.side,
      entry.amount_paise,
      entry.sources,
    ])).toEqual([
      [ACCOUNT.SETTLEMENT_PENDING, 'debit', 12_500n, [{ type: 'transfer_reversal', id: partialReversal.id }]],
      [ACCOUNT.SELLER_PAYOUT_CLEARING, 'credit', 12_500n, [{ type: 'transfer_reversal', id: partialReversal.id }]],
    ]);
  });

  it('still raises for Source_Record types with no posting table', () => {
    for (const type of ['order', 'credit_note', 'proposal'] as const) {
      expect(() => postingSourceFrom({ ...transfer, type })).toThrow(SemanticLedgerError);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Nothing attempted for a request that cannot resolve                     */
/* -------------------------------------------------------------------------- */

describe('a request that cannot resolve', () => {
  it('raises when the Tenant has no such stored Source_Record', async () => {
    const store = derivationStore([PAYMENT]);
    await expect(
      ledgerWith(store, silentSink()).postFromSource(TENANT, {
        type: 'payment',
        id: 'pay_never_ingested',
      }),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.writes).toEqual([]);
  });

  it('raises on a blank Source_Record identifier, before the lookup', async () => {
    const store = derivationStore([PAYMENT]);
    await expect(
      ledgerWith(store, silentSink()).postFromSource(TENANT, { type: 'payment', id: '  ' }),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.lookups).toEqual([]);
  });

  it('raises on a Tenant identifier that is not a UUID, before the lookup', async () => {
    const store = derivationStore([PAYMENT]);
    await expect(
      ledgerWith(store, silentSink()).postFromSource('tenant-1', {
        type: 'payment',
        id: PAYMENT.id,
      }),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
    expect(store.lookups).toEqual([]);
  });

  it('raises when the stored Refund names no refunded Payment (Requirement 2.9)', async () => {
    const store = derivationStore([{ ...REFUND, refunded_payment_id: null }]);
    await expect(
      ledgerWith(store, silentSink()).postFromSource(TENANT, {
        type: 'refund',
        id: REFUND.id,
      }),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
  });

  it('raises when the stored record carries no amount', async () => {
    const store = derivationStore([{ ...PAYMENT, amount_paise: null }]);
    await expect(
      ledgerWith(store, silentSink()).postFromSource(TENANT, {
        type: 'payment',
        id: PAYMENT.id,
      }),
    ).rejects.toBeInstanceOf(SemanticLedgerError);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The Refund and Settlement links                                         */
/* -------------------------------------------------------------------------- */

describe('the Source_Record links of a derived set', () => {
  it('links the Refund and the refunded Payment, Refund first (Requirement 2.9)', async () => {
    const store = derivationStore([REFUND]);
    await ledgerWith(store, silentSink()).postFromSource(TENANT, {
      type: 'refund',
      id: REFUND.id,
    });

    const write = store.writes[0];
    expect(write?.source_record_type).toBe('refund');
    expect(write?.source_record_id).toBe(REFUND.id);
    for (const entry of write?.entries ?? []) {
      expect(entry.sources).toEqual([
        { type: 'refund', id: REFUND.id },
        { type: 'payment', id: PAYMENT.id },
      ]);
    }
  });

  it('links the Settlement and its Settlement_Recon_Report (Requirement 2.10)', async () => {
    const store = derivationStore([SETTLEMENT]);
    await ledgerWith(store, silentSink()).postFromSource(TENANT, {
      type: 'settlement',
      id: SETTLEMENT.id,
    });

    for (const entry of store.writes[0]?.entries ?? []) {
      expect(entry.sources).toEqual([
        { type: 'settlement', id: SETTLEMENT.id },
        { type: 'settlement_recon_report', id: 'setlrpt_8Ai2Us' },
      ]);
    }
  });

  it('links the Settlement alone when no recon report has been ingested', async () => {
    const store = derivationStore([{ ...SETTLEMENT, settlement_recon_report_id: null }]);
    await ledgerWith(store, silentSink()).postFromSource(TENANT, {
      type: 'settlement',
      id: SETTLEMENT.id,
    });

    for (const entry of store.writes[0]?.entries ?? []) {
      expect(entry.sources).toEqual([{ type: 'settlement', id: SETTLEMENT.id }]);
    }
  });
});
