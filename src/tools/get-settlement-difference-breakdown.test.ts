/**
 * `get_settlement_difference_breakdown` end to end through the Financial_Tool
 * invoker (task 12.2).
 *
 * Driven through `createToolInvoker` rather than by calling `execute` directly, for
 * the reason 12.1's suite gives: every assertion is then about the tool **as an Agent
 * reaches it** — the registration audit, the parse-before-connect ordering, the
 * declared mode, the output schema and the envelope's Evidence_Chain. Chains are
 * persisted through the same in-memory store property P6 uses and read back through
 * `EvidenceChainBuilder.read`, the Tenant gate, so "resolvable" means resolvable and
 * not merely UUID-shaped (Requirement 12.6).
 *
 * `ctx.db` is a Proxy that throws on any property access: nothing in this tool reads
 * through it, and a stray query would fail loudly rather than reach a connection RLS
 * answers zero rows for until task 26.1.
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
  createGetSettlementDifferenceBreakdown,
  GET_SETTLEMENT_DIFFERENCE_BREAKDOWN,
  type GetSettlementDifferenceBreakdownDeps,
  type GetSettlementDifferenceBreakdownOutput,
  MAX_BREAKDOWN_LIMIT,
} from './get-settlement-difference-breakdown';
import { createToolRegistry } from './registry';
import type {
  ScopedSettlement,
  SettlementScopeQuery,
  SettlementScopeResult,
  SettlementScopeStore,
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
  user_id: 'usr_12_2',
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

function scopeStore(
  settlements: readonly ScopedSettlement[],
): SettlementScopeStore & { readonly queries: SettlementScopeQuery[] } {
  const queries: SettlementScopeQuery[] = [];
  return {
    queries,
    listInScope(query: SettlementScopeQuery): Promise<SettlementScopeResult> {
      queries.push(query);
      // A cross-Tenant request answers zero rows, never a permission error.
      return Promise.resolve({
        settlements: query.tenant_id === TENANT ? settlements : [],
        ledger_entries_examined: 0,
        razorpay_invoices_examined: 0,
      });
    },
  };
}

interface Harness {
  readonly chains: MemoryEvidenceStore;
  readonly scope: ReturnType<typeof scopeStore>;
  readonly recorded: Recorded;
  readonly audit: ToolAuditEvent[];
  invoke(
    input: unknown,
    session?: ToolSession,
  ): Promise<ToolResult<GetSettlementDifferenceBreakdownOutput>>;
}

function harness(settlements: readonly ScopedSettlement[]): Harness {
  const chains = createMemoryEvidenceStore();
  const scope = scopeStore(settlements);
  const recorded = recordingConnections();
  const audit: ToolAuditEvent[] = [];
  const deps: GetSettlementDifferenceBreakdownDeps = {
    settlements: () => scope,
    chains: () => chains,
  };
  const tool = createGetSettlementDifferenceBreakdown(deps);
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
    chains,
    scope,
    recorded,
    audit,
    invoke: (input, session = SESSION) => invoker.invoke(tool, session, input),
  };
}

/* -------------------------------------------------------------------------- */
/* Settlements                                                                */
/* -------------------------------------------------------------------------- */

/** The two worked examples, whose Differences are both 2320000n — a deliberate tie. */
const NINE = scopedSettlementFor(SET_9281);
const VARIANT = scopedSettlementFor(SET_9281_FEE_VARIANT);

const SYNTHETIC_AS_OF = '2026-07-15T00:00:00.000Z';

/**
 * A one-Payment Settlement, so its Difference is exactly `payment − received` and the
 * test can state the magnitude it wants to order on.
 */
function synthetic(options: {
  readonly id: string;
  readonly received_paise: bigint;
  readonly payment_paise: bigint;
  readonly fee_paise: bigint;
  readonly gst_paise: bigint;
}): ScopedSettlement {
  return {
    settlement_id: options.id,
    settlement_date: '2026-07-15',
    received_paise: options.received_paise,
    record_updated_at: SYNTHETIC_AS_OF,
    recon_report_id: `setlrcn_${options.id}`,
    payments: [
      {
        line_id: `pay_${options.id}`,
        record_updated_at: SYNTHETIC_AS_OF,
        amount_paise: options.payment_paise,
        fee_paise: options.fee_paise,
        gst_on_fee_paise: options.gst_paise,
      },
    ],
    refunds: [],
    chargebacks: [],
    adjustments: [],
  };
}

