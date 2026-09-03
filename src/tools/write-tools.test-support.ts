/**
 * In-memory seams for the two write-capable Financial_Tools (task 24.3).
 *
 * Shared by `./write-tool.test.ts`, `./post-reconciliation-adjustment.test.ts`,
 * `./mark-exception-resolved.test.ts` and `test/contract/slice-1-catalogue.ts`, so the
 * unit tests and the registry-driven contract suite run the tools against the same
 * fakes rather than two sets that could drift.
 *
 * Nothing here is production code. What each fake does **not** enforce is stated on it:
 * a fake that quietly enforced less than the database would make a passing test a false
 * one, and a fake that enforced more would make the contract suite unrunnable.
 */

import type { Paise } from '@/calc/calculation-service';
import type { Actor, TenantId } from '@/config/configuration-service';
import type { DateOnly, SourceRecordType, SourceRef } from '@/ledger/posting-rules';
import type {
  AccountPeriodTotals,
  LedgerSetWrite,
  LedgerStore,
  LedgerWriteOutcome,
  PersistedLedgerSet,
} from '@/ledger/semantic-ledger';
import type { ProposalState, RecordedAuthorization } from '@/policy/checks';

import type {
  AdjustmentSourceQuery,
  AdjustmentSourceRead,
  AdjustmentSourceRecord,
  AdjustmentSourceStore,
} from './post-reconciliation-adjustment';
import type {
  ExceptionResolutionOutcome,
  ExceptionResolutionRequest,
  ExceptionResolutionStore,
} from './mark-exception-resolved';
import type {
  ProposalAuthorizationLookup,
  ProposalAuthorizationRef,
  ToolAuditEvent,
  ToolAuditSink,
  ToolContext,
} from './tool';
import type { WriteCapableToolGate } from './write-tool';

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

export const WRITE_TENANT: TenantId = '11111111-1111-4111-8111-111111111111';
export const WRITE_USER = '33333333-3333-4333-8333-333333333333';

/** `proposals.id` and `authorizations.id` are UUIDs, and the gate holds them to it. */
export const PROPOSAL_ID = '44444444-4444-4444-8444-444444444444';
export const AUTHORIZATION_ID = '55555555-5555-4555-8555-555555555555';

export const WRITE_ACTOR: Actor = { kind: 'agent', id: 'write_tool_tests' };

export const WRITE_NOW = (): Date => new Date('2026-07-30T09:00:00.000Z');

/**
 * A `ToolContext` carrying the Proposal pair a `write_capable` invocation needs.
 *
 * `tenant_id` is the session's and there is no argument that could override it
 * (Requirement 12.7).
 */
export function writeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    tenant_id: WRITE_TENANT,
    user_id: WRITE_USER,
    permissions: ['view_financial_data', 'run_agents', 'approve_sensitive_actions'],
    proposal_id: PROPOSAL_ID,
    authorization_id: AUTHORIZATION_ID,
    db: {} as ToolContext['db'],
    signal: new AbortController().signal,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Authorization lookup                                                       */
/* -------------------------------------------------------------------------- */

/** One Proposal as an authorization lookup needs to see it. */
export interface StoredProposal {
  readonly tenant_id: TenantId;
  readonly proposal_id: string;
  readonly state: ProposalState;
  readonly authorizations: readonly RecordedAuthorization[];
}

/** An approved `authorizations` row, as `@/policy/decide` writes one. */
export function approval(
  proposalId: string,
  authorizationId: string,
  overrides: Partial<RecordedAuthorization> = {},
): RecordedAuthorization {
  return {
    id: authorizationId,
    proposal_id: proposalId,
    actor_kind: 'user',
    actor_user_id: WRITE_USER,
    decision: 'approved',
    decided_at: '2026-07-30T08:59:00.000Z',
    ...overrides,
  };
}

/** The Proposal every fixture authorizes: `authorized`, with one approval recorded. */
export const AUTHORIZED_PROPOSAL: StoredProposal = {
  tenant_id: WRITE_TENANT,
  proposal_id: PROPOSAL_ID,
  state: 'authorized',
  authorizations: [approval(PROPOSAL_ID, AUTHORIZATION_ID)],
};

/**
 * `ProposalAuthorizationLookup` over `@/policy/checks` values.
 *
 * The rule this fake applies, stated because it is a **test** decision and not a
 * production one: the pair resolves when the Proposal belongs to the requesting Tenant,
 * the named `authorizations.id` is recorded against that Proposal, and its `decision` is
 * `approved`. `state` is carried on {@link StoredProposal} and is deliberately **not**
 * part of the rule — which Proposal states admit a write is not stated by
 * requirements.md or design.md, so no whitelist is invented here or in
 * `./write-tool.ts`. A fixture wanting to exercise that question states it directly.
 *
 * The answer is a boolean, so "no such Proposal" and "not authorized" are
 * indistinguishable (Requirement 14.4).
 */
