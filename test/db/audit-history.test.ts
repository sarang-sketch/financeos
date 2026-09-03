/**
 * Audit_Log history retrieval against Supabase local (task 25.4, Requirement 13.6,
 * 13.7).
 *
 * `src/audit/history.test.ts` pins the page assembly, the ordering contract and the
 * stage classification in process. This file answers the three questions that cannot
 * be answered in process:
 *
 * | Claim | Mechanism | Requirement |
 * |---|---|---|
 * | both statements plan as exported, with 3 and 1 parameters and no Tenant among them | `PREPARE` over the exact text + `pg_prepared_statements` | 13.6, 13.7, 14.1 |
 * | the order really is ascending timestamp then ascending sequence number | 6 real appends whose timestamps disagree with their sequence numbers | 13.6 |
 * | `source_record_refs @> $1` selects exactly the Audit_Events referencing the record | an unrelated ref and a multi-ref event in the same Audit_Log | 13.6 |
 * | that containment is what the GIN index serves | `EXPLAIN` with `enable_seqscan` off | 13.6 |
 * | pages of at most 100 with a further-events indicator, no trailing empty page | three consecutive pages of a 5-event history | 13.6 |
 * | exactly one Audit_Event per completed stage, absent stages named | 3 of 7 stages appended, plus a non-stage event citing the Proposal | 13.7 |
 * | a read-back Audit_Event carries what was appended | the page compared against the draft | 13.10 |
 *
 * Every script is rolled back: `audit_events` is append-only and revokes `DELETE`, so
 * a committed row could never be cleaned up.
 *
 * Requirements: 13.6, 13.7.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  ACTION_PIPELINE_STAGES,
  AUDIT_EVENT_APPEND_SQL,
  type AuditEventDraft,
  auditEventAppendParams,
} from '@/audit/audit-service';
import {
  AUDIT_PROPOSAL_HISTORY_SQL,
  AUDIT_SOURCE_HISTORY_SQL,
  type AuditEventRow,
  auditEventsFromRows,
  auditProposalHistoryParams,
  auditSourceHistoryParams,
  auditSourceHistoryQuery,
  type SourceHistoryPageRequest,
  sourceHistoryPageFor,
  stageHistoryFor,
} from '@/audit/history';
import type { SourceRef } from '@/ledger/posting-rules';

import {
  announceIfUnreachable,
  database,
  type Fixture,
  jsonAt,
  jsonRows,
  lit,
  newFixture,
  provision,
  rolledBack,
  runScript,
} from './pg';

const REF: SourceRef = { type: 'settlement', id: 'setl_SYNTHETIC9281' };
const OTHER_REF: SourceRef = { type: 'payment', id: 'pay_SYNTHETIC4410' };

const at = (second: number, ms = 0): string =>
  new Date(Date.UTC(2026, 1, 14, 9, 30, second, ms)).toISOString();

/** `PREPARE`, so Postgres plans the exported string itself. */
const prepared = (name: string, sql: string): string => `prepare ${name} as\n${sql};`;

const execute = (name: string, params: readonly (string | null)[] = []): string =>
  params.length === 0
    ? `execute ${name};`
    : `execute ${name}(${params.map((p) => (p === null ? 'null' : lit(p))).join(', ')});`;

/**
 * The exported statement with its `$n` placeholders replaced by literals, so the same
 * text can be wrapped in `jsonRows` for the field-level assertions.
 *
 * Only `$n` is substituted — every cast, predicate and `ORDER BY` in the exported
 * string is left exactly as exported, so this reads the statement under test rather
 * than a paraphrase of it.
 */
const withParams = (sql: string, params: readonly (string | null)[]): string =>
  sql.replace(/\$(\d+)/g, (_match, n: string) => {
    const value = params[Number(n) - 1];
    return value === undefined || value === null ? 'null' : lit(value);
  });

function draft(overrides: Partial<AuditEventDraft> = {}): AuditEventDraft {
  return {
    eventType: 'agent_stage_completed',
    actor: { kind: 'agent', id: 'reconciliation_agent' },
    payload: { note: 'db-test' },
    sourceRefs: [REF],
    occurredAt: at(0),
    ...overrides,
  };
}

const append = (overrides: Partial<AuditEventDraft> = {}): string =>
  execute('audit_append', auditEventAppendParams(draft(overrides)));

