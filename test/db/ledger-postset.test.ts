/**
 * `postSet` against Supabase local (task 8.3).
 *
 * The unit tests in `src/ledger/semantic-ledger.test.ts` can prove that an
 * imbalanced draft issues no statement, because a fake store can count its calls.
 * What they cannot prove is what is on disk afterwards, and Requirement 2.6 is a
 * statement about disk: **0 Ledger_Entries persisted**. That needs a real
 * transaction, a real `DEFERRABLE INITIALLY DEFERRED` constraint trigger, and a
 * real `COMMIT`, so it lives here.
 *
 * Four things are asserted:
 *
 * 1. **The balanced path commits**, and every persisted Ledger_Entry carries at
 *    least 1 `ledger_entry_sources` row (Requirement 2.2). Without this control
 *    every rejection below could be produced by a store that cannot write at all.
 * 2. **The application-level rejection persists 0 entries**, and issues no
 *    statement: the counting wrapper around the store sees zero calls, so the
 *    zero rows are not the result of a rollback but of nothing having been
 *    attempted.
 * 3. **The deferred barrier persists 0 entries.** A `corruptingStore` mutates the
 *    entries of the write after `postSet` has validated it, which is the only way
 *    to reach barrier 3 through `postSet` — the fault it exists to catch is a
 *    store-level one, and a well-formed caller never produces it. The transaction
 *    is attempted and aborted at `COMMIT`, `postSet` reports the same
 *    `{ ok: false, kind: 'unbalanced' }` result, and the entries are gone.
 * 4. **The `ledger_set_rejected` Audit_Event survives**, with the control that
 *    makes that claim meaningful: the same append issued *inside* the doomed
 *    transaction is rolled back with it, while the append on a separate
 *    connection commits. That is the whole reason design.md asks for a separate
 *    connection.
 *
 * ## Why the audit append is a TypeScript connection and not `dblink`
 *
 * `app.append_audit_event_autonomous` is the SQL-side mechanism for exactly this,
 * and it is broken: task 4.8 proved at runtime that its
 * `dblink_connect('dbname=' || current_database())` fails with `2F003 password or
 * GSSAPI delegated credentials required`, because `postgres` on Supabase local is
 * not a superuser — the same shape as Supabase-hosted. It is documented with 8
 * `it.fails` markers in `./append-only.test.ts`, and it is task 4.4's defect to
 * resolve. So the sink below opens its own `psql` session and calls
 * `app.append_audit_event` there, which is a second connection with its own
 * transaction: same intent, no `dblink`.
 *
 * ## Which barrier catches what
 *
 * `./ledger-balance.test.ts` (task 4.8) already proves both database barriers in
 * isolation, including that the entry rows are visible inside the transaction
 * before `COMMIT` rejects them. This file does not repeat that; it asserts what
 * `postSet` does with them.
 *
 * NOTE ON CLEANUP: the balanced path has to commit, and `ledger_entries` and
 * `audit_events` are append-only — the `BEFORE UPDATE OR DELETE` trigger rejects
 * a delete, and on the way to rejecting it hits the same broken `dblink` path.
 * So these rows cannot be removed afterwards, exactly as in
 * `./append-only.test.ts`. Every identifier is freshly generated so runs never
 * collide; `npx supabase db reset` clears them.
 *
 * Requirements: 2.1, 2.2, 2.6, 2.7.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { subtract, sum } from '@/calc/calculation-service';
import type { Actor } from '@/config/configuration-service';
import {
  chartOfAccountsSeedRows,
  type LedgerEntrySetDraft,
  paymentPostingDraft,
  refundPostingDraft,
} from '@/ledger/posting-rules';
import {
  createSemanticLedger,
  type LedgerAuditEvent,
  type LedgerAuditSink,
  type LedgerSetWrite,
  type LedgerStore,
  type LedgerWriteOutcome,
} from '@/ledger/semantic-ledger';
import {
  claims,
  database,
  jsonAt,
  jsonScalar,
  lit,
  newFixture,
  provision,
  runOk,
  runScript,
} from './pg';

const reachable = database().reachable;
const f = newFixture();
const ACTOR: Actor = { kind: 'user', id: 'usr_db_operator' };
const DATE = '2026-02-14';
const NOW = '2026-02-14T09:30:00.000Z';

/** `integrity_constraint_violation`, raised by `assert_ledger_set_balanced()`. */
const INTEGRITY_CONSTRAINT_VIOLATION = '23000';
/** `check_violation`, raised by the immediate `ledger_set_balanced` CHECK. */
const CHECK_VIOLATION = '23514';

