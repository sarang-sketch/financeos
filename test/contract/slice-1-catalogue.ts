/**
 * The Slice 1 Financial_Tool catalogue and its contract fixtures (task 12.7).
 * Requirements 12.1, 12.2, 12.3, 12.7, 12.9, 12.11.
 *
 * A **library, not a test file**: `./slice-1-catalogue.test.ts` is the suite, and it is
 * three lines long because everything a generated case needs is here. The split exists
 * so `./tool-contract.test.ts` can assert facts about the real catalogue — that it is
 * wired into `runToolContract` at all, and how far it is from design.md's twenty — without
 * running the whole contract suite twice.
 *
 * ## Two worlds per tool, and why the second one exists
 *
 * Every tool takes its read seams as factories over the `ToolContext`, so a fixture is
 * a set of in-memory stores. Each tool therefore gets **two** dep bundles:
 *
 * - the **readable** world, whose stores answer completely. This is what
 *   `validInput`, the output-schema case, the mode case and the monetary-evidence case
 *   run against.
 * - the **hidden** world, identical except that one contributing Source_Record cannot
 *   be read. This is `ToolContractFixture.hiddenContributingRecord`, and it is what
 *   proves Requirement 12.3 for each tool rather than for the layer in general.
 *
 * Both bundles are assembled into a {@link SliceOneToolDeps} and passed through
 * `createSliceOneToolRegistry`, so the hidden variant of a tool is **the same
 * declaration reached the same way** — through the production catalogue module, audited
 * by the production registry — rather than a hand-built lookalike. That is what makes
 * `hiddenContributingRecord`'s name-and-mode check trivially true and meaningful:
 * nothing here can hand the harness a different tool by accident.
 *
 * ## The Evidence_Chains are real
 *
 * Chains are composed through `createEvidenceChainBuilder` over the same in-memory store
 * property P6 uses, and read back through `EvidenceChainBuilder.read` — the Tenant gate.
 * So "resolvable" means the builder found it under {@link CONTRACT_TENANT}, not that the
 * string looked like a UUID (Requirement 12.6). Each tool gets its **own** store, so one
 * tool's chain cannot accidentally resolve another tool's identifier.
 *
 * ## Every scope holds something, deliberately
 *
 * Four Slice 1 tools refuse an empty window as `tool_failure` — `source_count >= 1` is a
 * database CHECK and `ToolResult` has no chainless success variant — and that refusal is
 * an escalated gap, not a defect of theirs. So every fixture here supplies a scope
 * holding at least one record, and no case asserts anything about an empty one. See the
 * harness module doc comment.
 *
 * ## Money
 *
 * Every figure is `bigint`. Nothing here rounds, converts or formats one; the fixtures
 * state paise as literals and the tools do the arithmetic.
 */

import { createEvidenceChainBuilder } from '@/evidence/chain-builder';
import { type AccountKind, DEFAULT_CHART_OF_ACCOUNTS } from '@/ledger/posting-rules';
import {
  adjustmentSourceStore,
  ADJUSTMENT_DATE,
  AUTHORIZATION_ID,
  authorizationLookup,
  balancedEntries,
  citedRecord,
  exceptionResolutionStore,
  MemoryLedgerStore,
  PROPOSAL_ID,
  WRITE_ACTOR,
  writeGate,
} from '@/tools/write-tools.test-support';
import {
  type AccountPeriodTotals,
  createSemanticLedger,
  type LedgerStore,
  type SemanticLedger,
  type TrialBalanceQuery,
} from '@/ledger/semantic-ledger';
import {
  createSliceOneToolRegistry,
  type SliceOneToolDeps,
} from '@/tools/catalogue';
import type {
  CashMetricRead,
  CashMetricSource,
  MetricAmountRecord,
  PendingSettlementMetricRead,
  PendingSettlementMetricSource,
  Revenue30dMetricRead,
  Revenue30dMetricSource,
} from '@/tools/control-tower-metrics';
import type { ExceptionStore, ScopedException } from '@/tools/exception-tools';
import {
  exceptionWithChain,
  MemoryEvidenceStore as ExceptionEvidenceStore,
  MemoryExceptionStore,
} from '@/tools/exception-tools.test-support';
import type {
  DuplicateRefundQuery,
  DuplicateRefundRead,
  DuplicateRefundStore,
  PaymentRefundGroup,
} from '@/tools/get-duplicate-refund-candidates';
import type {
  AccrualSourceRecord,
  MissingAccrualQuery,
  MissingAccrualRead,
  MissingAccrualStore,
} from '@/tools/get-missing-accruals';
import type {
  ScopedPayment,
  UnsettledPaymentQuery,
  UnsettledPaymentResult,
  UnsettledPaymentStore,
} from '@/tools/get-unsettled-payments';
import type {
  MarketplaceRead,
  MarketplaceStore,
} from '@/tools/marketplace-tools';
import type {
  LedgerEntryScopeQuery,
  LedgerEntryScopeResult,
  LedgerEntryScopeStore,
  ScopedLedgerEntry,
} from '@/tools/ledger-scope';
import type { ToolRegistry } from '@/tools/registry';
import type {
  ScopedSettlement,
  SettlementScopeQuery,
  SettlementScopeResult,
  SettlementScopeStore,
} from '@/tools/settlement-scope';
import type { ErasedFinancialTool } from '@/tools/tool';

