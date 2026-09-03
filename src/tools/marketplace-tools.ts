/**
 * Marketplace read-only Financial_Tools (task 19.4).
 * Requirements 7.2–7.6, 7.9, 12.1 and 12.2.
 */

import { z } from 'zod';

import { assertInRange, subtract, sum, type Paise } from '@/calc/calculation-service';
import type { TenantId } from '@/config/configuration-service';
import {
  createEvidenceChainBuilder,
  type EvidenceChain,
  type EvidenceChainInput,
  type EvidenceChainStore,
  type EvidenceOperand,
  type EvidenceSourceCitation,
  incompleteEvidence,
  type IncompleteEvidence,
} from '@/evidence/chain-builder';
import { SOURCE_RECORD_TYPES, type DateOnly, type SourceRef } from '@/ledger/posting-rules';
import { MAX_ROUTE_RECONCILIATION_DAYS } from '@/agents/marketplace/route-split';
import { rangeLengthInDays, type DateRange } from './settlement-scope';
import { catalogued } from './registry';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const GET_SELLER_PAYOUT_CHAIN = 'get_seller_payout_chain';
export const GET_LINKED_ACCOUNT_BALANCE = 'get_linked_account_balance';

const ACCOUNT_ID_RE = /^acc_[A-Za-z0-9_]{2,80}$/;
const PAYMENT_ID_RE = /^pay_[A-Za-z0-9_]{2,80}$/;
const TRANSFER_ID_RE = /^trf_[A-Za-z0-9_]{2,100}$/;
const REVERSAL_ID_RE = /^(?:rvrsl|trfr)_[A-Za-z0-9_]{2,100}$/;
const SETTLEMENT_ID_RE = /^setl_[A-Za-z0-9_]{2,100}$/;
const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class MarketplaceToolError extends Error {
  override readonly name = 'MarketplaceToolError';
}

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const payoutInputSchema = z
  .strictObject({
    linked_account_id: z.string().regex(ACCOUNT_ID_RE),
    from: z.iso.date(),
    to: z.iso.date(),
    limit: z.number().int().min(1).max(200),
  })
  .refine((v) => isRealDate(v.from), { error: 'from must be a real calendar date', path: ['from'] })
  .refine((v) => isRealDate(v.to), { error: 'to must be a real calendar date', path: ['to'] })
  .refine((v) => v.from <= v.to, { error: 'from must be on or before to', path: ['from'] })
  .refine(
    (v) => !isRealDate(v.from) || !isRealDate(v.to) || v.from > v.to ||
      rangeLengthInDays({ from: v.from, to: v.to }) <= MAX_ROUTE_RECONCILIATION_DAYS,
    { error: `range must cover at most ${MAX_ROUTE_RECONCILIATION_DAYS} inclusive days`, path: ['to'] },
  );

const balanceInputSchema = z
  .strictObject({
    linked_account_id: z.string().regex(ACCOUNT_ID_RE),
    as_of: z.iso.date(),
  })
  .refine((v) => isRealDate(v.as_of), { error: 'as_of must be a real calendar date', path: ['as_of'] });

export type GetSellerPayoutChainInput = z.infer<typeof payoutInputSchema>;
export type GetLinkedAccountBalanceInput = z.infer<typeof balanceInputSchema>;

const payoutRowSchema = z.strictObject({
  payment_id: z.string().regex(PAYMENT_ID_RE),
  payment_created_at: z.iso.datetime(),
  transfer_id: z.string().regex(TRANSFER_ID_RE),
  transfer_reversal_id: z.string().regex(REVERSAL_ID_RE).nullable(),
  transfer_paise: z.bigint(),
  transfer_reversal_paise: z.bigint().nullable(),
  net_transfer_paise: z.bigint(),
  razorpay_fee_paise: z.bigint(),
  gst_on_fee_paise: z.bigint(),
  platform_commission_paise: z.bigint(),
  evidence_chain_id: z.uuid(),
  evidence_as_of: z.iso.datetime(),
});

