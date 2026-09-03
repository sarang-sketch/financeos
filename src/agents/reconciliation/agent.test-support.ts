/**
 * The four seams a Reconciliation_Agent run reads and writes through, in memory
 * (task 13.2).
 *
 * **Not mocks.** Each one implements the semantics its real counterpart is specified to
 * have, so a test written against these is a statement about the run rather than about a
 * stub:
 *
 * - {@link memoryReconStore} keys on `(tenant, settlement)` — `settlement_recon_uniq` —
 *   so a re-run is an UPDATE and `created` is `false` the second time (Requirement 4.15).
 * - {@link memoryExceptionStore} keys on the fingerprint, writes `first_detected_at`
 *   **once**, and touches no field at all unless the row is `open` — the
 *   `WHERE exceptions.lifecycle_state = 'open'` guard — answering
 *   `{ kind: 'not_reopened' }` otherwise.
 * - {@link memoryScopeStore} applies the Tenant gate and the resolved range: a
 *   cross-Tenant request answers **zero rows**, never a permission error
 *   (Requirement 14.4).
 * - {@link memoryLinkStore} answers only about Payments it holds, which is what keeps
 *   13.1's "read, but not read at all" distinction observable.
 *
 * It lives in `src/` beside the agent rather than under `test/` for the reason
 * `src/tools/exception-tools.test-support.ts` does: two test files need it —
 * `./agent.test.ts` and `test/worked-example/set-9281.worked-example.test.ts` — and a
 * second copy of the upsert semantics is exactly the kind of restatement that drifts.
 * It imports nothing from `test/`; the fixtures stay with the tests that use them.
 *
 * The filename does not end in `.test.ts`, so no Vitest project collects it.
 */

import type {
  ExceptionState,
  ExceptionStore,
  ExceptionWrite,
  ExceptionWriteOutcome,
} from '@/agents/exception-fingerprint';
import type { TenantId } from '@/config/configuration-service';
import type {
  ScopedSettlement,
  SettlementScopeQuery,
  SettlementScopeResult,
  SettlementScopeStore,
} from '@/tools/settlement-scope';

import type {
  LifecycleLinkQuery,
  LifecycleLinkResult,
  LifecycleLinkStore,
  PaymentLinks,
} from './match';
import type {
  SettlementReconStore,
  SettlementReconWrite,
  SettlementReconWriteOutcome,
} from './reconcile-settlement';

/* -------------------------------------------------------------------------- */
/* A clock a test drives                                                      */
/* -------------------------------------------------------------------------- */

/** A wall clock under test control. `autoAdvanceMs` advances it on every read. */
export interface TestClock {
  now(): Date;
  advance(byMs: number): void;
}

