/**
 * `post_reconciliation_adjustment` (task 24.3).
 * Requirements 2.1, 2.6, 5.17, 12.2, 12.3, 12.7, 12.10.
 *
 * The assertion this file exists for is the one the task text names: an **unbalanced
 * adjustment is rejected atomically with zero entries persisted**, and it is rejected by
 * `SemanticLedger.postSet` rather than by a second balance check in the tool. So the
 * unbalanced case asserts three things together — no `insertSet` reached the store, the
 * ledger's own `ledger_set_rejected` Audit_Event carries the imbalance and
 * `entries_persisted: 0`, and the tool surfaces that rejection instead of reporting a
 * post.
 */

import { describe, expect, it } from 'vitest';

import { createEvidenceChainBuilder } from '@/evidence/chain-builder';
import { createSemanticLedger, type LedgerAuditEvent } from '@/ledger/semantic-ledger';

import { MemoryEvidenceStore } from './exception-tools.test-support';
import {
  catalogueEntryFor,
  createPostReconciliationAdjustment,
  POST_RECONCILIATION_ADJUSTMENT,
  SOURCE_RECORD_CITED_FIELD,
  unreadableCitedRefs,
  type PostReconciliationAdjustmentDeps,
} from './post-reconciliation-adjustment';
import { createToolRegistry } from './registry';
import type { SourceRef, ToolContext } from './tool';
import {
  adjustmentSourceStore,
  ADJUSTMENT_DATE,
  balancedEntries,
  citedRecord,
  duplicateDerivationLedgerStore,
  MemoryLedgerStore,
  recordingWriteAudit,
  SOURCE_UPDATED_AT,
  WRITE_ACTOR,
  WRITE_NOW,
  WRITE_TENANT,
  writeContext,
  writeGate,
} from './write-tools.test-support';

const SETTLEMENT: SourceRef = { type: 'settlement', id: 'setl_SYNTHETIC9281' };
const RECON: SourceRef = { type: 'settlement_recon_report', id: 'pay_SYNTHETIC92811' };
const SOURCE_REFS: readonly SourceRef[] = [SETTLEMENT, RECON];

const POSTED_AT = WRITE_NOW().toISOString();

interface World {
  readonly ledgerStore: MemoryLedgerStore;
  readonly ledgerAudit: LedgerAuditEvent[];
  readonly chains: MemoryEvidenceStore;
  readonly deps: PostReconciliationAdjustmentDeps;
}

/**
 * The tool over a memory ledger, a memory chain store and the two cited records.
 *
 * The ledger is the **real** `createSemanticLedger`, not a stub: the balance rejection
 * and the atomicity are its, and stubbing it would test nothing about the delegation the
 * task is about.
 */
function world(
  options: {
    readonly unreadable?: readonly SourceRef[];
    readonly retainedSetId?: string;
  } = {},
): World {
  const ledgerStore = new MemoryLedgerStore();
  const ledgerAudit: LedgerAuditEvent[] = [];
  const chains = new MemoryEvidenceStore();
  const ledger = createSemanticLedger({
    store:
      options.retainedSetId === undefined
        ? ledgerStore
        : duplicateDerivationLedgerStore(options.retainedSetId),
    audit: {
      append: (event: LedgerAuditEvent): Promise<void> => {
        ledgerAudit.push(event);
        return Promise.resolve();
      },
    },
    actor: WRITE_ACTOR,
    now: WRITE_NOW,
  });
  return {
    ledgerStore,
    ledgerAudit,
    chains,
    deps: {
      ledger: () => ledger,
      sources: () =>
        adjustmentSourceStore(
          [citedRecord(SETTLEMENT.type, SETTLEMENT.id), citedRecord(RECON.type, RECON.id, '2026-07-29T00:00:00.000Z')],
          options.unreadable ?? [],
        ),
      chains: () => chains,
      now: WRITE_NOW,
    },
  };
}

function toolFor(world: World) {
  return createPostReconciliationAdjustment(world.deps, writeGate());
}

const VALID_INPUT = {
  entry_date: ADJUSTMENT_DATE,
  entries: balancedEntries(),
  source_refs: [...SOURCE_REFS],
};

