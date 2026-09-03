/**
 * `postFromSource` and `trialBalance` against Supabase local (task 8.4).
 *
 * Both halves of task 8.4 are database behaviours, so both are proven here against
 * real rows rather than only against a fake:
 *
 * 1. **Derivation idempotency is `ledger_set_derivation_uniq`.** The unit tests in
 *    `src/ledger/semantic-ledger.postfromsource.test.ts` run against an in-memory
 *    store that enforces the same key, which proves the service does the right
 *    thing with the rejection but not that the rejection happens. Here the second
 *    derivation is refused by the real `UNIQUE (tenant_id, source_record_type,
 *    source_record_id)` on `ledger_entry_sets` — SQLSTATE `23505`, matched **by
 *    constraint name** — and the assertions are about what is on disk afterwards:
 *    one set, no additional Ledger_Entries, and an account balance map identical to
 *    the one before, read back out of `ledger_entries`.
 * 2. **A trial balance is a real aggregation.** `SUM` over `BIGINT`, grouped by
 *    account, joined to `chart_of_accounts` for the `account_kind` the closing sign
 *    rule needs, over an inclusive `entry_date` range. Every figure crosses back as
 *    digit text and is parsed with `decodePaise`, so no monetary value passes
 *    through `Number(...)` (Requirement 15.1, 15.8).
 *
 * The store below also proves the narrower claim that makes the idempotency safe: a
 * unique violation on a *different* constraint — `ledger_entries (set_id, line_no)`
 * — is NOT reported as a duplicate derivation. It throws. Matching on SQLSTATE
 * alone would have swallowed it as a successful no-op.
 *
 * NOTE ON CLEANUP: as in `./ledger-postset.test.ts`, the sets under test have to
 * commit, and `ledger_entries` is append-only, so these rows cannot be removed
 * afterwards. Every identifier is freshly generated per run and every assertion is
 * scoped to this run's Tenant, so nothing here depends on a global row count.
 * `npx supabase db reset` clears them.
 *
 * Requirements: 2.3, 2.5, 2.8, 2.9, 2.10.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Paise } from '@/calc/calculation-service';
import type { Actor } from '@/config/configuration-service';
import { chartOfAccountsSeedRows, type SourceRef } from '@/ledger/posting-rules';
import {
  type AccountPeriodTotals,
  createSemanticLedger,
  type LedgerAuditEvent,
  type LedgerAuditSink,
  LEDGER_SET_DERIVATION_UNIQ,
  type LedgerSetWrite,
  type LedgerSourceRecord,
  type LedgerStore,
  type LedgerWriteOutcome,
  type TrialBalanceQuery,
  trialBalanceCreditTotalPaise,
  trialBalanceDebitTotalPaise,
} from '@/ledger/semantic-ledger';
import { decodePaise } from '@/wire/paise-wire';
import {
  claims,
  database,
  jsonAt,
  jsonRows,
  jsonScalar,
  lit,
  newFixture,
  provision,
  runOk,
  runScript,
} from './pg';

const reachable = database().reachable;
const f = newFixture();
const ACTOR: Actor = { kind: 'user', id: 'usr_db_derivation' };

/** `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** `integrity_constraint_violation`, raised by `assert_ledger_set_balanced()`. */
const INTEGRITY_CONSTRAINT_VIOLATION = '23000';
/** `check_violation`, raised by the immediate `ledger_set_balanced` CHECK. */
const CHECK_VIOLATION = '23514';

/* -------------------------------------------------------------------------- */
/* Source_Records to derive from                                              */
/* -------------------------------------------------------------------------- */

const PAYMENT_ID = 'pay_db_derive';
const REFUND_ID = 'rfnd_db_derive';
const SETTLEMENT_ID = 'setl_db_derive';
const RECON_REPORT_ID = 'setlrpt_db_derive';
const TRANSFER_ID = 'trf_db_derive';
const TRANSFER_REVERSAL_ID = 'trfr_db_derive';
/** Created 19:00 UTC, which is 00:30 IST the next day: an IST date-edge Payment. */
const IST_EDGE_PAYMENT_ID = 'pay_db_ist_edge';