import { SET_9281, SET_9281_FEE_VARIANT } from '../fixtures/set-9281';
import {
  scopedSettlementFor,
  settlementWithNoReconReport,
} from '../fixtures/set-9281.scoped';
import {
  createMemoryEvidenceStore,
  type MemoryEvidenceStore,
} from '../property/evidence-chain-memory-store';

import { CONTRACT_TENANT, type ResolvedChain, type ToolContractFixture } from './tool-contract';

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Read a chain back through the Tenant gate. What `resolvable` means here. */
function resolverFor(store: MemoryEvidenceStore | ExceptionEvidenceStore) {
  return async (id: string): Promise<ResolvedChain | null> =>
    createEvidenceChainBuilder({ store, tenantId: CONTRACT_TENANT }).read(id);
}

/** The scope every date-taking fixture states, and every fixture record falls inside. */
const SCOPE = { from: '2026-07-01', to: '2026-07-31' } as const;

const UPDATED_AT = '2026-07-28T00:00:00.000Z';

/* -------------------------------------------------------------------------- */
/* 12.1 / 12.2: the two settlement tools                                      */
/* -------------------------------------------------------------------------- */

/** The two worked examples, both with a non-zero Difference of 2320000 paise. */
const NINE = scopedSettlementFor(SET_9281);
const FEE_VARIANT = scopedSettlementFor(SET_9281_FEE_VARIANT);

/** Requirement 4.13's absent report, so the reconciliation fixture covers that branch. */
const UNRECONCILED = settlementWithNoReconReport({
  settlement_id: 'setl_SYNTHETIC9283',
  settlement_date: '2026-07-30',
  received_paise: 5_000_000n,
  record_updated_at: '2026-07-30T00:00:00.000Z',
});

/** One unreadable contributing record, for the Requirement 12.3 world. */
const HIDDEN_RECON_LINE = { type: 'settlement_recon_report', id: 'pay_SYNTHETIC92811' } as const;

function settlementStore(settlements: readonly ScopedSettlement[]): SettlementScopeStore {
  return {
    listInScope(query: SettlementScopeQuery): Promise<SettlementScopeResult> {
      // A cross-Tenant request answers zero rows, never a permission error.
      const rows = query.tenant_id === CONTRACT_TENANT ? settlements : [];
      const named = query.settlement_ids;
      return Promise.resolve({
        settlements: named === null ? rows : rows.filter((row) => named.includes(row.settlement_id)),
        ledger_entries_examined: 9,
        razorpay_invoices_examined: 4,
      });
    },
  };
}

const RECONCILIATION_CHAINS = createMemoryEvidenceStore();
const BREAKDOWN_CHAINS = createMemoryEvidenceStore();

const READABLE_SETTLEMENTS: readonly ScopedSettlement[] = [UNRECONCILED, FEE_VARIANT, NINE];
const HIDDEN_SETTLEMENTS: readonly ScopedSettlement[] = [
  { ...NINE, unreadable: [HIDDEN_RECON_LINE] },
  FEE_VARIANT,
];

/* -------------------------------------------------------------------------- */
/* 12.3: get_trial_balance                                                    */
/* -------------------------------------------------------------------------- */

/** One fixture entry: a {@link ScopedLedgerEntry} plus the date the range filters on. */
interface FixtureEntry extends ScopedLedgerEntry {
  readonly entry_date: string;
}

const PAYMENT_SET = '92810000-0000-4281-8281-0000000000a1';
const SETTLEMENT_SET = '92810000-0000-4281-8281-0000000000a2';
const LEDGER_UPDATED_AT = '2026-07-05T04:30:00.000Z';
const LEDGER_LATER_AT = '2026-07-10T04:30:00.000Z';

/**
 * A Payment posting (gross 100000, fee 2118, GST on fee 382) and the Settlement that
 * clears it. Both sets balance, so the trial balance must — and every account code is in
 * `DEFAULT_CHART_OF_ACCOUNTS`, which is where `account_name` is resolved from.
 */
const LEDGER_ENTRIES: readonly FixtureEntry[] = [
  {
    account_code: 'settlement_pending',
    set_id: PAYMENT_SET,
    line_no: 1,
    side: 'debit',
    amount_paise: 97_500n,
    record_updated_at: LEDGER_UPDATED_AT,
    entry_date: '2026-07-05',
  },
  {
    account_code: 'razorpay_fee_expense',
    set_id: PAYMENT_SET,
    line_no: 2,
    side: 'debit',
    amount_paise: 2_118n,
    record_updated_at: LEDGER_UPDATED_AT,
    entry_date: '2026-07-05',
  },
  {
    account_code: 'gst_input_credit',
    set_id: PAYMENT_SET,
    line_no: 3,
    side: 'debit',
    amount_paise: 382n,
    record_updated_at: LEDGER_UPDATED_AT,
    entry_date: '2026-07-05',
  },
  {
    account_code: 'revenue',
    set_id: PAYMENT_SET,
    line_no: 4,
    side: 'credit',
    amount_paise: 100_000n,
    record_updated_at: LEDGER_UPDATED_AT,
    entry_date: '2026-07-05',
  },
  {
    account_code: 'bank',
    set_id: SETTLEMENT_SET,
    line_no: 1,
    side: 'debit',
    amount_paise: 97_500n,
    record_updated_at: LEDGER_LATER_AT,
    entry_date: '2026-07-10',
  },
  {
    account_code: 'settlement_pending',
    set_id: SETTLEMENT_SET,
    line_no: 2,
    side: 'credit',
    amount_paise: 97_500n,
    record_updated_at: LEDGER_LATER_AT,
    entry_date: '2026-07-10',
  },
];

