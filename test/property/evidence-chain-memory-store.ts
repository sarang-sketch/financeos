/**
 * An in-memory {@link EvidenceChainStore} for property P6 (task 9.3): the three
 * evidence tables, the JSONB round trip, the SQL grouping and the collated keyset
 * order, with no database.
 *
 * ## Why P6 runs against this and not against Supabase local
 *
 * design.md is explicit: "P3, P4, **P6**, P11 and P12 run in-process against the
 * pure functions", while P1, P2, P7, P13 and P14 run against Supabase local. Three
 * things make that the right call here rather than a shortcut:
 *
 *   1. **The invariant is not a database object.** P6 asserts that replaying an
 *      ordered step list reproduces a figure, and that the pages of a chain's
 *      source identifiers cover each identifier exactly once. The first is pure
 *      arithmetic over `evidence_chain_steps` rows. The second is a property of
 *      the keyset walk in `createEvidenceChainBuilder`, which is TypeScript.
 *   2. **The SQL half is already proven, at exactly the sizes that matter.**
 *      `test/db/evidence-chain.test.ts` (task 9.1) drives the real
 *      `listSourcePage` against a real transactional session at 499, 500, 501,
 *      1000 and 1001 identifiers, including the `C`-collation `ORDER BY` and the
 *      `after` comparison. P6 restating that against Postgres would buy a slower
 *      copy of a covered fact.
 *   3. **Cost.** `npm run test:property` already spends ~490 s (P1 151 s, P2
 *      206 s) and the project caps a file at 300 s. A `wide` P6 iteration writes
 *      up to 1000 citation rows; 100 of those over `docker exec psql` at ~106 ms
 *      a session is minutes, for no additional assurance.
 *
 * What this store therefore has to be faithful about is **order and grouping**,
 * because those are what the keyset walk depends on:
 *
 *   - One page row is one **distinct `(type, id)` identifier**, not one
 *     `evidence_chain_sources` row: the fields cited for an identifier are
 *     grouped, ascending, and `record_updated_at` is the maximum among them —
 *     the same `group by` the SQL adapter issues. This is what makes
 *     `source_count` (a count of identifiers) equal the number of rows across
 *     every page.
 *   - Rows are ordered by `source_record_type` then `source_record_id`, compared
 *     as text. JavaScript compares strings by UTF-16 code unit, which agrees with
 *     the `C` collation for the ASCII identifiers this system stores; both are
 *     byte-order comparisons over ASCII. A non-ASCII identifier could diverge,
 *     and no Razorpay identifier is non-ASCII.
 *   - `after` is exclusive and compared on the same composite key as the order,
 *     so the keyset and the sequence cannot disagree.
 *   - A step's `operands` come back as the **parsed** JSONB value, so every
 *     chain P6 replays has been through `JSON.stringify` and `JSON.parse` and is
 *     read back through `parseEvidenceOperands`. Money crosses as integer text,
 *     never as a JSON number.
 *
 * It also reproduces the one database CHECK that has a result shape:
 * `source_count >= 1` is reported as `ungrounded_figure` rather than thrown.
 *
 * ## Money
 *
 * Nothing here does arithmetic. `figure_paise` and `result_paise` arrive as the
 * integer strings `evidenceChainWriteFor` produced and are handed back unchanged,
 * so the decode is the builder's `fromWire`, not this module's.
 */

import { randomUUID } from 'node:crypto';

import type { TenantId } from '@/config/configuration-service';
import {
  type EvidenceChainHeaderRow,
  type EvidenceChainStepRow,
  type EvidenceChainStore,
  type EvidenceChainWrite,
  type EvidenceChainWriteOutcome,
  EVIDENCE_SOURCE_COUNT_CHECK,
  type EvidenceSourcePageQuery,
  type EvidenceSourceRow,
  type SourceRecordType,
} from '@/evidence/chain-builder';

/** `\u0000` cannot appear in a Postgres text value, so it is a safe key joiner. */
const SEP = '\u0000';

interface StoredChain {
  readonly tenant_id: TenantId;
  readonly header: EvidenceChainHeaderRow;
  readonly steps: readonly EvidenceChainStepRow[];
  readonly sources: readonly {
    readonly source_record_type: SourceRecordType;
    readonly source_record_id: string;
    readonly field: string;
    readonly record_updated_at: string;
  }[];
}

/** The store plus what a test wants to know about what it was asked to do. */
export interface MemoryEvidenceStore extends EvidenceChainStore {
  /** How many chains have been written. */
  readonly chainCount: number;
  /** How many `listSourcePage` calls the keyset walk made. */
  readonly pageQueries: number;
}