const PAYMENT_DATE = '2026-02-14';
const SETTLEMENT_DATE = '2026-02-20';
/** `2026-02-28T19:00:00Z` in IST. Deliberately in March, so a February range omits it. */
const IST_EDGE_DATE = '2026-03-01';

function razorpayObject(
  razorpayId: string,
  objectType: string,
  createdAtUtc: string,
  amounts: { amount?: bigint; fee?: bigint; gst?: bigint },
  payload: Readonly<Record<string, string>>,
): string {
  const money = (v: bigint | undefined): string => (v === undefined ? 'null' : v.toString());
  return `insert into razorpay_objects
  (tenant_id, razorpay_id, object_type, ingestion_run_id, created_at_rzp,
   amount_paise, fee_paise, gst_on_fee_paise, payload)
values (${lit(f.tenantId)}, ${lit(razorpayId)}, ${lit(objectType)}::razorpay_object_type,
        ${lit(f.runId)}, ${lit(createdAtUtc)}::timestamptz,
        ${money(amounts.amount)}, ${money(amounts.fee)}, ${money(amounts.gst)},
        ${lit(JSON.stringify({ id: razorpayId, ...payload }))}::jsonb);`;
}

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

function scalar<T>(expr: string): T {
  return jsonAt<T>(runOk(`${claims(f)}\n${jsonScalar(expr)}`), 0);
}

function rows<T>(select: string): readonly T[] {
  return jsonAt<T[]>(runOk(`${claims(f)}\n${jsonRows(select)}`), 0);
}

/** The set already derived from this `(tenant, type, id)`, read back after a conflict. */
function existingSetId(write: LedgerSetWrite): string {
  const type =
    write.source_record_type === null
      ? 'null'
      : `${lit(write.source_record_type)}::source_record_type`;
  return scalar<string>(
    `(select id::text from ledger_entry_sets
       where tenant_id = ${lit(write.tenant_id)}
         and source_record_type = ${type}
         and source_record_id = ${write.source_record_id === null ? 'null' : lit(write.source_record_id)})`,
  );
}

const IMBALANCE_IN_MESSAGE = /imbalance (-?\d+) paise/;

/**
 * The whole set in ONE transaction, so a rejection takes every row with it — which
 * is what makes "the duplicate derivation wrote nothing" true rather than hopeful.
 *
 * The unique violation is matched by **constraint name**. A `23505` on any other
 * constraint throws: reporting it as a duplicate derivation would turn a genuine
 * fault into a silent success, and a rename of `ledger_set_derivation_uniq` has to
 * break loudly rather than start writing a second set per Source_Record.
 */