const ACCOUNT_KINDS: ReadonlyMap<string, AccountKind> = new Map(
  DEFAULT_CHART_OF_ACCOUNTS.map((account) => [account.account_code, account.kind]),
);

const inLedgerRange = (entry: FixtureEntry, from: string, to: string): boolean =>
  entry.entry_date >= from && entry.entry_date <= to;

/**
 * The aggregate half: a `LedgerStore` that groups the fixture by account and side, as the
 * real `GROUP BY` does. The tool cross-checks it against the entry list, so both must be
 * derived from one array — they are.
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
      if (query.tenant_id !== CONTRACT_TENANT) {
        return Promise.resolve([]);
      }
      const totals = new Map<string, { debit: bigint; credit: bigint }>();
      for (const entry of entries) {
        if (!inLedgerRange(entry, query.from, query.to)) {
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
          kind: ACCOUNT_KINDS.get(account_code) ?? 'asset',
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
    actor: { kind: 'agent', id: 'contract_harness' },
    now: () => new Date('2026-07-30T09:00:00.000Z'),
  });
}

function ledgerEntryStore(
  entries: readonly FixtureEntry[],
  extra: Partial<LedgerEntryScopeResult> = {},
): LedgerEntryScopeStore {
  return {
    listEntriesInRange(query: LedgerEntryScopeQuery): Promise<LedgerEntryScopeResult> {
      const visible =
        query.tenant_id === CONTRACT_TENANT
          ? entries.filter((entry) => inLedgerRange(entry, query.range.from, query.range.to))
          : [];
      return Promise.resolve({ entries: visible, ...extra });
    },
  };
}

const TRIAL_BALANCE_CHAINS = createMemoryEvidenceStore();

/** The unreadable contributor for the trial balance's Requirement 12.3 world. */
const HIDDEN_LEDGER_SET = { type: 'ledger_entry_set', id: PAYMENT_SET } as const;

/* -------------------------------------------------------------------------- */
/* 12.4: unsettled Payments, duplicate Refunds, missing accruals              */
/* -------------------------------------------------------------------------- */

const PAYMENT_UPDATED_AT = '2026-07-20T00:00:00.000Z';

function scopedPayment(overrides: Partial<ScopedPayment> = {}): ScopedPayment {
  return {
    payment_id: 'pay_contract_1',
    status_rzp: 'captured',
    created_on: '2026-07-18',
    amount_paise: 250_000n,
    record_updated_at: PAYMENT_UPDATED_AT,
    settlement_candidate_count: 0,
    ...overrides,
  };
}

/** Two unsettled Payments and one already linked, so the exclusion is exercised too. */
const UNSETTLED_PAYMENTS: readonly ScopedPayment[] = [
  scopedPayment(),
  scopedPayment({ payment_id: 'pay_contract_2', created_on: '2026-07-10', amount_paise: 400_000n }),
  scopedPayment({ payment_id: 'pay_contract_linked', settlement_candidate_count: 1 }),
];

function paymentCitations(
  payments: readonly ScopedPayment[],
): UnsettledPaymentResult['examined'] {
  return payments.map((payment) => ({
    ref: { type: 'payment', id: payment.payment_id },
    field: 'amount',
    record_updated_at: payment.record_updated_at,
  }));
}

function unsettledPaymentStore(payments: readonly ScopedPayment[]): UnsettledPaymentStore {
  return {
    listCandidates(query: UnsettledPaymentQuery): Promise<UnsettledPaymentResult> {
      const rows = query.tenant_id === CONTRACT_TENANT ? payments : [];
      return Promise.resolve({ payments: rows, examined: paymentCitations(rows) });
    },
  };
}

const UNSETTLED_CHAINS = createMemoryEvidenceStore();

/** One Payment whose Settlement link could not be read (Requirement 12.3). */
const HIDDEN_UNSETTLED: readonly ScopedPayment[] = [
  scopedPayment({ unreadable: [{ type: 'settlement', id: 'setl_SYNTHETIC9284' }] }),
  ...UNSETTLED_PAYMENTS.slice(1),
];

/* --- duplicate Refunds ---------------------------------------------------- */

function refundGroup(options: {
  readonly payment_id: string;
  readonly payment_paise: bigint;
  readonly refunds: readonly (readonly [string, bigint])[];
  readonly unreadable?: readonly { readonly type: 'refund'; readonly id: string }[];
}): PaymentRefundGroup {
  return {
    payment_id: options.payment_id,
    payment_paise: options.payment_paise,
    record_updated_at: UPDATED_AT,
    refunds: options.refunds.map(([refund_id, amount_paise]) => ({
      refund_id,
      linked_payment_id: options.payment_id,
      created_on: '2026-07-12',
      amount_paise,
      record_updated_at: UPDATED_AT,
    })),
    ...(options.unreadable === undefined ? {} : { unreadable: options.unreadable }),
  };
}

