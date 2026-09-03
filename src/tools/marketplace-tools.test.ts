import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TenantId } from '@/config/configuration-service';
import { createEvidenceChainBuilder } from '@/evidence/chain-builder';
import { createToolRegistry } from '@/tools/registry';
import type { ToolContext, ToolDbClient } from '@/tools/tool';
import { createMemoryEvidenceStore } from '../../test/property/evidence-chain-memory-store';

import {
  createGetLinkedAccountBalance,
  createGetSellerPayoutChain,
  linkedAccountBalanceCatalogueEntry,
  type MarketplacePayment,
  type MarketplaceRead,
  type MarketplaceStore,
  type MarketplaceTransfer,
  type MarketplaceTransferReversal,
  sellerPayoutChainCatalogueEntry,
} from './marketplace-tools';

const TENANT = '11111111-1111-4111-8111-111111111111' as TenantId;
const ACCOUNT = 'acc_seller_contract';
const UPDATED = '2026-07-20T00:00:00.000Z';

const context: ToolContext = {
  tenant_id: TENANT,
  user_id: 'user_contract',
  permissions: ['view_financial_data'],
  db: {} as ToolDbClient,
  signal: new AbortController().signal,
};

function payment(overrides: Partial<MarketplacePayment> = {}): MarketplacePayment {
  return {
    payment_id: 'pay_market_a',
    created_at: '2026-07-02T10:00:00.000Z',
    razorpay_fee_paise: 20n,
    gst_on_fee_paise: 4n,
    platform_commission_paise: 76n,
    record_updated_at: UPDATED,
    ...overrides,
  };
}

function transfer(overrides: Partial<MarketplaceTransfer> = {}): MarketplaceTransfer {
  return {
    transfer_id: 'trf_market_b',
    payment_id: 'pay_market_a',
    linked_account_id: ACCOUNT,
    created_at: '2026-07-03T10:00:00.000Z',
    amount_paise: 1_000n,
    on_hold: false,
    record_updated_at: UPDATED,
    ...overrides,
  };
}

