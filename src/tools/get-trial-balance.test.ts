/**
 * `get_trial_balance` end to end through the Financial_Tool invoker (task 12.3).
 *
 * Driven through `createToolInvoker` rather than by calling `execute` directly, for the
 * reason 12.1's and 12.2's suites give: every assertion is then about the tool **as an
 * Agent reaches it** — the registration audit, the parse-before-connect ordering, the
 * declared mode, the output schema and the envelope's Evidence_Chain.
 *
 * Two things are deliberately real rather than faked:
 *
 * 1. **The trial balance itself.** `createSemanticLedger` runs over an in-memory
 *    `LedgerStore` that aggregates the same fixture entries the evidence seam lists, so
 *    the closing sign rule, the row ordering and the two grand totals are task 8.4's
 *    code and not a test's restatement of it. The tool's cross-check between the
 *    aggregate and the entry list is therefore exercised against two genuinely separate
 *    computations over one fixture.
 * 2. **The Evidence_Chains.** They are persisted through the same in-memory store
 *    property P6 uses and read back through `EvidenceChainBuilder.read`, the Tenant
 *    gate, so "resolvable" means resolvable rather than merely UUID-shaped
 *    (Requirement 12.6).
 *
 * `ctx.db` is a Proxy that throws on any property access: nothing in this tool reads
 * through it, and a stray query would fail loudly rather than reach a connection RLS
 * answers zero rows for until task 26.1.
 */

import { describe, expect, it } from 'vitest';

import { createEvidenceChainBuilder } from '@/evidence/chain-builder';
import {
  type AccountPeriodTotals,
  createSemanticLedger,
  type LedgerStore,
  type SemanticLedger,
  type TrialBalanceQuery,
} from '@/ledger/semantic-ledger';
import { type AccountKind, DEFAULT_CHART_OF_ACCOUNTS } from '@/ledger/posting-rules';

import {
  createMemoryEvidenceStore,
  type MemoryEvidenceStore,
} from '../../test/property/evidence-chain-memory-store';

import {
  catalogueEntryFor,
  createGetTrialBalance,
  GET_TRIAL_BALANCE,
  type GetTrialBalanceDeps,
  type GetTrialBalanceOutput,
} from './get-trial-balance';
import {
  ACCOUNT_CHAIN_STEP_COUNT,
  ACCOUNT_CLOSING_STEP_INDEX,
  ACCOUNT_CREDIT_TOTAL_STEP_INDEX,
  ACCOUNT_DEBIT_TOTAL_STEP_INDEX,
} from './ledger-evidence';
import type {
  EntrySide,
  LedgerEntryScopeQuery,
  LedgerEntryScopeResult,
  LedgerEntryScopeStore,
  ScopedLedgerEntry,
} from './ledger-scope';
import { createToolRegistry } from './registry';
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
/* Fixture: two balanced Ledger_Entry sets                                    */
/* -------------------------------------------------------------------------- */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

const PAYMENT_SET = '92810000-0000-4281-8281-0000000000a1';
const SETTLEMENT_SET = '92810000-0000-4281-8281-0000000000a2';

const UPDATED_AT = '2026-07-05T04:30:00.000Z';
const LATER_UPDATED_AT = '2026-07-10T04:30:00.000Z';

/** One fixture entry: a {@link ScopedLedgerEntry} plus the date the range filters on. */
interface FixtureEntry extends ScopedLedgerEntry {
  readonly entry_date: string;
}

/**
 * A Payment posting (gross 100000, fee 2118, GST on fee 382) and the Settlement that
 * clears it. Both sets balance, so the trial balance must too.
 */