function psqlStore(): LedgerStore {
  return {
    async insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome> {
      const setId = randomUUID();
      const entries: readonly EntryRow[] = write.entries.map((entry) => ({
        id: randomUUID(),
        write: entry,
      }));

      const r = runScript(
        `begin;
${claims(f)}
${setInsert(write, setId)}
${entryInserts(write, setId, entries)}
${sourceInserts(write, entries)}
commit;`,
      );

      const unique = r.errors.find((e) => e.sqlstate === UNIQUE_VIOLATION);
      if (unique !== undefined) {
        if (unique.constraint !== LEDGER_SET_DERIVATION_UNIQ) {
          throw new Error(
            `unique violation on ${unique.constraint ?? 'an unnamed constraint'}, which is not ` +
              `the derivation identity ${LEDGER_SET_DERIVATION_UNIQ}:\n${r.rawErr}`,
          );
        }
        return {
          ok: false,
          kind: 'duplicate_derivation',
          set_id: existingSetId(write),
          constraint: LEDGER_SET_DERIVATION_UNIQ,
        };
      }

      const barrier = r.errors.find(
        (e) => e.sqlstate === INTEGRITY_CONSTRAINT_VIOLATION || e.sqlstate === CHECK_VIOLATION,
      );
      if (barrier !== undefined) {
        const stated = IMBALANCE_IN_MESSAGE.exec(barrier.message);
        return {
          ok: false,
          kind: 'unbalanced',
          imbalance_paise: stated?.[1] === undefined ? 0n : decodePaise(stated[1]),
        };
      }
      if (r.errors.length > 0) {
        throw new Error(`ledger set insert failed:\n${r.rawErr}`);
      }
      return { ok: true, set_id: setId };
    },

    findSourceRecord(tenantId, ref: SourceRef): Promise<LedgerSourceRecord | null> {
      /**
       * `object_type` is compared as text rather than cast to
       * `razorpay_object_type`: three `source_record_type` labels
       * (`ledger_entry_set`, `proposal`, `forecast_component`) have no counterpart in
       * that enum, and a cast would raise instead of matching nothing.
       *
       * The recon report is resolved the same way the reconciliation path will: the
       * `settlement_recon_report` object whose `payload->>'settlement_id'` names this
       * Settlement, which is what `razorpay_recon_report_settlement_idx` serves. No
       * amount is recomputed anywhere in here.
       */
      const found = rows<{
        type: string;
        id: string;
        created_at_rzp: string;
        amount_paise: string | null;
        fee_paise: string | null;
        gst_on_fee_paise: string | null;
        refunded_payment_id: string | null;
        settlement_recon_report_id: string | null;
      }>(
        `select o.object_type::text as type,
                o.razorpay_id as id,
                to_char(o.created_at_rzp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
                  as created_at_rzp,
                o.amount_paise::text as amount_paise,
                o.fee_paise::text as fee_paise,
                o.gst_on_fee_paise::text as gst_on_fee_paise,
                o.payload ->> 'payment_id' as refunded_payment_id,
                (select r.razorpay_id from razorpay_objects r
                  where r.tenant_id = o.tenant_id
                    and r.object_type = 'settlement_recon_report'
                    and r.payload ->> 'settlement_id' = o.razorpay_id
                  limit 1) as settlement_recon_report_id
           from razorpay_objects o
          where o.tenant_id = ${lit(tenantId)}
            and o.razorpay_id = ${lit(ref.id)}
            and o.object_type::text = ${lit(ref.type)}`,
      );

      const row = found[0];
      if (row === undefined) {
        return Promise.resolve(null);
      }
      // Digit text in, `bigint` out. No monetary value passes through `Number(...)`.
      const money = (v: string | null): Paise | null => (v === null ? null : decodePaise(v));
      return Promise.resolve({
        type: ref.type,
        id: row.id,
        created_at_rzp: row.created_at_rzp,
        amount_paise: money(row.amount_paise),
        fee_paise: money(row.fee_paise),
        gst_on_fee_paise: money(row.gst_on_fee_paise),
        refunded_payment_id: row.refunded_payment_id,
        settlement_recon_report_id: row.settlement_recon_report_id,
      });
    },

    findSet() {
      // `reverseSet`'s seam (task 24.1). This file covers derivation and the trial
      // balance; a call here would mean it had started asserting on reversal.
      return Promise.reject(new Error('findSet is task 24.1, tested in its own file'));
    },

    trialBalanceTotals(query: TrialBalanceQuery): Promise<readonly AccountPeriodTotals[]> {
      /**
       * The aggregation of Requirement 2.5. Joined FROM `ledger_entries`, so an
       * account with no entry in the range produces no row at all; joined TO
       * `chart_of_accounts` for the `account_kind` the closing sign rule needs. The
       * range is inclusive at both ends. `SUM` runs over `BIGINT` and the totals
       * leave as digit text.
       */
      const aggregated = rows<{
        account_code: string;
        kind: AccountPeriodTotals['kind'];
        total_debit_paise: string;
        total_credit_paise: string;
      }>(
        `select e.account_code,
                coa.kind::text as kind,
                coalesce(sum(case when e.side = 'debit'
                                  then e.amount_paise::bigint else 0::bigint end), 0)::bigint::text
                  as total_debit_paise,
                coalesce(sum(case when e.side = 'credit'
                                  then e.amount_paise::bigint else 0::bigint end), 0)::bigint::text
                  as total_credit_paise
           from ledger_entries e
           join chart_of_accounts coa
             on coa.tenant_id = e.tenant_id and coa.account_code = e.account_code
          where e.tenant_id = ${lit(query.tenant_id)}
            and e.entry_date >= ${lit(query.from)}::date
            and e.entry_date <= ${lit(query.to)}::date
          group by e.account_code, coa.kind
          order by e.account_code`,
      );

      return Promise.resolve(
        aggregated.map((row) => ({
          account_code: row.account_code,
          kind: row.kind,
          total_debit_paise: decodePaise(row.total_debit_paise),
          total_credit_paise: decodePaise(row.total_credit_paise),
        })),
      );
    },
  };
}

