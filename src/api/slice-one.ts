/** Thin, authenticated Slice 1 FinanceOS_API route handlers (task 15.1). */
import { z } from 'zod';

import type { ReconciliationAgent, ReconciliationRunRequest } from '@/agents/reconciliation/agent';
import type { Permission } from '@/authz/permissions';
import type { EvidenceChainBuilder, EvidenceSourcePage, EvidenceStep } from '@/evidence/chain-builder';
import { UI_SOURCE_PAGE_SIZE } from '@/evidence/chain-builder';
import type { IngestionService } from '@/ingestion/ingestion-service';
import { EXCEPTION_CATEGORIES, MAX_EXCEPTION_PAGE_SIZE } from '@/tools/exception-tools';
import type {
  GetControlTowerMetricsInput,
  GetControlTowerMetricsOutput,
} from '@/tools/get-control-tower-metrics';
import type {
  ListExceptionsByCategoryInput,
  ListExceptionsByCategoryOutput,
} from '@/tools/list-exceptions-by-category';
import { MAX_PAGE_OFFSET } from '@/tools/paging';
import type {
  FinancialTool,
  ToolInvoker,
  ToolResult,
} from '@/tools/tool';
import { toWire } from '@/wire/paise-wire';

import {
  AuthenticationRequiredError,
  type ApiSession,
  type SessionResolver,
} from './session';

export class ApiValidationError extends Error {
  override readonly name = 'ApiValidationError';
}

export class ApiPermissionDeniedError extends Error {
  override readonly name = 'ApiPermissionDeniedError';
  constructor(readonly required: Permission | readonly Permission[]) {
    super('Permission denied');
  }
}

export class ApiDependencyUnavailableError extends Error {
  override readonly name = 'ApiDependencyUnavailableError';
}

export interface ApiAuthorizationGate {
  require(session: ApiSession, required: Permission | readonly Permission[], action: string): Promise<void>;
}
export interface EvidenceChainPage {
  readonly evidence_chain_id: string;
  readonly figure_paise: bigint;
  readonly source_count: number;
  readonly as_of: string;
  readonly produced_by: string;
  readonly steps: readonly EvidenceStep[];
  readonly source_page: EvidenceSourcePage;
}

export interface SliceOneApiServices {
  startIngestion(session: ApiSession): Promise<unknown>;
  getControlTowerMetrics(session: ApiSession): Promise<ToolResult<GetControlTowerMetricsOutput>>;
  listExceptions(
    session: ApiSession,
    input: ListExceptionsByCategoryInput,
  ): Promise<ToolResult<ListExceptionsByCategoryOutput>>;
  getEvidenceChain(session: ApiSession, chainId: string, page: number): Promise<EvidenceChainPage | null>;
  runReconciliation(session: ApiSession, request: ReconciliationRunRequest): Promise<unknown>;
}

export interface SliceOneServiceBindings {
  readonly ingestion: IngestionService;
  readonly toolInvokerFor: (session: ApiSession) => ToolInvoker;
  readonly controlTowerMetrics: FinancialTool<GetControlTowerMetricsInput, GetControlTowerMetricsOutput>;
  readonly exceptionList: FinancialTool<ListExceptionsByCategoryInput, ListExceptionsByCategoryOutput>;
  readonly evidenceFor: (session: ApiSession) => EvidenceChainBuilder;
  readonly reconciliationFor: (session: ApiSession) => ReconciliationAgent;
}

/** Adapts the already-implemented services/tools; it performs no financial calculation. */
export function createSliceOneApiServices(bindings: SliceOneServiceBindings): SliceOneApiServices {
  return {
    startIngestion: (session) => bindings.ingestion.startRun(session.tenant_id, session.user_id),
    getControlTowerMetrics: (session) =>
      bindings.toolInvokerFor(session).invoke(bindings.controlTowerMetrics, session, {}),
    listExceptions: (session, input) =>
      bindings.toolInvokerFor(session).invoke(bindings.exceptionList, session, input),
    async getEvidenceChain(session, chainId, page) {
      const reader = bindings.evidenceFor(session);
      const view = await reader.read(chainId, UI_SOURCE_PAGE_SIZE);
      if (view === null) return null;
      let sourcePage: EvidenceSourcePage | undefined;
      if (page === 1) {
        sourcePage = view.first_page;
      } else {
        for await (const candidate of reader.sourcePages(chainId, UI_SOURCE_PAGE_SIZE)) {
          if (candidate.page_index === page) {
            sourcePage = candidate;
            break;
          }
        }
      }
      if (sourcePage === undefined) return null;
      return {
        evidence_chain_id: view.evidence_chain_id,
        figure_paise: view.figure_paise,
        source_count: view.source_count,
        as_of: view.as_of,
        produced_by: view.produced_by,
        steps: view.steps,
        source_page: sourcePage,
      };
    },
    runReconciliation: (session, request) => bindings.reconciliationFor(session).run(request),
  };
}
const emptyObjectSchema = z.strictObject({});
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sourceIdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const reconciliationRequestSchema = z
  .strictObject({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    settlement_ids: z.array(sourceIdentifierSchema).max(5_000).optional(),
  })
  .refine((value) => (value.from === undefined) === (value.to === undefined), {
    message: 'from and to must be supplied together',
  });

async function bodyOf(request: Request, schema: z.ZodType): Promise<unknown> {
  const text = await request.text();
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ApiValidationError('request body must be valid JSON');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ApiValidationError('request body does not match the route schema');
  return parsed.data;
}

function onlyQuery(url: URL, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!allowedSet.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ApiValidationError('query parameters do not match the route schema');
    }
  }
}

