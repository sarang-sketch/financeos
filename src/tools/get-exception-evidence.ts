/**
 * `get_exception_evidence` (task 12.5). Requirements 12.2, 12.3 and 12.5.
 *
 * **Changed by task 12.7**: an Exception whose Evidence_Chain cannot be read is now
 * Requirement 12.3's `incomplete_evidence` — figure omitted, the Exception's own cited
 * Source_Record types named — rather than a thrown `ExceptionToolError` surfacing as
 * `tool_failure`. This tool composes no figure of its own; the impact it presents *is*
 * the persisted chain's figure, so an unreadable chain is an unreadable contributor and
 * the requirement applies literally. A chain that resolves and **disagrees** with the
 * stored impact still throws: that is corruption, not unavailability, and neither number
 * can be presented.
 *
 * A foreign or absent `exception_id` still throws, deliberately and unchanged: the two are
 * one path, so no answer distinguishes "another Tenant owns it" from "no such Exception".
 */
import {
  createEvidenceChainBuilder,
  incompleteEvidence,
  MAX_SOURCE_PAGE_SIZE,
  type EvidenceChainStore,
} from '@/evidence/chain-builder';
import { z } from 'zod';

import {
  envelopeFromExceptionEvidence,
  type ExceptionStore,
  ExceptionToolError,
  exceptionEvidencePage,
  exceptionEvidenceSchema,
  exceptionItemSummarySchema,
  itemSummary,
  unreadableRefsOf,
} from './exception-tools';
import { pageSchema } from './paging';
import { catalogued } from './registry';
import {
  type ErasedFinancialTool,
  type FinancialTool,
  TOOL_TIMEOUT_MS,
  type ToolContext,
  type ToolResult,
} from './tool';

export const GET_EXCEPTION_EVIDENCE = 'get_exception_evidence';

const inputSchema = z.strictObject({
  exception_id: z.uuid(),
  source_page: pageSchema(MAX_SOURCE_PAGE_SIZE),
});
export type GetExceptionEvidenceInput = z.infer<typeof inputSchema>;

const outputSchema = z.strictObject({
  exception: exceptionItemSummarySchema,
  evidence: exceptionEvidenceSchema,
});
export type GetExceptionEvidenceOutput = z.infer<typeof outputSchema>;

export interface GetExceptionEvidenceDeps {
  readonly exceptions: (ctx: ToolContext) => ExceptionStore;
  readonly chains: (ctx: ToolContext) => EvidenceChainStore;
}
export function createGetExceptionEvidence(
  deps: GetExceptionEvidenceDeps,
): FinancialTool<GetExceptionEvidenceInput, GetExceptionEvidenceOutput> {
  return {
    name: GET_EXCEPTION_EVIDENCE,
    mode: 'read_only',
    inputSchema,
    outputSchema,
    timeoutMs: TOOL_TIMEOUT_MS,

    async execute(ctx, input): Promise<ToolResult<GetExceptionEvidenceOutput>> {
      const found = await deps.exceptions(ctx).find(ctx.tenant_id, input.exception_id);
      // A foreign id and an absent id are deliberately one not-found path. No
      // permission error confirms that another Tenant owns the identifier.
      if (found === null || found.tenant_id !== ctx.tenant_id) {
        throw new ExceptionToolError(`Exception ${input.exception_id} was not found`);
      }
      if (ctx.signal.aborted) throw new ExceptionToolError(`${GET_EXCEPTION_EVIDENCE} was aborted`);

      const reader = createEvidenceChainBuilder({
        store: deps.chains(ctx),
        tenantId: ctx.tenant_id,
      });
      const evidence = await exceptionEvidencePage(reader, found.evidence_chain_id, input.source_page);
      if (evidence === null) {
        // Requirement 12.3. This tool composes no figure of its own: the impact it
        // presents *is* the persisted chain's figure, so a chain that does not resolve
        // is a contributing record it cannot read. The figure is omitted entirely and
        // the Exception's own cited Source_Record types are reported unavailable, which
        // is the answer an Agent can act on — a tool_failure said only that something
        // went wrong. Requirement 12.6 is satisfied either way: no figure escapes
        // behind an identifier that resolves to nothing.
        return incompleteEvidence(unreadableRefsOf(found));
      }
      if (evidence.figure_paise !== found.impact_paise) {
        throw new ExceptionToolError(
          `Exception ${input.exception_id} impact does not equal its persisted Evidence_Chain figure`,
        );
      }
      const exception = itemSummary(found, evidence.as_of);
      return {
        ok: true,
        value: { exception, evidence },
        // The same persisted chain. `sources` is this invocation's requested
        // retrievable page; source_count remains the full chain count.
        evidence: envelopeFromExceptionEvidence(evidence),
      };
    },
  };
}

export function catalogueEntryFor(deps: GetExceptionEvidenceDeps): ErasedFinancialTool {
  return catalogued(createGetExceptionEvidence(deps));
}
