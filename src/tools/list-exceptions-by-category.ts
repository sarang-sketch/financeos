/**
 * `list_exceptions_by_category` (task 12.5). Requirements 3.5, 3.6, 12.2, 12.3.
 *
 * **Changed by task 12.7**: a contributing Exception whose Evidence_Chain cannot be read
 * now yields `incomplete_evidence` naming that Exception's cited Source_Record types,
 * rather than throwing. The aggregate spans the whole filtered set, so one unreadable
 * contributor withholds the whole figure — summing the readable remainder would present a
 * partial total as a complete one. See `./exception-tools.ts`.
 */
import { sum } from '@/calc/calculation-service';
import { createEvidenceChainBuilder, type EvidenceChainStore } from '@/evidence/chain-builder';
import { z } from 'zod';

import {
  aggregateExceptionChainInput,
  EXCEPTION_CATEGORIES,
  EXCEPTION_STATES,
  type ExceptionCategorySummary,
  type ExceptionStore,
  type ExceptionSummary,
  exceptionSummarySchema,
  exceptionsInOrder,
  itemSummary,
  MAX_EXCEPTION_PAGE_SIZE,
} from './exception-tools';
import { type Page, pageOf, pageSchema } from './paging';
import { catalogued } from './registry';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const LIST_EXCEPTIONS_BY_CATEGORY = 'list_exceptions_by_category';

const inputSchema = z.strictObject({
  category: z.enum(EXCEPTION_CATEGORIES).optional(),
  state: z.enum(EXCEPTION_STATES),
  page: pageSchema(MAX_EXCEPTION_PAGE_SIZE),
});
export type ListExceptionsByCategoryInput = z.infer<typeof inputSchema>;

const outputSchema = z.strictObject({
  rows: z.array(exceptionSummarySchema).max(MAX_EXCEPTION_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  aggregate_impact_paise: z.bigint().nonnegative(),
});
export type ListExceptionsByCategoryOutput = z.infer<typeof outputSchema>;

export interface ListExceptionsByCategoryDeps {
  readonly exceptions: (ctx: ToolContext) => ExceptionStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}
interface CategoryGroup {
  readonly category: (typeof EXCEPTION_CATEGORIES)[number];
  readonly rows: ReturnType<typeof exceptionsInOrder>;
  readonly impact_paise: bigint;
}

/** Requirement 3.5 order: aggregate impact descending, category label ascending. */
export function categoryGroupsInOrder(
  rows: readonly Parameters<typeof exceptionsInOrder>[0][number][],
): readonly CategoryGroup[] {
  const grouped = new Map<(typeof EXCEPTION_CATEGORIES)[number], Parameters<typeof exceptionsInOrder>[0][number][]>();
  for (const row of rows) {
    const group = grouped.get(row.category) ?? [];
    group.push(row);
    grouped.set(row.category, group);
  }
  return [...grouped.entries()]
    .map(([category, members]) => ({
      category,
      rows: exceptionsInOrder(members),
      impact_paise: sum(members.map((member) => member.impact_paise)),
    }))
    .sort((left, right) => {
      if (left.impact_paise !== right.impact_paise) {
        return left.impact_paise > right.impact_paise ? -1 : 1;
      }
      return left.category < right.category ? -1 : left.category > right.category ? 1 : 0;
    });
}

export function createListExceptionsByCategory(
  deps: ListExceptionsByCategoryDeps,
): FinancialTool<ListExceptionsByCategoryInput, ListExceptionsByCategoryOutput> {
  return {
    name: LIST_EXCEPTIONS_BY_CATEGORY,
    mode: 'read_only',
    inputSchema,
    outputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,

    async execute(ctx, input): Promise<ToolResult<ListExceptionsByCategoryOutput>> {
      const read = await deps.exceptions(ctx).list({
        tenant_id: ctx.tenant_id,
        category: input.category ?? null,
        state: input.state,
      });
      // Defence in depth over the store/RLS contract. Foreign rows become zero rows,
      // never a permission-shaped response.
      const filtered = read.filter(
        (row) =>
          row.tenant_id === ctx.tenant_id &&
          row.state === input.state &&
          (input.category === undefined || row.category === input.category),
      );
      const ordered = exceptionsInOrder(filtered);
      const aggregateImpact = sum(ordered.map((row) => row.impact_paise));
      const reader = createEvidenceChainBuilder({ store: deps.chains(ctx), tenantId: ctx.tenant_id });
      const aggregate = await aggregateExceptionChainInput(
        LIST_EXCEPTIONS_BY_CATEGORY,
        ordered,
        reader,
      );
      // Requirement 12.3: a contributing Exception whose Evidence_Chain cannot be read
      // withholds the whole aggregate rather than summing the readable remainder.
      if (!aggregate.ok) return aggregate;
      if (ctx.signal.aborted) throw new Error(`${LIST_EXCEPTIONS_BY_CATEGORY} was aborted`);
      const aggregateBuilt = await reader.build(aggregate.input);
      if (!aggregateBuilt.ok) return aggregateBuilt;

      let rows: readonly ExceptionSummary[];
      let total: number;
      if (input.category !== undefined) {
        const paged = pageOf(ordered, input.page as Page<50>);
        rows = paged.rows.map((row) => {
          const asOf = aggregate.asOfByException.get(row.exception_id);
          if (asOf === undefined) throw new Error(`no Evidence_Chain as-of for ${row.exception_id}`);
          return itemSummary(row, asOf);
        });
        total = paged.total;
      } else {
        // Reconciliation of the task prose with the fixed contract: absent category
        // means category rollups for the requested state. Under state=open,
        // exception_count is exactly Requirement 3.5's open count. Closed-state
        // callers get the same lifecycle-scoped rollup rather than a silently ignored
        // `state` argument.
        const summaries: ExceptionCategorySummary[] = [];
        for (const group of categoryGroupsInOrder(ordered)) {
          const categoryAggregate = await aggregateExceptionChainInput(
            LIST_EXCEPTIONS_BY_CATEGORY,
            group.rows,
            reader,
          );
          if (!categoryAggregate.ok) return categoryAggregate;
          if (ctx.signal.aborted) throw new Error(`${LIST_EXCEPTIONS_BY_CATEGORY} was aborted`);
          const built = await reader.build(categoryAggregate.input);
          if (!built.ok) return built;
          summaries.push({
            kind: 'category',
            category: group.category,
            state: input.state,
            exception_count: group.rows.length,
            impact_paise: group.impact_paise,
            evidence_chain_id: built.evidence.evidence_chain_id,
            evidence_as_of: built.evidence.as_of,
          });
        }
        const paged = pageOf(summaries, input.page as Page<50>);
        rows = paged.rows;
        total = paged.total;
      }

      return {
        ok: true,
        value: { rows: [...rows], total, aggregate_impact_paise: aggregateImpact },
        evidence: aggregateBuilt.evidence,
      };
    },
  };
}

export function catalogueEntryFor(deps: ListExceptionsByCategoryDeps): ErasedFinancialTool {
  return catalogued(createListExceptionsByCategory(deps));
}
