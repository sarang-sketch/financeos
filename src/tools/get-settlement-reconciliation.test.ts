/**
 * `get_settlement_reconciliation` end to end through the Financial_Tool invoker
 * (task 12.1).
 *
 * Driven through `createToolInvoker` rather than by calling `execute` directly, so
 * every assertion is about the tool **as an Agent reaches it**: the registration
 * audit, the parse-before-connect ordering, the declared mode, the output schema and
 * the envelope's Evidence_Chain. The Evidence_Chains are persisted through the same
 * in-memory store property P6 uses, and read back through
 * `EvidenceChainBuilder.read` — the Tenant gate — so "resolvable" means resolvable
 * and not merely UUID-shaped (Requirement 12.6).
 *
 * `ctx.db` is a Proxy that throws on any property access. Nothing in this tool reads
 * through it today, and a stray query would fail loudly rather than reach a
 * connection that RLS would answer zero rows for until task 26.1.
 */

import { describe, expect, it } from 'vitest';

import { createEvidenceChainBuilder } from '@/evidence/chain-builder';

import { SET_9281, SET_9281_FEE_VARIANT } from '../../test/fixtures/set-9281';
import {
  scopedSettlementFor,
  settlementWithNoReconReport,
} from '../../test/fixtures/set-9281.scoped';
import {
  createMemoryEvidenceStore,
  type MemoryEvidenceStore,
} from '../../test/property/evidence-chain-memory-store';

import {
  catalogueEntryFor,
  createGetSettlementReconciliation,
  GET_SETTLEMENT_RECONCILIATION,
  type GetSettlementReconciliationDeps,
  type GetSettlementReconciliationOutput,
} from './get-settlement-reconciliation';
import { createToolRegistry } from './registry';
import {
  type ScopedSettlement,
  type SettlementScopeQuery,
  type SettlementScopeResult,
  type SettlementScopeStore,
} from './settlement-scope';
import {
  createToolInvoker,
  type ToolAuditEvent,
  type ToolConnection,
  type ToolConnections,
  type ToolDbClient,
  type ToolMode,
  type ToolResult,
  type ToolSession,
} from './tool';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const TENANT = '11111111-1111-4111-8111-111111111111';

const SESSION: ToolSession = {
  tenant_id: TENANT,
  user_id: 'usr_12_1',
  permissions: ['view_financial_data', 'run_agents'],
};

const SCOPE = { from: '2026-07-01', to: '2026-07-31' } as const;

/** A client that throws if touched. This tool reads no Tenant data through `ctx.db`. */
function unreachableDb(): ToolDbClient {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(`the tool reached ctx.db.${String(property)}; it reads through its seams`);
      },
    },
  ) as ToolDbClient;
}

interface Recorded {
  readonly acquired: ToolMode[];
  readonly dispositions: ('commit' | 'rollback')[];
  readonly connections: ToolConnections;
}

function recordingConnections(): Recorded {
  const acquired: ToolMode[] = [];
  const dispositions: ('commit' | 'rollback')[] = [];
  return {
    acquired,
    dispositions,
    connections: {
      acquire(mode: ToolMode): Promise<ToolConnection> {
        acquired.push(mode);
        return Promise.resolve({
          db: unreachableDb(),
          mode,
          release(disposition): Promise<void> {
            dispositions.push(disposition);
            return Promise.resolve();
          },
        });
      },
    },
  };
}

/** The read seam, over a stated set of Settlements. */
function scopeStore(
  settlements: readonly ScopedSettlement[],
  counts: { readonly ledger: number; readonly invoices: number } = { ledger: 0, invoices: 0 },
): SettlementScopeStore & { readonly queries: SettlementScopeQuery[] } {
  const queries: SettlementScopeQuery[] = [];
  return {
    queries,
    listInScope(query: SettlementScopeQuery): Promise<SettlementScopeResult> {
      queries.push(query);
      // A cross-Tenant request answers zero rows, never a permission error.
      const rows = query.tenant_id === TENANT ? settlements : [];
      const named = query.settlement_ids;
      return Promise.resolve({
        settlements: named === null ? rows : rows.filter((r) => named.includes(r.settlement_id)),
        ledger_entries_examined: counts.ledger,
        razorpay_invoices_examined: counts.invoices,
      });
    },
  };
}

