/**
 * Ordered FinanceOS demo path, steps 1 through 5 (task 16.1).
 *
 * The checked-in Razorpay seed is task 7.1's deterministic output. Its synthetic
 * recon rows repeat Payment and Refund identifiers because Razorpay's report lines
 * identify the source entity; Requirement 1.3 stores one row per Tenant and object
 * identifier, so the fixture transport exposes one canonical object for each id.
 *
 * Requirements 1.1, 1.6, 2.1, 2.8, 4.4, 4.5, 12.8. Properties P1, P2, P3, P6, P10.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  createReconciliationAgent,
  inScopePaymentIds,
} from '@/agents/reconciliation/agent';
import {
  memoryExceptionStore,
  memoryLinkStore,
  memoryReconStore,
  memoryScopeStore,
} from '@/agents/reconciliation/agent.test-support';
import type { TenantId } from '@/config/configuration-service';
import { createEvidenceChainBuilder } from '@/evidence/chain-builder';
import {
  createIngestionService,
  type IngestionError,
  type IngestionRun,
  type IngestionStore,
  type NewRun,
  type RazorpayObjectRow,
  type RunCompletion,
} from '@/ingestion/ingestion-service';
import {
  RAZORPAY_ENDPOINTS,
  type FetchOptions,
  type IngestedObjectType,
  type RazorpayClient,
  type RazorpayObject,
} from '@/ingestion/razorpay-client';
import type { SourceRef } from '@/ledger/posting-rules';
import {
  createSemanticLedger,
  LEDGER_SET_DERIVATION_UNIQ,
  type LedgerSetWrite,
  type LedgerSourceRecord,
  type LedgerStore,
} from '@/ledger/semantic-ledger';
import { GET_SETTLEMENT_RECONCILIATION } from '@/tools/get-settlement-reconciliation';
import { reconciledSettlementChain } from '@/tools/settlement-evidence';
import { fromWire } from '@/wire/paise-wire';

import { recordLookupFromRecords, replayFigure } from '../evidence/replay-interpreter';
import { scopedSettlementFor } from '../fixtures/set-9281.scoped';
import {
  SET_9281,
  SET_9281_FEE_VARIANT,
  TENANT_ID,
  WORKED_EXAMPLES,
} from '../fixtures/set-9281';
import { createMemoryEvidenceStore } from '../property/evidence-chain-memory-store';

type SeedObject = {
  readonly object_type: IngestedObjectType;
  readonly razorpay_id: string;
  readonly payload: RazorpayObject;
};

type SeedFixture = {
  readonly part_b_synthetic: {
    readonly tenant_id: TenantId;
    readonly objects_flat: readonly SeedObject[];
  };
};

const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const INGESTION_RUN_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_RUN_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-07-30T09:15:00.000Z');
const JULY_2026 = { year: '2026', month: '7' } as const;

interface MemoryIngestionStore extends IngestionStore {
  readonly rows: Map<string, RazorpayObjectRow>;
  readonly errors: IngestionError[];
  readonly completions: RunCompletion[];
}

function memoryIngestionStore(): MemoryIngestionStore {
  const rows = new Map<string, RazorpayObjectRow>();
  const errors: IngestionError[] = [];
  const completions: RunCompletion[] = [];
  return {
    rows,
    errors,
    completions,
    createRun(run: NewRun) {
      return Promise.resolve({ id: INGESTION_RUN_ID, startedAt: run.startedAt });
    },
    upsertObjects(batch) {
      for (const row of batch) rows.set(`${row.tenant_id}:${row.razorpay_id}`, row);
      return Promise.resolve();
    },
    recordErrors(_tenantId, _runId, recorded) {
      errors.push(...recorded);
      return Promise.resolve();
    },
    completeRun(completion) {
      completions.push(completion);
      return Promise.resolve();
    },
  };
}

/** Requirement 1.3's provider view: one canonical object for each Razorpay id. */
function oneObjectPerIdentifier(objects: readonly SeedObject[]): readonly SeedObject[] {
  const canonical = new Map<string, SeedObject>();
  for (const object of objects) {
    if (!canonical.has(object.razorpay_id)) canonical.set(object.razorpay_id, object);
  }
  return [...canonical.values()];
}