/* -------------------------------------------------------------------------- */
/* A psql-backed LedgerStore                                                  */
/* -------------------------------------------------------------------------- */

interface EntryRow {
  readonly id: string;
  readonly write: LedgerSetWrite['entries'][number];
}

function setInsert(write: LedgerSetWrite, setId: string): string {
  const type =
    write.source_record_type === null
      ? 'null'
      : `${lit(write.source_record_type)}::source_record_type`;
  return `insert into ledger_entry_sets
  (id, tenant_id, entry_date, source_record_type, source_record_id, reverses_set_id,
   entry_count, total_debit_paise, total_credit_paise, created_by)
values (${lit(setId)}, ${lit(write.tenant_id)}, ${lit(write.entry_date)}, ${type},
        ${write.source_record_id === null ? 'null' : lit(write.source_record_id)},
        ${write.reverses_set_id === null ? 'null' : lit(write.reverses_set_id)},
        ${write.entry_count}, ${write.total_debit_paise}, ${write.total_credit_paise},
        ${lit(write.created_by)});`;
}

function entryInserts(write: LedgerSetWrite, setId: string, rows: readonly EntryRow[]): string {
  const values = rows
    .map(
      ({ id, write: entry }) =>
        `(${lit(id)}, ${lit(write.tenant_id)}, ${lit(setId)}, ${lit(entry.account_code)}, ` +
        `${lit(entry.side)}::entry_side, ${entry.amount_paise}, ${lit(entry.entry_date)}, ` +
        `${entry.line_no})`,
    )
    .join(',\n       ');
  return `insert into ledger_entries
  (id, tenant_id, set_id, account_code, side, amount_paise, entry_date, line_no)
values ${values};`;
}

/** One row per (entry, Source_Record ref) pair: at least 1 per entry (Requirement 2.2). */
function sourceInserts(write: LedgerSetWrite, rows: readonly EntryRow[]): string {
  const values = rows.flatMap(({ id, write: entry }) =>
    entry.sources.map(
      (ref) =>
        `(${lit(id)}, ${lit(write.tenant_id)}, ${lit(ref.type)}::source_record_type, ` +
        `${lit(ref.id)})`,
    ),
  );
  return `insert into ledger_entry_sources (entry_id, tenant_id, source_record_type, source_record_id)
values ${values.join(',\n       ')};`;
}

const IMBALANCE_IN_MESSAGE = /imbalance (-?\d+) paise/;

/**
 * The imbalance the barrier saw. Read from the trigger's message where it states
 * one, otherwise recomputed over the entries the transaction attempted — the
 * "declared totals do not match its entries" branch names no imbalance.
 */
function imbalanceOf(write: LedgerSetWrite, message: string): bigint {
  const stated = IMBALANCE_IN_MESSAGE.exec(message);
  if (stated?.[1] !== undefined) {
    return BigInt(stated[1]);
  }
  const side = (which: 'debit' | 'credit'): bigint =>
    sum(write.entries.filter((e) => e.side === which).map((e) => e.amount_paise));
  return subtract(side('debit'), side('credit'));
}

/**
 * The whole set in ONE transaction: set row, entry rows, link rows, commit. So the
 * deferred trigger fires across all of them, and an abort takes every row with it.
 */