const ENTRIES: readonly FixtureEntry[] = [
  {
    account_code: 'settlement_pending',
    set_id: PAYMENT_SET,
    line_no: 1,
    side: 'debit',
    amount_paise: 97_500n,
    record_updated_at: UPDATED_AT,
    entry_date: '2026-07-05',
  },
  {
    account_code: 'razorpay_fee_expense',
    set_id: PAYMENT_SET,
    line_no: 2,
    side: 'debit',
    amount_paise: 2_118n,
    record_updated_at: UPDATED_AT,
    entry_date: '2026-07-05',
  },
  {
    account_code: 'gst_input_credit',
    set_id: PAYMENT_SET,
    line_no: 3,
    side: 'debit',
    amount_paise: 382n,
    record_updated_at: UPDATED_AT,
    entry_date: '2026-07-05',
  },
  {
    account_code: 'revenue',
    set_id: PAYMENT_SET,
    line_no: 4,
    side: 'credit',
    amount_paise: 100_000n,
    record_updated_at: UPDATED_AT,
    entry_date: '2026-07-05',
  },
  {
    account_code: 'bank',
    set_id: SETTLEMENT_SET,
    line_no: 1,
    side: 'debit',
    amount_paise: 97_500n,
    record_updated_at: LATER_UPDATED_AT,
    entry_date: '2026-07-10',
  },
  {
    account_code: 'settlement_pending',
    set_id: SETTLEMENT_SET,
    line_no: 2,
    side: 'credit',
    amount_paise: 97_500n,
    record_updated_at: LATER_UPDATED_AT,
    entry_date: '2026-07-10',
  },
];

const RANGE = { from: '2026-07-01', to: '2026-07-31' } as const;

const KINDS: ReadonlyMap<string, AccountKind> = new Map(
  DEFAULT_CHART_OF_ACCOUNTS.map((account) => [account.account_code, account.kind]),
);

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

const SESSION: ToolSession = {
  tenant_id: TENANT,
  user_id: 'usr_12_3',
  permissions: ['view_financial_data', 'run_agents'],
};

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

const inRange = (entry: FixtureEntry, from: string, to: string): boolean =>
  entry.entry_date >= from && entry.entry_date <= to;

/**
 * The aggregate half: a `LedgerStore` that groups the fixture by account and side, as
 * the real `GROUP BY` does. Nothing else on the interface is reachable from this tool.
 */
function ledgerStore(entries: readonly FixtureEntry[]): LedgerStore {
  return {
    insertSet(): never {
      throw new Error('get_trial_balance is read_only; it posts nothing');
    },
    findSourceRecord(): never {
      throw new Error('get_trial_balance reads no Source_Record directly');
    },
    findSet(): never {
      throw new Error('get_trial_balance reads no Ledger_Entry set directly');
    },
    trialBalanceTotals(query: TrialBalanceQuery): Promise<readonly AccountPeriodTotals[]> {
      // A cross-Tenant request answers zero rows, never a permission error.
      if (query.tenant_id !== TENANT) {
        return Promise.resolve([]);
      }
      const totals = new Map<string, { debit: bigint; credit: bigint }>();
      for (const entry of entries) {
        if (!inRange(entry, query.from, query.to)) {
          continue;
        }
        const bucket = totals.get(entry.account_code) ?? { debit: 0n, credit: 0n };
        if (entry.side === 'debit') {
          bucket.debit += entry.amount_paise;
        } else {
          bucket.credit += entry.amount_paise;
        }
        totals.set(entry.account_code, bucket);
      }
      return Promise.resolve(
        [...totals.entries()].map(([account_code, bucket]) => ({
          account_code,
          kind: KINDS.get(account_code) ?? 'asset',
          total_debit_paise: bucket.debit,
          total_credit_paise: bucket.credit,
        })),
      );
    },
  };
}

function semanticLedger(entries: readonly FixtureEntry[]): SemanticLedger {
  return createSemanticLedger({
    store: ledgerStore(entries),
    audit: { append: () => Promise.resolve() },
    actor: { kind: 'agent', id: 'reconciliation_agent' },
    now: () => new Date('2026-07-30T09:00:00.000Z'),
  });
}

/** The entry half, with whatever the store could not read (Requirement 12.3). */
function entryStore(
  entries: readonly FixtureEntry[],
  result: Partial<LedgerEntryScopeResult> = {},
): LedgerEntryScopeStore & { readonly queries: LedgerEntryScopeQuery[] } {
  const queries: LedgerEntryScopeQuery[] = [];
  return {
    queries,
    listEntriesInRange(query: LedgerEntryScopeQuery): Promise<LedgerEntryScopeResult> {
      queries.push(query);
      const visible =
        query.tenant_id === TENANT
          ? entries.filter((entry) => inRange(entry, query.range.from, query.range.to))
          : [];
      return Promise.resolve({ entries: visible, ...result });
    },
  };
}

