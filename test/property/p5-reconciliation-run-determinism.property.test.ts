// Feature: financeos-control-tower, Property 5: Reconciliation run determinism
//
// For every generated Tenant dataset, a second run over the unchanged rows in a shuffled
// insertion order returns the same ordered persisted Exception tuples and updates, rather
// than duplicates, every open Exception.
//
// **Validates: Requirements 4.15, 6.12, 7.10, 15.7**
//
// SLICE 2: THE ROUTE HALF OF THE DATASET IS NOW LIVE
// -------------------------------------------------
// Requirement 7.10 — the re-run rule for the Marketplace_Agent's two range-scoped
// Exception_Categories — is in P5's validates list, and design.md composes
// `arbitraryTenantDataset` from `arbitraryRouteSplit` among others. Until Slice 2 landed
// there was no Marketplace_Agent to run, so the Route rows were inert. Task 20 (the Slice 2
// property gate) closes that: every generated dataset now carries real Razorpay_Route
// objects (see `./reconciliation-determinism-generators.ts`) and **both** agents run over
// it, twice, through **one shared Exception store** — which is what makes the
// "no duplicate Exception" claim a statement about the Tenant's whole Exception table
// rather than about one agent's slice of it.
//
// The two agents' categories are disjoint (`settlement_mismatch` against
// `seller_settlement_mismatch` and `over_allocated_split`), and the ordered tuple oracle is
// each agent's own production order, concatenated in run order — the Reconciliation_Agent's
// `settlementMismatchOrder`, then the Marketplace_Agent's already-ordered `detections`.
// Neither ordering rule is restated here.
//
// The generator guarantees both Marketplace detectors fire on every draw, and that premise
// is checked against the agent's output rather than assumed, the same way the impact tie is.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canonicalSourceRefs,
  type ExceptionCategory,
} from '@/agents/exception-fingerprint';
import {
  createMarketplaceAgent,
  type MarketplaceAgentRunReport,
} from '@/agents/marketplace/agent';
import {
  createReconciliationAgent,
  type ReconciliationRunReport,
  settlementMismatchOrder,
} from '@/agents/reconciliation/agent';
import {
  type MemoryExceptionStore,
  type MemoryReconStore,
  memoryExceptionStore,
  memoryLinkStore,
  memoryReconStore,
  memoryScopeStore,
} from '@/agents/reconciliation/agent.test-support';
import { fromWire } from '@/wire/paise-wire';

import {
  arbitraryTenantDataset,
  type TenantDataset,
} from './reconciliation-determinism-generators';

const NUM_RUNS = 100;
const SEED = 20260415;
const PARAMS = { numRuns: NUM_RUNS, seed: SEED } as const;

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const FIRST_RUN_ID = '55555555-5555-4555-8555-555555555551';
const SECOND_RUN_ID = '55555555-5555-4555-8555-555555555552';
const FIRST_RUN_AT = '2026-08-01T00:00:00.000Z';
const SECOND_RUN_AT = '2026-08-02T00:00:00.000Z';
const SCOPE = { from: '2026-07-01', to: '2026-07-31' } as const;

type ExceptionTuple = readonly [
  category: ExceptionCategory,
  impact_paise: bigint,
  sortedSourceRefs: readonly string[],
];

interface Stores {
  readonly exceptions: MemoryExceptionStore;
  readonly reconciliations: MemoryReconStore;
}

function runAgent(
  dataset: TenantDataset,
  stores: Stores,
  runAt: string,
  runId: string,
): Promise<ReconciliationRunReport> {
  return createReconciliationAgent({
    tenantId: TENANT_ID,
    settlements: memoryScopeStore({ tenantId: TENANT_ID, settlements: dataset.settlements }),
    reconciliations: stores.reconciliations,
    exceptions: stores.exceptions,
    links: memoryLinkStore(dataset.links),
    now: () => new Date(runAt),
    newRunId: () => runId,
  }).run(SCOPE);
}

/** The same Tenant, the same range, the same Exception store: the Route half of the run. */
function runMarketplaceAgent(
  dataset: TenantDataset,
  stores: Stores,
  runAt: string,
): Promise<MarketplaceAgentRunReport> {
  return createMarketplaceAgent({ tenantId: TENANT_ID, exceptions: stores.exceptions }).run({
    range: SCOPE,
    linked_account_id: dataset.route.focus_linked_account_id,
    payments: dataset.route.payments,
    transfers: dataset.route.transfers,
    transfer_reversals: dataset.route.transfer_reversals,
    settlements: dataset.route.settlements,
    detected_at: runAt,
  });
}

/** One persisted Exception as P5's `[category, impact_paise, sortedSourceRefs]` tuple. */
function tupleFor(fingerprint: string, store: MemoryExceptionStore): ExceptionTuple {
  const row = store.byFingerprint(fingerprint);
  if (row === undefined) {
    throw new Error(`missing persisted Exception ${fingerprint}`);
  }
  const sortedSourceRefs = canonicalSourceRefs(
    row.links.map((link) => ({
      type: link.source_record_type,
      id: link.source_record_id,
    })),
  ).map((ref) => `${ref.type}:${ref.id}`);
  return [row.category, fromWire(row.impact_paise), sortedSourceRefs] as const;
}