/**
 * A fresh, empty set of the three evidence tables.
 *
 * Not shared between iterations: a store carrying the previous iteration's rows
 * would make a page walk read identifiers the chain under test never cited.
 */
export function createMemoryEvidenceStore(): MemoryEvidenceStore {
  const chains = new Map<string, StoredChain>();
  let pageQueries = 0;

  const store: MemoryEvidenceStore = {
    get chainCount(): number {
      return chains.size;
    },
    get pageQueries(): number {
      return pageQueries;
    },

    insertChain(write: EvidenceChainWrite): Promise<EvidenceChainWriteOutcome> {
      if (write.source_count < 1) {
        // The `evidence_chains_source_count_check` CHECK, as a value.
        return Promise.resolve({
          ok: false as const,
          kind: 'ungrounded_figure' as const,
          constraint: EVIDENCE_SOURCE_COUNT_CHECK,
        });
      }
      const chainId = randomUUID();
      chains.set(chainId, {
        tenant_id: write.tenant_id,
        header: {
          chain_id: chainId,
          figure_paise: write.figure_paise,
          source_count: write.source_count,
          as_of: write.as_of,
          produced_by: write.produced_by,
        },
        // The JSONB round trip: text in, parsed value out. Nothing may assume the
        // operand objects came back with their keys in the order they went in.
        steps: write.steps.map((step) => ({
          step_index: step.step_index,
          operation: step.operation,
          operands: JSON.parse(step.operands_json) as unknown,
          result_paise: step.result_paise,
          note: step.note,
        })),
        sources: write.sources.map((source) => ({
          source_record_type: source.source_record_type,
          source_record_id: source.source_record_id,
          field: source.field,
          record_updated_at: source.record_updated_at,
        })),
      });
      return Promise.resolve({ ok: true as const, chain_id: chainId });
    },

    findChain(tenantId: TenantId, chainId: string): Promise<EvidenceChainHeaderRow | null> {
      const chain = chains.get(chainId);
      // Another Tenant's chain and an absent chain are the same answer.
      return Promise.resolve(
        chain === undefined || chain.tenant_id !== tenantId ? null : chain.header,
      );
    },

    listSteps(tenantId: TenantId, chainId: string): Promise<readonly EvidenceChainStepRow[]> {
      const chain = chains.get(chainId);
      // Qualified through the header, because `evidence_chain_steps` carries no
      // `tenant_id` of its own (migration FINDING 1).
      if (chain === undefined || chain.tenant_id !== tenantId) {
        return Promise.resolve([]);
      }
      // Deliberately not pre-sorted: the builder orders by `step_index` itself,
      // and a store that handed them back sorted would hide it if it stopped.
      return Promise.resolve([...chain.steps].reverse());
    },

    listSourcePage(query: EvidenceSourcePageQuery): Promise<readonly EvidenceSourceRow[]> {
      pageQueries += 1;
      const chain = chains.get(query.chain_id);
      if (chain === undefined || chain.tenant_id !== query.tenant_id) {
        return Promise.resolve([]);
      }

      // `group by (source_record_type, source_record_id)`: fields ascending,
      // `record_updated_at` the maximum among the grouped citations.
      const grouped = new Map<string, { row: EvidenceSourceRow; fields: string[] }>();
      for (const source of chain.sources) {
        const key = `${source.source_record_type}${SEP}${source.source_record_id}`;
        const existing = grouped.get(key);
        if (existing === undefined) {
          grouped.set(key, {
            fields: [source.field],
            row: {
              source_record_type: source.source_record_type,
              source_record_id: source.source_record_id,
              fields: [source.field],
              record_updated_at: source.record_updated_at,
            },
          });
          continue;
        }
        existing.fields.push(source.field);
        existing.row = {
          ...existing.row,
          record_updated_at:
            source.record_updated_at > existing.row.record_updated_at
              ? source.record_updated_at
              : existing.row.record_updated_at,
        };
      }

      const rows: EvidenceSourceRow[] = [...grouped.entries()]
        // The total order over the identity key: `type`, then `id`, as text. The
        // composite key already encodes both, separated by a byte no text value
        // can contain, so one comparison orders both levels.
        .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
        .map(([, entry]) => ({ ...entry.row, fields: [...entry.fields].sort() }));

      const after = query.after;
      const remaining =
        after === null
          ? rows
          : rows.filter(
              (row) =>
                `${row.source_record_type}${SEP}${row.source_record_id}` >
                `${after.type}${SEP}${after.id}`,
            );
      return Promise.resolve(remaining.slice(0, query.limit));
    },
  };

  return store;
}