interface Harness {
  readonly chains: MemoryEvidenceStore;
  readonly entries: ReturnType<typeof entryStore>;
  readonly recorded: Recorded;
  readonly audit: ToolAuditEvent[];
  readonly deps: GetTrialBalanceDeps;
  invoke(input: unknown, session?: ToolSession): Promise<ToolResult<GetTrialBalanceOutput>>;
}

function harness(
  entries: readonly FixtureEntry[] = ENTRIES,
  scopeResult: Partial<LedgerEntryScopeResult> = {},
): Harness {
  const chains = createMemoryEvidenceStore();
  const store = entryStore(entries, scopeResult);
  const recorded = recordingConnections();
  const audit: ToolAuditEvent[] = [];
  const deps: GetTrialBalanceDeps = {
    ledger: () => semanticLedger(entries),
    entries: () => store,
    chains: () => chains,
  };
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
  const tool = createGetTrialBalance(deps);
  return {
    chains,
    entries: store,
    recorded,
    audit,
    deps,
    invoke: (input, session = SESSION) => invoker.invoke(tool, session, input),
  };
}

/** The success payload, or a failure naming what came back instead. */
function valueOf(result: ToolResult<GetTrialBalanceOutput>): GetTrialBalanceOutput {
  if (!result.ok) {
    throw new Error(`expected a figure, got ${result.kind}`);
  }
  return result.value;
}

/* -------------------------------------------------------------------------- */
/* The answer                                                                 */
/* -------------------------------------------------------------------------- */

describe('get_trial_balance', () => {
  it('declares design.md\'s name and read-only mode, and registers cleanly', () => {
    const tool = createGetTrialBalance(harness().deps);
    expect(tool.name).toBe(GET_TRIAL_BALANCE);
    expect(tool.name).toBe('get_trial_balance');
    expect(tool.mode).toBe('read_only');
    expect(tool.timeoutMs).toBe(10_000);

    const registry = createToolRegistry([catalogueEntryFor(harness().deps)]);
    expect(registry.names()).toEqual([GET_TRIAL_BALANCE]);
  });

  it('returns one row per in-range account with its name, totals and closing balance', async () => {
    const value = valueOf(await harness().invoke(RANGE));

    expect(value.accounts.map((account) => account.account_code)).toEqual([
      // Ascending account_code, as trialBalance orders its rows.
      'bank',
      'gst_input_credit',
      'razorpay_fee_expense',
      'revenue',
      'settlement_pending',
    ]);
    expect(value.accounts.map((account) => account.account_name)).toEqual([
      'Bank',
      'GST Input Credit',
      'Razorpay Fee Expense',
      'Revenue',
      'Settlement Pending',
    ]);
    expect(
      value.accounts.map((account) => [
        account.account_code,
        account.debit_total_paise,
        account.credit_total_paise,
        account.closing_paise,
      ]),
    ).toEqual([
      // asset, debited once
      ['bank', 97_500n, 0n, 97_500n],
      ['gst_input_credit', 382n, 0n, 382n],
      // expense
      ['razorpay_fee_expense', 2_118n, 0n, 2_118n],
      // income: closes credits − debits, so a credit-only account closes positive
      ['revenue', 0n, 100_000n, 100_000n],
      // fully cleared: debited by the Payment, credited by the Settlement
      ['settlement_pending', 97_500n, 97_500n, 0n],
    ]);
  });

  it('states the two grand totals as equal, which is Requirement 2.5\'s guarantee', async () => {
    const value = valueOf(await harness().invoke(RANGE));
    expect(value.debit_total_paise).toBe(197_500n);
    expect(value.credit_total_paise).toBe(197_500n);
    expect(value.debit_total_paise).toBe(value.credit_total_paise);
  });

  it('reads the range from the argument and the Tenant from the session', async () => {
    const test = harness();
    await test.invoke(RANGE);
    expect(test.entries.queries).toEqual([{ tenant_id: TENANT, range: { ...RANGE } }]);
  });

  it('excludes an account whose only entry falls outside the range', async () => {
    const value = valueOf(await harness().invoke({ from: '2026-07-08', to: '2026-07-31' }));
    // Only the Settlement set is in range: bank debit, settlement_pending credit.
    expect(value.accounts.map((account) => account.account_code)).toEqual([
      'bank',
      'settlement_pending',
    ]);
    expect(value.debit_total_paise).toBe(97_500n);
    expect(value.credit_total_paise).toBe(97_500n);
  });

  it('acquires a read-only connection and commits it', async () => {
    const test = harness();
    await test.invoke(RANGE);
    expect(test.recorded.acquired).toEqual(['read_only']);
    expect(test.recorded.dispositions).toEqual(['commit']);
  });
});