export function testClock(startIso: string, autoAdvanceMs = 0): TestClock {
  let ms = Date.parse(startIso);
  if (Number.isNaN(ms)) {
    throw new Error(`testClock needs a real instant, got ${JSON.stringify(startIso)}`);
  }
  return {
    now(): Date {
      const at = new Date(ms);
      ms += autoAdvanceMs;
      return at;
    },
    advance(byMs: number): void {
      ms += byMs;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The scope read seam                                                        */
/* -------------------------------------------------------------------------- */

export interface MemoryScopeStore extends SettlementScopeStore {
  readonly queries: SettlementScopeQuery[];
}

/**
 * In-scope Settlements, filtered by the Tenant, the resolved range and the optional
 * identifier list — the three things `SettlementScopeStore`'s contract requires an
 * adapter to apply. The range **is** the scope: a named identifier outside it is not
 * returned.
 */
export function memoryScopeStore(options: {
  readonly tenantId: TenantId;
  readonly settlements: readonly ScopedSettlement[];
  readonly ledgerEntriesExamined?: number;
  readonly razorpayInvoicesExamined?: number;
}): MemoryScopeStore {
  const queries: SettlementScopeQuery[] = [];
  return {
    queries,
    listInScope(query: SettlementScopeQuery): Promise<SettlementScopeResult> {
      queries.push(query);
      const rows = query.tenant_id === options.tenantId ? options.settlements : [];
      const named = query.settlement_ids;
      return Promise.resolve({
        settlements: rows.filter(
          (row) =>
            row.settlement_date >= query.scope.from &&
            row.settlement_date <= query.scope.to &&
            (named === null || named.includes(row.settlement_id)),
        ),
        ledger_entries_examined: options.ledgerEntriesExamined ?? 0,
        razorpay_invoices_examined: options.razorpayInvoicesExamined ?? 0,
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* `settlement_reconciliations`                                               */
/* -------------------------------------------------------------------------- */

/** One stored reconciliation row, with the latest write that landed on it. */
export interface StoredRecon {
  readonly id: string;
  write: SettlementReconWrite;
}

export interface MemoryReconStore extends SettlementReconStore {
  readonly rows: Map<string, StoredRecon>;
  readonly writes: SettlementReconWrite[];
}

/**
 * `settlement_recon_uniq` in memory: one row per `(tenant, settlement)`, replaced in
 * place on a re-run, which is what keeps a second run to one row (Requirement 4.15).
 *
 * `onUpsert` runs before the row is written, so a test can charge wall-clock time to a
 * reconciliation and drive Requirement 15.6's bound.
 */
export function memoryReconStore(onUpsert?: () => void): MemoryReconStore {
  const rows = new Map<string, StoredRecon>();
  const writes: SettlementReconWrite[] = [];
  return {
    rows,
    writes,
    upsertReconciliation(write: SettlementReconWrite): Promise<SettlementReconWriteOutcome> {
      writes.push(write);
      onUpsert?.();
      const key = `${write.tenant_id}:${write.settlement_id}`;
      const existing = rows.get(key);
      if (existing === undefined) {
        const id = `recon-${rows.size + 1}`;
        rows.set(key, { id, write });
        return Promise.resolve({ ok: true, reconciliation_id: id, created: true });
      }
      existing.write = write;
      return Promise.resolve({ ok: true, reconciliation_id: existing.id, created: false });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* `exceptions`                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One stored Exception. `first_detected_at` is `readonly` for the same reason it appears
 * in the statement's `VALUES` list and never in its `DO UPDATE SET` list: a re-run must
 * not move it.
 */
export interface StoredException {
  readonly id: string;
  readonly category: ExceptionWrite['category'];
  state: ExceptionState;
  /** Integer paise as text, exactly as the column holds it. */
  impact_paise: string;
  direction: string;
  detail: string;
  evidence_chain_id: string | null;
  readonly first_detected_at: string;
  last_detected_at: string;
  /** `exception_source_records`, in the canonical order the write states. */
  links: ExceptionWrite['links'];
}

export interface MemoryExceptionStore extends ExceptionStore {
  readonly rows: Map<string, StoredException>;
  readonly writes: ExceptionWrite[];
  /** The stored Exception for a fingerprint, or `undefined`. */
  byFingerprint(fingerprint: string): StoredException | undefined;
}

/**
 * `exceptions_fingerprint_uniq` plus the `WHERE lifecycle_state = 'open'` guard, in
 * memory.
 *
 * Three behaviours a test depends on, all of them the statement's:
 *
 * 1. One row per fingerprint. A re-detection updates; it never inserts a second row.
 * 2. `first_detected_at` is written on insert and never again.
 * 3. A `resolved` or `dismissed` row is left **entirely** untouched and the caller is
 *    told so, rather than the re-detection being silently discarded.
 */
export function memoryExceptionStore(onUpsert?: () => void): MemoryExceptionStore {
  const rows = new Map<string, StoredException>();
  const writes: ExceptionWrite[] = [];
  return {
    rows,
    writes,
    byFingerprint(fingerprint: string): StoredException | undefined {
      return rows.get(fingerprint);
    },
    upsertException(write: ExceptionWrite): Promise<ExceptionWriteOutcome> {
      writes.push(write);
      onUpsert?.();
      const existing = rows.get(write.fingerprint);
      if (existing === undefined) {
        const id = `exc-${rows.size + 1}`;
        rows.set(write.fingerprint, {
          id,
          category: write.category,
          state: 'open',
          impact_paise: write.impact_paise,
          direction: write.direction,
          detail: write.detail,
          evidence_chain_id: write.evidence_chain_id,
          // `VALUES (..., $8, $8)`: one instant, both detection columns.
          first_detected_at: write.detected_at,
          last_detected_at: write.detected_at,
          links: write.links,
        });
        return Promise.resolve({ ok: true, exception_id: id, created: true });
      }
      if (existing.state !== 'open') {
        return Promise.resolve({
          ok: false,
          kind: 'not_reopened',
          exception_id: existing.id,
          lifecycle_state: existing.state,
          fingerprint: write.fingerprint,
        });
      }
      existing.impact_paise = write.impact_paise;
      existing.direction = write.direction;
      existing.detail = write.detail;
      existing.evidence_chain_id = write.evidence_chain_id;
      existing.last_detected_at = write.detected_at;
      existing.links = write.links;
      return Promise.resolve({ ok: true, exception_id: existing.id, created: false });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Stored identifier links                                                    */
/* -------------------------------------------------------------------------- */

export interface MemoryLinkStore extends LifecycleLinkStore {
  readonly queries: LifecycleLinkQuery[];
}

/**
 * Stored identifier links for the Payments it holds, and **no entry** for a requested
 * Payment it does not — which is what makes `payments_not_read` distinguishable from a
 * Payment whose four record types are all `not_matched`.
 */
export function memoryLinkStore(
  links: readonly PaymentLinks[],
  unreadable: LifecycleLinkResult['unreadable'] = [],
): MemoryLinkStore {
  const queries: LifecycleLinkQuery[] = [];
  return {
    queries,
    readLinks(query: LifecycleLinkQuery): Promise<LifecycleLinkResult> {
      queries.push(query);
      return Promise.resolve({
        payments: links.filter((one) => query.payment_ids.includes(one.payment_id)),
        unreadable,
      });
    },
  };
}
