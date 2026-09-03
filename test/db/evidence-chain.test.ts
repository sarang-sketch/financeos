/**
 * The Evidence_Chain builder against Supabase local (task 9.1).
 *
 * `src/evidence/chain-builder.test.ts` proves the composition funnel and the
 * keyset walk in process, over a fake store. What it cannot prove is what the
 * three tables actually hold, and four of this task's guarantees are statements
 * about the database:
 *
 * 1. **A whole chain commits as one unit** — header, 12 steps, 14 citations —
 *    and reads back with every step's operands and results intact. `operands` is
 *    `JSONB`, so this is also where the round trip is checked **structurally**:
 *    Postgres reorders object keys and normalises whitespace, so nothing here
 *    asserts on the text of the column.
 * 2. **Pagination is total and lossless at the 500 boundary** — exactly 500, 501
 *    and 1000 identifiers — with the ordering and the grouping done in SQL, which
 *    is the half a fake store cannot vouch for. Property P6 (task 9.3) asserts
 *    `source_count === concatenatedPages().length`; this file establishes it holds
 *    against real rows first.
 * 3. **`source_count >= 1` is enforced by the database**, under the exact
 *    constraint name `EVIDENCE_SOURCE_COUNT_CHECK` declares, so the by-name match
 *    in the store adapter is matched against reality rather than against a guess.
 * 4. **A chain belonging to another Tenant reads as absent**, not as an error.
 *
 * The SET-9281 fixture is the specimen for (1): its twelve steps, its 14
 * `(record, field)` citations across 8 identifiers, and its `as_of` are design.md's
 * worked example, so a chain that survives this round trip is one the settlement
 * tool of task 12.1 can actually persist. The citations are **derived from the
 * steps** — every `{ kind: 'source' }` operand, with the timestamp of the record it
 * names — which is exactly the relationship Requirement 12.2 asks for between the
 * steps and the cited identifiers.
 *
 * ## Reading steps that carry no tenant_id
 *
 * FINDING 1 of `20260101000006_evidence_chains.sql`: `evidence_chain_steps` has no
 * `tenant_id` column, so the step query below **joins `evidence_chains`** and
 * filters the Tenant there. That join is the only tenant scope the table has, and
 * the isolation test at the bottom is what proves it works.
 *
 * NOTE ON CLEANUP: the chains here have to commit, so their rows stay behind. Every
 * identifier is freshly generated, so runs never collide; `npx supabase db reset`
 * clears them. Every count below is scoped to the fixture Tenant or to one
 * `chain_id`, never global.
 *
 * Requirements: 12.2, 12.3, 12.5.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  createEvidenceChainBuilder,
  EVIDENCE_SOURCE_COUNT_CHECK,
  type EvidenceChainHeaderRow,
  type EvidenceChainInput,
  type EvidenceChainStepRow,
  type EvidenceChainStore,
  type EvidenceChainWrite,
  type EvidenceChainWriteOutcome,
  type EvidenceSourceCitation,
  type EvidenceSourcePage,
  type EvidenceSourcePageQuery,
  type EvidenceSourceRow,
  type EvidenceStep,
  MAX_SOURCE_PAGE_SIZE,
} from '@/evidence/chain-builder';
import type { SourceRef } from '@/ledger/posting-rules';
import { findRecord, SET_9281 } from '../fixtures/set-9281';
import { claims, database, jsonAt, jsonScalar, lit, newFixture, provision, runOk, runScript } from './pg';

const reachable = database().reachable;
const f = newFixture();
const other = newFixture();

/** `check_violation`: what the `source_count >= 1` CHECK raises. */
const CHECK_VIOLATION = '23514';

/** Postgres renders TIMESTAMPTZ in the session time zone; this pins ISO-8601 UTC ms. */
const ISO_MS = (expr: string): string =>
  `to_char(${expr} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/* -------------------------------------------------------------------------- */
/* A psql-backed EvidenceChainStore                                           */
/* -------------------------------------------------------------------------- */

function headerInsert(write: EvidenceChainWrite, chainId: string): string {
  return `insert into evidence_chains
  (id, tenant_id, figure_paise, source_count, as_of, produced_by)