/* -------------------------------------------------------------------------- */
/* Grounding (Requirement 12.2)                                               */
/* -------------------------------------------------------------------------- */

describe('get_trial_balance evidence', () => {
  it('grounds every account row in a resolvable three-step chain', async () => {
    const test = harness();
    const result = await test.invoke(RANGE);
    const value = valueOf(result);
    const builder = createEvidenceChainBuilder({ store: test.chains, tenantId: TENANT });

    for (const account of value.accounts) {
      const chain = await builder.read(account.evidence_chain_id);
      expect(chain).not.toBeNull();
      if (chain === null) {
        continue;
      }
      expect(chain.produced_by).toBe(GET_TRIAL_BALANCE);
      expect(chain.as_of).toBe(account.evidence_as_of);
      // The closing balance is the chain's figure; the two totals are intermediates.
      expect(chain.figure_paise).toBe(account.closing_paise);
      expect(chain.steps).toHaveLength(ACCOUNT_CHAIN_STEP_COUNT);
      const [debit, credit, closing] = chain.steps;
      expect(debit?.index).toBe(ACCOUNT_DEBIT_TOTAL_STEP_INDEX);
      expect(debit?.result_paise).toBe(account.debit_total_paise);
      expect(credit?.index).toBe(ACCOUNT_CREDIT_TOTAL_STEP_INDEX);
      expect(credit?.result_paise).toBe(account.credit_total_paise);
      expect(closing?.index).toBe(ACCOUNT_CLOSING_STEP_INDEX);
      expect(closing?.operation).toBe('subtract');
      expect(closing?.result_paise).toBe(account.closing_paise);
      // Every citation is a Ledger_Entry set, identified per line.
      for (const source of chain.first_page.sources) {
        expect(source.ref.type).toBe('ledger_entry_set');
        expect([PAYMENT_SET, SETTLEMENT_SET]).toContain(source.ref.id);
        for (const field of source.fields) {
          expect(field).toMatch(/^line_\d+\.amount_paise$/);
        }
      }
    }
  });

  it('states the operand order that reproduces the ledger\'s signed closing balance', async () => {
    const test = harness();
    const value = valueOf(await test.invoke(RANGE));
    const builder = createEvidenceChainBuilder({ store: test.chains, tenantId: TENANT });

    const closingStepOf = async (accountCode: string): Promise<readonly unknown[]> => {
      const account = value.accounts.find((row) => row.account_code === accountCode);
      const chain = await builder.read(account?.evidence_chain_id ?? '');
      return chain?.steps[ACCOUNT_CLOSING_STEP_INDEX - 1]?.operands ?? [];
    };

    // An asset closes debits − credits, so the debit total step comes first...
    expect(await closingStepOf('bank')).toEqual([
      { kind: 'step', index: ACCOUNT_DEBIT_TOTAL_STEP_INDEX },
      { kind: 'step', index: ACCOUNT_CREDIT_TOTAL_STEP_INDEX },
    ]);
    // ...and income the other way round. Neither order is asserted from the account
    // kind: the tool reads it off the figure the Semantic_Ledger signed.
    expect(await closingStepOf('revenue')).toEqual([
      { kind: 'step', index: ACCOUNT_CREDIT_TOTAL_STEP_INDEX },
      { kind: 'step', index: ACCOUNT_DEBIT_TOTAL_STEP_INDEX },
    ]);
  });

  it('grounds each grand total in its own aggregate chain, and nominates the debit one', async () => {
    const test = harness();
    const result = await test.invoke(RANGE);
    const value = valueOf(result);
    if (!result.ok) {
      return;
    }
    expect(result.evidence.evidence_chain_id).toBe(value.debit_total_evidence_chain_id);
    expect(result.evidence.figure_paise).toBe(value.debit_total_paise);
    // Two derivations over disjoint operand sets, so two chains.
    expect(value.credit_total_evidence_chain_id).not.toBe(value.debit_total_evidence_chain_id);

    const builder = createEvidenceChainBuilder({ store: test.chains, tenantId: TENANT });
    const debit = await builder.read(value.debit_total_evidence_chain_id);
    const credit = await builder.read(value.credit_total_evidence_chain_id);
    expect(debit?.figure_paise).toBe(value.debit_total_paise);
    expect(credit?.figure_paise).toBe(value.credit_total_paise);
    expect(debit?.as_of).toBe(value.debit_total_evidence_as_of);
    expect(credit?.as_of).toBe(value.credit_total_evidence_as_of);
    // One sum step per in-range account, then the terminal sum over those results.
    expect(debit?.steps).toHaveLength(value.accounts.length + 1);
    expect(credit?.steps).toHaveLength(value.accounts.length + 1);
    expect(debit?.steps.at(-1)?.operation).toBe('sum');
  });

  it('resolves no chain of this Tenant for another Tenant\'s session', async () => {
    const test = harness();
    const value = valueOf(await test.invoke(RANGE));
    const otherTenant = createEvidenceChainBuilder({ store: test.chains, tenantId: OTHER_TENANT });
    // Absent and "not yours" are the same answer (Requirement 14.4).
    expect(await otherTenant.read(value.debit_total_evidence_chain_id)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

describe('get_trial_balance refusals', () => {
  it('returns incomplete_evidence with per-type counts and no figure', async () => {
    const result = await harness(ENTRIES, {
      unreadable: [
        { type: 'ledger_entry_set', id: PAYMENT_SET },
        { type: 'payment', id: 'pay_12_3' },
      ],
    }).invoke(RANGE);

    expect(result.ok).toBe(false);
    if (result.ok || result.kind !== 'incomplete_evidence') {
      throw new Error(`expected incomplete_evidence, got ${result.ok ? 'ok' : result.kind}`);
    }
    expect(result.unavailable).toEqual([
      // `source_record_type` enum order, one entry per type.
      { type: 'payment', count: 1 },
      { type: 'ledger_entry_set', count: 1 },
    ]);
    expect(Object.keys(result)).toEqual(['ok', 'kind', 'unavailable']);
  });

  it('refuses a range holding no Ledger_Entry rather than answering an ungrounded zero', async () => {
    const result = await harness().invoke({ from: '2026-09-01', to: '2026-09-30' });
    expect(result).toEqual({
      ok: false,
      kind: 'tool_failure',
      tool: GET_TRIAL_BALANCE,
      cause: 'execution_error',
    });
  });

  it('answers zero rows for another Tenant, and then refuses for want of a figure', async () => {
    const result = await harness().invoke(RANGE, { ...SESSION, tenant_id: OTHER_TENANT });
    // Not a permission error: the rows simply do not exist for that Tenant.
    expect(result).toEqual({
      ok: false,
      kind: 'tool_failure',
      tool: GET_TRIAL_BALANCE,
      cause: 'execution_error',
    });
  });

  it('rejects a malformed range as a schema violation, with no connection opened', async () => {
    const test = harness();
    const notADate = await test.invoke({ from: '2026-02-30', to: '2026-03-31' });
    expect(notADate.ok).toBe(false);
    if (notADate.ok || notADate.kind !== 'schema_violation') {
      throw new Error('expected schema_violation for a date that is not a calendar date');
    }
    // Every violation names `from` and nothing else. Deduplicated because `2026-02-30`
    // trips two independent checks on that one argument — `z.iso.date()`'s format,
    // which is leap-year aware, and the explicit calendar refinement that states the
    // same requirement in a message a caller can read.
    expect([...new Set(notADate.violations.map((violation) => violation.argument))]).toEqual([
      'from',
    ]);

    const inverted = await test.invoke({ from: '2026-07-31', to: '2026-07-01' });
    expect(inverted.ok).toBe(false);
    if (inverted.ok || inverted.kind !== 'schema_violation') {
      throw new Error('expected schema_violation for an inverted range');
    }
    expect(inverted.violations.map((violation) => violation.argument)).toEqual(['from']);

    // Requirement 12.9: nothing is read, and no connection is acquired.
    expect(test.recorded.acquired).toEqual([]);
    expect(test.entries.queries).toEqual([]);
    expect(test.chains.chainCount).toBe(0);
    expect(test.audit.map((event) => event.eventType)).toEqual([
      'tool_invocation_rejected',
      'tool_invocation_rejected',
    ]);
  });

  it('rejects a tenant_id argument and any unknown key', async () => {
    const test = harness();
    const scoped = await test.invoke({ ...RANGE, tenant_id: OTHER_TENANT });
    expect(scoped.ok).toBe(false);
    if (scoped.ok || scoped.kind !== 'schema_violation') {
      throw new Error('expected schema_violation for a tenant_id argument');
    }
    // Rejected, not stripped (Requirement 12.7).
    expect(scoped.violations.map((violation) => violation.argument)).toEqual(['tenant_id']);

    const unknown = await test.invoke({ ...RANGE, limit: 50 });
    expect(unknown.ok).toBe(false);
    if (unknown.ok || unknown.kind !== 'schema_violation') {
      throw new Error('expected schema_violation for an unknown argument');
    }
    expect(unknown.violations.map((violation) => violation.argument)).toEqual(['limit']);
  });

  it('refuses when the aggregate and the entry list disagree', async () => {
    // The entry seam hides the Settlement set; the aggregate still counts it, so `bank`
    // has a row with no entry and `settlement_pending` totals disagree.
    const visible = ENTRIES.filter((entry) => entry.set_id === PAYMENT_SET);
    const chains = createMemoryEvidenceStore();
    const recorded = recordingConnections();
    const invoker = createToolInvoker({
      connections: recorded.connections,
      audit: { append: () => Promise.resolve() },
      actor: { kind: 'agent', id: 'reconciliation_agent' },
      now: () => new Date('2026-07-30T09:00:00.000Z'),
    });
    const tool = createGetTrialBalance({
      // The aggregate sees everything...
      ledger: () => semanticLedger(ENTRIES),
      // ...the entry read does not.
      entries: () => entryStore(visible),
      chains: () => chains,
    });

    const result = await invoker.invoke(tool, SESSION, RANGE);
    expect(result).toEqual({
      ok: false,
      kind: 'tool_failure',
      tool: GET_TRIAL_BALANCE,
      cause: 'execution_error',
    });
    // Nothing is written for a figure that will not be returned.
    expect(chains.chainCount).toBe(0);
  });

  it('refuses an entry list that repeats one (set_id, line_no)', async () => {
    const duplicated: readonly FixtureEntry[] = [
      ...ENTRIES,
      { ...(ENTRIES[0] as FixtureEntry), amount_paise: 1n },
    ];
    const result = await harness(duplicated).invoke(RANGE);
    expect(result).toEqual({
      ok: false,
      kind: 'tool_failure',
      tool: GET_TRIAL_BALANCE,
      cause: 'execution_error',
    });
  });

  it('refuses an account the seeded chart of accounts cannot name', async () => {
    const unknownAccount: readonly FixtureEntry[] = [
      {
        account_code: 'tenant_defined_clearing',
        set_id: SETTLEMENT_SET,
        line_no: 3,
        side: 'debit',
        amount_paise: 500n,
        record_updated_at: LATER_UPDATED_AT,
        entry_date: '2026-07-10',
      },
      {
        account_code: 'revenue',
        set_id: SETTLEMENT_SET,
        line_no: 4,
        side: 'credit' satisfies EntrySide,
        amount_paise: 500n,
        record_updated_at: LATER_UPDATED_AT,
        entry_date: '2026-07-10',
      },
    ];
    // A Tenant-defined account still needs a chart read seam; the tool must not guess
    // a display name from the code.
    const result = await harness(unknownAccount).invoke(RANGE);
    expect(result).toEqual({
      ok: false,
      kind: 'tool_failure',
      tool: GET_TRIAL_BALANCE,
      cause: 'execution_error',
    });
  });
});
