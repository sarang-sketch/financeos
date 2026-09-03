/**
 * Audit_Log history retrieval (task 25.4, Requirement 13.6, 13.7).
 *
 * Two conventions carried over from `chain.test.ts`:
 *
 * 1. **Rows are built through {@link auditEventFromRow}**, not hand-assembled as
 *    `AuditEvent` objects. That is the boundary a driver row actually crosses, so
 *    every fixture here exercises the `BIGINT`-as-digit-text conversion and the field
 *    validation rather than bypassing them.
 * 2. **The two claims that cannot be checked in process are named, not asserted.**
 *    That the statements plan, that `@>` uses the GIN index, and that the `ORDER BY`
 *    produces Requirement 13.6's order against real rows is
 *    `test/db/audit-history.test.ts`, which `PREPARE`s these exact strings.
 *
 * Requirements: 13.6, 13.7.
 */

import { describe, expect, it } from 'vitest';

import type { SourceRef } from '@/ledger/posting-rules';

import { ACTION_PIPELINE_STAGES, type AuditEvent } from './audit-service';
import {
  AUDIT_PROPOSAL_HISTORY_SQL,
  AUDIT_SOURCE_HISTORY_SQL,
  type AuditEventRow,
  auditEventFromRow,
  AuditHistoryError,
  type AuditHistoryStore,
  auditProposalHistoryParams,
  auditSourceHistoryParams,
  auditSourceHistoryQuery,
  createAuditHistory,
  MAX_SOURCE_HISTORY_PAGE_SIZE,
  type SourceHistoryPageRequest,
  sourceHistoryPageFor,
  stageHistoryFor,
} from './history';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const PROPOSAL = '33333333-3333-4333-8333-333333333333';
const OTHER_PROPOSAL = '44444444-4444-4444-8444-444444444444';
const CHAIN = 'a'.repeat(64);
const PREV_CHAIN = 'b'.repeat(64);
const REF: SourceRef = { type: 'settlement', id: 'setl_SYNTHETIC9281' };
const OTHER_REF: SourceRef = { type: 'payment', id: 'pay_SYNTHETIC4410' };

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function row(seq: number, overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    tenant_id: TENANT,
    sequence_number: String(seq),
    event_type: 'agent_stage_completed',
    stage: null,
    outcome: null,
    actor_kind: 'agent',
    actor_id: 'reconciliation_agent',
    proposal_id: null,
    source_record_refs: [REF],
    payload: { note: `event-${seq}` },
    payload_reduced: false,
    payload_bytes: 24,
    occurred_at: '2026-02-14T09:30:00.000Z',
    chain_value: CHAIN,
    prev_chain_value: PREV_CHAIN,
    ...overrides,
  };
}

const event = (seq: number, overrides: Partial<AuditEventRow> = {}): AuditEvent =>
  auditEventFromRow(row(seq, overrides));

/** `n` Audit_Events one second apart, all referencing {@link REF}. */
const history = (n: number): readonly AuditEvent[] =>
  Array.from({ length: n }, (_unused, i) =>
    event(i + 1, {
      occurred_at: new Date(Date.UTC(2026, 1, 14, 9, 30, i)).toISOString(),
    }),
  );

const page = (offset: number, limit: number): SourceHistoryPageRequest =>
  ({ offset, limit }) as SourceHistoryPageRequest;