function reversal(
  overrides: Partial<MarketplaceTransferReversal> = {},
): MarketplaceTransferReversal {
  return {
    transfer_reversal_id: 'rvrsl_market_b_1',
    transfer_id: 'trf_market_b',
    created_at: '2026-07-04T10:00:00.000Z',
    amount_paise: 100n,
    record_updated_at: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function readable(overrides: Partial<MarketplaceRead> = {}): MarketplaceRead {
  return {
    linked_account: {
      linked_account_id: ACCOUNT,
      record_updated_at: '2026-07-01T00:00:00.000Z',
    },
    payments: [
      payment(),
      payment({
        payment_id: 'pay_market_early',
        created_at: '2026-07-01T10:00:00.000Z',
      }),
    ],
    transfers: [
      transfer(),
      transfer({
        transfer_id: 'trf_market_a',
        payment_id: 'pay_market_early',
        amount_paise: 500n,
      }),
      transfer({
        transfer_id: 'trf_market_hold',
        amount_paise: 700n,
        on_hold: true,
      }),
    ],
    transfer_reversals: [
      reversal(),
      reversal({ transfer_reversal_id: 'rvrsl_market_b_2', amount_paise: 200n }),
    ],
    settlements: [
      {
        settlement_id: 'setl_market_one',
        linked_account_id: ACCOUNT,
        created_at: '2026-07-10T10:00:00.000Z',
        amount_paise: 1_000n,
        record_updated_at: '2026-07-25T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function storeFor(read: MarketplaceRead, tenants: TenantId[] = []): MarketplaceStore {
  return {
    readSellerPayout(query) {
      tenants.push(query.tenant_id);
      return Promise.resolve(read);
    },
    readLinkedAccountBalance(query) {
      tenants.push(query.tenant_id);
      return Promise.resolve(read);
    },
  };
}

function harness(read: MarketplaceRead = readable()) {
  const chains = createMemoryEvidenceStore();
  const tenants: TenantId[] = [];
  const marketplace = storeFor(read, tenants);
  const deps = { marketplace: () => marketplace, chains: () => chains };
  return {
    chains,
    tenants,
    payout: createGetSellerPayoutChain(deps),
    balance: createGetLinkedAccountBalance(deps),
    payoutEntry: sellerPayoutChainCatalogueEntry(deps),
    balanceEntry: linkedAccountBalanceCatalogueEntry(deps),
  };
}

async function payoutOf(read: MarketplaceRead, limit = 200) {
  return harness(read).payout.execute(context, {
    linked_account_id: ACCOUNT,
    from: '2026-07-01',
    to: '2026-07-31',
    limit,
  });
}

describe('Marketplace tool declarations', () => {
  it('registers both strict, bounded read-only tools', () => {
    const h = harness();
    const registry = createToolRegistry([h.payoutEntry, h.balanceEntry]);
    expect(registry.names()).toEqual([
      'get_seller_payout_chain',
      'get_linked_account_balance',
    ]);
    expect(registry.byMode('read_only')).toHaveLength(2);
    expect(h.payout.inputSchema.safeParse({
      linked_account_id: ACCOUNT,
      from: '2026-01-01',
      to: '2027-01-02',
      limit: 200,
    }).success).toBe(false);
    expect(h.balance.inputSchema.safeParse({
      linked_account_id: ACCOUNT,
      as_of: '2026-07-31',
      tenant_id: TENANT,
    }).success).toBe(false);
  });
});

describe('get_seller_payout_chain', () => {
  it('returns the exact shortfall, deterministic limited rows, total, truncation and on-hold list', async () => {
    const h = harness();
    const result = await h.payout.execute(context, {
      linked_account_id: ACCOUNT,
      from: '2026-07-01',
      to: '2026-07-31',
      limit: 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.classification).toBe('settlement_received');
    expect(result.value.shortfall_paise).toBe(200n);
    expect(result.value.pending_amount_paise).toBeNull();
    expect(result.value.oldest_transfer_age_days).toBeNull();
    expect(result.value.total_rows).toBe(3);
    expect(result.value.truncated).toBe(true);
    expect(result.value.rows.map((row) => [row.payment_id, row.transfer_id, row.transfer_reversal_id])).toEqual([
      ['pay_market_early', 'trf_market_a', null],
      ['pay_market_a', 'trf_market_b', 'rvrsl_market_b_1'],
    ]);
    expect(result.value.on_hold).toHaveLength(1);
    expect(result.value.on_hold[0]).toMatchObject({
      transfer_id: 'trf_market_hold',
      amount_paise: 700n,
    });
    expect(typeof result.value.shortfall_paise).toBe('bigint');
    expect(result.evidence.figure_paise).toBe(200n);
    expect(h.tenants).toEqual([TENANT]);
    await expect(
      createEvidenceChainBuilder({ store: h.chains, tenantId: TENANT }).read(
        result.value.rows[0]?.evidence_chain_id ?? '',
      ),
    ).resolves.not.toBeNull();
  });

  it('classifies zero-settlement payout as pending with exact amount and oldest Transfer age', async () => {
    const h = harness(readable({ settlements: [] }));
    const result = await h.payout.execute(context, {
      linked_account_id: ACCOUNT,
      from: '2026-07-01',
      to: '2026-07-31',
      limit: 200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toMatchObject({
      classification: 'pending',
      shortfall_paise: 1_200n,
      pending_amount_paise: 1_200n,
      oldest_transfer_age_days: 28,
    });
    expect(result.evidence.figure_paise).toBe(result.value.pending_amount_paise);
    const persisted = await createEvidenceChainBuilder({
      store: h.chains,
      tenantId: TENANT,
    }).read(result.evidence.evidence_chain_id);
    expect(
      persisted?.first_page.sources.some(
        (source) =>
          source.ref.type === 'transfer' && source.fields.includes('created_at'),
      ),
    ).toBe(true);
  });

  it('returns incomplete_evidence and no figure when one required source is unreadable', async () => {
    const result = await payoutOf(
      readable({ unreadable: [{ type: 'transfer', id: 'trf_hidden' }] }),
    );
    expect(result).toEqual({
      ok: false,
      kind: 'incomplete_evidence',
      unavailable: [{ type: 'transfer', count: 1 }],
    });
    expect('value' in result).toBe(false);
  });
});

describe('get_linked_account_balance', () => {
  it('returns eligible transfers minus reversals minus settlements, latest contributing as-of, and sorted sources', async () => {
    const h = harness();
    const result = await h.balance.execute(context, {
      linked_account_id: ACCOUNT,
      as_of: '2026-07-31',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.balance_paise).toBe(200n);
    expect(typeof result.value.balance_paise).toBe('bigint');
    expect(result.value.as_of).toBe('2026-07-25T00:00:00.000Z');
    expect(result.value.sources).toEqual([
      { type: 'settlement', id: 'setl_market_one' },
      { type: 'transfer', id: 'trf_market_a' },
      { type: 'transfer', id: 'trf_market_b' },
      { type: 'transfer_reversal', id: 'rvrsl_market_b_1' },
      { type: 'transfer_reversal', id: 'rvrsl_market_b_2' },
    ]);
    expect(result.value.sources).not.toContainEqual({ type: 'transfer', id: 'trf_market_hold' });
    expect(result.evidence.figure_paise).toBe(result.value.balance_paise);
    expect(result.evidence.sources).toEqual(expect.arrayContaining(result.value.sources));
  });
});

describe('Marketplace tools properties', () => {
  it('keeps payout arithmetic and total ordering invariant under store row permutations', async () => {
    const base = readable();
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray([...base.payments], { minLength: base.payments.length, maxLength: base.payments.length }),
        fc.shuffledSubarray([...base.transfers], { minLength: base.transfers.length, maxLength: base.transfers.length }),
        fc.shuffledSubarray([...base.transfer_reversals], { minLength: base.transfer_reversals.length, maxLength: base.transfer_reversals.length }),
        fc.shuffledSubarray([...base.settlements], { minLength: base.settlements.length, maxLength: base.settlements.length }),
        async (payments, transfers, transfer_reversals, settlements) => {
          const result = await payoutOf({ ...base, payments, transfers, transfer_reversals, settlements });
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.shortfall_paise).toBe(200n);
          expect(result.value.rows.map((row) => `${row.payment_id}|${row.transfer_id}|${row.transfer_reversal_id ?? ''}`)).toEqual([
            'pay_market_early|trf_market_a|',
            'pay_market_a|trf_market_b|rvrsl_market_b_1',
            'pay_market_a|trf_market_b|rvrsl_market_b_2',
          ]);
        },
      ),
      { numRuns: 40 },
    );
  });
});