interface Harness {
  readonly deps: GetSettlementReconciliationDeps;
  readonly chains: MemoryEvidenceStore;
  readonly scope: ReturnType<typeof scopeStore>;
  readonly recorded: Recorded;
  readonly audit: ToolAuditEvent[];
  invoke(input: unknown, session?: ToolSession): Promise<ToolResult<GetSettlementReconciliationOutput>>;
}

function harness(
  settlements: readonly ScopedSettlement[],
  counts?: { readonly ledger: number; readonly invoices: number },
): Harness {
  const chains = createMemoryEvidenceStore();
  const scope = scopeStore(settlements, counts);
  const recorded = recordingConnections();
  const audit: ToolAuditEvent[] = [];
  const deps: GetSettlementReconciliationDeps = {
    settlements: () => scope,
    chains: () => chains,
  };
  const tool = createGetSettlementReconciliation(deps);
  const invoker = createToolInvoker({
    connections: recorded.connections,
    audit: {
      append(event: ToolAuditEvent): Promise<void> {
        audit.push(event);
        return Promise.resolve();
      },
    },
    actor: { kind: 'agent', id: 'reconciliation_agent' },
    now: () => new Date('2026-07-30T09:00:00.000Z'),
  });
  return {
    deps,
    chains,
    scope,
    recorded,
    audit,
    invoke: (input, session = SESSION) => invoker.invoke(tool, session, input),
  };
}

const NINE = scopedSettlementFor(SET_9281);
const VARIANT = scopedSettlementFor(SET_9281_FEE_VARIANT);
const UNRECONCILED = settlementWithNoReconReport({
  settlement_id: 'setl_SYNTHETIC9283',
  settlement_date: '2026-07-30',
  received_paise: 5_000_000n,
  record_updated_at: '2026-07-30T00:00:00.000Z',
});

/* -------------------------------------------------------------------------- */
/* The declaration                                                            */
/* -------------------------------------------------------------------------- */