values (${lit(chainId)}, ${lit(write.tenant_id)}, ${write.figure_paise}, ${write.source_count},
        ${lit(write.as_of)}::timestamptz, ${lit(write.produced_by)});`;
}

function stepInserts(write: EvidenceChainWrite, chainId: string): string {
  const values = write.steps
    .map(
      (step) =>
        `(${lit(chainId)}, ${step.step_index}, ${lit(step.operation)}::evidence_operation, ` +
        `${lit(step.operands_json)}::jsonb, ` +
        `${step.result_paise === null ? 'null' : step.result_paise}, ` +
        `${step.note === null ? 'null' : lit(step.note)})`,
    )
    .join(',\n       ');
  return `insert into evidence_chain_steps
  (chain_id, step_index, operation, operands, result_paise, note)
values ${values};`;
}

function citationInserts(write: EvidenceChainWrite, chainId: string): string {
  const values = write.sources
    .map(
      (source) =>
        `(${lit(chainId)}, ${lit(source.tenant_id)}, ` +
        `${lit(source.source_record_type)}::source_record_type, ${lit(source.source_record_id)}, ` +
        `${lit(source.field)}, ${lit(source.record_updated_at)}::timestamptz)`,
    )
    .join(',\n       ');
  return `insert into evidence_chain_sources
  (chain_id, tenant_id, source_record_type, source_record_id, field, record_updated_at)
values ${values};`;
}

/** Emit one JSON line for `select`, with the array order stated rather than assumed. */
function orderedRows(select: string, orderBy: string): string {
  return `select coalesce(jsonb_agg(to_jsonb(t) order by ${orderBy}), '[]'::jsonb)::text
  from (${select}) t;`;
}

/**
 * The store the builder writes and reads through, over `psql`.
 *
 * The whole chain is one transaction, so a rejected statement takes the header,
 * every step and every citation with it: a half-written chain is not a state this
 * adapter can produce.
 */
function psqlStore(): EvidenceChainStore {
  return {
    insertChain(write: EvidenceChainWrite): Promise<EvidenceChainWriteOutcome> {
      const chainId = randomUUID();
      const r = runScript(
        `begin;
${claims(f)}
${headerInsert(write, chainId)}
${stepInserts(write, chainId)}
${citationInserts(write, chainId)}
commit;`,
      );
      // By constraint NAME, not merely by SQLSTATE: a `paise` domain range
      // violation is also 23514 and is a fault, not an ungrounded figure.
      const grounding = r.errors.find(
        (e) => e.sqlstate === CHECK_VIOLATION && e.constraint === EVIDENCE_SOURCE_COUNT_CHECK,
      );
      if (grounding !== undefined) {
        return Promise.resolve({
          ok: false as const,
          kind: 'ungrounded_figure' as const,
          constraint: EVIDENCE_SOURCE_COUNT_CHECK,
        });
      }
      if (r.errors.length > 0) {
        throw new Error(`evidence chain insert failed:\n${r.rawErr}`);
      }
      return Promise.resolve({ ok: true as const, chain_id: chainId });
    },

    findChain(tenantId: string, chainId: string): Promise<EvidenceChainHeaderRow | null> {
      // `coalesce(..., 'null'::jsonb)` so a chain this Tenant does not have emits the
      // line `null` rather than no line at all: absent is an answer, not an error.
      const r = runOk(
        `${claims(f)}
${jsonScalar(`coalesce((select to_jsonb(x) from (
  select id::text as chain_id, figure_paise::text as figure_paise, source_count,
         ${ISO_MS('as_of')} as as_of, produced_by
    from evidence_chains
   where id = ${lit(chainId)} and tenant_id = ${lit(tenantId)}) x), 'null'::jsonb)`)}`,
      );
      return Promise.resolve(jsonAt<EvidenceChainHeaderRow | null>(r, 0));
    },

    listSteps(tenantId: string, chainId: string): Promise<readonly EvidenceChainStepRow[]> {
      // FINDING 1: evidence_chain_steps carries no tenant_id, so the scope comes
      // from the header through this join.
      const r = runOk(
        `${claims(f)}