/** One candidate (110000 refunded against 100000) and one group that is not. */
const REFUND_GROUPS: readonly PaymentRefundGroup[] = [
  refundGroup({
    payment_id: 'pay_contract_over',
    payment_paise: 100_000n,
    refunds: [
      ['rfnd_contract_a', 60_000n],
      ['rfnd_contract_b', 50_000n],
    ],
  }),
  refundGroup({
    payment_id: 'pay_contract_exact',
    payment_paise: 100_000n,
    refunds: [
      ['rfnd_contract_c', 40_000n],
      ['rfnd_contract_d', 60_000n],
    ],
  }),
];

const REFUND_EXAMINED: DuplicateRefundRead['examined'] = [
  { ref: { type: 'payment', id: 'pay_contract_examined' }, field: 'amount', record_updated_at: UPDATED_AT },
];

function duplicateRefundStore(groups: readonly PaymentRefundGroup[]): DuplicateRefundStore {
  return {
    listLinkedRefunds(query: DuplicateRefundQuery): Promise<DuplicateRefundRead> {
      return Promise.resolve({
        groups: query.tenant_id === CONTRACT_TENANT ? groups : [],
        examined: REFUND_EXAMINED,
      });
    },
  };
}

const REFUND_CHAINS = createMemoryEvidenceStore();

const HIDDEN_REFUND_GROUPS: readonly PaymentRefundGroup[] = [
  refundGroup({
    payment_id: 'pay_contract_over',
    payment_paise: 100_000n,
    refunds: [
      ['rfnd_contract_a', 60_000n],
      ['rfnd_contract_b', 50_000n],
    ],
    unreadable: [{ type: 'refund', id: 'rfnd_contract_hidden' }],
  }),
];

/* --- missing accruals ----------------------------------------------------- */

function accrualRecord(options: {
  readonly type: 'payment' | 'refund';
  readonly id: string;
  readonly amount_paise: bigint;
  readonly links?: number;
  readonly unreadable?: readonly { readonly type: 'ledger_entry_set'; readonly id: string }[];
}): AccrualSourceRecord {
  return {
    ref: { type: options.type, id: options.id },
    created_on: '2026-07-14',
    amount_paise: options.amount_paise,
    record_updated_at: UPDATED_AT,
    ledger_entry_source_count: options.links ?? 0,
    ...(options.unreadable === undefined ? {} : { unreadable: options.unreadable }),
  };
}

/** Two unposted records and one posted, so the exact-link exclusion is exercised. */
const ACCRUAL_RECORDS: readonly AccrualSourceRecord[] = [
  accrualRecord({ type: 'payment', id: 'pay_contract_accrual', amount_paise: 500_000n }),
  accrualRecord({ type: 'refund', id: 'rfnd_contract_accrual', amount_paise: 120_000n }),
  accrualRecord({ type: 'payment', id: 'pay_contract_posted', amount_paise: 900_000n, links: 1 }),
];

function accrualCitations(records: readonly AccrualSourceRecord[]): MissingAccrualRead['examined'] {
  return records.map((entry) => ({
    ref: entry.ref,
    field: 'amount',
    record_updated_at: entry.record_updated_at,
  }));
}

function missingAccrualStore(records: readonly AccrualSourceRecord[]): MissingAccrualStore {
  return {
    listAccrualSources(query: MissingAccrualQuery): Promise<MissingAccrualRead> {
      const rows = query.tenant_id === CONTRACT_TENANT ? records : [];
      return Promise.resolve({ records: rows, examined: accrualCitations(rows) });
    },
  };
}

const ACCRUAL_CHAINS = createMemoryEvidenceStore();

const HIDDEN_ACCRUAL_RECORDS: readonly AccrualSourceRecord[] = [
  accrualRecord({
    type: 'payment',
    id: 'pay_contract_accrual',
    amount_paise: 500_000n,
    unreadable: [{ type: 'ledger_entry_set', id: SETTLEMENT_SET }],
  }),
  ...ACCRUAL_RECORDS.slice(1),
];

/* -------------------------------------------------------------------------- */
/* 12.5: the two Exception tools                                              */
/* -------------------------------------------------------------------------- */

const EXCEPTION_CHAINS = new ExceptionEvidenceStore();

const SETTLEMENT_EXCEPTION_ID = '10000000-0000-4000-8000-000000000001';
const REFUND_EXCEPTION_ID = '10000000-0000-4000-8000-000000000002';

/**
 * Two Exceptions with **real** persisted chains, in two categories, so the drill-down
 * branch has rows and the category rollup has more than one group.
 *
 * Top-level `await`: `exceptionWithChain` composes through the real builder, and an
 * Exception's impact is defined as its persisted chain's figure — there is no synchronous
 * way to state one without restating the builder.
 */
const SETTLEMENT_EXCEPTION: ScopedException = await exceptionWithChain({
  store: EXCEPTION_CHAINS,
  exceptionId: SETTLEMENT_EXCEPTION_ID,
  impact: 2_320_000n,
});