const onHoldSchema = z.strictObject({
  transfer_id: z.string().regex(TRANSFER_ID_RE),
  amount_paise: z.bigint(),
  evidence_chain_id: z.uuid(),
  evidence_as_of: z.iso.datetime(),
});

const payoutOutputSchema = z.strictObject({
  classification: z.enum(['pending', 'settlement_received']),
  shortfall_paise: z.bigint(),
  pending_amount_paise: z.bigint().nullable(),
  oldest_transfer_age_days: z.number().int().nonnegative().nullable(),
  rows: z.array(payoutRowSchema).max(200),
  total_rows: z.number().int().nonnegative(),
  truncated: z.boolean(),
  on_hold: z.array(onHoldSchema),
});

const sourceRefSchema = z.strictObject({
  type: z.enum(SOURCE_RECORD_TYPES),
  id: z.string().min(1),
});

const balanceOutputSchema = z.strictObject({
  balance_paise: z.bigint(),
  as_of: z.iso.datetime(),
  sources: z.array(sourceRefSchema),
});

export type GetSellerPayoutChainOutput = z.infer<typeof payoutOutputSchema>;
export type PayoutChainRow = z.infer<typeof payoutRowSchema>;
export type OnHoldTransfer = z.infer<typeof onHoldSchema>;
export type GetLinkedAccountBalanceOutput = z.infer<typeof balanceOutputSchema>;

interface StoredRecord {
  readonly record_updated_at: string;
}

export interface MarketplaceLinkedAccount extends StoredRecord {
  readonly linked_account_id: string;
}

export interface MarketplacePayment extends StoredRecord {
  readonly payment_id: string;
  readonly created_at: string;
  readonly razorpay_fee_paise: Paise;
  readonly gst_on_fee_paise: Paise;
  readonly platform_commission_paise: Paise;
}

export interface MarketplaceTransfer extends StoredRecord {
  readonly transfer_id: string;
  readonly payment_id: string;
  readonly linked_account_id: string;
  readonly created_at: string;
  readonly amount_paise: Paise;
  readonly on_hold: boolean;
}

export interface MarketplaceTransferReversal extends StoredRecord {
  readonly transfer_reversal_id: string;
  readonly transfer_id: string;
  readonly created_at: string;
  readonly amount_paise: Paise;
}

export interface MarketplaceSellerSettlement extends StoredRecord {
  readonly settlement_id: string;
  readonly linked_account_id: string;
  readonly created_at: string;
  readonly amount_paise: Paise;
}

export interface MarketplaceRead {
  readonly linked_account: MarketplaceLinkedAccount;
  readonly payments: readonly MarketplacePayment[];
  readonly transfers: readonly MarketplaceTransfer[];
  readonly transfer_reversals: readonly MarketplaceTransferReversal[];
  readonly settlements: readonly MarketplaceSellerSettlement[];
  readonly unreadable?: readonly SourceRef[];
}

export interface SellerPayoutQuery {
  readonly tenant_id: TenantId;
  readonly linked_account_id: string;
  readonly range: DateRange;
}

export interface LinkedAccountBalanceQuery {
  readonly tenant_id: TenantId;
  readonly linked_account_id: string;
  readonly as_of: DateOnly;
}

export interface MarketplaceStore {
  readSellerPayout(query: SellerPayoutQuery): Promise<MarketplaceRead>;
  readLinkedAccountBalance(query: LinkedAccountBalanceQuery): Promise<MarketplaceRead>;
}