const PREPARE_ALL = [
  prepared('audit_append', AUDIT_EVENT_APPEND_SQL),
  prepared('audit_source_history', AUDIT_SOURCE_HISTORY_SQL),
  prepared('audit_proposal_history', AUDIT_PROPOSAL_HISTORY_SQL),
].join('\n');

/**
 * A minimal `proposals` row, so a stage Audit_Event can cite it (task 21.1's
 * `audit_events_proposal_id_fkey`). `proposals.evidence_chain_id` is `NOT NULL
 * REFERENCES evidence_chains(id)`, so the chain comes first.
 */
const withProposal = (f: Fixture, chainId: string, proposalId: string): string => `
insert into evidence_chains (id, tenant_id, figure_paise, source_count, as_of, produced_by)
values (${lit(chainId)}, ${lit(f.tenantId)}, 38200000, 1, now(), 'audit_history_test');
insert into proposals
  (id, tenant_id, agent_name, action_type, target_source_records, target_fingerprint,
   impact_paise, evidence_chain_id, expected_outcome, state)
values (${lit(proposalId)}, ${lit(f.tenantId)}, 'reconciliation_agent',
  'post_reconciliation_adjustment', '[{"type":"settlement","id":"setl_SYNTHETIC9281"}]'::jsonb,
  'post_reconciliation_adjustment|settlement:setl_SYNTHETIC9281', 38200000, ${lit(chainId)},
  '{"status":"adjusted"}'::jsonb, 'proposed');`;

const pageRequest = (offset: number, limit: number): SourceHistoryPageRequest =>
  ({ offset, limit }) as SourceHistoryPageRequest;

/** `AUDIT_SOURCE_HISTORY_SQL` as a JSON read, with the look-ahead row `page` implies. */
const sourceHistoryRead = (ref: SourceRef, page: SourceHistoryPageRequest): string =>
  jsonRows(
    withParams(AUDIT_SOURCE_HISTORY_SQL, auditSourceHistoryParams(auditSourceHistoryQuery(ref, page))),
  );

/**
 * The 6 appends every Source_Record-history assertion below shares.
 *
 * The timestamps deliberately disagree with the sequence numbers, and two of them are
 * equal, so Requirement 13.6's order is distinguishable from the order the rows were
 * appended in and from the sequence order:
 *
 * ```
 *   seq 1  09:30:03  [settlement]                 -> 4th
 *   seq 2  09:30:01  [settlement]                 -> 1st
 *   seq 3  09:30:02  [settlement]                 -> 3rd
 *   seq 4  09:30:01  [settlement]                 -> 2nd  (tie with seq 2, lower seq first)
 *   seq 5  09:30:00  [payment]                    -> excluded: does not reference it
 *   seq 6  09:30:04  [payment, settlement]        -> 5th   (multi-ref, still matched)
 * ```
 */
const SIX_APPENDS = [
  append({ occurredAt: at(3), payload: { note: 'seq1' } }),
  append({ occurredAt: at(1), payload: { note: 'seq2' } }),
  append({ occurredAt: at(2), payload: { note: 'seq3' } }),
  append({ occurredAt: at(1), payload: { note: 'seq4' } }),
  append({ occurredAt: at(0), payload: { note: 'seq5' }, sourceRefs: [OTHER_REF] }),
  append({ occurredAt: at(4), payload: { note: 'seq6' }, sourceRefs: [OTHER_REF, REF] }),
];

/** The matched history, in Requirement 13.6's order. */
const MATCHED_SEQUENCE = [2n, 4n, 3n, 1n, 6n];

beforeAll(announceIfUnreachable);