function fixtureClient(objects: readonly SeedObject[]): RazorpayClient {
  return {
    fetchPages(type: IngestedObjectType, _window, options: FetchOptions = {}) {
      const isRequestedReconMonth =
        type !== 'settlement_recon_report' ||
        (options.query?.year === JULY_2026.year && options.query.month === JULY_2026.month);
      const selected = isRequestedReconMonth
        ? objects.filter((object) => object.object_type === type).map((object) => object.payload)
        : [];
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            kind: 'page' as const,
            objectType: type,
            pageIndex: 0,
            objects: selected,
            windowApplied: RAZORPAY_ENDPOINTS[type].supportsTimeWindow,
          };
        },
      };
    },
  };
}

interface MemoryLedgerStore extends LedgerStore {
  readonly writes: LedgerSetWrite[];
}

function memoryLedgerStore(ingested: MemoryIngestionStore): MemoryLedgerStore {
  const writes: LedgerSetWrite[] = [];
  const identities = new Map<string, string>();

  return {
    writes,
    insertSet(write) {
      const key = `${write.source_record_type ?? ''}:${write.source_record_id ?? ''}`;
      const retained = identities.get(key);
      if (retained !== undefined) {
        return Promise.resolve({
          ok: false as const,
          kind: 'duplicate_derivation' as const,
          set_id: retained,
          constraint: LEDGER_SET_DERIVATION_UNIQ,
        });
      }
      const setId = `ledger-set-${writes.length + 1}`;
      identities.set(key, setId);
      writes.push(write);
      return Promise.resolve({ ok: true as const, set_id: setId });
    },
    findSourceRecord(tenantId, ref): Promise<LedgerSourceRecord | null> {
      const row = ingested.rows.get(`${tenantId}:${ref.id}`);
      if (row === undefined || row.object_type !== ref.type) return Promise.resolve(null);

      const paymentId = row.payload.payment_id;
      const report =
        ref.type === 'settlement'
          ? [...ingested.rows.values()].find(
              (candidate) =>
                candidate.tenant_id === tenantId &&
                candidate.object_type === 'settlement_recon_report' &&
                candidate.payload.settlement_id === ref.id,
            )
          : undefined;
      return Promise.resolve({
        type: ref.type,
        id: row.razorpay_id,
        created_at_rzp: row.created_at_rzp,
        amount_paise: row.amount_paise,
        fee_paise: row.fee_paise,
        gst_on_fee_paise: row.gst_on_fee_paise,
        refunded_payment_id: typeof paymentId === 'string' ? paymentId : null,
        settlement_recon_report_id: report?.razorpay_id ?? null,
      });
    },
    findSet() {
      return Promise.reject(new Error('findSet is not used by the demo path'));
    },
    trialBalanceTotals() {
      return Promise.resolve([]);
    },
  };
}

function allLinksForFixture() {
  const settlements = WORKED_EXAMPLES.map(scopedSettlementFor);
  return inScopePaymentIds(settlements).map((paymentId) => ({
    payment_id: paymentId,
    order_ids: [],
    razorpay_invoice_ids: [],
    settlement_ids: [],
    ledger_entry_ids: [],
  }));
}

function payloadPaise(row: RazorpayObjectRow, field: string): bigint | undefined {
  const value = row.payload[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new Error(
      `${row.object_type}:${row.razorpay_id}.${field} must be task 7.1's decimal-string paise`,
    );
  }
  return fromWire(value, `${row.object_type}.${field}`);
}

/** Monetary fields exposed by the ingested row to the independent replay interpreter. */
function replayFields(row: RazorpayObjectRow): Readonly<Record<string, bigint>> {
  const fields: Record<string, bigint> = {};
  const amount = row.amount_paise ?? payloadPaise(row, 'amount');
  const fee = row.fee_paise ?? payloadPaise(row, 'fee');
  const tax = row.gst_on_fee_paise ?? payloadPaise(row, 'tax');
  const debit = payloadPaise(row, 'debit');
  const credit = payloadPaise(row, 'credit');
  if (amount !== undefined) fields.amount = amount;
  if (fee !== undefined) fields.fee = fee;
  if (tax !== undefined) fields.tax = tax;
  if (debit !== undefined) fields.debit = debit;
  if (credit !== undefined) fields.credit = credit;
  if (debit !== undefined && credit !== undefined) fields.signed_amount = credit - debit;
  return fields;
}