const REFUND_EXCEPTION: ScopedException = await exceptionWithChain({
  store: EXCEPTION_CHAINS,
  exceptionId: REFUND_EXCEPTION_ID,
  impact: 500_000n,
  category: 'possible_duplicate_refund',
});

const EXCEPTIONS: readonly ScopedException[] = [SETTLEMENT_EXCEPTION, REFUND_EXCEPTION];

/**
 * The same Exceptions, with the settlement one's Evidence_Chain unreachable.
 *
 * Well-formed and stored nowhere, which is exactly Requirement 12.3's condition for these
 * two tools: neither composes the impact it presents — the impact *is* the persisted
 * chain's figure — so a chain that cannot be read is a contributing record that cannot be
 * read. The Exception's own `source_records` are what name the unavailable types.
 */
const HIDDEN_EXCEPTIONS: readonly ScopedException[] = [
  { ...SETTLEMENT_EXCEPTION, evidence_chain_id: '00000000-0000-4000-8000-0000000000ff' },
  REFUND_EXCEPTION,
];

function exceptionStore(rows: readonly ScopedException[]): ExceptionStore {
  return new MemoryExceptionStore([...rows]);
}

/* -------------------------------------------------------------------------- */
/* 12.6: get_control_tower_metrics                                            */
/* -------------------------------------------------------------------------- */

const METRICS_NOW = new Date('2026-07-30T09:00:00.000Z');
const METRIC_INGESTED_AT = '2026-07-30T08:00:00.000Z';

function metricRecord(
  type: MetricAmountRecord['ref']['type'],
  id: string,
  amount_paise: bigint,
): MetricAmountRecord {
  return {
    ref: { type, id },
    field: type === 'ledger_entry_set' ? 'line_2.amount_paise' : 'amount',
    amount_paise,
    record_updated_at: UPDATED_AT,
    last_ingested_at: METRIC_INGESTED_AT,
  };
}

const CASH_READ: CashMetricRead = {
  settlements: [metricRecord('settlement', 'setl_SYNTHETIC9281', 8_194_000n)],
  recorded_outflows: [metricRecord('ledger_entry_set', SETTLEMENT_SET, 2_000_000n)],
};

const REVENUE_READ: Revenue30dMetricRead = {
  captured_payments: [
    metricRecord('payment', 'pay_contract_revenue_1', 6_000_000n),
    metricRecord('payment', 'pay_contract_revenue_2', 4_000_000n),
  ],
  refunds: [metricRecord('refund', 'rfnd_contract_revenue', 1_000_000n)],
};

const PENDING_READ: PendingSettlementMetricRead = {
  captured_unlinked_payments: [metricRecord('payment', 'pay_contract_pending', 3_000_000n)],
};

const METRICS_CHAINS = createMemoryEvidenceStore();

/** Only Cash is unreadable, so Requirement 3.9's isolation is what gets exercised. */
const HIDDEN_CASH_READ: CashMetricRead = {
  ...CASH_READ,
  unreadable: [{ type: 'settlement', id: 'setl_SYNTHETIC9285' }],
};

function cashSource(read: CashMetricRead): CashMetricSource {
  return { read: () => Promise.resolve(read) };
}

const revenueSource: Revenue30dMetricSource = { read: () => Promise.resolve(REVENUE_READ) };
const pendingSource: PendingSettlementMetricSource = {
  read: () => Promise.resolve(PENDING_READ),
};

/* -------------------------------------------------------------------------- */
/* 19.4: Marketplace tools                                                    */
/* -------------------------------------------------------------------------- */

const MARKETPLACE_ACCOUNT = 'acc_contract_seller';
const MARKETPLACE_READ: MarketplaceRead = {
  linked_account: { linked_account_id: MARKETPLACE_ACCOUNT, record_updated_at: UPDATED_AT },
  payments: [{
    payment_id: 'pay_contract_market',
    created_at: '2026-07-10T00:00:00.000Z',
    razorpay_fee_paise: 100n,
    gst_on_fee_paise: 18n,
    platform_commission_paise: 382n,
    record_updated_at: UPDATED_AT,
  }],
  transfers: [
    {
      transfer_id: 'trf_contract_market', payment_id: 'pay_contract_market',
      linked_account_id: MARKETPLACE_ACCOUNT, created_at: '2026-07-11T00:00:00.000Z',
      amount_paise: 5_000n, on_hold: false, record_updated_at: UPDATED_AT,
    },
    {
      transfer_id: 'trf_contract_hold', payment_id: 'pay_contract_market',
      linked_account_id: MARKETPLACE_ACCOUNT, created_at: '2026-07-12T00:00:00.000Z',
      amount_paise: 700n, on_hold: true, record_updated_at: UPDATED_AT,
    },
  ],
  transfer_reversals: [{
    transfer_reversal_id: 'rvrsl_contract_market', transfer_id: 'trf_contract_market',
    created_at: '2026-07-13T00:00:00.000Z', amount_paise: 500n,
    record_updated_at: '2026-07-21T00:00:00.000Z',
  }],
  settlements: [{
    settlement_id: 'setl_contract_market', linked_account_id: MARKETPLACE_ACCOUNT,
    created_at: '2026-07-20T00:00:00.000Z', amount_paise: 4_000n,
    record_updated_at: '2026-07-22T00:00:00.000Z',
  }],
};
const HIDDEN_MARKETPLACE_READ: MarketplaceRead = {
  ...MARKETPLACE_READ,
  unreadable: [{ type: 'transfer', id: 'trf_contract_hidden' }],
};
const PAYOUT_CHAINS = createMemoryEvidenceStore();
const BALANCE_CHAINS = createMemoryEvidenceStore();