describe.skipIf(!database().reachable)('the statements an adapter runs', () => {
  it('plans both as exported, with 3 and 1 parameters and no Tenant among them', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          append(),
          execute('audit_source_history', auditSourceHistoryParams(auditSourceHistoryQuery(REF, pageRequest(0, 100)))),
          execute('audit_proposal_history', auditProposalHistoryParams(randomUUID())),
          jsonRows(
            `select name, (select count(*)::int from unnest(parameter_types)) as params
               from pg_prepared_statements
              where name in ('audit_source_history', 'audit_proposal_history')
              order by name`,
          ),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    // The Tenant is app.current_tenant_id(), so it is not one of the parameters
    // (Requirement 14.1, 14.2): a caller can bend the ref, the page and the Proposal.
    expect(jsonAt<readonly { name: string; params: number }[]>(r, 2)).toEqual([
      { name: 'audit_proposal_history', params: 1 },
      { name: 'audit_source_history', params: 3 },
    ]);
    // One row out of the source history, 16 columns; no value here contains a '|'.
    expect((r.out[1] ?? '').split('|')).toHaveLength(16);
  });

  it('returns nothing when the session carries no Tenant', () => {
    // The same reported gap `AUDIT_CHAIN_WALK_SQL` documents: `tenant_id = NULL` matches
    // nothing, so an unscoped caller gets an empty page rather than an authentication
    // failure. An adapter runs AUDIT_SESSION_TENANT_PROBE_SQL first.
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          append(),
          `do $c$ begin perform set_config('request.jwt.claims',
             json_build_object('sub', ${lit(f.userId)})::text, false); end $c$;`,
          sourceHistoryRead(REF, pageRequest(0, 100)),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    expect(jsonAt<readonly AuditEventRow[]>(r, 1)).toEqual([]);
  });

  /**
   * FINDING (task 25.4): `audit_events_source_refs_idx` is a GIN index over
   * `source_record_refs` **alone**, with no `tenant_id`, so it cannot serve
   * Requirement 13.6's read on its own — that read is always Tenant-scoped
   * (Requirement 14.1, 14.2). Using both indexes needs a `BitmapAnd`, and the planner
   * instead takes the Tenant-leading btree (`audit_events_proposal_idx`, whose leading
   * column is `tenant_id`) and applies the containment as a **filter**.
   *
   * Measured below rather than asserted from the migration comment, in two halves: the
   * operator IS GIN-indexable, and the exported Tenant-scoped statement nevertheless
   * does not use that index. So the GIN index earns nothing for 13.6 as specified.
   *
   * Not repaired here: the fix is a composite index — `GIN (tenant_id,
   * source_record_refs)` with the `btree_gin` extension, or a partial/expression index
   * — which is a migration, and design.md's index list is task 4.4's. Correctness is
   * unaffected: the containment predicate selects the same rows either way.
   */
  it('is GIN-indexable on the containment operator, yet plans as a Tenant-scoped filter', () => {
    const f = newFixture();
    const params = auditSourceHistoryParams(auditSourceHistoryQuery(REF, pageRequest(0, 3)));
    const refsJson = params[0];
    const r = runScript(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          append(),
          // On a one-row table a sequential scan wins regardless, so the question asked is
          // whether an index CAN serve the operator, not which one costs less here.
          'set local enable_seqscan = off;',
          `select 'MARK1';`,
          `explain (costs off) select 1 from audit_events e
             where e.source_record_refs @> ${lit(refsJson)}::jsonb;`,
          `select 'MARK2';`,
          `explain (costs off) ${execute('audit_source_history', params).replace(/;$/, '')};`,
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);

    const first = r.out.indexOf('MARK1');
    const second = r.out.indexOf('MARK2');
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThan(first);

    // Half 1: the GIN index does serve `@>`.
    const ginPlan = r.out.slice(first + 1, second).join('\n');
    expect(ginPlan).toContain('audit_events_source_refs_idx');

    // Half 2: the Tenant-scoped statement does not reach it. The containment is a
    // Filter under a tenant_id index scan, and the 13.6 order is a Sort.
    const scopedPlan = r.out.slice(second + 1).join('\n');
    expect(scopedPlan).not.toContain('audit_events_source_refs_idx');
    expect(scopedPlan).toContain('Filter: (source_record_refs @>');
    expect(scopedPlan).toContain('tenant_id = app.current_tenant_id()');
    expect(scopedPlan).toContain(
      "Sort Key: (date_trunc('milliseconds'::text, occurred_at)), sequence_number",
    );
  });
});