function psqlStore(): LedgerStore {
  return {
    async insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome> {
      const setId = randomUUID();
      const rows: readonly EntryRow[] = write.entries.map((entry) => ({
        id: randomUUID(),
        write: entry,
      }));

      const r = runScript(
        `begin;
${claims(f)}
${setInsert(write, setId)}
${entryInserts(write, setId, rows)}
${sourceInserts(write, rows)}
commit;`,
      );

      const barrier = r.errors.find(
        (e) =>
          e.sqlstate === INTEGRITY_CONSTRAINT_VIOLATION || e.sqlstate === CHECK_VIOLATION,
      );
      if (barrier !== undefined) {
        return { ok: false, kind: 'unbalanced', imbalance_paise: imbalanceOf(write, barrier.message) };
      }
      if (r.errors.length > 0) {
        throw new Error(`ledger set insert failed:\n${r.rawErr}`);
      }
      return { ok: true, set_id: setId };
    },

    /**
     * The two seams task 8.4 added to {@link LedgerStore}. `postSet` never reaches
     * either, so they reject rather than returning something a test here could
     * accidentally pass on. `./ledger-derivation-trial-balance.test.ts` implements
     * both against the same psql session, including the
     * `ledger_set_derivation_uniq` handling `insertSet` above deliberately leaves
     * out — a duplicate derivation surfaces here as a failure, which is correct for
     * a file whose drafts each carry a distinct Source_Record.
     */
    findSourceRecord() {
      return Promise.reject(new Error('findSourceRecord is task 8.4, tested in its own file'));
    },
    findSet() {
      return Promise.reject(new Error('findSet is task 24.1, tested in its own file'));
    },
    trialBalanceTotals() {
      return Promise.reject(new Error('trialBalanceTotals is task 8.4, tested in its own file'));
    },
  };
}

/** Counts the calls, so "no statement was issued" is assertable, not inferred. */
function counting(store: LedgerStore): LedgerStore & { calls: number } {
  const wrapper = {
    ...store,
    calls: 0,
    async insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome> {
      wrapper.calls += 1;
      return store.insertSet(write);
    },
  };
  return wrapper;
}

/**
 * Mutates the entries after `postSet` validated them, leaving the declared totals
 * as `postSet` computed them. That is a store-level fault, and barrier 3 is the
 * thing that exists to catch it.
 */