describe('the catalogue declaration', () => {
  it('passes the registration audit unmodified', () => {
    const registry = createToolRegistry([
      catalogueEntryFor({ settlements: () => scopeStore([]), chains: createMemoryEvidenceStore }),
    ]);
    expect(registry.names()).toEqual([GET_SETTLEMENT_RECONCILIATION]);
    const entry = registry.list()[0];
    expect(entry?.tool.mode).toBe<ToolMode>('read_only');
    // Every argument bounded: two pattern-bounded dates and a pattern-bounded id list.
    expect(entry?.audit.arguments.map((argument) => `${argument.path}:${argument.bound}`)).toEqual([
      'from:pattern',
      'to:pattern',
      'settlement_ids[]:pattern',
    ]);
    expect(entry?.tool.freeTextArguments).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Rejections, before any connection is opened (Requirement 12.7, 12.9)       */
/* -------------------------------------------------------------------------- */

describe('a non-conforming invocation is refused with no connection acquired', () => {
  const cases: readonly { readonly why: string; readonly input: unknown; readonly argument: string }[] =
    [
      {
        why: 'a smuggled tenant_id',
        input: { ...SCOPE, tenant_id: TENANT },
        argument: 'tenant_id',
      },
      { why: 'an unknown key', input: { ...SCOPE, limit: 50 }, argument: 'limit' },
      { why: 'an inverted range', input: { from: '2026-07-31', to: '2026-07-01' }, argument: 'from' },
      { why: 'a date that is not a calendar date', input: { from: '2026-02-30', to: '2026-03-01' }, argument: 'from' },
      { why: 'free-form SQL in a date', input: { from: "' OR 1=1; --", to: '2026-07-31' }, argument: 'from' },
    ];

  for (const testCase of cases) {
    it(`refuses ${testCase.why}, naming the argument`, async () => {
      const h = harness([NINE]);
      const result = await h.invoke(testCase.input);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.kind).toBe('schema_violation');
      if (result.kind !== 'schema_violation') {
        return;
      }
      expect(result.violations.map((violation) => violation.argument)).toContain(testCase.argument);
      // Structural, not asserted: `ToolContext.db` is the only database a tool is
      // handed, and it does not exist until `acquire` is called.
      expect(h.recorded.acquired).toEqual([]);
      expect(h.scope.queries).toEqual([]);
      expect(h.audit.map((event) => event.eventType)).toEqual(['tool_invocation_rejected']);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The demo path                                                              */
/* -------------------------------------------------------------------------- */

describe('the reconciliation answer (Requirement 4.2, 4.4, 4.7, 4.13)', () => {
  it('reports rows, the total, the scope, the examined counts and the residual count', async () => {
    const h = harness([UNRECONCILED, VARIANT, NINE], { ledger: 9, invoices: 4 });
    const result = await h.invoke({ ...SCOPE });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const value = result.value;

    // Requirement 4.7's reported range is the range that was read.
    expect(value.scope).toEqual(SCOPE);
    expect(h.scope.queries).toEqual([
      { tenant_id: TENANT, scope: SCOPE, settlement_ids: null },
    ]);

    // Ascending settlement date, then identifier. A function of the set.
    expect(value.rows.map((row) => row.settlement_id)).toEqual([
      SET_9281.settlement_id,
      SET_9281_FEE_VARIANT.settlement_id,
      UNRECONCILED.settlement_id,
    ]);

    // Both worked examples have a Difference of 2320000n; the unreconciled one has
    // none and is excluded (Requirement 4.13).
    expect(value.total_shortfall_paise).toBe(4_640_000n);
    // Only the fee variant leaves an unexplained residual.
    expect(value.residual_nonzero_count).toBe(1);

    expect(value.examined).toEqual({
      payments_examined: 6,
      settlements_examined: 3,
      refunds_examined: 2,
      ledger_entries_examined: 9,
      razorpay_invoices_examined: 4,
    });

    // The two reconciled rows are exactly what task 11.1's algorithm returns.
    expect(value.rows[0]).toMatchObject({ ...SET_9281.recon, unreconciled_source: null });
    expect(value.rows[1]).toMatchObject({
      ...SET_9281_FEE_VARIANT.recon,
      unreconciled_source: null,
    });

    // Requirement 4.13: five nulls, `unreconciled`, and the absent source type
    // reported against the identifier. `received_paise` survives.
    expect(value.rows[2]).toMatchObject({
      expected_paise: null,
      difference_paise: null,
      fee_component_paise: null,
      gst_component_paise: null,
      residual_paise: null,
      received_paise: 5_000_000n,
      status: 'unreconciled',
      direction: 'not_applicable',
      recon_report_id: null,
      unreconciled_source: { type: 'settlement_recon_report', reason: 'absent' },
    });

    // The connection was the declared mode's, and the invocation committed.
    expect(h.recorded.acquired).toEqual<ToolMode[]>(['read_only']);
    expect(h.recorded.dispositions).toEqual(['commit']);
  });

  it('grounds every figure: one chain per row, and the envelope behind the total', async () => {
    const h = harness([UNRECONCILED, VARIANT, NINE]);
    const result = await h.invoke({ ...SCOPE });
    if (!result.ok) {
      throw new Error(`expected a figure, got ${result.kind}`);
    }
    const builder = createEvidenceChainBuilder({ store: h.chains, tenantId: TENANT });

    // The envelope grounds the one top-level figure, and its figure is that figure.
    expect(result.evidence.figure_paise).toBe(result.value.total_shortfall_paise);
    expect(result.evidence.produced_by).toBe(GET_SETTLEMENT_RECONCILIATION);
    // 8 identifiers per contributing Settlement's 1..8 prefix, plus the unreconciled
    // Settlement, which is cited as examined even though it contributed nothing.
    expect(result.evidence.source_count).toBe(17);
    const envelope = await builder.read(result.evidence.evidence_chain_id);
    expect(envelope?.figure_paise).toBe(result.value.total_shortfall_paise);

    // Every row's chain resolves, through the Tenant gate, to that row's figure.
    const expectedFigures = [
      SET_9281.recon.residual_paise,
      SET_9281_FEE_VARIANT.recon.residual_paise,
      UNRECONCILED.received_paise,
    ];
    for (const [position, row] of result.value.rows.entries()) {
      const chain = await builder.read(row.evidence_chain_id);
      expect(chain).not.toBeNull();
      expect(chain?.produced_by).toBe(GET_SETTLEMENT_RECONCILIATION);
      expect(chain?.figure_paise).toBe(expectedFigures[position]);
      expect(chain?.as_of).toBe(row.evidence_as_of);
    }

    // Four chains: three rows and the aggregate.
    expect(h.chains.chainCount).toBe(4);
  });

  it('narrows to the named Settlements without widening the range', async () => {
    const h = harness([UNRECONCILED, VARIANT, NINE]);
    const result = await h.invoke({ ...SCOPE, settlement_ids: [SET_9281.settlement_id] });
    if (!result.ok) {
      throw new Error(`expected a figure, got ${result.kind}`);
    }
    expect(result.value.rows.map((row) => row.settlement_id)).toEqual([SET_9281.settlement_id]);
    expect(result.value.total_shortfall_paise).toBe(2_320_000n);
    expect(result.value.examined.settlements_examined).toBe(1);
  });

  it('answers zero rows for another Tenant rather than a permission error', async () => {
    const h = harness([NINE]);
    const result = await h.invoke({ ...SCOPE }, {
      ...SESSION,
      tenant_id: '22222222-2222-4222-8222-222222222222',
    });
    // No Settlement in scope, so there is no Source_Record to ground a figure on —
    // see the empty-scope decision on the tool.
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe('tool_failure');
  });
});

/* -------------------------------------------------------------------------- */
/* Requirement 12.3 and the empty scope                                       */
/* -------------------------------------------------------------------------- */

describe('an unreadable contributing record omits the figure (Requirement 12.3)', () => {
  it('returns incomplete_evidence with no figure field and writes no chain', async () => {
    const hidden: ScopedSettlement = {
      ...NINE,
      unreadable: [{ type: 'settlement_recon_report', id: 'pay_SYNTHETIC92811' }],
    };
    const h = harness([hidden, VARIANT]);
    const result = await h.invoke({ ...SCOPE });
    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== 'incomplete_evidence') {
      throw new Error('expected incomplete_evidence');
    }
    expect(result.unavailable).toEqual([{ type: 'settlement_recon_report', count: 1 }]);
    // Structurally no figure: `IncompleteEvidence` has no figure field at all.
    expect('figure_paise' in result).toBe(false);
    expect(h.chains.chainCount).toBe(0);
    expect(h.recorded.dispositions).toEqual(['rollback']);
    expect(h.audit.map((event) => event.eventType)).toEqual(['incomplete_evidence']);
  });
});

describe('a scope holding no Settlement', () => {
  it('refuses rather than returning an ungrounded zero', async () => {
    const h = harness([]);
    const result = await h.invoke({ ...SCOPE });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result).toEqual({
      ok: false,
      kind: 'tool_failure',
      tool: GET_SETTLEMENT_RECONCILIATION,
      cause: 'execution_error',
    });
    expect(h.chains.chainCount).toBe(0);
    expect(h.recorded.dispositions).toEqual(['rollback']);
  });
});