export function authorizationLookup(
  proposals: readonly StoredProposal[] = [AUTHORIZED_PROPOSAL],
): ProposalAuthorizationLookup & { readonly asked: ProposalAuthorizationRef[] } {
  const asked: ProposalAuthorizationRef[] = [];
  return {
    asked,
    isAuthorized(ref: ProposalAuthorizationRef): Promise<boolean> {
      asked.push(ref);
      const proposal = proposals.find(
        (candidate) =>
          candidate.tenant_id === ref.tenantId && candidate.proposal_id === ref.proposalId,
      );
      if (proposal === undefined) {
        return Promise.resolve(false);
      }
      return Promise.resolve(
        proposal.authorizations.some(
          (recorded) =>
            recorded.id === ref.authorizationId &&
            recorded.proposal_id === proposal.proposal_id &&
            recorded.decision === 'approved',
        ),
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Audit sink                                                                 */
/* -------------------------------------------------------------------------- */

export interface RecordingWriteAudit extends ToolAuditSink {
  readonly events: ToolAuditEvent[];
}

/** Records appends. `app.append_audit_event_autonomous` fails with `2F003` today. */
export function recordingWriteAudit(options: { readonly fail?: boolean } = {}): RecordingWriteAudit {
  const events: ToolAuditEvent[] = [];
  return {
    events,
    append(event: ToolAuditEvent): Promise<void> {
      events.push(event);
      return options.fail === true
        ? Promise.reject(new Error('audit sink unavailable'))
        : Promise.resolve();
    },
  };
}

/**
 * The gate every write-capable fixture shares.
 *
 * A caller that needs to read the appended `unauthorized_write_rejected` back passes its
 * own {@link recordingWriteAudit} in, so the sink it holds is the sink the gate uses.
 */
export function writeGate(overrides: Partial<WriteCapableToolGate> = {}): WriteCapableToolGate {
  return {
    authorization: overrides.authorization ?? authorizationLookup(),
    audit: overrides.audit ?? recordingWriteAudit(),
    actor: overrides.actor ?? WRITE_ACTOR,
    now: overrides.now ?? WRITE_NOW,
  };
}

/* -------------------------------------------------------------------------- */
/* Ledger store                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A `LedgerStore` that writes to a Map.
 *
 * **What it does not enforce:** `ledger_set_derivation_uniq`. Every `insertSet` answers
 * a fresh set identifier, so posting one draft twice yields two sets rather than
 * Requirement 2.8's idempotent no-op. That is deliberate and is what lets the contract
 * harness invoke one conforming input several times; the no-op refusal
 * `post_reconciliation_adjustment` makes is covered by
 * {@link duplicateDerivationLedgerStore} and by its own unit test.
 *
 * The balance barriers are not modelled either, because `postSet` rejects an unbalanced
 * draft **before** reaching a store at all — which is the whole point of delegating.
 */
export class MemoryLedgerStore implements LedgerStore {
  readonly writes: LedgerSetWrite[] = [];
  private readonly sets = new Map<string, PersistedLedgerSet>();
  private nextId = 1;

  insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome> {
    const setId = `70000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
    this.writes.push(write);
    this.sets.set(setId, {
      id: setId,
      tenant_id: write.tenant_id,
      entry_date: write.entry_date,
      source_record_type: write.source_record_type,
      source_record_id: write.source_record_id,
      reverses_set_id: write.reverses_set_id,
      entry_count: write.entry_count,
      total_debit_paise: write.total_debit_paise,
      total_credit_paise: write.total_credit_paise,
      entries: write.entries.map((entry) => ({
        account_code: entry.account_code,
        side: entry.side,
        amount_paise: entry.amount_paise,
        entry_date: entry.entry_date,
        line_no: entry.line_no,
        sources: [...entry.sources],
      })),
    });
    return Promise.resolve({ ok: true, set_id: setId });
  }

  findSourceRecord(): Promise<null> {
    // Only `postFromSource` reads one, and neither write-capable tool calls it.
    return Promise.resolve(null);
  }

  findSet(tenantId: TenantId, setId: string): Promise<PersistedLedgerSet | null> {
    const set = this.sets.get(setId);
    return Promise.resolve(set === undefined || set.tenant_id !== tenantId ? null : set);
  }

  trialBalanceTotals(): Promise<readonly AccountPeriodTotals[]> {
    return Promise.resolve([]);
  }
}

/**
 * A `LedgerStore` that reports `ledger_set_derivation_uniq` for every insert, retaining
 * `retainedSetId`. Requirement 2.8's idempotent no-op, as the database reports it.
 */
export function duplicateDerivationLedgerStore(retainedSetId: string): LedgerStore {
  const store = new MemoryLedgerStore();
  return {
    insertSet(write: LedgerSetWrite): Promise<LedgerWriteOutcome> {
      store.writes.push(write);
      return Promise.resolve({
        ok: false,
        kind: 'duplicate_derivation',
        set_id: retainedSetId,
        constraint: 'ledger_set_derivation_uniq',
      });
    },
    findSourceRecord: () => store.findSourceRecord(),
    findSet: (tenantId: TenantId, setId: string) => store.findSet(tenantId, setId),
    trialBalanceTotals: () => store.trialBalanceTotals(),
  };
}

/* -------------------------------------------------------------------------- */
/* The adjustment's Source_Record read                                        */
/* -------------------------------------------------------------------------- */

export const SOURCE_UPDATED_AT = '2026-07-28T00:00:00.000Z';

/** One readable cited record, dated {@link SOURCE_UPDATED_AT} unless told otherwise. */
export function citedRecord(
  type: SourceRecordType,
  id: string,
  recordUpdatedAt: string = SOURCE_UPDATED_AT,
): AdjustmentSourceRecord {
  return { ref: { type, id }, record_updated_at: recordUpdatedAt };
}

/**
 * An `AdjustmentSourceStore` over a fixed record list.
 *
 * A requested ref the list does not hold is simply absent from the answer, and
 * `unreadable` is reported verbatim — the two spellings
 * `post_reconciliation_adjustment` treats identically. A cross-Tenant request answers
 * zero rows rather than an error (Requirement 14.4).
 */
export function adjustmentSourceStore(
  records: readonly AdjustmentSourceRecord[],
  unreadable: readonly SourceRef[] = [],
): AdjustmentSourceStore & { readonly queries: AdjustmentSourceQuery[] } {
  const queries: AdjustmentSourceQuery[] = [];
  return {
    queries,
    readSourceRecords(query: AdjustmentSourceQuery): Promise<AdjustmentSourceRead> {
      queries.push(query);
      if (query.tenant_id !== WRITE_TENANT) {
        return Promise.resolve({ records: [] });
      }
      const answered = records.filter((record) =>
        query.refs.some((ref) => ref.type === record.ref.type && ref.id === record.ref.id),
      );
      return Promise.resolve(
        unreadable.length === 0 ? { records: answered } : { records: answered, unreadable },
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The Exception resolution write                                             */
/* -------------------------------------------------------------------------- */

/**
 * An `ExceptionResolutionStore` over a Map.
 *
 * **What it does not do:** write the transition back into the `ExceptionStore` the tool
 * reads. So a second invocation still sees `open` and resolves again, which is what lets
 * the contract harness invoke one conforming input several times. The three lifecycle
 * branches — `open`, `resolved`, `dismissed` — are driven directly in
 * `./mark-exception-resolved.test.ts` by stating the stored state, and the `not_open`
 * race is driven by {@link notOpenResolutionStore}.
 */
export function exceptionResolutionStore(
  options: { readonly known?: readonly string[] } = {},
): ExceptionResolutionStore & { readonly resolved: ExceptionResolutionRequest[] } {
  const resolved: ExceptionResolutionRequest[] = [];
  return {
    resolved,
    resolve(
      tenantId: TenantId,
      request: ExceptionResolutionRequest,
    ): Promise<ExceptionResolutionOutcome> {
      if (tenantId !== WRITE_TENANT) {
        return Promise.resolve({ kind: 'absent' });
      }
      if (options.known !== undefined && !options.known.includes(request.exception_id)) {
        return Promise.resolve({ kind: 'absent' });
      }
      resolved.push(request);
      return Promise.resolve({ kind: 'resolved', resolved_at: request.resolved_at });
    },
  };
}

/** The guard declined: the row moved between the read and the `UPDATE`. */
export function notOpenResolutionStore(state: string): ExceptionResolutionStore {
  return {
    resolve(): Promise<ExceptionResolutionOutcome> {
      return Promise.resolve({ kind: 'not_open', state });
    },
  };
}

/** The Exception vanished between the read and the `UPDATE`. */
export const absentResolutionStore: ExceptionResolutionStore = {
  resolve(): Promise<ExceptionResolutionOutcome> {
    return Promise.resolve({ kind: 'absent' });
  },
};

/* -------------------------------------------------------------------------- */
/* Drafts                                                                     */
/* -------------------------------------------------------------------------- */

/** The date every fixture posts on. A real calendar date, as the schema requires. */
export const ADJUSTMENT_DATE: DateOnly = '2026-07-30';

/** One drafted entry, in the shape the tool's parsed input carries it. */
export interface DraftedEntry {
  account_code: string;
  side: 'debit' | 'credit';
  amount_paise: Paise;
}

/**
 * One balanced two-line adjustment: `amount` debited to `bank`, credited to `revenue`.
 *
 * Mutable, because `z.infer` of the tool's input schema is, and a fixture that had to be
 * spread to satisfy the parser would be a fixture nobody could pass straight through.
 */
export function balancedEntries(amount: Paise = 2_320_000n): DraftedEntry[] {
  return [
    { account_code: 'bank', side: 'debit', amount_paise: amount },
    { account_code: 'revenue', side: 'credit', amount_paise: amount },
  ];
}