function marketplaceStore(read: MarketplaceRead): MarketplaceStore {
  return {
    readSellerPayout: () => Promise.resolve(read),
    readLinkedAccountBalance: () => Promise.resolve(read),
  };
}

/* -------------------------------------------------------------------------- */
/* 24.3: the two write-capable tools                                          */
/* -------------------------------------------------------------------------- */

/**
 * The write-capable half of the catalogue, under the same generated cases as the eleven
 * read-only tools plus the one that only applies to it: `writeAuthorizationCase`, which
 * invokes each tool with **no** Proposal pair and again with **no** authorization source
 * and requires `unauthorized_write` with zero connections acquired and zero executions
 * (Requirement 12.10).
 *
 * The fixture therefore has to state two things a read-only fixture never does:
 *
 * - `session.proposal_id` / `session.authorization_id`, as **UUIDs**. `proposals.id` and
 *   `authorizations.id` are UUIDs and the tool-side gate in `@/tools/write-tool` holds
 *   both to that shape before it asks the lookup, so the `prop_9281` / `auth_9281`
 *   spellings `./tool-contract.test.ts` uses for its specimens would not resolve here.
 * - `authorization`, a lookup answering for that pair. It is built over
 *   `RecordedAuthorization` values from `@/policy/checks`, so the shape the Policy_Engine
 *   records is the shape the gate is driven with.
 *
 * The gate the *tools* hold is the same lookup, because Requirement 12.10 is one rule and
 * two answers to it would be one answer too many.
 *
 * ## What the two write seams are, and what they deliberately do not enforce
 *
 * `post_reconciliation_adjustment` runs against the **real** `createSemanticLedger` over
 * `MemoryLedgerStore`, because the atomic imbalance rejection is the ledger's and a stub
 * would prove nothing about the delegation. That store does not enforce
 * `ledger_set_derivation_uniq`: the harness invokes one conforming input several times
 * across its ten cases, and a store that reported the second post as Requirement 2.8's
 * idempotent no-op would fail every case after the first. The no-op refusal is asserted
 * in `src/tools/post-reconciliation-adjustment.test.ts` instead.
 *
 * `mark_exception_resolved`'s resolution store does not write the transition back into
 * the `ExceptionStore` the tool reads, for the same reason: every generated case starts
 * from an `open` Exception. The three lifecycle branches are asserted in
 * `src/tools/mark-exception-resolved.test.ts`.
 *
 * Both notes are limitations of the **fixture**, not of the tools, and they are stated
 * rather than left for a reader to infer from a green run.
 */
const ADJUSTMENT_CHAINS = createMemoryEvidenceStore();
const RESOLUTION_CHAINS = new ExceptionEvidenceStore();

const ADJUSTMENT_SETTLEMENT = { type: 'settlement', id: 'setl_SYNTHETIC9281' } as const;
const ADJUSTMENT_RECON = { type: 'settlement_recon_report', id: 'pay_SYNTHETIC92811' } as const;

/** The Source_Record the hidden world cannot read (Requirement 12.3). */
const HIDDEN_ADJUSTMENT_REF = {
  type: 'settlement_recon_report',
  id: 'pay_SYNTHETIC92819',
} as const;

/** One ledger per world, so a hidden-world invocation cannot post into the readable one. */
function adjustmentLedger(): SemanticLedger {
  return createSemanticLedger({
    store: new MemoryLedgerStore(),
    audit: { append: () => Promise.resolve() },
    actor: WRITE_ACTOR,
    now: () => METRICS_NOW,
  });
}

const READABLE_ADJUSTMENT_LEDGER = adjustmentLedger();
const HIDDEN_ADJUSTMENT_LEDGER = adjustmentLedger();

/** The Exception `mark_exception_resolved` closes. Its own chain, its own store. */
const RESOLVABLE_EXCEPTION_ID = '10000000-0000-4000-8000-00000000024a';
const RESOLVABLE_EXCEPTION: ScopedException = await exceptionWithChain({
  store: RESOLUTION_CHAINS,
  exceptionId: RESOLVABLE_EXCEPTION_ID,
  impact: 750_000n,
  tenantId: CONTRACT_TENANT,
});

const RESOLUTION_STORE = exceptionResolutionStore({ known: [RESOLVABLE_EXCEPTION_ID] });

/** The one gate both write-capable tools are behind, and the harness drives them with. */
const WRITE_AUTHORIZATION = authorizationLookup();
const WRITE_GATE = writeGate({ authorization: WRITE_AUTHORIZATION });

/* -------------------------------------------------------------------------- */
/* The two worlds, assembled through the production catalogue module           */
/* -------------------------------------------------------------------------- */

/** Which world a dep bundle reads: complete, or one contributor short. */
type World = 'readable' | 'hidden';

