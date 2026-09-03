/**
 * A specimen read-only Financial_Tool, and its P6 probe.
 *
 * ## Why this file exists
 *
 * Property P6's second half iterates every `read_only` tool in the catalogue and
 * asserts the replay and pagination clauses on each chain it returns. **The
 * catalogue is empty today** — the 17 read-only tools are tasks 12.1 through
 * 12.6 — so that half would be a loop over nothing: code that has never run,
 * committed green, and first exercised at the moment someone is trying to land a
 * tool.
 *
 * This specimen makes the loop run now. It is a genuine `FinancialTool`: it
 * passes `createToolRegistry`'s registration audit unmodified (strict object
 * schema, pattern-bounded argument, `snake_case` name, the fixed 10-second
 * bound), it composes its Evidence_Chain through `@/evidence/chain-builder`, and
 * it returns a real `ToolSuccess` carrying that chain. So the path P6 exercises —
 * discovery → registration audit → invocation → replay → page walk — is the same
 * path task 12.1's `get_settlement_reconciliation` will take.
 *
 * It is **not** a production tool and is not in `src/`: it reads no database, it
 * answers no question a User would ask, and `PRODUCTION_ROOTS` does not scan this
 * directory. Deleting it once a real read-only tool exists is the intended end
 * state, and P6 says so in its own comment.
 *
 * ## How a generated dataset reaches it, and what that models
 *
 * A tool reads Tenant data through `ctx.db`, which is a Supabase client bound by
 * RLS. There is no way to point one at a generated in-memory dataset, and
 * design.md states no seam for doing so — the gap `tool-catalogue.ts` reports.
 * The specimen therefore takes a `dataset_key`, a pattern-bounded argument, and
 * resolves it through {@link registerDataset}: the argument names the data, the
 * tool reads it, and the value never travels in the argument. That keeps the
 * shape of the real thing (arguments are bounded identifiers; data comes from the
 * session's Tenant, not from the caller) without pretending to be a database.
 *
 * `ctx.db` is a stub that would throw if touched, which is the point: a
 * `read_only` tool that performs no write is being modelled, and this one
 * performs no read through the client either, so a stray query would fail loudly
 * rather than silently reach a real connection.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { createEvidenceChainBuilder, type EvidenceChain } from '@/evidence/chain-builder';
import { type FinancialTool, type ToolContext, type ToolResult, TOOL_TIMEOUT_MS } from '@/tools/tool';

import { buildChain, type EvidenceTenantDataset } from '../evidence-chain-generators';
import { createMemoryEvidenceStore } from '../evidence-chain-memory-store';
import type { P6ToolProbe, ProbedFigure } from '../tool-catalogue';

/** The Tenant the specimen answers for. A UUID, as the builder requires. */
const SPECIMEN_TENANT = '22222222-2222-4222-8222-222222222222';

/* -------------------------------------------------------------------------- */
/* The data seam                                                              */
/* -------------------------------------------------------------------------- */

const datasets = new Map<string, EvidenceTenantDataset>();

/** `dataset_key` values are bounded, so the argument cannot carry free-form text. */
const DATASET_KEY = /^ds_[0-9a-f]{8}$/;

/**
 * Make a dataset readable under a fresh key, and return the key.
 *
 * The registration is dropped by {@link releaseDataset} after the invocation, so
 * one iteration's data cannot answer the next iteration's question.
 */
export function registerDataset(dataset: EvidenceTenantDataset): string {
  const key = `ds_${randomUUID().slice(0, 8)}`;
  datasets.set(key, dataset);
  return key;
}

export function releaseDataset(key: string): void {
  datasets.delete(key);
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

const inputSchema = z.strictObject({
  dataset_key: z.string().regex(DATASET_KEY),
});

/** Money leaves as a decimal string, never as a JSON number (Requirement 15.8). */
const outputSchema = z.strictObject({
  figure_paise: z.string().regex(/^-?[0-9]+$/),
  source_count: z.number().int(),
});

type SpecimenInput = z.infer<typeof inputSchema>;
type SpecimenOutput = z.infer<typeof outputSchema>;

/**
 * Sums one monetary field of every Source_Record in the dataset and returns the
 * total with its Evidence_Chain.
 *
 * The chain comes from {@link buildChain} with no extra steps — a single `sum`
 * over every cited identifier — so the specimen states one arithmetic operation
 * per step (Requirement 12.2) and cites every record it read.
 */
export const specimenReadOnlyTool: FinancialTool<SpecimenInput, SpecimenOutput> = {
  name: 'get_specimen_evidence_figure',
  mode: 'read_only',
  inputSchema,
  outputSchema,
  timeoutMs: TOOL_TIMEOUT_MS,
  async execute(_ctx: ToolContext, input: SpecimenInput): Promise<ToolResult<SpecimenOutput>> {
    const dataset = datasets.get(input.dataset_key);
    if (dataset === undefined) {
      // Modelled as unreadable Source_Records: Requirement 12.3 omits the figure
      // rather than returning a zero.
      return {
        ok: false,
        kind: 'incomplete_evidence',
        unavailable: [{ type: 'payment', count: 1 }],
      };
    }

    const builder = createEvidenceChainBuilder({
      store: createMemoryEvidenceStore(),
      tenantId: SPECIMEN_TENANT,
    });
    const result = await builder.build(buildChain(dataset, []));
    if (!result.ok) {
      return result;
    }
    const evidence: EvidenceChain = result.evidence;
    return {
      ok: true,
      value: {
        figure_paise: evidence.figure_paise.toString(),
        source_count: evidence.source_count,
      },
      evidence,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* The P6 probe                                                               */
/* -------------------------------------------------------------------------- */

/** A `ToolContext` whose client throws if a read is attempted. See the module doc. */
function contextThatCannotQuery(): ToolContext {
  const db = new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `the specimen tool reached ctx.db.${String(property)}; it models a tool that reads ` +
            `only the dataset it was pointed at`,
        );
      },
    },
  );
  return {
    tenant_id: SPECIMEN_TENANT,
    user_id: 'usr_p6_specimen',
    permissions: ['view_financial_data'],
    db: db as ToolContext['db'],
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  };
}

/**
 * P6's seam for this tool: invoke it over the dataset and hand back the figure it
 * presented, its chain, and the records the chain cites.
 *
 * The records come from the dataset itself rather than from the chain, which is
 * the honest direction: `evidence_chain_sources` stores no values, so a replay
 * has to be given the Source_Records — and the ones it is given are the ones the
 * tool read, not a set reconstructed to make the arithmetic work.
 */
export const specimenP6Probe: P6ToolProbe = {
  tool: specimenReadOnlyTool.name,
  async figuresFor(dataset: EvidenceTenantDataset): Promise<readonly ProbedFigure[]> {
    const key = registerDataset(dataset);
    try {
      const result = await specimenReadOnlyTool.execute(contextThatCannotQuery(), {
        dataset_key: key,
      });
      if (!result.ok) {
        // `incomplete_evidence` is a legitimate outcome with no figure to replay.
        return [];
      }
      return [
        {
          label: `${specimenReadOnlyTool.name}.figure_paise`,
          evidence: result.evidence,
          records: dataset.records.map((record) => ({
            ref: record.ref,
            fields: record.fields,
          })),
          citations: dataset.records.flatMap((record) =>
            Object.keys(record.fields)
              .slice(0, 1)
              .map((field) => ({
                ref: record.ref,
                field,
                record_updated_at: record.record_updated_at,
              })),
          ),
        },
      ];
    } finally {
      releaseDataset(key);
    }
  },
};