export interface GetSellerPayoutChainDeps {
  readonly marketplace: (ctx: ToolContext) => MarketplaceStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

export interface GetLinkedAccountBalanceDeps {
  readonly marketplace: (ctx: ToolContext) => MarketplaceStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}

function assertId(value: string, pattern: RegExp, field: string): void {
  if (!pattern.test(value)) throw new MarketplaceToolError(`${field} is not a valid stored identifier`);
}

function assertTimestamp(value: string, field: string): void {
  if (!ISO_UTC_MS.test(value) || Number.isNaN(Date.parse(value))) {
    throw new MarketplaceToolError(`${field} must be ISO-8601 UTC to millisecond precision`);
  }
}

function assertMoney(value: Paise, field: string): void {
  assertInRange(value);
  if (value < 0n) throw new MarketplaceToolError(`${field} must be non-negative integer paise`);
}

function assertUnique(id: string, seen: Set<string>, kind: string): void {
  if (seen.has(id)) throw new MarketplaceToolError(`duplicate ${kind} identifier ${id}`);
  seen.add(id);
}

function validateRead(read: MarketplaceRead, accountId: string): void {
  assertId(read.linked_account.linked_account_id, ACCOUNT_ID_RE, 'linked_account_id');
  if (read.linked_account.linked_account_id !== accountId) {
    throw new MarketplaceToolError('the store returned a different Linked_Account than requested');
  }
  assertTimestamp(read.linked_account.record_updated_at, 'linked_account.record_updated_at');
  const payments = new Set<string>();
  for (const row of read.payments) {
    assertId(row.payment_id, PAYMENT_ID_RE, 'payment_id');
    assertUnique(row.payment_id, payments, 'Payment');
    assertTimestamp(row.created_at, `${row.payment_id}.created_at`);
    assertTimestamp(row.record_updated_at, `${row.payment_id}.record_updated_at`);
    assertMoney(row.razorpay_fee_paise, `${row.payment_id}.razorpay_fee_paise`);
    assertMoney(row.gst_on_fee_paise, `${row.payment_id}.gst_on_fee_paise`);
    assertMoney(row.platform_commission_paise, `${row.payment_id}.platform_commission_paise`);
  }
  const transfers = new Set<string>();
  for (const row of read.transfers) {
    assertId(row.transfer_id, TRANSFER_ID_RE, 'transfer_id');
    assertId(row.payment_id, PAYMENT_ID_RE, `${row.transfer_id}.payment_id`);
    assertId(row.linked_account_id, ACCOUNT_ID_RE, `${row.transfer_id}.linked_account_id`);
    assertUnique(row.transfer_id, transfers, 'Transfer');
    assertTimestamp(row.created_at, `${row.transfer_id}.created_at`);
    assertTimestamp(row.record_updated_at, `${row.transfer_id}.record_updated_at`);
    assertMoney(row.amount_paise, `${row.transfer_id}.amount_paise`);
  }
  const reversals = new Set<string>();
  for (const row of read.transfer_reversals) {
    assertId(row.transfer_reversal_id, REVERSAL_ID_RE, 'transfer_reversal_id');
    assertId(row.transfer_id, TRANSFER_ID_RE, `${row.transfer_reversal_id}.transfer_id`);
    assertUnique(row.transfer_reversal_id, reversals, 'Transfer_Reversal');
    assertTimestamp(row.created_at, `${row.transfer_reversal_id}.created_at`);
    assertTimestamp(row.record_updated_at, `${row.transfer_reversal_id}.record_updated_at`);
    assertMoney(row.amount_paise, `${row.transfer_reversal_id}.amount_paise`);
  }
  const settlements = new Set<string>();
  for (const row of read.settlements) {
    assertId(row.settlement_id, SETTLEMENT_ID_RE, 'settlement_id');
    assertId(row.linked_account_id, ACCOUNT_ID_RE, `${row.settlement_id}.linked_account_id`);
    assertUnique(row.settlement_id, settlements, 'Settlement');
    assertTimestamp(row.created_at, `${row.settlement_id}.created_at`);
    assertTimestamp(row.record_updated_at, `${row.settlement_id}.record_updated_at`);
    assertMoney(row.amount_paise, `${row.settlement_id}.amount_paise`);
  }
}

const dateOf = (timestamp: string): string => timestamp.slice(0, 10);
const inRange = (timestamp: string, range: DateRange): boolean =>
  dateOf(timestamp) >= range.from && dateOf(timestamp) <= range.to;
const onOrBefore = (timestamp: string, asOf: DateOnly): boolean => dateOf(timestamp) <= asOf;

interface ScopedMarketplace {
  readonly payments: ReadonlyMap<string, MarketplacePayment>;
  readonly transfers: readonly MarketplaceTransfer[];
  readonly reversals: readonly MarketplaceTransferReversal[];
  readonly settlements: readonly MarketplaceSellerSettlement[];
}

function payoutScope(read: MarketplaceRead, accountId: string, range: DateRange): ScopedMarketplace {
  const payments = new Map(
    read.payments.filter((row) => inRange(row.created_at, range)).map((row) => [row.payment_id, row]),
  );
  const transfers = read.transfers.filter(
    (row) => row.linked_account_id === accountId && payments.has(row.payment_id),
  );
  const transferIds = new Set(transfers.map((row) => row.transfer_id));
  return {
    payments,
    transfers,
    reversals: read.transfer_reversals.filter((row) => transferIds.has(row.transfer_id)),
    settlements: read.settlements.filter(
      (row) => row.linked_account_id === accountId && inRange(row.created_at, range),
    ),
  };
}

/** Requirement 7.8 uses UTC calendar dates, matching other whole-day ageing tools. */
function oldestTransferAgeDays(scope: ScopedMarketplace, asOf: DateOnly): number | null {
  const eligible = scope.transfers.filter((row) => !row.on_hold);
  if (eligible.length === 0) return null;
  const oldest = eligible.reduce((left, right) =>
    left.created_at < right.created_at ||
    (left.created_at === right.created_at && left.transfer_id < right.transfer_id)
      ? left
      : right,
  );
  const createdOn = dateOf(oldest.created_at) as DateOnly;
  if (createdOn > asOf) {
    throw new MarketplaceToolError(
      `${oldest.transfer_id}.created_at is after pending payout as_of ${asOf}`,
    );
  }
  return rangeLengthInDays({ from: createdOn, to: asOf }) - 1;
}

function balanceScope(read: MarketplaceRead, accountId: string, asOf: DateOnly): ScopedMarketplace {
  const transfers = read.transfers.filter(
    (row) => row.linked_account_id === accountId && onOrBefore(row.created_at, asOf),
  );
  const transferIds = new Set(transfers.map((row) => row.transfer_id));
  return {
    payments: new Map(),
    transfers,
    reversals: read.transfer_reversals.filter(
      (row) => transferIds.has(row.transfer_id) && onOrBefore(row.created_at, asOf),
    ),
    settlements: read.settlements.filter(
      (row) => row.linked_account_id === accountId && onOrBefore(row.created_at, asOf),
    ),
  };
}

interface OrderedRow {
  readonly payment: MarketplacePayment;
  readonly transfer: MarketplaceTransfer;
  readonly reversal: MarketplaceTransferReversal | null;
}

export function payoutRowsInOrder(scope: ScopedMarketplace): readonly OrderedRow[] {
  const reversals = new Map<string, MarketplaceTransferReversal[]>();
  for (const row of scope.reversals) {
    const group = reversals.get(row.transfer_id) ?? [];
    group.push(row);
    reversals.set(row.transfer_id, group);
  }
  const rows: OrderedRow[] = [];
  for (const transfer of scope.transfers.filter((row) => !row.on_hold)) {
    const payment = scope.payments.get(transfer.payment_id);
    if (payment === undefined) throw new MarketplaceToolError(`Transfer ${transfer.transfer_id} has no in-scope Payment`);
    const matches = reversals.get(transfer.transfer_id) ?? [];
    if (matches.length === 0) rows.push({ payment, transfer, reversal: null });
    else for (const reversal of matches) rows.push({ payment, transfer, reversal });
  }
  return rows.sort((a, b) => {
    const keysA = [a.payment.created_at, a.payment.payment_id, a.transfer.transfer_id, a.reversal?.transfer_reversal_id ?? ''];
    const keysB = [b.payment.created_at, b.payment.payment_id, b.transfer.transfer_id, b.reversal?.transfer_reversal_id ?? ''];
    for (let index = 0; index < keysA.length; index += 1) {
      const left = keysA[index] ?? '';
      const right = keysB[index] ?? '';
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  });
}

const ref = (type: SourceRef['type'], id: string): SourceRef => ({ type, id });
const operand = (source: SourceRef, field: string): EvidenceOperand => ({ kind: 'source', ref: source, field });
const literalZero: EvidenceOperand = { kind: 'literal', value: '0' };
const cite = (source: SourceRef, field: string, record: StoredRecord): EvidenceSourceCitation => ({
  ref: source,
  field,
  record_updated_at: record.record_updated_at,
});

function sumOperands(sources: readonly { readonly ref: SourceRef; readonly field: string }[]): readonly EvidenceOperand[] {
  return sources.length === 0 ? [literalZero] : sources.map((row) => operand(row.ref, row.field));
}

function aggregateChain(
  producedBy: string,
  read: MarketplaceRead,
  scope: ScopedMarketplace,
): EvidenceChainInput {
  const transfers = scope.transfers.filter((row) => !row.on_hold);
  const eligibleIds = new Set(transfers.map((row) => row.transfer_id));
  const reversals = scope.reversals.filter((row) => eligibleIds.has(row.transfer_id));
  const transferred = sum(transfers.map((row) => row.amount_paise));
  const reversed = sum(reversals.map((row) => row.amount_paise));
  const expected = subtract(transferred, reversed);
  const received = sum(scope.settlements.map((row) => row.amount_paise));
  const result = subtract(expected, received);
  const transferSources = transfers.map((row) => ({ ref: ref('transfer', row.transfer_id), field: 'amount' }));
  const reversalSources = reversals.map((row) => ({ ref: ref('transfer_reversal', row.transfer_reversal_id), field: 'amount' }));
  const settlementSources = scope.settlements.map((row) => ({ ref: ref('settlement', row.settlement_id), field: 'amount' }));
  const contributorCitations: EvidenceSourceCitation[] = [
    ...transfers.flatMap((row) => [
      cite(ref('transfer', row.transfer_id), 'amount', row),
      cite(ref('transfer', row.transfer_id), 'on_hold', row),
      cite(ref('transfer', row.transfer_id), 'created_at', row),
    ]),
    ...reversals.map((row) => cite(ref('transfer_reversal', row.transfer_reversal_id), 'amount', row)),
    ...scope.settlements.map((row) => cite(ref('settlement', row.settlement_id), 'amount', row)),
  ];
  return {
    produced_by: producedBy,
    figure_paise: result,
    steps: [
      { index: 1, operation: 'sum', operands: sumOperands(transferSources), result_paise: transferred },
      { index: 2, operation: 'sum', operands: sumOperands(reversalSources), result_paise: reversed },
      { index: 3, operation: 'subtract', operands: [{ kind: 'step', index: 1 }, { kind: 'step', index: 2 }], result_paise: expected },
      { index: 4, operation: 'sum', operands: sumOperands(settlementSources), result_paise: received },
      { index: 5, operation: 'subtract', operands: [{ kind: 'step', index: 3 }, { kind: 'step', index: 4 }], result_paise: result },
    ],
    sources: contributorCitations.length > 0
      ? contributorCitations
      : [cite(ref('linked_account', read.linked_account.linked_account_id), 'status', read.linked_account)],
  };
}

function rowChain(row: OrderedRow): EvidenceChainInput {
  const paymentRef = ref('payment', row.payment.payment_id);
  const transferRef = ref('transfer', row.transfer.transfer_id);
  const reversalRef = row.reversal === null ? null : ref('transfer_reversal', row.reversal.transfer_reversal_id);
  const reversalAmount = row.reversal?.amount_paise ?? 0n;
  const net = subtract(row.transfer.amount_paise, reversalAmount);
  return {
    produced_by: GET_SELLER_PAYOUT_CHAIN,
    figure_paise: net,
    steps: [
      { index: 1, operation: 'sum', operands: [operand(paymentRef, 'fee')], result_paise: row.payment.razorpay_fee_paise },
      { index: 2, operation: 'sum', operands: [operand(paymentRef, 'gst_on_fee')], result_paise: row.payment.gst_on_fee_paise },
      { index: 3, operation: 'sum', operands: [operand(paymentRef, 'platform_commission')], result_paise: row.payment.platform_commission_paise },
      { index: 4, operation: 'sum', operands: [operand(transferRef, 'amount')], result_paise: row.transfer.amount_paise },
      { index: 5, operation: 'sum', operands: reversalRef === null ? [literalZero] : [operand(reversalRef, 'amount')], result_paise: reversalAmount },
      { index: 6, operation: 'subtract', operands: [{ kind: 'step', index: 4 }, { kind: 'step', index: 5 }], result_paise: net },
    ],
    sources: [
      cite(paymentRef, 'fee', row.payment),
      cite(paymentRef, 'gst_on_fee', row.payment),
      cite(paymentRef, 'platform_commission', row.payment),
      cite(paymentRef, 'created_at', row.payment),
      cite(transferRef, 'amount', row.transfer),
      ...(row.reversal === null || reversalRef === null ? [] : [cite(reversalRef, 'amount', row.reversal)]),
    ],
  };
}

function onHoldChain(row: MarketplaceTransfer): EvidenceChainInput {
  const transferRef = ref('transfer', row.transfer_id);
  return {
    produced_by: GET_SELLER_PAYOUT_CHAIN,
    figure_paise: row.amount_paise,
    steps: [{ index: 1, operation: 'sum', operands: [operand(transferRef, 'amount')], result_paise: row.amount_paise }],
    sources: [cite(transferRef, 'amount', row), cite(transferRef, 'on_hold', row)],
  };
}

async function persist(
  ctx: ToolContext,
  builder: ReturnType<typeof createEvidenceChainBuilder>,
  input: EvidenceChainInput,
  tool: string,
): Promise<EvidenceChain | IncompleteEvidence> {
  if (ctx.signal.aborted) throw new MarketplaceToolError(`${tool} was aborted while composing Evidence_Chains`);
  const built = await builder.build(input);
  return built.ok ? built.evidence : built;
}

function sourceRefsForBalance(scope: ScopedMarketplace): SourceRef[] {
  const refs: SourceRef[] = [];
  const eligible = scope.transfers.filter((row) => !row.on_hold);
  const eligibleIds = new Set(eligible.map((row) => row.transfer_id));
  refs.push(...eligible.map((row) => ref('transfer', row.transfer_id)));
  refs.push(...scope.reversals.filter((row) => eligibleIds.has(row.transfer_id)).map((row) => ref('transfer_reversal', row.transfer_reversal_id)));
  refs.push(...scope.settlements.map((row) => ref('settlement', row.settlement_id)));
  return refs.sort((a, b) => a.type === b.type ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.type < b.type ? -1 : 1);
}

export function createGetSellerPayoutChain(
  deps: GetSellerPayoutChainDeps,
): FinancialTool<GetSellerPayoutChainInput, GetSellerPayoutChainOutput> {
  return {
    name: GET_SELLER_PAYOUT_CHAIN,
    mode: 'read_only',
    inputSchema: payoutInputSchema,
    outputSchema: payoutOutputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(ctx, input): Promise<ToolResult<GetSellerPayoutChainOutput>> {
      const range = { from: input.from, to: input.to };
      const read = await deps.marketplace(ctx).readSellerPayout({ tenant_id: ctx.tenant_id, linked_account_id: input.linked_account_id, range });
      validateRead(read, input.linked_account_id);
      if ((read.unreadable ?? []).length > 0) return incompleteEvidence(read.unreadable ?? []);
      const scope = payoutScope(read, input.linked_account_id, range);
      const ordered = payoutRowsInOrder(scope);
      const requested = ordered.slice(0, input.limit);
      const builder = createEvidenceChainBuilder({ store: deps.chains(ctx), tenantId: ctx.tenant_id });
      const rows: PayoutChainRow[] = [];
      for (const row of requested) {
        const evidence = await persist(ctx, builder, rowChain(row), GET_SELLER_PAYOUT_CHAIN);
        if ('ok' in evidence) return evidence;
        const reversed = row.reversal?.amount_paise ?? 0n;
        rows.push({
          payment_id: row.payment.payment_id,
          payment_created_at: row.payment.created_at,
          transfer_id: row.transfer.transfer_id,
          transfer_reversal_id: row.reversal?.transfer_reversal_id ?? null,
          transfer_paise: row.transfer.amount_paise,
          transfer_reversal_paise: row.reversal?.amount_paise ?? null,
          net_transfer_paise: subtract(row.transfer.amount_paise, reversed),
          razorpay_fee_paise: row.payment.razorpay_fee_paise,
          gst_on_fee_paise: row.payment.gst_on_fee_paise,
          platform_commission_paise: row.payment.platform_commission_paise,
          evidence_chain_id: evidence.evidence_chain_id,
          evidence_as_of: evidence.as_of,
        });
      }
      const onHold: OnHoldTransfer[] = [];
      for (const row of [...scope.transfers.filter((item) => item.on_hold)].sort((a, b) => a.transfer_id < b.transfer_id ? -1 : a.transfer_id > b.transfer_id ? 1 : 0)) {
        const evidence = await persist(ctx, builder, onHoldChain(row), GET_SELLER_PAYOUT_CHAIN);
        if ('ok' in evidence) return evidence;
        onHold.push({ transfer_id: row.transfer_id, amount_paise: row.amount_paise, evidence_chain_id: evidence.evidence_chain_id, evidence_as_of: evidence.as_of });
      }
      const envelope = await persist(ctx, builder, aggregateChain(GET_SELLER_PAYOUT_CHAIN, read, scope), GET_SELLER_PAYOUT_CHAIN);
      if ('ok' in envelope) return envelope;
      const pending = scope.settlements.length === 0;
      return {
        ok: true,
        value: {
          classification: pending ? 'pending' : 'settlement_received',
          shortfall_paise: envelope.figure_paise,
          pending_amount_paise: pending ? envelope.figure_paise : null,
          oldest_transfer_age_days: pending ? oldestTransferAgeDays(scope, range.to) : null,
          rows,
          total_rows: ordered.length,
          truncated: ordered.length > rows.length,
          on_hold: onHold,
        },
        evidence: envelope,
      };
    },
  };
}

export function createGetLinkedAccountBalance(
  deps: GetLinkedAccountBalanceDeps,
): FinancialTool<GetLinkedAccountBalanceInput, GetLinkedAccountBalanceOutput> {
  return {
    name: GET_LINKED_ACCOUNT_BALANCE,
    mode: 'read_only',
    inputSchema: balanceInputSchema,
    outputSchema: balanceOutputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(ctx, input): Promise<ToolResult<GetLinkedAccountBalanceOutput>> {
      const read = await deps.marketplace(ctx).readLinkedAccountBalance({ tenant_id: ctx.tenant_id, linked_account_id: input.linked_account_id, as_of: input.as_of });
      validateRead(read, input.linked_account_id);
      if ((read.unreadable ?? []).length > 0) return incompleteEvidence(read.unreadable ?? []);
      const scope = balanceScope(read, input.linked_account_id, input.as_of);
      const builder = createEvidenceChainBuilder({ store: deps.chains(ctx), tenantId: ctx.tenant_id });
      const envelope = await persist(ctx, builder, aggregateChain(GET_LINKED_ACCOUNT_BALANCE, read, scope), GET_LINKED_ACCOUNT_BALANCE);
      if ('ok' in envelope) return envelope;
      return {
        ok: true,
        value: { balance_paise: envelope.figure_paise, as_of: envelope.as_of, sources: sourceRefsForBalance(scope) },
        evidence: envelope,
      };
    },
  };
}

export function sellerPayoutChainCatalogueEntry(deps: GetSellerPayoutChainDeps): ErasedFinancialTool {
  return catalogued(createGetSellerPayoutChain(deps));
}

export function linkedAccountBalanceCatalogueEntry(deps: GetLinkedAccountBalanceDeps): ErasedFinancialTool {
  return catalogued(createGetLinkedAccountBalance(deps));
}