/** Difference −500000n: ₹5,000 more arrived than expected. An excess is still a row. */
const EXCESS = synthetic({
  id: 'setl_SYNTHETICEXCESS',
  received_paise: 10_000_000n,
  payment_paise: 9_500_000n,
  fee_paise: 100_000n,
  gst_paise: 18_000n,
});

/** Difference +300000n: ₹3,000 short. Ranked below the ₹5,000 excess. */
const SHORTFALL = synthetic({
  id: 'setl_SYNTHETICSHORT',
  received_paise: 10_000_000n,
  payment_paise: 10_300_000n,
  fee_paise: 100_000n,
  gst_paise: 18_000n,
});

/** Difference exactly 0n. Not a row, in either direction, with no tolerance band. */
const ZERO_DIFFERENCE = synthetic({
  id: 'setl_SYNTHETICEXACT',
  received_paise: 10_000_000n,
  payment_paise: 10_000_000n,
  fee_paise: 0n,
  gst_paise: 0n,
});

/** No Settlement_Recon_Report at all: `unreconciled`, so no Difference (4.13). */
const UNRECONCILED = settlementWithNoReconReport({
  settlement_id: 'setl_SYNTHETIC9283',
  settlement_date: '2026-07-30',
  received_paise: 5_000_000n,
  record_updated_at: '2026-07-30T00:00:00.000Z',
});

/** Every Settlement above, in an order no assertion depends on. */
const ALL: readonly ScopedSettlement[] = [
  SHORTFALL,
  UNRECONCILED,
  VARIANT,
  ZERO_DIFFERENCE,
  NINE,
  EXCESS,
];

/** Requirement 4.6's order over {@link ALL}: descending |Difference|, ties on id. */
const EXPECTED_ORDER: readonly string[] = [
  SET_9281.settlement_id, //         2320000, tie broken by ascending identifier
  SET_9281_FEE_VARIANT.settlement_id, // 2320000
  EXCESS.settlement_id, //           |−500000|
  SHORTFALL.settlement_id, //         300000
];

/* -------------------------------------------------------------------------- */
/* The declaration                                                            */
/* -------------------------------------------------------------------------- */