/**
 * Project persisted Exceptions in each run's production total order. Both ordering
 * and Source_Record canonicalization are imported from production; the property does
 * not carry a second copy of either rule.
 */
function orderedExceptionTuples(
  recon: ReconciliationRunReport,
  marketplace: MarketplaceAgentRunReport,
  store: MemoryExceptionStore,
): readonly ExceptionTuple[] {
  return [
    ...settlementMismatchOrder(recon.exceptions.detections).map((detection) =>
      tupleFor(detection.outcome.fingerprint, store),
    ),
    // `createMarketplaceExceptionRunner` sorts before it upserts, so `detections` is
    // already the Marketplace_Agent's total order.
    ...marketplace.exceptions.detections.map((detection) =>
      tupleFor(detection.outcome.fingerprint, store),
    ),
  ];
}

interface DetectionTimes {
  readonly first_detected_at: string;
  readonly last_detected_at: string;
}

function detectionTimes(store: MemoryExceptionStore): ReadonlyMap<string, DetectionTimes> {
  return new Map(
    [...store.rows].map(([fingerprint, row]) => [
      fingerprint,
      {
        first_detected_at: row.first_detected_at,
        last_detected_at: row.last_detected_at,
      },
    ]),
  );
}

describe('Property 5: reconciliation run determinism', () => {
  it('repeats the same ordered Exception set without duplicates and advances only last detection time', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryTenantDataset, async ({ dataset, shuffled }) => {
        const stores: Stores = {
          exceptions: memoryExceptionStore(),
          reconciliations: memoryReconStore(),
        };

        const first = await runAgent(dataset, stores, FIRST_RUN_AT, FIRST_RUN_ID);
        expect(first.incomplete).toBeNull();
        const firstRoute = await runMarketplaceAgent(dataset, stores, FIRST_RUN_AT);

        // The generator premise for the Route half, checked against the agent's own output:
        // one seller mismatch (Requirement 7.3) and one over-allocated split (7.7) always
        // fire, so the Route contribution to the tuple list is never empty.
        const routeCategories = firstRoute.exceptions.detections.map(
          (detection) => detection.exception.category,
        );
        expect(routeCategories).toContain('seller_settlement_mismatch');
        expect(routeCategories).toContain('over_allocated_split');
        expect(firstRoute.exceptions.not_reopened_count).toBe(0);
        // Requirement 7.8: a Linked_Account with no received Settlement is pending, never
        // mismatched, so no Exception cites one.
        const mismatchedAccounts = firstRoute.exceptions.detections
          .filter((detection) => detection.exception.category === 'seller_settlement_mismatch')
          .flatMap((detection) => detection.exception.source_refs.map((ref) => ref.id));
        for (const pending of dataset.route.pending_linked_account_ids) {
          expect(mismatchedAccounts).not.toContain(pending);
        }

        // The generator premise is checked against the agent output: two distinct
        // Exceptions always reach both impact and identifier tie-breaks.
        const tied = first.exceptions.detections.filter((detection) =>
          dataset.tied_settlement_ids.includes(detection.settlement_id),
        );
        expect(tied).toHaveLength(2);
        expect(tied[0]!.impact_paise).toBe(tied[1]!.impact_paise);
        expect(tied[0]!.settlement_date).toBe(tied[1]!.settlement_date);

        const firstTuples = orderedExceptionTuples(first, firstRoute, stores.exceptions);
        const countAfterFirst = stores.exceptions.rows.size;
        const reconCountAfterFirst = first.exceptions.detections.length;
        const routeCountAfterFirst = firstRoute.exceptions.detections.length;
        expect(countAfterFirst).toBe(reconCountAfterFirst + routeCountAfterFirst);
        const timesAfterFirst = detectionTimes(stores.exceptions);

        const second = await runAgent(shuffled, stores, SECOND_RUN_AT, SECOND_RUN_ID);
        expect(second.incomplete).toBeNull();
        const secondRoute = await runMarketplaceAgent(shuffled, stores, SECOND_RUN_AT);
        const secondTuples = orderedExceptionTuples(second, secondRoute, stores.exceptions);

        // P5's exact tuple oracle, in array order.
        expect(secondTuples).toEqual(firstTuples);
        expect(stores.exceptions.rows.size).toBe(countAfterFirst);
        expect(second.exceptions.created_count).toBe(0);
        expect(second.exceptions.updated_count).toBe(reconCountAfterFirst);
        // Requirement 7.10: the Marketplace_Agent's re-run updates in place too.
        expect(secondRoute.exceptions.created_count).toBe(0);
        expect(secondRoute.exceptions.updated_count).toBe(routeCountAfterFirst);

        for (const [fingerprint, row] of stores.exceptions.rows) {
          const before = timesAfterFirst.get(fingerprint);
          if (before === undefined) {
            throw new Error(`second run created unexpected Exception ${fingerprint}`);
          }
          expect(row.first_detected_at).toBe(before.first_detected_at);
          expect(row.last_detected_at).toBe(SECOND_RUN_AT);
          expect(Date.parse(row.last_detected_at)).toBeGreaterThan(
            Date.parse(before.last_detected_at),
          );
        }
      }),
      PARAMS,
    );
  });
});