function corrupting(store: LedgerStore): LedgerStore {
  return {
    ...store,
    async insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome> {
      const entries = write.entries.map((entry, index) =>
        index === 0 ? { ...entry, amount_paise: entry.amount_paise - 1n } : entry,
      );
      return store.insertSet({ ...write, entries });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* A psql-backed audit sink, on its own connection                            */
/* -------------------------------------------------------------------------- */

function appendCall(event: LedgerAuditEvent): string {
  return `do $ae$ begin perform app.append_audit_event(
  p_tenant_id   => ${lit(event.tenantId)}::uuid,
  p_event_type  => ${lit(event.eventType)},
  p_actor_kind  => ${lit(event.actor.kind)},
  p_actor_id    => ${lit(event.actor.id)},
  p_stage       => null,
  p_outcome     => ${lit(event.outcome)},
  p_proposal_id => null,
  p_source_refs => ${lit(JSON.stringify(event.sourceRefs))}::jsonb,
  p_payload     => ${lit(JSON.stringify(event.payload))}::jsonb,
  p_occurred_at => ${lit(event.occurredAt)}::timestamptz); end $ae$;`;
}

/** Each `runScript` is its own `psql` session, so this is a separate connection. */
function psqlAuditSink(): LedgerAuditSink & { events: LedgerAuditEvent[] } {
  const sink = {
    events: [] as LedgerAuditEvent[],
    async append(event: LedgerAuditEvent): Promise<void> {
      sink.events.push(event);
      runOk(`${claims(f)}\n${appendCall(event)}`);
    },
  };
  return sink;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

function scalar<T>(expr: string): T {
  const r = runOk(`${claims(f)}\n${jsonScalar(expr)}`);
  return jsonAt<T>(r, 0);
}

const entryCount = (): number =>
  scalar<number>(`(select count(*)::int from ledger_entries where tenant_id = ${lit(f.tenantId)})`);

const setCount = (): number =>
  scalar<number>(
    `(select count(*)::int from ledger_entry_sets where tenant_id = ${lit(f.tenantId)})`,
  );

const rejectionEventCount = (): number =>
  scalar<number>(
    `(select count(*)::int from audit_events where tenant_id = ${lit(f.tenantId)}
        and event_type = 'ledger_set_rejected')`,
  );

/** The smallest number of Source_Record links held by any persisted entry. */
const minLinksPerEntry = (): number =>
  scalar<number>(
    `(select coalesce(min(link_count), 0)::int from (
        select e.id, count(s.entry_id)::int as link_count
          from ledger_entries e
          left join ledger_entry_sources s on s.entry_id = e.id
         where e.tenant_id = ${lit(f.tenantId)}
         group by e.id) c)`,
  );

function ledgerWith(store: LedgerStore, audit: LedgerAuditSink) {
  return createSemanticLedger({ store, audit, actor: ACTOR, now: () => new Date(NOW) });
}

/* -------------------------------------------------------------------------- */
/* Drafts                                                                     */
/* -------------------------------------------------------------------------- */

const paymentDraft = (): LedgerEntrySetDraft =>
  paymentPostingDraft({
    payment_id: 'pay_db_postset',
    entry_date: DATE,
    amount_paise: 100_000n,
    fee_paise: 2_360n,
    gst_on_fee_paise: 424n,
  });

const refundDraft = (): LedgerEntrySetDraft =>
  refundPostingDraft({
    refund_id: 'rfnd_db_postset',
    payment_id: 'pay_db_postset',
    entry_date: DATE,
    amount_paise: 40_000n,
  });

/** A draft no posting rule produces: the sides disagree by 10000 paise. */
const imbalancedDraft = (): LedgerEntrySetDraft => ({
  source_refs: [
    { type: 'payment', id: 'pay_db_imbalanced' },
    { type: 'order', id: 'order_db_imbalanced' },
  ],
  entry_date: DATE,
  entries: [
    { account_code: 'settlement_pending', side: 'debit', amount_paise: 100_000n },
    { account_code: 'revenue', side: 'credit', amount_paise: 90_000n },
  ],
});

/* -------------------------------------------------------------------------- */

describe.skipIf(!reachable)('postSet against the real schema', () => {
  beforeAll(() => {
    // Committed, because the store commits its own transaction and the guarantees
    // under test span several sessions.
    const accounts = chartOfAccountsSeedRows(f.tenantId)
      .map(
        (a) =>
          `(${lit(a.tenant_id)}, ${lit(a.account_code)}, ${lit(a.account_name)}, ` +
          `${lit(a.kind)}::account_kind, ${a.is_active})`,
      )
      .join(',\n       ');
    runOk(
      `${provision(f)}
insert into chart_of_accounts (tenant_id, account_code, account_name, kind, is_active)
values ${accounts};`,
    );
  });

  describe('the balanced path', () => {
    it('commits the 4-entry Payment set with its declared totals', async () => {
      const result = await ledgerWith(psqlStore(), psqlAuditSink()).postSet(
        f.tenantId,
        paymentDraft(),
      );
      expect(result).toMatchObject({ ok: true, created: true });
      if (!result.ok) {
        return;
      }

      const row = scalar<{
        entry_count: number;
        total_debit_paise: string;
        total_credit_paise: string;
        source_record_type: string;
        source_record_id: string;
        created_by: string;
      }>(
        `(select to_jsonb(x) from (
            select entry_count, total_debit_paise::text, total_credit_paise::text,
                   source_record_type::text, source_record_id, created_by
              from ledger_entry_sets where id = ${lit(result.set_id)}) x)`,
      );
      expect(row.entry_count).toBe(4);
      expect(row.total_debit_paise).toBe('100000');
      expect(row.total_credit_paise).toBe('100000');
      expect(row.source_record_type).toBe('payment');
      expect(row.source_record_id).toBe('pay_db_postset');
      expect(row.created_by).toBe(ACTOR.id);
      expect(entryCount()).toBe(4);
    });

    it('commits the 2-entry Refund set alongside it', async () => {
      const result = await ledgerWith(psqlStore(), psqlAuditSink()).postSet(
        f.tenantId,
        refundDraft(),
      );
      expect(result).toMatchObject({ ok: true, created: true });
      expect(setCount()).toBe(2);
      expect(entryCount()).toBe(6);
    });

    it('links every persisted Ledger_Entry to at least 1 Source_Record', () => {
      // The Payment set carries 1 ref over 4 entries, the Refund set 2 refs over
      // 2 entries: 4 + 4 = 8 rows, and no entry with fewer than 1 link.
      expect(minLinksPerEntry()).toBeGreaterThanOrEqual(1);
      expect(
        scalar<number>(
          `(select count(*)::int from ledger_entry_sources where tenant_id = ${lit(f.tenantId)})`,
        ),
      ).toBe(8);
      // The Refund entries hold both refs; the ref set is identical per entry.
      expect(
        scalar<number>(
          `(select count(*)::int from (
              select entry_id from ledger_entry_sources
               where tenant_id = ${lit(f.tenantId)}
               group by entry_id having count(*) = 2) t)`,
        ),
      ).toBe(2);
    });

    it('holds sum of debits minus sum of credits at 0 paise for every persisted set', () => {
      // Requirement 2.7, over what is actually on disk rather than over a draft.
      expect(
        scalar<number>(
          `(select count(*)::int from (
              select e.set_id
                from ledger_entries e
               where e.tenant_id = ${lit(f.tenantId)}
               group by e.set_id
              having coalesce(sum(case when e.side = 'debit' then e.amount_paise else 0 end), 0)
                   - coalesce(sum(case when e.side = 'credit' then e.amount_paise else 0 end), 0) <> 0) t)`,
        ),
      ).toBe(0);
    });
  });

  describe('the imbalanced draft, rejected before any statement', () => {
    it('returns the unbalanced result and issues no statement at all', async () => {
      const store = counting(psqlStore());
      const audit = psqlAuditSink();

      const result = await ledgerWith(store, audit).postSet(f.tenantId, imbalancedDraft());

      expect(result).toEqual({
        ok: false,
        kind: 'unbalanced',
        imbalance_paise: 10_000n,
        source_refs: [
          { type: 'payment', id: 'pay_db_imbalanced' },
          { type: 'order', id: 'order_db_imbalanced' },
        ],
      });
      expect(store.calls).toBe(0);
    });

    it('persists 0 additional Ledger_Entries and 0 additional sets', () => {
      // The 6 entries and 2 sets are the committed balanced sets above.
      expect(entryCount()).toBe(6);
      expect(setCount()).toBe(2);
    });

    it('committed the ledger_set_rejected Audit_Event with the imbalance and the refs', () => {
      const event = scalar<{
        event_type: string;
        outcome: string;
        actor_kind: string;
        actor_id: string;
        payload: Record<string, unknown>;
        source_record_refs: { type: string; id: string }[];
        occurred_at: string;
      }>(
        `(select to_jsonb(x) from (
            select event_type, outcome, actor_kind, actor_id, payload, source_record_refs,
                   occurred_at::text
              from audit_events
             where tenant_id = ${lit(f.tenantId)} and event_type = 'ledger_set_rejected'
             order by sequence_number desc limit 1) x)`,
      );
      expect(event.outcome).toBe('blocked');
      expect(event.actor_kind).toBe('user');
      expect(event.actor_id).toBe(ACTOR.id);
      expect(event.payload).toMatchObject({
        reason: 'unbalanced',
        imbalance_paise: '10000',
        total_debit_paise: '100000',
        total_credit_paise: '90000',
        entries_persisted: 0,
        rejected_at: 'before_insert',
      });
      expect(event.source_record_refs).toEqual([
        { type: 'payment', id: 'pay_db_imbalanced' },
        { type: 'order', id: 'order_db_imbalanced' },
      ]);
    });
  });

  describe('the deferred barrier, rejected at commit', () => {
    let rejectionsBefore = 0;
    let result: Awaited<ReturnType<ReturnType<typeof ledgerWith>['postSet']>>;

    beforeAll(async () => {
      rejectionsBefore = rejectionEventCount();
      // A balanced draft whose entries are corrupted at the store boundary, so
      // the write IS attempted and only `COMMIT` can prove it wrong.
      result = await ledgerWith(corrupting(psqlStore()), psqlAuditSink()).postSet(
        f.tenantId,
        refundPostingDraft({
          refund_id: 'rfnd_db_deferred',
          payment_id: 'pay_db_postset',
          entry_date: DATE,
          amount_paise: 25_000n,
        }),
      );
    });

    it('reports the same unbalanced result, with the imbalance the trigger saw', () => {
      // One debit entry short by 1 paisa: debit 24999, credit 25000.
      expect(result).toMatchObject({
        ok: false,
        kind: 'unbalanced',
        imbalance_paise: -1n,
      });
    });

    it('persists 0 Ledger_Entries from the aborted transaction', () => {
      expect(entryCount()).toBe(6);
      expect(setCount()).toBe(2);
      expect(
        scalar<number>(
          `(select count(*)::int from ledger_entry_sets
             where tenant_id = ${lit(f.tenantId)} and source_record_id = 'rfnd_db_deferred')`,
        ),
      ).toBe(0);
    });

    it('committed the Audit_Event, marked at_commit, outside the aborted transaction', () => {
      expect(rejectionEventCount()).toBe(rejectionsBefore + 1);
      const payload = scalar<Record<string, unknown>>(
        `(select payload from audit_events
           where tenant_id = ${lit(f.tenantId)} and event_type = 'ledger_set_rejected'
           order by sequence_number desc limit 1)`,
      );
      expect(payload).toMatchObject({
        reason: 'unbalanced',
        imbalance_paise: '-1',
        rejected_at: 'at_commit',
        entries_persisted: 0,
      });
    });
  });

  /**
   * The control that gives the point above its meaning. The same append issued on
   * the doomed connection does NOT survive; on a separate connection it does.
   * This is what `app.append_audit_event_autonomous` was supposed to provide and
   * cannot, because its `dblink_connect` fails with `2F003` (task 4.8).
   */
  describe('the separate connection is what makes the Audit_Event survive', () => {
    const probe = newFixture();
    const setId = randomUUID();

    const event: LedgerAuditEvent = {
      tenantId: probe.tenantId,
      eventType: 'ledger_set_rejected',
      actor: ACTOR,
      outcome: 'blocked',
      sourceRefs: [{ type: 'payment', id: 'pay_db_survival' }],
      payload: { reason: 'unbalanced', imbalance_paise: '10', rejected_at: 'at_commit' },
      occurredAt: NOW,
    };

    const countFor = (): number => {
      const r = runOk(
        `${claims(probe)}
${jsonScalar(
  `(select count(*)::int from audit_events where tenant_id = ${lit(probe.tenantId)}
      and event_type = 'ledger_set_rejected')`,
)}`,
      );
      return jsonAt<number>(r, 0);
    };

    let insideAborted = 0;
    let afterSeparate = 0;

    beforeAll(() => {
      runOk(provision(probe));

      // An unbalanced set inside a transaction that appends the event on the SAME
      // connection, then fails its COMMIT on the deferred trigger.
      const doomed = runScript(
        `begin;
${claims(probe)}
insert into ledger_entry_sets
  (id, tenant_id, entry_date, entry_count, total_debit_paise, total_credit_paise, created_by)
values (${lit(setId)}, ${lit(probe.tenantId)}, current_date, 2, 100, 100, 'db-test');
insert into ledger_entries
  (tenant_id, set_id, account_code, side, amount_paise, entry_date, line_no)
values (${lit(probe.tenantId)}, ${lit(setId)}, ${lit(probe.debitAccount)}, 'debit', 100,
        current_date, 1),
       (${lit(probe.tenantId)}, ${lit(setId)}, ${lit(probe.creditAccount)}, 'credit', 90,
        current_date, 2);
${appendCall(event)}
commit;`,
      );
      expect(doomed.errors.map((e) => e.sqlstate)).toContain(INTEGRITY_CONSTRAINT_VIOLATION);
      insideAborted = countFor();

      runOk(`${claims(probe)}\n${appendCall(event)}`);
      afterSeparate = countFor();
    });

    it('loses an append made inside the aborted transaction', () => {
      expect(insideAborted).toBe(0);
    });

    it('keeps an append made on a separate connection', () => {
      expect(afterSeparate).toBe(1);
    });

    it('persisted 0 Ledger_Entries either way', () => {
      const r = runOk(
        `${claims(probe)}
${jsonScalar(
  `(select count(*)::int from ledger_entries where tenant_id = ${lit(probe.tenantId)})`,
)}`,
      );
      expect(jsonAt<number>(r, 0)).toBe(0);
    });
  });
});