${orderedRows(
  `select s.step_index, s.operation::text as operation, s.operands,
          s.result_paise::text as result_paise, s.note
     from evidence_chain_steps s
     join evidence_chains c on c.id = s.chain_id
    where s.chain_id = ${lit(chainId)} and c.tenant_id = ${lit(tenantId)}`,
  't.step_index',
)}`,
      );
      return Promise.resolve(jsonAt<readonly EvidenceChainStepRow[]>(r, 0));
    },

    listSourcePage(query: EvidenceSourcePageQuery): Promise<readonly EvidenceSourceRow[]> {
      const after = query.after;
      // The keyset predicate, in the same collated expressions as the ORDER BY, so
      // the resume point and the order cannot disagree.
      const resume =
        after === null
          ? ''
          : `and (source_record_type::text collate "C" > ${lit(after.type)}::text collate "C"
        or (source_record_type::text collate "C" = ${lit(after.type)}::text collate "C"
            and source_record_id collate "C" > ${lit(after.id)}::text collate "C"))`;
      const r = runOk(
        `${claims(f)}
${orderedRows(
  `select source_record_type::text as source_record_type,
          source_record_id,
          array_agg(field order by field collate "C") as fields,
          ${ISO_MS('max(record_updated_at)')} as record_updated_at
     from evidence_chain_sources
    where chain_id = ${lit(query.chain_id)} and tenant_id = ${lit(query.tenant_id)}
      ${resume}
    group by source_record_type, source_record_id
    order by source_record_type::text collate "C", source_record_id collate "C"
    limit ${query.limit}`,
  't.source_record_type collate "C", t.source_record_id collate "C"',
)}`,
      );
      return Promise.resolve(jsonAt<readonly EvidenceSourceRow[]>(r, 0));
    },
  };
}

const builder = () => createEvidenceChainBuilder({ store: psqlStore(), tenantId: f.tenantId });

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

function scalar<T>(expr: string): T {
  const r = runOk(`${claims(f)}\n${jsonScalar(expr)}`);
  return jsonAt<T>(r, 0);
}

const chainCount = (): number =>
  scalar<number>(`(select count(*)::int from evidence_chains where tenant_id = ${lit(f.tenantId)})`);

const stepCount = (chainId: string): number =>
  scalar<number>(
    `(select count(*)::int from evidence_chain_steps where chain_id = ${lit(chainId)})`,
  );

const citationCount = (chainId: string): number =>
  scalar<number>(
    `(select count(*)::int from evidence_chain_sources where chain_id = ${lit(chainId)}
        and tenant_id = ${lit(f.tenantId)})`,
  );

/* -------------------------------------------------------------------------- */
/* The SET-9281 specimen                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The citations the twelve steps imply: one per `{ kind: 'source' }` operand,
 * carrying the `record_updated_at` of the record it names. 14 pairs across 8
 * identifiers.
 */
function citationsFromSteps(steps: readonly EvidenceStep[]): readonly EvidenceSourceCitation[] {
  const citations: EvidenceSourceCitation[] = [];
  for (const step of steps) {
    for (const operand of step.operands) {
      if (operand.kind !== 'source') {
        continue;
      }
      const record = findRecord(SET_9281, operand.ref);
      if (record === undefined) {
        throw new Error(`the fixture cites ${operand.ref.type} ${operand.ref.id} but has no record`);
      }
      citations.push({
        ref: operand.ref,
        field: operand.field,
        record_updated_at: record.record_updated_at,
      });
    }
  }
  return citations;
}

const SET_9281_INPUT: EvidenceChainInput = {
  produced_by: SET_9281.chain.produced_by,
  figure_paise: SET_9281.chain.figure_paise,
  steps: SET_9281.chain.steps,
  sources: citationsFromSteps(SET_9281.chain.steps),
};

/* -------------------------------------------------------------------------- */
/* A synthetic wide chain, for the pagination boundary                        */
/* -------------------------------------------------------------------------- */

const UPDATED = '2026-07-28T00:00:00.000Z';

/** One `sum` step over `total` Payment amounts: `total` identifiers, one field each. */
function wideChain(total: number): EvidenceChainInput {
  // One prefix per chain, so identifiers are unique across runs while the order
  // within the chain is decided by the counter alone.
  const prefix = randomUUID().slice(0, 8);
  const refs: SourceRef[] = Array.from({ length: total }, (_unused, index) => ({
    type: 'payment' as const,
    // Fixed width so the collated text order is the numeric order, and counted
    // downwards so the SQL ORDER BY has something to do.
    id: `pay_${prefix}_${String(total - index).padStart(6, '0')}`,
  }));
  return {
    produced_by: 'get_cash_position',
    figure_paise: BigInt(total),
    steps: [
      {
        index: 1,
        operation: 'sum',
        operands: refs.map((ref) => ({ kind: 'source' as const, ref, field: 'amount' })),
        result_paise: BigInt(total),
        note: `Σ ${total} Payment amounts`,
      },
    ],
    sources: refs.map((ref) => ({ ref, field: 'amount', record_updated_at: UPDATED })),
  };
}

async function pagesOf(chainId: string, pageSize?: number): Promise<readonly EvidenceSourcePage[]> {
  const pages: EvidenceSourcePage[] = [];
  for await (const page of builder().sourcePages(chainId, pageSize)) {
    pages.push(page);
  }
  return pages;
}

/* -------------------------------------------------------------------------- */

describe.skipIf(!reachable)('Evidence_Chain persistence against the real schema', () => {
  beforeAll(() => {
    runOk(provision(f));
    runOk(provision(other));
  });

  describe('the SET-9281 worked example, persisted and read back', () => {
    let chainId = '';

    beforeAll(async () => {
      const result = await builder().build(SET_9281_INPUT);
      expect(result.ok).toBe(true);
      if (result.ok) {
        chainId = result.evidence.evidence_chain_id;
      }
    });

    it('committed one header, twelve steps and fourteen citations', () => {
      expect(chainCount()).toBe(1);
      expect(stepCount(chainId)).toBe(12);
      // 3 Payments × (amount, fee, tax) + refund + chargeback + 2 adjustments +
      // the Settlement = 14 (record, field) pairs.
      expect(citationCount(chainId)).toBe(14);
    });

    it('recorded the figure, the identifier count and the newest contributing record', () => {
      const row = scalar<{
        figure_paise: string;
        source_count: number;
        as_of: string;
        produced_by: string;
      }>(
        `(select to_jsonb(x) from (
            select figure_paise::text as figure_paise, source_count,
                   ${ISO_MS('as_of')} as as_of, produced_by
              from evidence_chains where id = ${lit(chainId)}) x)`,
      );
      expect(row.figure_paise).toBe('0');
      // 8 identifiers, not 14 citation rows (Requirement 12.2).
      expect(row.source_count).toBe(SET_9281.chain.source_count);
      expect(row.as_of).toBe(SET_9281.chain.as_of);
      expect(row.produced_by).toBe('get_settlement_reconciliation');
    });

    it('reads back every step in order with its operands and results intact', async () => {
      const view = await builder().read(chainId);
      expect(view).not.toBeNull();
      if (view === null) {
        return;
      }
      expect(view.figure_paise).toBe(0n);
      expect(view.source_count).toBe(8);
      expect(view.as_of).toBe(SET_9281.chain.as_of);
      expect(view.steps).toHaveLength(12);
      expect(view.steps.map((s) => s.index)).toEqual([...Array(12).keys()].map((i) => i + 1));
      expect(view.steps.map((s) => s.operation)).toEqual(
        SET_9281.chain.steps.map((s) => s.operation),
      );
      expect(view.steps.map((s) => s.result_paise)).toEqual(
        SET_9281.chain.steps.map((s) => s.result_paise),
      );
      // Structural, not textual: JSONB reorders keys and normalises whitespace.
      expect(view.steps.map((s) => s.operands)).toEqual(
        SET_9281.chain.steps.map((s) => s.operands),
      );
      expect(view.steps.map((s) => s.note)).toEqual(SET_9281.chain.steps.map((s) => s.note));
    });

    it('pages its 8 identifiers on one page, each exactly once', async () => {
      const pages = await pagesOf(chainId);
      expect(pages).toHaveLength(1);
      const ids = pages.flatMap((page) => page.sources.map((s) => s.ref.id));
      expect(ids).toHaveLength(8);
      expect(new Set(ids).size).toBe(8);
      expect([...new Set(SET_9281.chain.sources.map((s) => s.id))].sort()).toEqual([...ids].sort());
      expect(pages[0]?.source_count).toBe(8);
    });

    it('reports the fields cited for each identifier', async () => {
      const page = await builder().sourcePage(chainId);
      const payment = page?.sources.find((s) => s.ref.id === 'pay_SYNTHETIC92811');
      expect(payment?.fields).toEqual(['amount', 'fee', 'tax']);
      const settlement = page?.sources.find((s) => s.ref.type === 'settlement');
      expect(settlement?.fields).toEqual(['amount']);
    });

    it('reports every identifier as fresh, because as_of is the newest of them', async () => {
      const page = await builder().sourcePage(chainId);
      expect(page?.sources.every((s) => s.as_of === SET_9281.chain.as_of)).toBe(true);
      expect(page?.sources.some((s) => s.stale)).toBe(false);
    });

    it('marks an identifier stale once a citation carries a newer record_updated_at', () => {
      // The live half of Requirement 12.5's stale check belongs to whoever renders
      // the drill-down (see the module doc comment); what is asserted here is that
      // the comparison this module exposes does fire when the two differ. A newly
      // read field of an already-cited record is a new row, and it does not change
      // the identifier count.
      runOk(
        `${claims(f)}