describe.skipIf(!database().reachable)(
  'a Source_Records history, ordered and paged (Requirement 13.6)',
  () => {
    it('orders by ascending timestamp, breaking ties by ascending sequence number', () => {
      const f = newFixture();
      const r = runScript(
        rolledBack(
          [
            provision(f),
            PREPARE_ALL,
            ...SIX_APPENDS,
            // Executed rather than JSON-aggregated: psql prints rows in result order, so
            // this reads the statement's own ordering rather than an aggregate's.
            execute(
              'audit_source_history',
              auditSourceHistoryParams(auditSourceHistoryQuery(REF, pageRequest(0, 100))),
            ),
          ].join('\n'),
        ),
      );
      expect(r.errors, r.rawErr).toHaveLength(0);

      // 6 appends emit 6 lines; the history follows.
      const returned = r.out.slice(6).map((line) => BigInt(line.split('|')[2] ?? '0'));
      expect(returned).toEqual(MATCHED_SEQUENCE);
    });

    it('selects exactly the Audit_Events referencing the record, multi-ref included', () => {
      const f = newFixture();
      const r = runScript(
        rolledBack(
          [provision(f), PREPARE_ALL, ...SIX_APPENDS, sourceHistoryRead(REF, pageRequest(0, 100))].join(
            '\n',
          ),
        ),
      );
      expect(r.errors, r.rawErr).toHaveLength(0);

      const events = auditEventsFromRows(jsonAt<readonly AuditEventRow[]>(r, 6));
      expect(events.map((e) => e.sequence_number)).toEqual(MATCHED_SEQUENCE);
      // seq 5 references only the Payment, so it is not part of the Settlement's history.
      expect(events.some((e) => e.payload['note'] === 'seq5')).toBe(false);
      // seq 6 references both, and one of them is the record asked about.
      expect(events.at(-1)?.source_record_refs).toEqual([OTHER_REF, REF]);
    });

    it('pages at most the requested size, indicates further events, and ends cleanly', () => {
      const f = newFixture();
      const r = runScript(
        rolledBack(
          [
            provision(f),
            PREPARE_ALL,
            ...SIX_APPENDS,
            sourceHistoryRead(REF, pageRequest(0, 2)),
            sourceHistoryRead(REF, pageRequest(2, 2)),
            sourceHistoryRead(REF, pageRequest(4, 2)),
          ].join('\n'),
        ),
      );
      expect(r.errors, r.rawErr).toHaveLength(0);

      const pages = [0, 1, 2].map((i) => {
        const request = pageRequest(i * 2, 2);
        return sourceHistoryPageFor(
          REF,
          request,
          auditEventsFromRows(jsonAt<readonly AuditEventRow[]>(r, 6 + i)),
        );
      });

      expect(pages.map((p) => p.events.map((e) => e.sequence_number))).toEqual([
        [2n, 4n],
        [3n, 1n],
        [6n],
      ]);
      // Requirement 13.6's indicator, and no trailing empty page.
      expect(pages.map((p) => p.further_events)).toEqual([true, true, false]);
      expect(pages.every((p) => p.events.length <= 2)).toBe(true);
    });

    it('returns a read-back Audit_Event carrying what was appended (Requirement 13.10)', () => {
      const f = newFixture();
      const r = runScript(
        rolledBack(
          [
            provision(f),
            PREPARE_ALL,
            append({ occurredAt: at(7, 123), payload: { note: 'round-trip' } }),
            sourceHistoryRead(REF, pageRequest(0, 100)),
          ].join('\n'),
        ),
      );
      expect(r.errors, r.rawErr).toHaveLength(0);

      const events = auditEventsFromRows(jsonAt<readonly AuditEventRow[]>(r, 1));
      expect(events).toHaveLength(1);
      const [only] = events;
      expect(only?.sequence_number).toBe(1n);
      expect(only?.event_type).toBe('agent_stage_completed');
      expect(only?.actor_kind).toBe('agent');
      expect(only?.actor_id).toBe('reconciliation_agent');
      expect(only?.payload).toEqual({ note: 'round-trip' });
      // Millisecond precision preserved, and rendered as the text the Chain_Value hashed.
      expect(only?.occurred_at).toBe('2026-02-14T09:30:07.123Z');
      expect(only?.source_record_refs).toEqual([REF]);
      expect(only?.payload_reduced).toBe(false);
    });
  },
);