/**
 * Every Slice 1 seam, for one world.
 *
 * Both worlds go through `createSliceOneToolRegistry`, so the hidden variant of a tool is
 * the same declaration reached through the same audited catalogue.
 */
function depsFor(world: World): SliceOneToolDeps {
  const hidden = world === 'hidden';
  return {
    settlementReconciliation: {
      settlements: () => settlementStore(hidden ? HIDDEN_SETTLEMENTS : READABLE_SETTLEMENTS),
      chains: () => RECONCILIATION_CHAINS,
    },
    settlementDifferenceBreakdown: {
      settlements: () => settlementStore(hidden ? HIDDEN_SETTLEMENTS : READABLE_SETTLEMENTS),
      chains: () => BREAKDOWN_CHAINS,
    },
    trialBalance: {
      ledger: () => semanticLedger(LEDGER_ENTRIES),
      entries: () =>
        ledgerEntryStore(LEDGER_ENTRIES, hidden ? { unreadable: [HIDDEN_LEDGER_SET] } : {}),
      chains: () => TRIAL_BALANCE_CHAINS,
    },
    unsettledPayments: {
      payments: () => unsettledPaymentStore(hidden ? HIDDEN_UNSETTLED : UNSETTLED_PAYMENTS),
      chains: () => UNSETTLED_CHAINS,
    },
    duplicateRefundCandidates: {
      refunds: () => duplicateRefundStore(hidden ? HIDDEN_REFUND_GROUPS : REFUND_GROUPS),
      chains: () => REFUND_CHAINS,
    },
    missingAccruals: {
      accruals: () => missingAccrualStore(hidden ? HIDDEN_ACCRUAL_RECORDS : ACCRUAL_RECORDS),
      chains: () => ACCRUAL_CHAINS,
    },
    exceptionList: {
      exceptions: () => exceptionStore(hidden ? HIDDEN_EXCEPTIONS : EXCEPTIONS),
      chains: () => EXCEPTION_CHAINS,
    },
    exceptionEvidence: {
      exceptions: () => exceptionStore(hidden ? HIDDEN_EXCEPTIONS : EXCEPTIONS),
      chains: () => EXCEPTION_CHAINS,
    },
    sellerPayoutChain: {
      marketplace: () => marketplaceStore(hidden ? HIDDEN_MARKETPLACE_READ : MARKETPLACE_READ),
      chains: () => PAYOUT_CHAINS,
    },
    linkedAccountBalance: {
      marketplace: () => marketplaceStore(hidden ? HIDDEN_MARKETPLACE_READ : MARKETPLACE_READ),
      chains: () => BALANCE_CHAINS,
    },
    controlTowerMetrics: {
      cash: () => cashSource(hidden ? HIDDEN_CASH_READ : CASH_READ),
      revenue30d: () => revenueSource,
      pendingSettlement: () => pendingSource,
      chains: () => METRICS_CHAINS,
      now: () => METRICS_NOW,
    },
    writeGate: WRITE_GATE,
    reconciliationAdjustment: {
      // Reachable only with the gate's proof, which is why this is a `WriteSeam`.
      ledger: () => (hidden ? HIDDEN_ADJUSTMENT_LEDGER : READABLE_ADJUSTMENT_LEDGER),
      sources: () =>
        adjustmentSourceStore(
          [
            citedRecord(ADJUSTMENT_SETTLEMENT.type, ADJUSTMENT_SETTLEMENT.id),
            citedRecord(ADJUSTMENT_RECON.type, ADJUSTMENT_RECON.id),
          ],
          hidden ? [HIDDEN_ADJUSTMENT_REF] : [],
        ),
      chains: () => ADJUSTMENT_CHAINS,
      now: () => METRICS_NOW,
    },
    exceptionResolution: {
      exceptions: () => new MemoryExceptionStore([RESOLVABLE_EXCEPTION]),
      resolution: () => RESOLUTION_STORE,
      chains: () => RESOLUTION_CHAINS,
      now: () => METRICS_NOW,
    },
  };
}

/** The catalogue under contract: the production module, audited by the real registry. */
export const SLICE_1_REGISTRY: ToolRegistry = createSliceOneToolRegistry(depsFor('readable'));

/** The same registered declarations, each one contributing record short. */
const HIDDEN_REGISTRY: ToolRegistry = createSliceOneToolRegistry(depsFor('hidden'));

/** The hidden-world declaration of one tool, by name. */
function hiddenVariantOf(name: string): () => ErasedFinancialTool {
  return (): ErasedFinancialTool => {
    const tool = HIDDEN_REGISTRY.get(name);
    if (tool === undefined) {
      throw new Error(`the hidden-world catalogue holds no ${name}`);
    }
    return tool;
  };
}

/* -------------------------------------------------------------------------- */
/* The fixtures                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One fixture per registered tool. A missing one fails the suite, and so does a fixture
 * naming a tool the catalogue does not hold, so this map cannot drift from the catalogue.
 *
 * Every `validInput` populates **every** declared argument including the optional ones —
 * `settlement_ids` and `category` — because an argument the fixture leaves out is an
 * argument whose wrong-type and free-form-SQL cases could not be generated, which the
 * harness reports rather than skips.
 */