insert into evidence_chain_sources
  (chain_id, tenant_id, source_record_type, source_record_id, field, record_updated_at)
values (${lit(chainId)}, ${lit(f.tenantId)}, 'settlement_recon_report',
        'pay_SYNTHETIC92811', 'credit', '2026-08-01T09:00:00.000Z'::timestamptz);`,
      );
      const page = scalar<{ record_updated_at: string }>(
        `(select to_jsonb(x) from (
            select ${ISO_MS('max(record_updated_at)')} as record_updated_at
              from evidence_chain_sources
             where chain_id = ${lit(chainId)} and source_record_id = 'pay_SYNTHETIC92811') x)`,
      );
      expect(page.record_updated_at).toBe('2026-08-01T09:00:00.000Z');
      expect(page.record_updated_at > SET_9281.chain.as_of).toBe(true);
    });

    it('still counts 8 identifiers after that fifteenth citation row', async () => {
      const pages = await pagesOf(chainId);
      const ids = pages.flatMap((page) => page.sources.map((s) => s.ref.id));
      expect(citationCount(chainId)).toBe(15);
      expect(new Set(ids).size).toBe(8);
      const stale = pages.flatMap((page) => page.sources.filter((s) => s.stale));
      expect(stale).toHaveLength(1);
      expect(stale[0]?.ref.id).toBe('pay_SYNTHETIC92811');
    });
  });

  describe('pagination at the 500 boundary', () => {
    const built = new Map<number, string>();

    beforeAll(async () => {
      for (const total of [500, 501, 1000]) {
        const result = await builder().build(wideChain(total));
        expect(result.ok).toBe(true);
        if (result.ok) {
          built.set(total, result.evidence.evidence_chain_id);
        }
      }
    }, 300_000);

    it.each([
      [500, [500]],
      [501, [500, 1]],
      [1000, [500, 500]],
    ])('pages %i stored identifiers as %j, each exactly once', async (total, expected) => {
      const chainId = built.get(total) ?? '';
      const pages = await pagesOf(chainId);

      expect(pages.map((p) => p.sources.length)).toEqual(expected);
      expect(pages.every((p) => p.sources.length <= MAX_SOURCE_PAGE_SIZE)).toBe(true);

      const ids = pages.flatMap((page) => page.sources.map((s) => s.ref.id));
      // Requirement 12.2: no identifier omitted, and none repeated across pages.
      expect(ids).toHaveLength(total);
      expect(new Set(ids).size).toBe(total);
      // What property P6 (task 9.3) asserts at the tool boundary.
      expect(pages[0]?.source_count).toBe(total);
      // The order is total, so concatenated pages are globally ascending.
      expect([...ids].sort()).toEqual(ids);
    });

    it('pages the same 1000 identifiers at the UI page size of 100', async () => {
      const pages = await pagesOf(built.get(1000) ?? '', 100);
      expect(pages.map((p) => p.sources.length)).toEqual(Array.from({ length: 10 }, () => 100));
      const ids = pages.flatMap((page) => page.sources.map((s) => s.ref.id));
      expect(new Set(ids).size).toBe(1000);
    });
  });

  describe('an ungrounded figure', () => {
    it('is refused by the database under the constraint name the store matches', () => {
      // The by-name match in `psqlStore` is only as good as the name, so the name
      // is asserted against the live schema rather than assumed.
      const r = runScript(
        `begin;