describe.skipIf(!database().reachable)(
  'a Proposals stage history (Requirement 13.7)',
  () => {
    it('reports one Audit_Event per completed stage and names the absent stages', () => {
      const f = newFixture();
      const chainId = randomUUID();
      const proposalId = randomUUID();
      const stages = ACTION_PIPELINE_STAGES.slice(0, 3);
      const r = runScript(
        rolledBack(
          [
            provision(f),
            withProposal(f, chainId, proposalId),
            PREPARE_ALL,
            ...stages.map((stage, i) =>
              append({
                stage,
                outcome: 'succeeded',
                proposalId,
                occurredAt: at(i),
                payload: { note: stage },
              }),
            ),
            // A non-stage Audit_Event citing the same Proposal: real, and outside 13.7.
            append({
              eventType: 'proposal_expired',
              proposalId,
              occurredAt: at(9),
              payload: { note: 'expiry' },
            }),
            jsonRows(withParams(AUDIT_PROPOSAL_HISTORY_SQL, auditProposalHistoryParams(proposalId))),
          ].join('\n'),
        ),
      );
      expect(r.errors, r.rawErr).toHaveLength(0);

      const events = auditEventsFromRows(jsonAt<readonly AuditEventRow[]>(r, 4));
      // `stage IS NOT NULL`: the expiry event is excluded by the statement itself.
      expect(events.map((e) => e.stage)).toEqual([...stages]);
      expect(events.map((e) => e.sequence_number)).toEqual([1n, 2n, 3n]);

      const history = stageHistoryFor(proposalId, events);
      expect(history.stages.map((s) => s.completed)).toEqual([
        true,
        true,
        true,
        false,
        false,
        false,
        false,
      ]);
      expect(history.not_completed).toEqual(['PROPOSE', 'AUTHORIZE', 'EXECUTE', 'VERIFY']);
      expect(history.events).toHaveLength(3);
      expect(history.repeated_stage_events).toEqual([]);
    });

    it('reports all 7 as not completed for a Proposal with no stage Audit_Events', () => {
      const f = newFixture();
      const chainId = randomUUID();
      const proposalId = randomUUID();
      const r = runScript(
        rolledBack(
          [
            provision(f),
            withProposal(f, chainId, proposalId),
            PREPARE_ALL,
            append({ occurredAt: at(0) }),
            jsonRows(withParams(AUDIT_PROPOSAL_HISTORY_SQL, auditProposalHistoryParams(proposalId))),
          ].join('\n'),
        ),
      );
      expect(r.errors, r.rawErr).toHaveLength(0);

      const events = auditEventsFromRows(jsonAt<readonly AuditEventRow[]>(r, 1));
      expect(events).toEqual([]);
      const history = stageHistoryFor(proposalId, events);
      expect(history.not_completed).toEqual([...ACTION_PIPELINE_STAGES]);
      expect(history.stages).toHaveLength(7);
    });

    it('keeps the lowest sequence number when a stage was recorded twice', () => {
      // Requirement 5.17's retry path: a second EXECUTE under the same Proposal. The
      // append-only Audit_Log keeps both, so the history reports one and names the other.
      const f = newFixture();
      const chainId = randomUUID();
      const proposalId = randomUUID();
      const r = runScript(
        rolledBack(
          [
            provision(f),
            withProposal(f, chainId, proposalId),
            PREPARE_ALL,
            append({ stage: 'EXECUTE', outcome: 'failed', proposalId, occurredAt: at(1) }),
            append({ stage: 'EXECUTE', outcome: 'succeeded', proposalId, occurredAt: at(2) }),
            jsonRows(withParams(AUDIT_PROPOSAL_HISTORY_SQL, auditProposalHistoryParams(proposalId))),
          ].join('\n'),
        ),
      );
      expect(r.errors, r.rawErr).toHaveLength(0);

      const history = stageHistoryFor(
        proposalId,
        auditEventsFromRows(jsonAt<readonly AuditEventRow[]>(r, 2)),
      );
      expect(history.events.map((e) => e.sequence_number)).toEqual([1n]);
      expect(history.events[0]?.outcome).toBe('failed');
      expect(history.repeated_stage_events).toEqual([{ stage: 'EXECUTE', sequence_number: 2n }]);
      expect(history.not_completed).toEqual([
        'DETECT',
        'INVESTIGATE',
        'EXPLAIN',
        'PROPOSE',
        'AUTHORIZE',
        'VERIFY',
      ]);
    });
  },
);