/**
 * Collides `line_no` across the two entries of a set, provoking a unique violation
 * on `ledger_entries (set_id, line_no)` rather than on the derivation identity.
 */
function lineNoColliding(store: LedgerStore): LedgerStore {
  return {
    ...store,
    insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome> {
      return store.insertSet({
        ...write,
        entries: write.entries.map((entry) => ({ ...entry, line_no: 1 })),
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* A psql-backed audit sink, on its own connection                            */
/* -------------------------------------------------------------------------- */

function psqlAuditSink(): LedgerAuditSink & { events: LedgerAuditEvent[] } {
  const sink = {
    events: [] as LedgerAuditEvent[],
    async append(event: LedgerAuditEvent): Promise<void> {
      sink.events.push(event);
      runOk(
        `${claims(f)}
do $ae$ begin perform app.append_audit_event(
  p_tenant_id   => ${lit(event.tenantId)}::uuid,
  p_event_type  => ${lit(event.eventType)},
  p_actor_kind  => ${lit(event.actor.kind)},
  p_actor_id    => ${lit(event.actor.id)},
  p_stage       => null,
  p_outcome     => ${lit(event.outcome)},
  p_proposal_id => null,
  p_source_refs => ${lit(JSON.stringify(event.sourceRefs))}::jsonb,
  p_payload     => ${lit(JSON.stringify(event.payload))}::jsonb,
  p_occurred_at => ${lit(event.occurredAt)}::timestamptz); end $ae$;`,
      );
    },
  };
  return sink;
}

/* -------------------------------------------------------------------------- */
/* Queries the assertions read                                               */
/* -------------------------------------------------------------------------- */

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

/**
 * Every account's `debit − credit` over every persisted entry of this Tenant, read
 * back out of `ledger_entries` as `bigint`. This is the map Requirement 2.8 and
 * property P2 require to be unchanged by a second derivation.
 */
function accountBalances(): Map<string, Paise> {
  const aggregated = rows<{ account_code: string; balance_paise: string }>(
    `select account_code,
            (coalesce(sum(case when side = 'debit' then amount_paise::bigint else 0::bigint end), 0)
           - coalesce(sum(case when side = 'credit' then amount_paise::bigint else 0::bigint end), 0)
             )::bigint::text as balance_paise
       from ledger_entries where tenant_id = ${lit(f.tenantId)}
      group by account_code order by account_code`,
  );
  return new Map(aggregated.map((row) => [row.account_code, decodePaise(row.balance_paise)]));
}

const entryDatesOfSet = (setId: string): readonly string[] =>
  rows<{ entry_date: string }>(
    `select distinct entry_date::text as entry_date from ledger_entries
      where set_id = ${lit(setId)}`,
  ).map((row) => row.entry_date);

function ledger(store: LedgerStore = psqlStore()) {
  return createSemanticLedger({ store, audit: psqlAuditSink(), actor: ACTOR });
}

const ref = (type: SourceRef['type'], id: string): SourceRef => ({ type, id });

/* -------------------------------------------------------------------------- */

describe.skipIf(!reachable)('postFromSource and trialBalance against the real schema', () => {
  beforeAll(() => {
    const accounts = chartOfAccountsSeedRows(f.tenantId)
      .map(
        (a) =>
          `(${lit(a.tenant_id)}, ${lit(a.account_code)}, ${lit(a.account_name)}, ` +
          `${lit(a.kind)}::account_kind, ${a.is_active})`,
      )
      .join(',\n       ');

    // Committed: the store commits its own transactions and the guarantees under
    // test span several sessions.
    runOk(
      [
        provision(f),
        `insert into chart_of_accounts (tenant_id, account_code, account_name, kind, is_active)
values ${accounts};`,
        // 09:30 IST on 2026-02-14.
        razorpayObject(
          PAYMENT_ID,
          'payment',
          '2026-02-14T04:00:00Z',
          { amount: 100_000n, fee: 2_360n, gst: 424n },
          {},
        ),
        razorpayObject(REFUND_ID, 'refund', '2026-02-16T04:00:00Z', { amount: 40_000n }, {
          payment_id: PAYMENT_ID,
        }),
        razorpayObject(SETTLEMENT_ID, 'settlement', '2026-02-20T04:00:00Z', {
          amount: 97_216n,
        }, {}),
        razorpayObject(RECON_REPORT_ID, 'settlement_recon_report', '2026-02-20T05:00:00Z', {}, {
          settlement_id: SETTLEMENT_ID,
        }),
        // Route records are dated outside the February trial-balance ranges below so their
        // committed derivation tests cannot alter those existing balance expectations.
        razorpayObject(TRANSFER_ID, 'transfer', '2027-01-10T04:00:00Z', { amount: 50_000n }, {}),
        razorpayObject(
          TRANSFER_REVERSAL_ID,
          'transfer_reversal',
          '2027-01-11T04:00:00Z',
          { amount: 12_500n },
          { transfer_id: TRANSFER_ID },
        ),
        // 00:30 IST on 2026-03-01, stored as 2026-02-28T19:00:00Z.
        razorpayObject(
          IST_EDGE_PAYMENT_ID,
          'payment',
          '2026-02-28T19:00:00Z',
          { amount: 1_000n },
          {},
        ),
      ].join('\n'),
    );
  });

  /* ------------------------------------------------------------------------ */
  /* 1. The first derivation                                                  */
  /* ------------------------------------------------------------------------ */

  describe('a first derivation from a stored Payment', () => {
    let setId = '';

    beforeAll(async () => {
      const result = await ledger().postFromSource(f.tenantId, ref('payment', PAYMENT_ID));
      expect(result).toMatchObject({ ok: true, created: true });
      setId = result.ok ? result.set_id : '';
    });

    it('commits the 4-entry set with the stored amounts', () => {
      const row = scalar<{
        entry_count: number;
        total_debit_paise: string;
        total_credit_paise: string;
        source_record_type: string;
        source_record_id: string;
        entry_date: string;
      }>(
        `(select to_jsonb(x) from (
            select entry_count, total_debit_paise::text, total_credit_paise::text,
                   source_record_type::text, source_record_id, entry_date::text
              from ledger_entry_sets where id = ${lit(setId)}) x)`,
      );
      expect(row.entry_count).toBe(4);
      expect(row.total_debit_paise).toBe('100000');
      expect(row.total_credit_paise).toBe('100000');
      expect(row.source_record_type).toBe('payment');
      expect(row.source_record_id).toBe(PAYMENT_ID);
      // The IST calendar date of created_at_rzp (09:30 IST on the 14th).
      expect(row.entry_date).toBe(PAYMENT_DATE);
      expect(entryDatesOfSet(setId)).toEqual([PAYMENT_DATE]);
    });

    it('posts settlement_pending at gross minus fee minus GST, read from the stored row', () => {
      const posted = rows<{ account_code: string; side: string; amount_paise: string }>(
        `select account_code, side::text as side, amount_paise::text as amount_paise
           from ledger_entries where set_id = ${lit(setId)} order by line_no`,
      );
      expect(posted).toEqual([
        { account_code: 'settlement_pending', side: 'debit', amount_paise: '97216' },
        { account_code: 'razorpay_fee_expense', side: 'debit', amount_paise: '2360' },
        { account_code: 'gst_input_credit', side: 'debit', amount_paise: '424' },
        { account_code: 'revenue', side: 'credit', amount_paise: '100000' },
      ]);
    });

    it('dates a Payment created at 19:00 UTC on its IST date, the following day', async () => {
      const result = await ledger().postFromSource(
        f.tenantId,
        ref('payment', IST_EDGE_PAYMENT_ID),
      );
      expect(result).toMatchObject({ ok: true, created: true });
      if (!result.ok) {
        return;
      }
      expect(entryDatesOfSet(result.set_id)).toEqual([IST_EDGE_DATE]);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* 2. The second derivation: the real ledger_set_derivation_uniq            */
  /* ------------------------------------------------------------------------ */

  describe('a second derivation from the same Source_Record', () => {
    let before = new Map<string, Paise>();
    let after = new Map<string, Paise>();
    let entriesBefore = 0;
    let setsBefore = 0;
    let rejectionsBefore = 0;
    let second: Awaited<ReturnType<ReturnType<typeof ledger>['postFromSource']>> | null = null;

    beforeAll(async () => {
      before = accountBalances();
      entriesBefore = entryCount();
      setsBefore = setCount();
      rejectionsBefore = rejectionEventCount();

      second = await ledger().postFromSource(f.tenantId, ref('payment', PAYMENT_ID));

      after = accountBalances();
    });

    it('returns ok with created false, naming the retained set (Requirement 2.8)', () => {
      const retained = scalar<string>(
        `(select id::text from ledger_entry_sets
           where tenant_id = ${lit(f.tenantId)} and source_record_id = ${lit(PAYMENT_ID)})`,
      );
      expect(second).toEqual({ ok: true, set_id: retained, created: false });
    });

    it('creates 0 additional Ledger_Entries and 0 additional sets', () => {
      expect(entryCount()).toBe(entriesBefore);
      expect(setCount()).toBe(setsBefore);
      expect(
        scalar<number>(
          `(select count(*)::int from ledger_entry_sets
             where tenant_id = ${lit(f.tenantId)} and source_record_id = ${lit(PAYMENT_ID)})`,
        ),
      ).toBe(1);
    });

    it('leaves every account balance unchanged', () => {
      expect(after).toEqual(before);
      expect(after.get('settlement_pending')).toBe(97_216n + 1_000n);
      expect(after.get('revenue')).toBe(-101_000n);
    });

    it('records no ledger_set_rejected Audit_Event: the no-op refused nothing', () => {
      expect(rejectionEventCount()).toBe(rejectionsBefore);
      expect(rejectionsBefore).toBe(0);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* 3. What is NOT idempotency                                               */
  /* ------------------------------------------------------------------------ */

  describe('a unique violation on a different constraint', () => {
    it('throws instead of being reported as a duplicate derivation', async () => {
      const entriesBefore = entryCount();
      // Two entries at line_no 1 violate `ledger_entries (set_id, line_no)`, also a
      // 23505. Matching on SQLSTATE alone would call this a successful no-op.
      await expect(
        ledger(lineNoColliding(psqlStore())).postFromSource(
          f.tenantId,
          ref('settlement', SETTLEMENT_ID),
        ),
      ).rejects.toThrow(/not the derivation identity/);
      expect(entryCount()).toBe(entriesBefore);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* 4. Route Source_Records and unresolved requests                          */
  /* ------------------------------------------------------------------------ */

  describe('Route Source_Records and unresolved requests', () => {
    it('commits Transfer and partial Transfer_Reversal at their own stored amounts', async () => {
      const transfer = await ledger().postFromSource(
        f.tenantId,
        ref('transfer', TRANSFER_ID),
      );
      const reversal = await ledger().postFromSource(
        f.tenantId,
        ref('transfer_reversal', TRANSFER_REVERSAL_ID),
      );
      expect(transfer).toMatchObject({ ok: true, created: true });
      expect(reversal).toMatchObject({ ok: true, created: true });
      if (!transfer.ok || !reversal.ok) {
        return;
      }

      const routeEntries = rows<{
        source_record_type: string;
        account_code: string;
        side: string;
        amount_paise: string;
      }>(
        `select s.source_record_type::text, e.account_code, e.side::text,
                e.amount_paise::text
           from ledger_entries e
           join ledger_entry_sets s on s.id = e.set_id
          where s.id in (${lit(transfer.set_id)}, ${lit(reversal.set_id)})
          order by s.source_record_type::text, e.line_no`,
      );
      expect(routeEntries).toEqual([
        {
          source_record_type: 'transfer',
          account_code: 'seller_payout_clearing',
          side: 'debit',
          amount_paise: '50000',
        },
        {
          source_record_type: 'transfer',
          account_code: 'settlement_pending',
          side: 'credit',
          amount_paise: '50000',
        },
        {
          source_record_type: 'transfer_reversal',
          account_code: 'settlement_pending',
          side: 'debit',
          amount_paise: '12500',
        },
        {
          source_record_type: 'transfer_reversal',
          account_code: 'seller_payout_clearing',
          side: 'credit',
          amount_paise: '12500',
        },
      ]);
    });

    it('refuses a Source_Record this Tenant has not ingested', async () => {
      await expect(
        ledger().postFromSource(f.tenantId, ref('payment', 'pay_db_never_ingested')),
      ).rejects.toThrow(/no stored payment/);
    });
  });

  /* ------------------------------------------------------------------------ */
  /* 5. The trial balance, over real rows                                     */
  /* ------------------------------------------------------------------------ */

  describe('the trial balance', () => {
    beforeAll(async () => {
      // The Refund (16 Feb) and the Settlement (20 Feb) complete the February shape.
      expect(
        await ledger().postFromSource(f.tenantId, ref('refund', REFUND_ID)),
      ).toMatchObject({ ok: true, created: true });
      expect(
        await ledger().postFromSource(f.tenantId, ref('settlement', SETTLEMENT_ID)),
      ).toMatchObject({ ok: true, created: true });
    });

    it('links the Refund and the refunded Payment, and the Settlement and its report', () => {
      const links = rows<{ source_record_type: string; source_record_id: string }>(
        `select distinct s.source_record_type::text as source_record_type, s.source_record_id
           from ledger_entry_sources s
           join ledger_entries e on e.id = s.entry_id
           join ledger_entry_sets st on st.id = e.set_id
          where st.tenant_id = ${lit(f.tenantId)}
            and st.source_record_id in (${lit(REFUND_ID)}, ${lit(SETTLEMENT_ID)})
          order by s.source_record_id`,
      );
      expect(links).toEqual([
        { source_record_type: 'payment', source_record_id: PAYMENT_ID },
        { source_record_type: 'refund', source_record_id: REFUND_ID },
        { source_record_type: 'settlement', source_record_id: SETTLEMENT_ID },
        { source_record_type: 'settlement_recon_report', source_record_id: RECON_REPORT_ID },
      ]);
    });

    it('reports every in-range account once, with the closing sign rule per kind', async () => {
      const balance = await ledger().trialBalance(f.tenantId, '2026-02-01', '2026-02-28');

      expect(
        balance.rows.map((row) => [
          row.account_code,
          row.kind,
          row.total_debit_paise,
          row.total_credit_paise,
          row.closing_balance_paise,
        ]),
      ).toEqual([
        // asset, expense: debits - credits. income: credits - debits.
        ['bank', 'asset', 97_216n, 0n, 97_216n],
        ['gst_input_credit', 'asset', 424n, 0n, 424n],
        ['razorpay_fee_expense', 'expense', 2_360n, 0n, 2_360n],
        ['revenue', 'income', 40_000n, 100_000n, 60_000n],
        ['settlement_pending', 'asset', 97_216n, 137_216n, -40_000n],
      ]);
      expect(new Set(balance.rows.map((r) => r.account_code)).size).toBe(balance.rows.length);
      // The IST-edge Payment is dated 1 March, so February omits it entirely.
      expect(balance.rows.every((r) => r.total_debit_paise + r.total_credit_paise > 0n)).toBe(
        true,
      );
    });

    it('holds summed debit equal to summed credit in exact integer paise', async () => {
      const balance = await ledger().trialBalance(f.tenantId, '2026-02-01', '2026-02-28');
      expect(trialBalanceDebitTotalPaise(balance)).toBe(237_216n);
      expect(trialBalanceCreditTotalPaise(balance)).toBe(
        trialBalanceDebitTotalPaise(balance),
      );
      for (const row of balance.rows) {
        // bigint out of SQL, never through `Number(...)`.
        expect(typeof row.total_debit_paise).toBe('bigint');
        expect(typeof row.closing_balance_paise).toBe('bigint');
      }
    });

    it('returns only the Payment set for a single-day range on its entry date', async () => {
      const balance = await ledger().trialBalance(f.tenantId, PAYMENT_DATE, PAYMENT_DATE);
      expect(balance.rows.map((r) => r.account_code)).toEqual([
        'gst_input_credit',
        'razorpay_fee_expense',
        'revenue',
        'settlement_pending',
      ]);
      expect(trialBalanceDebitTotalPaise(balance)).toBe(100_000n);
      expect(trialBalanceCreditTotalPaise(balance)).toBe(100_000n);
    });

    it('returns zero accounts and 0n totals for a range entirely outside the data', async () => {
      const balance = await ledger().trialBalance(f.tenantId, '2019-01-01', '2019-12-31');
      expect(balance.rows).toEqual([]);
      expect(trialBalanceDebitTotalPaise(balance)).toBe(0n);
      expect(trialBalanceCreditTotalPaise(balance)).toBe(0n);
    });

    it('includes an entry dated exactly on either boundary', async () => {
      // Both bounds coincide with entry dates: the Payment on the 14th and the
      // Settlement on the 20th. Inclusive means both are in.
      const inclusive = await ledger().trialBalance(f.tenantId, PAYMENT_DATE, SETTLEMENT_DATE);
      expect(trialBalanceDebitTotalPaise(inclusive)).toBe(237_216n);
      expect(inclusive.rows.map((r) => r.account_code)).toContain('bank');

      // Moving each bound one day inward drops the set that sat on it, which is what
      // makes the inclusion above a real assertion rather than a coincidence.
      const inward = await ledger().trialBalance(f.tenantId, '2026-02-15', '2026-02-19');
      expect(inward.rows.map((r) => r.account_code)).toEqual(['revenue', 'settlement_pending']);
      expect(trialBalanceDebitTotalPaise(inward)).toBe(40_000n);
      expect(trialBalanceCreditTotalPaise(inward)).toBe(40_000n);
    });

    it('crosses a month boundary to pick up the IST-edge Payment', async () => {
      const march = await ledger().trialBalance(f.tenantId, IST_EDGE_DATE, IST_EDGE_DATE);
      expect(march.rows.map((r) => [r.account_code, r.closing_balance_paise])).toEqual([
        ['revenue', 1_000n],
        ['settlement_pending', 1_000n],
      ]);
    });
  });
});