${claims(f)}
insert into evidence_chains (tenant_id, figure_paise, source_count, as_of, produced_by)
values (${lit(f.tenantId)}, 100, 0, now(), 'get_cash_position');
rollback;`,
      );
      const violation = r.errors.find((e) => e.sqlstate === CHECK_VIOLATION);
      expect(violation?.constraint).toBe(EVIDENCE_SOURCE_COUNT_CHECK);
    });

    it('never reaches a statement from the builder', async () => {
      const before = chainCount();
      await expect(
        builder().build({ ...SET_9281_INPUT, sources: [] }),
      ).rejects.toThrow(/at least 1 Source_Record/);
      expect(chainCount()).toBe(before);
    });
  });

  describe('incomplete evidence writes nothing', () => {
    it('returns the per-type counts and persists no chain', async () => {
      const before = chainCount();
      const result = await builder().build({
        ...SET_9281_INPUT,
        unreadable: [
          { type: 'settlement_recon_report', id: SET_9281.recon_report_id },
          { type: 'settlement', id: SET_9281.settlement_id },
        ],
      });
      expect(result).toEqual({
        ok: false,
        kind: 'incomplete_evidence',
        unavailable: [
          { type: 'settlement', count: 1 },
          { type: 'settlement_recon_report', count: 1 },
        ],
      });
      expect(chainCount()).toBe(before);
    });
  });

  describe('Tenant isolation', () => {
    it('reads another Tenant chain as absent, not as an error', async () => {
      const mine = await builder().build(wideChain(3));
      expect(mine.ok).toBe(true);
      if (!mine.ok) {
        return;
      }
      const theirs = createEvidenceChainBuilder({
        store: psqlStore(),
        tenantId: other.tenantId,
      });
      // Zero rows, not a rejection: an error naming the chain would confirm it
      // exists (Requirement 14.4).
      await expect(theirs.read(mine.evidence.evidence_chain_id)).resolves.toBeNull();
      await expect(theirs.sourcePage(mine.evidence.evidence_chain_id)).resolves.toBeNull();
      // And the steps are unreachable too, though they carry no tenant_id at all.
      const steps = await psqlStore().listSteps(
        other.tenantId,
        mine.evidence.evidence_chain_id,
      );
      expect(steps).toEqual([]);
    });
  });
});