const DERIVABLE_TYPES = new Set<IngestedObjectType>([
  'payment',
  'refund',
  'settlement',
  'transfer',
  'transfer_reversal',
]);

describe('ordered demo path', () => {
  it('executes ingestion, ledger derivation, reconciliation, and evidence replay in order', async () => {
    // 1. Seed task 7.1's two residual shapes and ingest one row per object identifier.
    const seed = JSON.parse(
      await readFile(new URL('../fixtures/razorpay-seed.json', import.meta.url), 'utf8'),
    ) as SeedFixture;
    expect(seed.part_b_synthetic.tenant_id).toBe(TENANT_ID);

    const seeded = oneObjectPerIdentifier(seed.part_b_synthetic.objects_flat);
    const ingestion = memoryIngestionStore();
    const ingestionRun: IngestionRun = await createIngestionService({
      store: ingestion,
      client: fixtureClient(seeded),
      now: () => new Date(NOW),
    }).startRun(TENANT_ID, ACTOR_ID);

    const expectedIdentifiers = new Set(
      seed.part_b_synthetic.objects_flat.map((object) => object.razorpay_id),
    );
    expect(ingestionRun.status).toBe('completed');
    expect(ingestion.errors).toEqual([]);
    expect(ingestion.completions.at(-1)?.status).toBe('completed');
    expect(new Set([...ingestion.rows.values()].map((row) => row.razorpay_id))).toEqual(
      expectedIdentifiers,
    );
    expect(ingestion.rows).toHaveLength(expectedIdentifiers.size);

    // 2. Derive every supported source, prove P1 in situ, then prove P2 by rerunning.
    const ledgerStore = memoryLedgerStore(ingestion);
    const ledger = createSemanticLedger({
      store: ledgerStore,
      audit: { append: () => Promise.resolve() },
      actor: { kind: 'agent', id: 'Reconciliation_Agent' },
      now: () => new Date(NOW),
    });
    const derivable: SourceRef[] = [...ingestion.rows.values()]
      .filter((row) => DERIVABLE_TYPES.has(row.object_type))
      .map((row) => ({ type: row.object_type, id: row.razorpay_id }));

    const firstPass = await Promise.all(
      derivable.map((source) => ledger.postFromSource(TENANT_ID, source)),
    );
    expect(firstPass.every((result) => result.ok && result.created)).toBe(true);
    expect(ledgerStore.writes).toHaveLength(derivable.length);
    for (const write of ledgerStore.writes) {
      const debit = write.entries
        .filter((entry) => entry.side === 'debit')
        .reduce((total, entry) => total + entry.amount_paise, 0n);
      const credit = write.entries
        .filter((entry) => entry.side === 'credit')
        .reduce((total, entry) => total + entry.amount_paise, 0n);
      expect(write.entry_count).toBeGreaterThanOrEqual(2);
      expect(write.entry_count).toBeLessThanOrEqual(20);
      expect(write.entries.every((entry) => entry.amount_paise > 0n)).toBe(true);
      expect(debit).toBe(credit);
      expect(write.total_debit_paise).toBe(write.total_credit_paise);
    }

    const writesAfterFirstPass = ledgerStore.writes.length;
    const secondPass = await Promise.all(
      derivable.map((source) => ledger.postFromSource(TENANT_ID, source)),
    );
    expect(secondPass.every((result) => result.ok && !result.created)).toBe(true);
    expect(ledgerStore.writes).toHaveLength(writesAfterFirstPass);

    // 3. Persist the production tool's per-Settlement chains, then run the agent with them.
    const settlements = WORKED_EXAMPLES.map(scopedSettlementFor);
    const evidenceStore = createMemoryEvidenceStore();
    const evidence = createEvidenceChainBuilder({ store: evidenceStore, tenantId: TENANT_ID });
    const evidenceBySettlement = new Map<string, string>();
    for (const [position, settlement] of settlements.entries()) {
      const example = WORKED_EXAMPLES[position];
      if (example === undefined) throw new Error(`missing worked example at ${position}`);
      const built = await evidence.build(
        reconciledSettlementChain(GET_SETTLEMENT_RECONCILIATION, settlement, example.recon),
      );
      if (!built.ok) throw new Error(`incomplete evidence for ${settlement.settlement_id}`);
      evidenceBySettlement.set(settlement.settlement_id, built.evidence.evidence_chain_id);
    }

    const exceptions = memoryExceptionStore();
    const report = await createReconciliationAgent({
      tenantId: TENANT_ID,
      settlements: memoryScopeStore({ tenantId: TENANT_ID, settlements }),
      reconciliations: memoryReconStore(),
      exceptions,
      links: memoryLinkStore(allLinksForFixture()),
      evidenceChainFor: (settlementId) => evidenceBySettlement.get(settlementId) ?? null,
      newRunId: () => AGENT_RUN_ID,
      now: () => new Date(NOW),
    }).run({ from: '2026-07-01', to: '2026-07-31' });

    const explained = report.settlements.find(
      (row) => row.settlement_id === SET_9281.settlement_id,
    );
    const mismatch = report.settlements.find(
      (row) => row.settlement_id === SET_9281_FEE_VARIANT.settlement_id,
    );
    expect(explained?.recon).toEqual(SET_9281.recon);
    expect(explained?.recon.status).toBe('difference_explained');
    expect(mismatch?.recon).toEqual(SET_9281_FEE_VARIANT.recon);
    expect(mismatch?.recon.status).toBe('mismatch');
    expect(mismatch?.recon.direction).toBe('unexplained_shortfall');

    // 4. The explained Settlement has no Exception; the mismatch has exactly one.
    expect(exceptions.rows).toHaveLength(1);
    const exception = [...exceptions.rows.values()][0];
    expect(exception?.category).toBe('settlement_mismatch');
    expect(exception?.impact_paise).toBe(
      SET_9281_FEE_VARIANT.exception?.impact_paise.toString(),
    );
    expect(exception?.direction).toBe('shortfall');
    expect(exception?.links.map((link) => link.source_record_id)).toEqual([
      SET_9281_FEE_VARIANT.settlement_id,
      SET_9281_FEE_VARIANT.recon_report_id,
    ]);
    expect(
      [...exceptions.rows.values()].some((row) =>
        row.links.some((link) => link.source_record_id === SET_9281.settlement_id),
      ),
    ).toBe(false);

    // 5. Fetch the Exception chain, resolve every cited id, and replay its ordered steps.
    expect(exception?.evidence_chain_id).toBe(
      evidenceBySettlement.get(SET_9281_FEE_VARIANT.settlement_id),
    );
    if (exception?.evidence_chain_id === null || exception?.evidence_chain_id === undefined) {
      throw new Error('the settlement_mismatch Exception has no Evidence_Chain');
    }
    const chain = await evidence.read(exception.evidence_chain_id);
    expect(chain).not.toBeNull();
    if (chain === null) throw new Error('the Exception Evidence_Chain did not resolve');

    const ingestedByIdentifier = new Map(
      [...ingestion.rows.values()].map((row) => [row.razorpay_id, row] as const),
    );
    const replayRecords = chain.first_page.sources.map((source) => {
      const row = ingestedByIdentifier.get(source.ref.id);
      expect(row, `${source.ref.id} must resolve to an ingested row`).toBeDefined();
      if (row === undefined) throw new Error(`missing ingested Source_Record ${source.ref.id}`);
      return { ref: source.ref, fields: replayFields(row) };
    });

    expect(chain.steps.map((step) => step.index)).toEqual(
      Array.from({ length: chain.steps.length }, (_unused, index) => index + 1),
    );
    expect(chain.source_count).toBe(replayRecords.length);
    expect(
      replayFigure(chain.steps, { lookup: recordLookupFromRecords(replayRecords) }),
    ).toBe(chain.figure_paise);
    expect(chain.figure_paise).toBe(SET_9281_FEE_VARIANT.exception?.impact_paise);
  });
});