describe('post_reconciliation_adjustment', () => {
  it('posts through postSet and grounds each grand total in its own Evidence_Chain', async () => {
    const built = world();
    const result = await toolFor(built).execute(writeContext(), VALID_INPUT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // One set, written once, with the derivation identity taken from the first ref.
    expect(built.ledgerStore.writes).toHaveLength(1);
    expect(built.ledgerStore.writes[0]).toMatchObject({
      tenant_id: WRITE_TENANT,
      entry_date: ADJUSTMENT_DATE,
      source_record_type: SETTLEMENT.type,
      source_record_id: SETTLEMENT.id,
      entry_count: 2,
      total_debit_paise: 2_320_000n,
      total_credit_paise: 2_320_000n,
    });
    // Every entry is linked to every Source_Record ref of its set (Requirement 2.2).
    expect(built.ledgerStore.writes[0]?.entries.map((entry) => entry.sources)).toEqual([
      [...SOURCE_REFS],
      [...SOURCE_REFS],
    ]);
    expect(result.value.total_debit_paise).toBe(2_320_000n);
    expect(result.value.total_credit_paise).toBe(2_320_000n);

    // Two chains, one per grand total, and they are different chains: Σdebit and Σcredit
    // sum disjoint operand sets.
    expect(result.value.total_debit_evidence_chain_id).not.toBe(
      result.value.total_credit_evidence_chain_id,
    );
    expect(result.evidence.evidence_chain_id).toBe(result.value.total_debit_evidence_chain_id);

    const reader = createEvidenceChainBuilder({ store: built.chains, tenantId: WRITE_TENANT });
    const debit = await reader.read(result.value.total_debit_evidence_chain_id);
    const credit = await reader.read(result.value.total_credit_evidence_chain_id);
    expect(debit?.figure_paise).toBe(2_320_000n);
    expect(credit?.figure_paise).toBe(2_320_000n);
    expect(debit?.produced_by).toBe(POST_RECONCILIATION_ADJUSTMENT);
    // The as-of is the newest contributing record, which is the instant of the post.
    expect(debit?.as_of).toBe(POSTED_AT);

    // The debit chain cites the persisted set's debit line and both derivation records.
    const debitWrite = built.chains.writes[0];
    expect(
      debitWrite?.sources.map((source) => `${source.source_record_type}.${source.field}`).sort(),
    ).toEqual([
      'ledger_entry_set.line_1.amount_paise',
      `settlement.${SOURCE_RECORD_CITED_FIELD}`,
      `settlement_recon_report.${SOURCE_RECORD_CITED_FIELD}`,
    ]);
    expect(
      debitWrite?.sources.find((source) => source.source_record_type === 'settlement')
        ?.record_updated_at,
    ).toBe(SOURCE_UPDATED_AT);
    // The credit chain cites line 2, the credit line, and not line 1.
    expect(
      built.chains.writes[1]?.sources
        .filter((source) => source.source_record_type === 'ledger_entry_set')
        .map((source) => source.field),
    ).toEqual(['line_2.amount_paise']);
  });

  it('rejects an unbalanced adjustment atomically, persisting zero entries', async () => {
    const built = world();
    const unbalanced = {
      entry_date: ADJUSTMENT_DATE,
      entries: [
        { account_code: 'bank', side: 'debit' as const, amount_paise: 100_000n },
        { account_code: 'revenue', side: 'credit' as const, amount_paise: 99_900n },
      ],
      source_refs: [...SOURCE_REFS],
    };

    await expect(toolFor(built).execute(writeContext(), unbalanced)).rejects.toThrow(
      /unbalanced by 100 paise/,
    );

    // Zero entries persisted, and no statement was even issued: `postSet` rejects from
    // the draft, before it reaches a store (Requirement 2.6).
    expect(built.ledgerStore.writes).toEqual([]);
    // No Evidence_Chain either: there is no figure to ground.
    expect(built.chains.writes).toEqual([]);
    // The authoritative record is the ledger's own, on its own connection.
    expect(built.ledgerAudit).toHaveLength(1);
    expect(built.ledgerAudit[0]?.eventType).toBe('ledger_set_rejected');
    expect(built.ledgerAudit[0]?.payload).toMatchObject({
      reason: 'unbalanced',
      imbalance_paise: '100',
      entries_persisted: 0,
    });
    // Requirement 2.6 names the Source_Records involved.
    expect(built.ledgerAudit[0]?.sourceRefs).toEqual([...SOURCE_REFS]);
  });

  it('withholds both totals and posts nothing when a cited record cannot be read', async () => {
    const built = world({ unreadable: [RECON] });

    const result = await toolFor(built).execute(writeContext(), VALID_INPUT);

    expect(result).toEqual({
      ok: false,
      kind: 'incomplete_evidence',
      unavailable: [{ type: RECON.type, count: 1 }],
    });
    // Ordered before the post, so "nothing was written" needs no compensating write.
    expect(built.ledgerStore.writes).toEqual([]);
    expect(built.chains.writes).toEqual([]);
  });

  it('refuses an idempotent no-op rather than reporting the retained set as a post', async () => {
    const retained = '70000000-0000-4000-8000-0000000000ff';
    const built = world({ retainedSetId: retained });

    await expect(toolFor(built).execute(writeContext(), VALID_INPUT)).rejects.toThrow(
      new RegExp(`${retained}[\\s\\S]*already derived`),
    );
    expect(built.chains.writes).toEqual([]);
  });

  it('refuses an invocation with no authorized Proposal, leaving the ledger untouched', async () => {
    const built = world();
    const audit = recordingWriteAudit();
    const gated = createPostReconciliationAdjustment(built.deps, writeGate({ audit }));

    const result = await gated.execute(
      writeContext({ proposal_id: undefined, authorization_id: undefined }),
      VALID_INPUT,
    );

    expect(result).toEqual({
      ok: false,
      kind: 'unauthorized_write',
      reason: 'missing_authorized_proposal',
    });
    // Tenant state unchanged: no Ledger_Entry set, no Evidence_Chain.
    expect(built.ledgerStore.writes).toEqual([]);
    expect(built.chains.writes).toEqual([]);
    expect(audit.events.map((event) => [event.eventType, event.payload['tool']])).toEqual([
      ['unauthorized_write_rejected', POST_RECONCILIATION_ADJUSTMENT],
    ]);
  });

  it('stops before posting when the 10 s bound has already elapsed', async () => {
    const built = world();
    const aborted = new AbortController();
    aborted.abort();
    const ctx: ToolContext = writeContext({ signal: aborted.signal });

    await expect(toolFor(built).execute(ctx, VALID_INPUT)).rejects.toThrow(/aborted/);
    expect(built.ledgerStore.writes).toEqual([]);
  });

  it('bounds every argument, admits no tenant_id, and registers as write_capable', () => {
    const built = world();
    const tool = toolFor(built);

    expect(tool.inputSchema.safeParse(VALID_INPUT).success).toBe(true);
    // The Tenant comes from the session and unknown keys are refused, not stripped.
    expect(tool.inputSchema.safeParse({ ...VALID_INPUT, tenant_id: WRITE_TENANT }).success).toBe(
      false,
    );
    // Requirement 2.1's 2..20 entries, stated where a caller learns of it.
    expect(
      tool.inputSchema.safeParse({ ...VALID_INPUT, entries: [balancedEntries()[0]] }).success,
    ).toBe(false);
    // `amount_paise` is `paise_positive`: a zero-amount entry is omitted, not posted.
    expect(
      tool.inputSchema.safeParse({
        ...VALID_INPUT,
        entries: [
          { account_code: 'bank', side: 'debit', amount_paise: 0n },
          { account_code: 'revenue', side: 'credit', amount_paise: 0n },
        ],
      }).success,
    ).toBe(false);
    // `2026-02-30` parses as a date shape and is not a calendar date.
    expect(tool.inputSchema.safeParse({ ...VALID_INPUT, entry_date: '2026-02-30' }).success).toBe(
      false,
    );
    // At least 1 Source_Record link (Requirement 2.2).
    expect(tool.inputSchema.safeParse({ ...VALID_INPUT, source_refs: [] }).success).toBe(false);

    const registry = createToolRegistry([catalogueEntryFor(built.deps, writeGate())]);
    expect(registry.names()).toEqual([POST_RECONCILIATION_ADJUSTMENT]);
    expect(registry.byMode('write_capable')).toHaveLength(1);
  });

  it('treats an unanswered ref and a declared unreadable one alike, in requested order', () => {
    const answered = citedRecord(SETTLEMENT.type, SETTLEMENT.id);
    expect(unreadableCitedRefs(SOURCE_REFS, { records: [answered] })).toEqual([RECON]);
    // Declared unreadable wins over an answer, because the adapter said so.
    expect(
      unreadableCitedRefs(SOURCE_REFS, {
        records: [answered, citedRecord(RECON.type, RECON.id)],
        unreadable: [SETTLEMENT],
      }),
    ).toEqual([SETTLEMENT]);
    expect(unreadableCitedRefs(SOURCE_REFS, { records: [answered, citedRecord(RECON.type, RECON.id)] })).toEqual([]);
  });
});