function pageNumber(url: URL, pageSize: number): number {
  const raw = url.searchParams.get('page');
  if (raw === null || !/^[1-9][0-9]*$/.test(raw)) {
    throw new ApiValidationError('page must be a positive whole number');
  }
  const page = Number(raw);
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(offset) || offset > MAX_PAGE_OFFSET) {
    throw new ApiValidationError('page is outside the supported range');
  }
  return page;
}

/**
 * Every `bigint` as a decimal string, recursively (Requirement 15.1, 15.8).
 *
 * Exported because `./internal-tools.ts` serialises the same `ToolResult<Out>`
 * envelope onto the same money wire contract. A second copy of this walk is the one
 * way a monetary field could reach a caller as a JSON number on one route and a
 * decimal string on the other.
 */
export function toJsonWire(value: unknown): unknown {
  if (typeof value === 'bigint') return toWire(value);
  if (Array.isArray(value)) return value.map(toJsonWire);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) out[key] = toJsonWire(member);
    }
    return out;
  }
  return value;
}

function json(value: unknown, status = 200): Response {
  return Response.json(toJsonWire(value), { status });
}

/**
 * The transport status for each `ToolResult` variant. Exported for the same reason
 * as {@link toJsonWire}: `./internal-tools.ts` returns the identical envelope, and
 * one variant mapping to two statuses depending on the route would make the Agent's
 * branch on `kind` disagree with its branch on the status line.
 */
export function toolResultStatus(result: ToolResult<unknown>): number {
  if (result.ok) return 200;
  switch (result.kind) {
    case 'schema_violation': return 400;
    case 'unauthorized_write': return 403;
    case 'incomplete_evidence': return 422;
    case 'tool_failure': return 503;
  }
}

function toolResponse<T>(result: ToolResult<T>): Response {
  return json(result, toolResultStatus(result));
}
export interface SliceOneRouteHandlers {
  postIngestionRun(request: Request): Promise<Response>;
  getControlTowerMetrics(request: Request): Promise<Response>;
  getExceptions(request: Request): Promise<Response>;
  getEvidenceChain(request: Request, chainId: string): Promise<Response>;
  postReconciliationRun(request: Request): Promise<Response>;
}

export interface SliceOneRouteDeps {
  readonly sessions: SessionResolver;
  readonly authorization: ApiAuthorizationGate;
  readonly services: SliceOneApiServices;
}

export function createSliceOneRouteHandlers(deps: SliceOneRouteDeps): SliceOneRouteHandlers {
  async function authenticated(
    request: Request,
    required: Permission | readonly Permission[],
    action: string,
    delegate: (session: ApiSession) => Promise<Response>,
  ): Promise<Response> {
    try {
      // Resolved once. The resulting Tenant scope is the only one passed downstream.
      const session = await deps.sessions.resolve(request);
      await deps.authorization.require(session, required, action);
      return await delegate(session);
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) {
        return json({ error: { code: 'authentication_required', message: 'Authentication required' } }, 401);
      }
      if (error instanceof ApiPermissionDeniedError) {
        return json({ error: { code: 'permission_denied', required: error.required } }, 403);
      }
      if (error instanceof ApiValidationError) {
        return json({ error: { code: 'invalid_request', message: error.message } }, 400);
      }
      if (error instanceof ApiDependencyUnavailableError) {
        return json({ error: { code: 'service_unavailable' } }, 503);
      }
      return json({ error: { code: 'internal_error' } }, 500);
    }
  }

  return {
    postIngestionRun(request) {
      return authenticated(request, ['manage_credentials', 'run_agents'], 'start_ingestion', async (session) => {
        await bodyOf(request, emptyObjectSchema);
        return json(await deps.services.startIngestion(session), 201);
      });
    },

    getControlTowerMetrics(request) {
      return authenticated(request, 'view_financial_data', 'view_control_tower_metrics', async (session) => {
        const url = new URL(request.url);
        onlyQuery(url, []);
        return toolResponse(await deps.services.getControlTowerMetrics(session));
      });
    },

    getExceptions(request) {
      return authenticated(request, 'view_financial_data', 'list_exceptions', async (session) => {
        const url = new URL(request.url);
        onlyQuery(url, ['category', 'page']);
        const page = pageNumber(url, MAX_EXCEPTION_PAGE_SIZE);
        const category = url.searchParams.get('category');
        if (category !== null && !(EXCEPTION_CATEGORIES as readonly string[]).includes(category)) {
          throw new ApiValidationError('category is not a supported Exception category');
        }
        const input: ListExceptionsByCategoryInput = {
          state: 'open',
          page: { offset: (page - 1) * MAX_EXCEPTION_PAGE_SIZE, limit: MAX_EXCEPTION_PAGE_SIZE },
          ...(category === null ? {} : { category: category as ListExceptionsByCategoryInput['category'] }),
        };
        return toolResponse(await deps.services.listExceptions(session, input));
      });
    },
    getEvidenceChain(request, chainId) {
      return authenticated(request, 'view_financial_data', 'view_evidence_chain', async (session) => {
        const url = new URL(request.url);
        onlyQuery(url, ['page']);
        if (!z.string().uuid().safeParse(chainId).success) {
          throw new ApiValidationError('evidence chain id must be a UUID');
        }
        const page = pageNumber(url, UI_SOURCE_PAGE_SIZE);
        const evidence = await deps.services.getEvidenceChain(session, chainId, page);
        // Foreign and absent identifiers deliberately share one response.
        return evidence === null
          ? json({ error: { code: 'not_found' } }, 404)
          : json(evidence);
      });
    },

    postReconciliationRun(request) {
      return authenticated(request, 'run_agents', 'run_reconciliation_agent', async (session) => {
        const parsed = await bodyOf(request, reconciliationRequestSchema);
        return json(
          await deps.services.runReconciliation(session, parsed as ReconciliationRunRequest),
          201,
        );
      });
    },
  };
}