describe('the catalogue declaration', () => {
  it('passes the registration audit unmodified', () => {
    const registry = createToolRegistry([
      catalogueEntryFor({ settlements: () => scopeStore([]), chains: createMemoryEvidenceStore }),
    ]);
    expect(registry.names()).toEqual([GET_SETTLEMENT_DIFFERENCE_BREAKDOWN]);
    const entry = registry.list()[0];
    expect(entry?.tool.mode).toBe<ToolMode>('read_only');
    // Two pattern-bounded dates and a numeric limit. No free-form argument anywhere.
    expect(entry?.audit.arguments.map((argument) => `${argument.path}:${argument.bound}`)).toEqual([
      'from:pattern',
      'to:pattern',
      'limit:non_text',
    ]);
    expect(entry?.tool.freeTextArguments).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Rejections, before any connection is opened (Requirement 12.7, 12.9)       */
/* -------------------------------------------------------------------------- */

describe('a non-conforming invocation is refused with no connection acquired', () => {
  const cases: readonly {
    readonly why: string;
    readonly input: unknown;
    readonly argument: string;
  }[] = [
    { why: 'a smuggled tenant_id', input: { ...SCOPE, limit: 50, tenant_id: TENANT }, argument: 'tenant_id' },
    {
      why: 'an unknown key this tool does not declare',
      input: { ...SCOPE, limit: 50, settlement_ids: ['setl_SYNTHETIC9281'] },
      argument: 'settlement_ids',
    },
    { why: 'no limit at all', input: { ...SCOPE }, argument: 'limit' },
    { why: 'a limit of 0', input: { ...SCOPE, limit: 0 }, argument: 'limit' },
    { why: 'a limit past 50', input: { ...SCOPE, limit: 51 }, argument: 'limit' },
    { why: 'a fractional limit', input: { ...SCOPE, limit: 1.5 }, argument: 'limit' },
    { why: 'an inverted range', input: { from: '2026-07-31', to: '2026-07-01', limit: 50 }, argument: 'from' },
    { why: 'a date that is not a calendar date', input: { from: '2026-02-30', to: '2026-03-01', limit: 50 }, argument: 'from' },
    { why: 'free-form SQL in a date', input: { from: "' OR 1=1; --", to: '2026-07-31', limit: 50 }, argument: 'from' },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.why}, naming the argument`, async () => {
      const h = harness(ALL);
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
      // An out-of-range limit is a rejection, never a clamp: nothing was read.
      expect(h.recorded.acquired).toEqual([]);
      expect(h.scope.queries).toEqual([]);
      expect(h.audit.map((event) => event.eventType)).toEqual(['tool_invocation_rejected']);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* The breakdown (Requirement 4.3, 4.6)                                       */
/* -------------------------------------------------------------------------- */

describe('the breakdown answer (Requirement 4.3, 4.6)', () => {
  it('returns one row per non-zero Difference, descending |Difference|', async () => {
    const h = harness(ALL);
    const result = await h.invoke({ ...SCOPE, limit: MAX_BREAKDOWN_LIMIT });
    if (!result.ok) {
      throw new Error(`expected a breakdown, got ${result.kind}`);
    }

    expect(h.scope.queries).toEqual([
      { tenant_id: TENANT, scope: SCOPE, settlement_ids: null },
    ]);

    // A ₹5,000 excess outranks a ₹3,000 shortfall; the zero-Difference and
    // unreconciled Settlements are absent altogether.
    expect(result.value.rows.map((row) => row.settlement_id)).toEqual(EXPECTED_ORDER);
    expect(result.value.rows.map((row) => row.difference_paise)).toEqual([
      2_320_000n,
      2_320_000n,
      -500_000n,
      300_000n,
    ]);

    // Requirement 4.3's decomposition, per row, from task 11.1's algorithm.
    expect(result.value.rows[0]).toMatchObject({
      expected_paise: SET_9281.recon.expected_paise,
      received_paise: SET_9281.recon.received_paise,
      difference_paise: SET_9281.recon.difference_paise,
      fee_component_paise: SET_9281.recon.fee_component_paise,
      gst_component_paise: SET_9281.recon.gst_component_paise,
      // A fully explained Difference is still a row: 4.6 tests the Difference, not
      // the residual.
      residual_paise: 0n,
    });
    expect(result.value.rows[1]).toMatchObject({
      fee_component_paise: SET_9281_FEE_VARIANT.recon.fee_component_paise,
      gst_component_paise: SET_9281_FEE_VARIANT.recon.gst_component_paise,
      residual_paise: 66_100n,
    });
    // difference − fee − gst, for an excess.
    expect(result.value.rows[2]?.residual_paise).toBe(-618_000n);

    // Nothing was cut off, and the remainder says so rather than being omitted.
    expect(result.value.remainder).toEqual({ count: 0, total_absolute_difference_paise: 0n });

    expect(h.recorded.acquired).toEqual<ToolMode[]>(['read_only']);
    expect(h.recorded.dispositions).toEqual(['commit']);
  });

  it('cuts at the limit and reports the remainder as a non-netting absolute total', async () => {
    const h = harness(ALL);
    const result = await h.invoke({ ...SCOPE, limit: 2 });
    if (!result.ok) {
      throw new Error(`expected a breakdown, got ${result.kind}`);
    }
    expect(result.value.rows.map((row) => row.settlement_id)).toEqual(EXPECTED_ORDER.slice(0, 2));
    // |−500000| + |300000|: an excess and a shortfall add rather than cancel.
    expect(result.value.remainder).toEqual({
      count: 2,
      total_absolute_difference_paise: 800_000n,
    });
  });

  it('is a function of the set, not of the store return order (Requirement 4.15)', async () => {
    const first = harness(ALL);
    const shuffled = harness([...ALL].reverse());
    const a = await first.invoke({ ...SCOPE, limit: 3 });
    const b = await shuffled.invoke({ ...SCOPE, limit: 3 });
    if (!a.ok || !b.ok) {
      throw new Error('expected two breakdowns');
    }
    expect(b.value.rows.map((row) => row.settlement_id)).toEqual(
      a.value.rows.map((row) => row.settlement_id),
    );
    expect(b.value.remainder).toEqual(a.value.remainder);
    expect(b.evidence.figure_paise).toBe(a.evidence.figure_paise);
  });
});

/* -------------------------------------------------------------------------- */
/* Grounding (Requirement 12.2, 12.8)                                         */
/* -------------------------------------------------------------------------- */

describe('every figure carries an Evidence_Chain (Requirement 12.2)', () => {
  it('grounds each row in its own twelve-step chain and the remainder in the envelope', async () => {
    const h = harness(ALL);
    const result = await h.invoke({ ...SCOPE, limit: 2 });
    if (!result.ok) {
      throw new Error(`expected a breakdown, got ${result.kind}`);
    }
    const builder = createEvidenceChainBuilder({ store: h.chains, tenantId: TENANT });

    // Two row chains plus the envelope.
    expect(h.chains.chainCount).toBe(3);

    // Each row's chain resolves through the Tenant gate; its figure is the residual,
    // with the Difference at step 8 and the Expected Amount at step 7.
    const expectedResiduals = [SET_9281.recon.residual_paise, SET_9281_FEE_VARIANT.recon.residual_paise];
    for (const [position, row] of result.value.rows.entries()) {
      const chain = await builder.read(row.evidence_chain_id);
      expect(chain).not.toBeNull();
      expect(chain?.produced_by).toBe(GET_SETTLEMENT_DIFFERENCE_BREAKDOWN);
      expect(chain?.figure_paise).toBe(expectedResiduals[position]);
      expect(chain?.as_of).toBe(row.evidence_as_of);
      expect(chain?.steps).toHaveLength(12);
      expect(chain?.steps[6]?.result_paise).toBe(row.expected_paise);
      expect(chain?.steps[7]?.result_paise).toBe(row.difference_paise);
    }

    // The envelope grounds the remainder total and nothing else.
    expect(result.evidence.produced_by).toBe(GET_SETTLEMENT_DIFFERENCE_BREAKDOWN);
    expect(result.evidence.figure_paise).toBe(
      result.value.remainder.total_absolute_difference_paise,
    );
    const envelope = await builder.read(result.evidence.evidence_chain_id);
    expect(envelope?.figure_paise).toBe(800_000n);

    // `|x|` is a `negate` step, because `evidence_operation` has no `abs`: the excess
    // contributes its magnitude through one, the shortfall reads its step 8 directly.
    const negations = (envelope?.steps ?? []).filter((step) => step.operation === 'negate');
    expect(negations.map((step) => step.result_paise)).toEqual([500_000n]);
    // 8 steps per contributor, one negate, one terminal sum.
    expect(envelope?.steps).toHaveLength(18);
    expect(envelope?.steps.at(-1)?.operation).toBe('sum');
  });

  it('grounds a zero remainder rather than omitting it', async () => {
    const h = harness([NINE]);
    const result = await h.invoke({ ...SCOPE, limit: MAX_BREAKDOWN_LIMIT });
    if (!result.ok) {
      throw new Error(`expected a breakdown, got ${result.kind}`);
    }
    expect(result.value.remainder).toEqual({ count: 0, total_absolute_difference_paise: 0n });
    expect(result.evidence.figure_paise).toBe(0n);
    // The one in-scope Settlement is still cited: the figure states the scope it was
    // computed over.
    expect(result.evidence.source_count).toBe(1);
    const builder = createEvidenceChainBuilder({ store: h.chains, tenantId: TENANT });
    expect((await builder.read(result.evidence.evidence_chain_id))?.figure_paise).toBe(0n);
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
    const result = await h.invoke({ ...SCOPE, limit: MAX_BREAKDOWN_LIMIT });
    if (result.ok || result.kind !== 'incomplete_evidence') {
      throw new Error('expected incomplete_evidence');
    }
    expect(result.unavailable).toEqual([{ type: 'settlement_recon_report', count: 1 }]);
    expect('figure_paise' in result).toBe(false);
    expect(h.chains.chainCount).toBe(0);
    expect(h.recorded.dispositions).toEqual(['rollback']);
    expect(h.audit.map((event) => event.eventType)).toEqual(['incomplete_evidence']);
  });
});

describe('a scope holding no Settlement', () => {
  it('refuses rather than returning an ungrounded zero remainder', async () => {
    const h = harness([]);
    const result = await h.invoke({ ...SCOPE, limit: MAX_BREAKDOWN_LIMIT });
    expect(result).toEqual({
      ok: false,
      kind: 'tool_failure',
      tool: GET_SETTLEMENT_DIFFERENCE_BREAKDOWN,
      cause: 'execution_error',
    });
    expect(h.chains.chainCount).toBe(0);
    expect(h.recorded.dispositions).toEqual(['rollback']);
  });

  it('answers another Tenant zero rows rather than a permission error', async () => {
    const h = harness(ALL);
    const result = await h.invoke(
      { ...SCOPE, limit: MAX_BREAKDOWN_LIMIT },
      { ...SESSION, tenant_id: '22222222-2222-4222-8222-222222222222' },
    );
    // Zero rows in scope, so there is no Source_Record to ground the remainder on —
    // the same refusal as an empty window, and not a "not yours" error.
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.kind).toBe('tool_failure');
  });
});