/** A store over rows already in memory, so the service is testable with no database. */
function storeOver(
  source: readonly AuditEvent[],
  stageEvents: readonly AuditEvent[] = [],
): AuditHistoryStore & { readonly seen: { offset: number; limit: number }[] } {
  const seen: { offset: number; limit: number }[] = [];
  return {
    seen,
    sourceHistory: async (query) => {
      seen.push({ offset: query.offset, limit: query.limit });
      return source
        .filter((e) => e.source_record_refs.some((r) => r.type === query.ref.type && r.id === query.ref.id))
        .slice(query.offset, query.offset + query.limit);
    },
    proposalStageEvents: async () => stageEvents,
  };
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                */
/* -------------------------------------------------------------------------- */

describe('a driver row becomes an Audit_Event', () => {
  it('turns the BIGINT sequence number into a bigint, never a number', () => {
    // 2^53 + 1: the first integer a double cannot represent, so `Number(...)` would
    // silently return the wrong value here rather than fail.
    const beyondDouble = '9007199254740993';
    const mapped = auditEventFromRow(row(1, { sequence_number: beyondDouble }));
    expect(mapped.sequence_number).toBe(9007199254740993n);
    expect(mapped.sequence_number.toString()).toBe(beyondDouble);
  });

  it('rejects a sequence number that arrived as a JSON number', () => {
    expect(() =>
      auditEventFromRow(row(1, { sequence_number: 7 as unknown as string })),
    ).toThrow(AuditHistoryError);
  });

  it('projects Source_Record references to exactly type and id', () => {
    const mapped = auditEventFromRow(
      row(1, { source_record_refs: [{ ...REF, amount_paise: '1200' }] }),
    );
    expect(mapped.source_record_refs).toEqual([REF]);
  });

  it.each([
    ['a Chain_Value that is not 64 hex', { chain_value: 'nope' }],
    ['an unknown stage label', { stage: 'REVIEW' }],
    ['an unknown outcome label', { outcome: 'partially' }],
    ['an unknown actor kind', { actor_kind: 'robot' }],
    ['an array payload', { payload: [] as unknown }],
    ['a payload over Requirement 13.3s limit', { payload_bytes: 65537 }],
    ['a timestamp coarser than a millisecond', { occurred_at: '2026-02-14T09:30:00Z' }],
    ['a proposal_id that is not a UUID', { proposal_id: 'prop-1' }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => auditEventFromRow(row(1, overrides as Partial<AuditEventRow>))).toThrow(Error);
  });
});

/* -------------------------------------------------------------------------- */
/* Source_Record history (Requirement 13.6)                                   */
/* -------------------------------------------------------------------------- */

describe('the page request (Requirement 13.6)', () => {
  it('asks the store for one row more than the page, so the indicator needs no count', () => {
    expect(auditSourceHistoryQuery(REF, page(0, 100))).toEqual({
      ref: REF,
      offset: 0,
      limit: 101,
    });
  });

  it.each([0, 101, 1.5, -1])('rejects a page size of %s', (limit) => {
    expect(() => auditSourceHistoryQuery(REF, page(0, limit))).toThrow(AuditHistoryError);
  });

  it('rejects a negative offset and an unbounded one', () => {
    expect(() => auditSourceHistoryQuery(REF, page(-1, 10))).toThrow(AuditHistoryError);
    expect(() => auditSourceHistoryQuery(REF, page(1_000_001, 10))).toThrow(AuditHistoryError);
  });

  it('rejects a Source_Record type that is not one of the 13 labels', () => {
    expect(() =>
      auditSourceHistoryQuery({ type: 'invoice_pdf' as SourceRef['type'], id: 'x' }, page(0, 10)),
    ).toThrow(Error);
  });

  it('binds the reference as a single-element JSONB array for the containment lookup', () => {
    expect(auditSourceHistoryParams(auditSourceHistoryQuery(REF, page(20, 50)))).toEqual([
      '[{"type":"settlement","id":"setl_SYNTHETIC9281"}]',
      '20',
      '51',
    ]);
  });
});

describe('one page of a Source_Records history (Requirement 13.6)', () => {
  it('caps the page at the requested size and reports that further events remain', () => {
    const rows = history(4);
    const built = sourceHistoryPageFor(REF, page(0, 3), rows);
    expect(built.events.map((e) => e.sequence_number)).toEqual([1n, 2n, 3n]);
    expect(built.further_events).toBe(true);
    expect(built.page_size).toBe(3);
  });

  it('reports no further events when the look-ahead row is absent', () => {
    const built = sourceHistoryPageFor(REF, page(0, 3), history(3));
    expect(built.events).toHaveLength(3);
    expect(built.further_events).toBe(false);
  });

  it('reports an empty page for a Source_Record with no Audit_Events', () => {
    const built = sourceHistoryPageFor(REF, page(0, 100), []);
    expect(built.events).toEqual([]);
    expect(built.further_events).toBe(false);
  });

  it('never exceeds 100 Audit_Events in a page', () => {
    const built = sourceHistoryPageFor(REF, page(0, MAX_SOURCE_HISTORY_PAGE_SIZE), history(101));
    expect(built.events).toHaveLength(MAX_SOURCE_HISTORY_PAGE_SIZE);
    expect(built.further_events).toBe(true);
  });

  it('accepts equal timestamps broken by ascending sequence number', () => {
    const at = '2026-02-14T09:30:00.000Z';
    const built = sourceHistoryPageFor(REF, page(0, 10), [
      event(4, { occurred_at: at }),
      event(9, { occurred_at: at }),
    ]);
    expect(built.events.map((e) => e.sequence_number)).toEqual([4n, 9n]);
  });

  it('rejects a descending timestamp rather than re-sorting the window', () => {
    expect(() =>
      sourceHistoryPageFor(REF, page(0, 10), [
        event(1, { occurred_at: '2026-02-14T10:00:00.000Z' }),
        event(2, { occurred_at: '2026-02-14T09:00:00.000Z' }),
      ]),
    ).toThrow(/ascending timestamp/);
  });

  it('rejects a descending sequence number within one timestamp', () => {
    const at = '2026-02-14T09:30:00.000Z';
    expect(() =>
      sourceHistoryPageFor(REF, page(0, 10), [
        event(9, { occurred_at: at }),
        event(4, { occurred_at: at }),
      ]),
    ).toThrow(/ascending Tenant-scoped sequence number/);
  });

  it('rejects an Audit_Event that does not reference the Source_Record asked about', () => {
    expect(() =>
      sourceHistoryPageFor(REF, page(0, 10), [event(1, { source_record_refs: [OTHER_REF] })]),
    ).toThrow(/does not reference settlement:setl_SYNTHETIC9281/);
  });

  it('rejects a page assembled over more than one Tenant', () => {
    expect(() =>
      sourceHistoryPageFor(REF, page(0, 10), [
        event(1),
        event(2, { tenant_id: OTHER_TENANT, occurred_at: '2026-02-14T09:31:00.000Z' }),
      ]),
    ).toThrow(/more than one Tenant/);
  });

  it('rejects more rows than the look-ahead asked for', () => {
    expect(() => sourceHistoryPageFor(REF, page(0, 2), history(4))).toThrow(AuditHistoryError);
  });
});

describe('the service (Requirement 13.6)', () => {
  it('passes the offset through and the page size plus one to the store', async () => {
    const store = storeOver(history(10));
    const service = createAuditHistory(store);
    const built = await service.sourceHistory(REF, page(3, 4));

    expect(store.seen).toEqual([{ offset: 3, limit: 5 }]);
    expect(built.events.map((e) => e.sequence_number)).toEqual([4n, 5n, 6n, 7n]);
    expect(built.further_events).toBe(true);
    expect(built.offset).toBe(3);
  });

  it('walks a history to its end with no trailing empty page', async () => {
    const service = createAuditHistory(storeOver(history(6)));
    const first = await service.sourceHistory(REF, page(0, 3));
    const second = await service.sourceHistory(REF, page(3, 3));

    expect(first.further_events).toBe(true);
    expect(second.events.map((e) => e.sequence_number)).toEqual([4n, 5n, 6n]);
    // 6 events in pages of 3: the second page is full AND final, which is exactly the
    // case a `rows.length === limit` indicator would get wrong.
    expect(second.further_events).toBe(false);
  });

  it('opens no store call for an out-of-range page', async () => {
    const store = storeOver(history(3));
    await expect(createAuditHistory(store).sourceHistory(REF, page(0, 101))).rejects.toThrow(
      AuditHistoryError,
    );
    expect(store.seen).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Proposal stage history (Requirement 13.7)                                  */
/* -------------------------------------------------------------------------- */

/** A stage Audit_Event for {@link PROPOSAL}. */
const stageEvent = (
  seq: number,
  stage: (typeof ACTION_PIPELINE_STAGES)[number],
  overrides: Partial<AuditEventRow> = {},
): AuditEvent =>
  event(seq, { stage, outcome: 'succeeded', proposal_id: PROPOSAL, ...overrides });

describe('a Proposals stage history (Requirement 13.7)', () => {
  it('reports all 7 stages in Requirement 5.1s order, absent ones as not completed', () => {
    const built = stageHistoryFor(PROPOSAL, [
      stageEvent(1, 'DETECT'),
      stageEvent(2, 'INVESTIGATE'),
      stageEvent(3, 'EXPLAIN'),
    ]);

    expect(built.stages.map((s) => s.stage)).toEqual([...ACTION_PIPELINE_STAGES]);
    expect(built.stages.map((s) => s.completed)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(built.not_completed).toEqual(['PROPOSE', 'AUTHORIZE', 'EXECUTE', 'VERIFY']);
    // Absent, not omitted: every not-completed stage still has an entry, with no event.
    expect(built.stages.filter((s) => !s.completed).every((s) => s.event === null)).toBe(true);
  });

  it('returns exactly one Audit_Event per completed stage, ascending by sequence number', () => {
    const built = stageHistoryFor(
      PROPOSAL,
      ACTION_PIPELINE_STAGES.map((stage, i) => stageEvent(i + 1, stage)),
    );

    expect(built.events).toHaveLength(ACTION_PIPELINE_STAGES.length);
    expect(built.events.map((e) => e.stage)).toEqual([...ACTION_PIPELINE_STAGES]);
    expect(built.events.map((e) => e.sequence_number)).toEqual([1n, 2n, 3n, 4n, 5n, 6n, 7n]);
    expect(built.not_completed).toEqual([]);
    expect(built.repeated_stage_events).toEqual([]);
  });

  it('reports all 7 as not completed for a Proposal with no stage Audit_Events', () => {
    const built = stageHistoryFor(PROPOSAL, []);
    expect(built.events).toEqual([]);
    expect(built.not_completed).toEqual([...ACTION_PIPELINE_STAGES]);
    expect(built.stages).toHaveLength(7);
  });

  it('counts a failed stage as completed, because Requirement 5.2 appends on completion', () => {
    const built = stageHistoryFor(PROPOSAL, [
      stageEvent(1, 'DETECT'),
      stageEvent(2, 'INVESTIGATE', { outcome: 'failed' }),
    ]);
    expect(built.stages.slice(0, 2).map((s) => s.completed)).toEqual([true, true]);
    expect(built.events[1]?.outcome).toBe('failed');
  });

  it('keeps the lowest sequence number per stage and reports the repeats', () => {
    const built = stageHistoryFor(PROPOSAL, [
      stageEvent(1, 'DETECT'),
      stageEvent(2, 'EXECUTE', { outcome: 'failed' }),
      stageEvent(9, 'EXECUTE'),
    ]);

    expect(built.events.map((e) => e.sequence_number)).toEqual([1n, 2n]);
    expect(built.events[1]?.outcome).toBe('failed');
    expect(built.repeated_stage_events).toEqual([{ stage: 'EXECUTE', sequence_number: 9n }]);
    // Still exactly one Audit_Event per completed stage, which is what 13.7 asks for.
    expect(new Set(built.events.map((e) => e.stage)).size).toBe(built.events.length);
  });

  it.each([
    [
      'a non-ascending sequence number',
      [stageEvent(5, 'DETECT'), stageEvent(2, 'INVESTIGATE')],
      /ascending Tenant-scoped sequence number/,
    ],
    [
      'an Audit_Event recording no stage',
      [stageEvent(1, 'DETECT'), event(2, { proposal_id: PROPOSAL, event_type: 'proposal_expired' })],
      /records no Action_Pipeline stage/,
    ],
    [
      'an Audit_Event for another Proposal',
      [stageEvent(1, 'DETECT'), stageEvent(2, 'PROPOSE', { proposal_id: OTHER_PROPOSAL })],
      /cites Proposal/,
    ],
    [
      'Audit_Events for more than one Tenant',
      [stageEvent(1, 'DETECT'), stageEvent(2, 'PROPOSE', { tenant_id: OTHER_TENANT })],
      /more than one Tenant/,
    ],
  ])('rejects %s', (_label, events, message) => {
    expect(() => stageHistoryFor(PROPOSAL, events as readonly AuditEvent[])).toThrow(message);
  });

  it('rejects a Proposal identifier that is not a UUID', () => {
    expect(() => stageHistoryFor('proposal-1', [])).toThrow(AuditHistoryError);
    expect(() => auditProposalHistoryParams('proposal-1')).toThrow(AuditHistoryError);
    expect(auditProposalHistoryParams(PROPOSAL)).toEqual([PROPOSAL]);
  });

  it('resolves a stage history through the service', async () => {
    const service = createAuditHistory(
      storeOver([], [stageEvent(1, 'DETECT'), stageEvent(2, 'INVESTIGATE')]),
    );
    const built = await service.proposalHistory(PROPOSAL);
    expect(built.proposal_id).toBe(PROPOSAL);
    expect(built.not_completed).toHaveLength(5);
  });
});

/* -------------------------------------------------------------------------- */
/* The statements: the Tenant is not a parameter                              */
/* -------------------------------------------------------------------------- */

describe('the statements an adapter runs', () => {
  it('scopes both reads on the session Tenant and takes no Tenant parameter', () => {
    for (const sql of [AUDIT_SOURCE_HISTORY_SQL, AUDIT_PROPOSAL_HISTORY_SQL]) {
      expect(sql).toContain('e.tenant_id = app.current_tenant_id()');
      expect(sql).not.toMatch(/\$\d+::uuid[^)]*tenant/i);
    }
    // Requirement 14.1/14.2: a caller can bend the ref, the page and the Proposal, and
    // nothing else. 3 parameters on the source read, 1 on the Proposal read.
    expect([...AUDIT_SOURCE_HISTORY_SQL.matchAll(/\$(\d+)/g)].map((m) => m[1])).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect([...AUDIT_PROPOSAL_HISTORY_SQL.matchAll(/\$(\d+)/g)].map((m) => m[1])).toEqual(['1']);
  });

  it('orders the Source_Record history by truncated timestamp then sequence number', () => {
    expect(AUDIT_SOURCE_HISTORY_SQL).toContain(
      "ORDER BY date_trunc('milliseconds', e.occurred_at), e.sequence_number",
    );
    expect(AUDIT_SOURCE_HISTORY_SQL).toContain('e.source_record_refs @> $1::jsonb');
  });

  it('reads only stage Audit_Events for a Proposal, in sequence order, unpaged', () => {
    expect(AUDIT_PROPOSAL_HISTORY_SQL).toContain('e.stage IS NOT NULL');
    expect(AUDIT_PROPOSAL_HISTORY_SQL).toContain('ORDER BY e.sequence_number');
    expect(AUDIT_PROPOSAL_HISTORY_SQL).not.toContain('LIMIT');
  });
});