export const SLICE_1_FIXTURES: Readonly<Record<string, ToolContractFixture>> = {
  get_settlement_reconciliation: {
    validInput: {
      ...SCOPE,
      settlement_ids: [
        SET_9281.settlement_id,
        SET_9281_FEE_VARIANT.settlement_id,
        UNRECONCILED.settlement_id,
      ],
    },
    hiddenContributingRecord: hiddenVariantOf('get_settlement_reconciliation'),
    resolveEvidenceChain: resolverFor(RECONCILIATION_CHAINS),
  },
  get_settlement_difference_breakdown: {
    // A limit below the candidate count, so the remainder total is a non-zero figure the
    // envelope chain has to ground rather than a trivial 0n.
    validInput: { ...SCOPE, limit: 1 },
    hiddenContributingRecord: hiddenVariantOf('get_settlement_difference_breakdown'),
    resolveEvidenceChain: resolverFor(BREAKDOWN_CHAINS),
  },
  get_trial_balance: {
    validInput: { ...SCOPE },
    hiddenContributingRecord: hiddenVariantOf('get_trial_balance'),
    resolveEvidenceChain: resolverFor(TRIAL_BALANCE_CHAINS),
  },
  get_unsettled_payments: {
    validInput: { as_of: '2026-07-28', page: { offset: 0, limit: 100 } },
    hiddenContributingRecord: hiddenVariantOf('get_unsettled_payments'),
    resolveEvidenceChain: resolverFor(UNSETTLED_CHAINS),
  },
  get_duplicate_refund_candidates: {
    validInput: { ...SCOPE },
    hiddenContributingRecord: hiddenVariantOf('get_duplicate_refund_candidates'),
    resolveEvidenceChain: resolverFor(REFUND_CHAINS),
  },
  get_missing_accruals: {
    validInput: { ...SCOPE, page: { offset: 0, limit: 100 } },
    hiddenContributingRecord: hiddenVariantOf('get_missing_accruals'),
    resolveEvidenceChain: resolverFor(ACCRUAL_CHAINS),
  },
  list_exceptions_by_category: {
    validInput: {
      category: 'settlement_mismatch',
      state: 'open',
      page: { offset: 0, limit: 50 },
    },
    hiddenContributingRecord: hiddenVariantOf('list_exceptions_by_category'),
    resolveEvidenceChain: resolverFor(EXCEPTION_CHAINS),
  },
  get_exception_evidence: {
    validInput: {
      exception_id: SETTLEMENT_EXCEPTION_ID,
      source_page: { offset: 0, limit: 500 },
    },
    hiddenContributingRecord: hiddenVariantOf('get_exception_evidence'),
    resolveEvidenceChain: resolverFor(EXCEPTION_CHAINS),
  },
  get_seller_payout_chain: {
    validInput: { linked_account_id: MARKETPLACE_ACCOUNT, ...SCOPE, limit: 200 },
    hiddenContributingRecord: hiddenVariantOf('get_seller_payout_chain'),
    resolveEvidenceChain: resolverFor(PAYOUT_CHAINS),
  },
  get_linked_account_balance: {
    validInput: { linked_account_id: MARKETPLACE_ACCOUNT, as_of: '2026-07-31' },
    hiddenContributingRecord: hiddenVariantOf('get_linked_account_balance'),
    resolveEvidenceChain: resolverFor(BALANCE_CHAINS),
  },
  get_control_tower_metrics: {
    validInput: {},
    hiddenContributingRecord: hiddenVariantOf('get_control_tower_metrics'),
    // Four independent figures in one invocation, so an unreadable Cash contributor
    // withholds the Cash cell and leaves the other three standing (Requirement 3.9).
    incompleteEvidenceScope: 'per_figure',
    resolveEvidenceChain: resolverFor(METRICS_CHAINS),
  },
  post_reconciliation_adjustment: {
    validInput: {
      entry_date: ADJUSTMENT_DATE,
      entries: balancedEntries(),
      source_refs: [{ ...ADJUSTMENT_SETTLEMENT }, { ...ADJUSTMENT_RECON }],
    },
    // The pair a write_capable invocation must carry, and the lookup that resolves it.
    session: { proposal_id: PROPOSAL_ID, authorization_id: AUTHORIZATION_ID },
    authorization: WRITE_AUTHORIZATION,
    hiddenContributingRecord: hiddenVariantOf('post_reconciliation_adjustment'),
    resolveEvidenceChain: resolverFor(ADJUSTMENT_CHAINS),
  },
  mark_exception_resolved: {
    validInput: {
      exception_id: RESOLVABLE_EXCEPTION_ID,
      // The one prose argument in the catalogue, inside its 2000-character ceiling.
      resolution_note: 'Shortfall traced to a fee variance and adjusted in the ledger.',
    },
    session: { proposal_id: PROPOSAL_ID, authorization_id: AUTHORIZATION_ID },
    authorization: WRITE_AUTHORIZATION,
    // No `hiddenContributingRecord` and no `resolveEvidenceChain`: the output declares no
    // monetary field, so `monetaryEvidenceCase` and `incompleteEvidenceCase` have no
    // figure to ground or withhold and both say so rather than passing vacuously. The
    // Requirement 12.3 branch this tool does have — an Exception whose own chain cannot be
    // read — is asserted in `src/tools/mark-exception-resolved.test.ts`.
  },
};
