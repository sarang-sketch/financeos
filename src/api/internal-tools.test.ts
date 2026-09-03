import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { NarrowAuditSink, NarrowAuditSinkEvent } from '@/audit/audit-service';
import type { PlatformLog } from '@/authz/rejection-audit';
import { Secret } from '@/config/env';
import { catalogued, createToolRegistry } from '@/tools/registry';
import type { ErasedFinancialTool, ToolResult, ToolSession } from '@/tools/tool';
import { TOOL_TIMEOUT_MS } from '@/tools/tool';

import {
  BROWSER_ORIGIN_HEADERS,
  createInternalToolRouteHandler,
  createServiceCredentialVerifier,
  findSessionOnlyKeys,
  FORWARDED_USER_SESSION_HEADER,
  INTERNAL_TOOL_REJECTED,
  InternalToolEndpointError,
  MIN_SERVICE_CREDENTIAL_LENGTH,
  permissionForToolMode,
  SERVICE_CREDENTIAL_HEADER,
  type InternalToolInvocation,
  type InternalToolRouteDeps,
} from './internal-tools';
import { AuthenticationRequiredError, type ApiSession } from './session';
import { ApiPermissionDeniedError } from './slice-one';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CHAIN = '33333333-3333-4333-8333-333333333333';
const SERVICE_CREDENTIAL = 'service-credential-of-the-agent-runtime-0001';
const USER_TOKEN = 'forwarded-user-access-token';

const session: ApiSession = Object.freeze({
  access_token: USER_TOKEN,
  tenant_id: TENANT,
  user_id: USER,
  permissions: ['view_financial_data'] as const,
});

/** A read-only fixture tool. Its schema is `.strict()`, so the registry accepts it. */
const readTool: ErasedFinancialTool = catalogued({
  name: 'get_fixture_figure',
  mode: 'read_only',
  inputSchema: z.strictObject({ as_of: z.iso.date() }),
  outputSchema: z.strictObject({ total_paise: z.bigint() }),
  timeoutMs: TOOL_TIMEOUT_MS,
  execute: async () => {
    throw new Error('the fixture tool is never executed: the invocation seam is stubbed');
  },
});

const writeTool: ErasedFinancialTool = catalogued({
  name: 'post_fixture_adjustment',
  mode: 'write_capable',
  inputSchema: z.strictObject({ entry_date: z.iso.date() }),
  outputSchema: z.strictObject({ set_id: z.uuid() }),
  timeoutMs: TOOL_TIMEOUT_MS,
  execute: async () => {
    throw new Error('the fixture tool is never executed: the invocation seam is stubbed');
  },
});

const registry = createToolRegistry([readTool, writeTool]);

const success: ToolResult<{ total_paise: bigint }> = {
  ok: true,
  value: { total_paise: 90_071_992_547_409n },
  evidence: {
    evidence_chain_id: CHAIN,
    figure_paise: 99_999_999_999_999n,
    sources: [{ type: 'payment', id: 'pay_FIXTURE0001' }],
    source_count: 1,
    steps: [
      {
        index: 1,
        operation: 'sum',
        operands: [{ kind: 'source', ref: { type: 'payment', id: 'pay_FIXTURE0001' }, field: 'amount_paise' }],
        result_paise: 99_999_999_999_999n,
      },
    ],
    as_of: '2026-01-01T00:00:00.000Z',
    produced_by: 'get_fixture_figure',
  },
};

interface Harness {
  readonly handler: ReturnType<typeof createInternalToolRouteHandler>;
  readonly appended: NarrowAuditSinkEvent[];
  readonly logged: Readonly<Record<string, string>>[];
  readonly invoked: { tool: string; session: ToolSession; rawInput: unknown }[];
  /** Every session resolution attempt, so a rejected caller can be proven not to cause one. */
  readonly resolutions: { count: number };
  readonly lookups: string[];
}

function harness(
  overrides: {
    readonly resolve?: () => Promise<ApiSession>;
    readonly require?: () => Promise<void>;
    readonly result?: ToolResult<unknown>;
    readonly credential?: string;
  } = {},
): Harness {
  const appended: NarrowAuditSinkEvent[] = [];
  const logged: Readonly<Record<string, string>>[] = [];
  const invoked: { tool: string; session: ToolSession; rawInput: unknown }[] = [];
  const resolutions = { count: 0 };
  const lookups: string[] = [];

  const audit: NarrowAuditSink = {
    async append(event) {
      appended.push(event);
    },
  };
  const platformLog: PlatformLog = {
    record(entry) {
      logged.push(entry);
    },
  };
  const invocation: InternalToolInvocation = {
    async invoke(tool, toolSession, rawInput) {
      invoked.push({ tool: tool.name, session: toolSession, rawInput });
      return overrides.result ?? (success as ToolResult<unknown>);
    },
  };

  const deps: InternalToolRouteDeps = {
    registry: {
      get(name) {
        lookups.push(name);
        return registry.get(name);
      },
      has: (name) => registry.has(name),
      list: () => registry.list(),
      byMode: (mode) => registry.byMode(mode),
      names: () => registry.names(),
    },
    serviceCredential: createServiceCredentialVerifier(
      new Secret('INTERNAL_TOOL_SERVICE_CREDENTIAL', overrides.credential ?? SERVICE_CREDENTIAL),
    ),
    forwardedSessions: {
      resolve: async () => {
        resolutions.count += 1;
        return overrides.resolve === undefined ? session : overrides.resolve();
      },
    },
    authorization: {
      require: overrides.require ?? (async () => undefined),
    },
    invocations: () => invocation,
    audit,
    platformLog,
    now: () => new Date('2026-02-01T00:00:00.000Z'),
  };

  return {
    handler: createInternalToolRouteHandler(deps),
    appended,
    logged,
    invoked,
    resolutions,
    lookups,
  };
}

function request(
  headers: Readonly<Record<string, string>>,
  body: unknown = { as_of: '2026-01-01' },
): Request {
  return new Request('https://financeos.internal/internal/tools/get_fixture_figure', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const serviceHeaders: Readonly<Record<string, string>> = {
  [SERVICE_CREDENTIAL_HEADER]: SERVICE_CREDENTIAL,
  [FORWARDED_USER_SESSION_HEADER]: `Bearer ${USER_TOKEN}`,
};

describe('POST /internal/tools/{tool_name} — the service credential', () => {
  it('refuses a request carrying no service credential, reading no session and no body', async () => {
    const h = harness();
    const req = request({ [FORWARDED_USER_SESSION_HEADER]: `Bearer ${USER_TOKEN}` });

    const response = await h.handler.postTool(req, 'get_fixture_figure');
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'service_credential_required', message: 'Service credential required' },
    });
    // No Tenant, no user, no credential, and no hint of which check refused it.
    expect(text).not.toContain(TENANT);
    expect(text).not.toContain(USER);
    expect(text).not.toContain(USER_TOKEN);
    expect(text).not.toContain('missing');
    // Nothing downstream ran: no session verification, no catalogue lookup, no tool.
    expect([h.resolutions.count, h.lookups.length, h.invoked.length]).toEqual([0, 0, 0]);
    expect(req.bodyUsed).toBe(false);
    // No attributable Tenant, so it is logged without Tenant data rather than appended.
    expect(h.appended).toEqual([]);
    expect(h.logged).toEqual([
      {
        event: INTERNAL_TOOL_REJECTED,
        endpoint: '/internal/tools/{tool_name}',
        reason: 'service_credential_missing',
        occurred_at: '2026-02-01T00:00:00.000Z',
        recorded: 'false',
        why: 'no_attributable_tenant',
      },
    ]);
  });

  it('refuses a leaked user session presented as the endpoint credential', async () => {
    const h = harness();
    const req = request({ authorization: `Bearer ${USER_TOKEN}` });

    const response = await h.handler.postTool(req, 'get_fixture_figure');

    expect(response.status).toBe(401);
    expect(h.logged[0]?.['reason']).toBe('user_session_presented');
    expect([h.resolutions.count, h.invoked.length]).toEqual([0, 0]);
    expect(req.bodyUsed).toBe(false);
  });

  it('refuses a wrong service credential without disclosing that it was merely wrong', async () => {
    const h = harness();
    const wrong = `${SERVICE_CREDENTIAL}-but-not-quite-the-configured-one`;

    const response = await h.handler.postTool(
      request({ ...serviceHeaders, [SERVICE_CREDENTIAL_HEADER]: wrong }),
      'get_fixture_figure',
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'service_credential_required', message: 'Service credential required' },
    });
    expect(h.logged[0]?.['reason']).toBe('service_credential_invalid');
    expect(h.invoked).toEqual([]);
  });

  it.each(BROWSER_ORIGIN_HEADERS)('refuses a browser-originated request carrying %s', async (header) => {
    const h = harness();

    const response = await h.handler.postTool(
      request({ ...serviceHeaders, [header]: 'same-origin' }),
      'get_fixture_figure',
    );

    expect(response.status).toBe(401);
    expect(h.logged[0]?.['reason']).toBe('browser_originated');
    expect([h.resolutions.count, h.invoked.length]).toEqual([0, 0]);
  });

  it('refuses to be constructed with a credential below the length floor', () => {
    expect(() =>
      createServiceCredentialVerifier(new Secret('INTERNAL_TOOL_SERVICE_CREDENTIAL', 'short')),
    ).toThrow(InternalToolEndpointError);
    expect(() =>
      createServiceCredentialVerifier(
        new Secret('INTERNAL_TOOL_SERVICE_CREDENTIAL', 'x'.repeat(MIN_SERVICE_CREDENTIAL_LENGTH)),
      ),
    ).not.toThrow();
  });

  it('authorizes nothing on its own: a valid credential with no forwarded session is refused', async () => {
    const h = harness({
      resolve: () => Promise.reject(new AuthenticationRequiredError()),
    });
    const req = request({ [SERVICE_CREDENTIAL_HEADER]: SERVICE_CREDENTIAL });

    const response = await h.handler.postTool(req, 'get_fixture_figure');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: 'authentication_required', message: 'Authentication required' },
    });
    expect(h.logged[0]?.['reason']).toBe('forwarded_user_session_invalid');
    expect([h.lookups.length, h.invoked.length]).toEqual([0, 0]);
    expect(req.bodyUsed).toBe(false);
  });
});

describe('POST /internal/tools/{tool_name} — authorization is additive', () => {
  it('refuses an invocation whose forwarded user context lacks the tool Permission', async () => {
    const h = harness({
      require: () => Promise.reject(new ApiPermissionDeniedError('view_financial_data')),
    });
    const req = request(serviceHeaders);

    const response = await h.handler.postTool(req, 'get_fixture_figure');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: 'permission_denied', required: 'view_financial_data' },
    });
    expect(h.invoked).toEqual([]);
    // Both auth checks completed before anything read the body (design.md).
    expect(req.bodyUsed).toBe(false);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]).toMatchObject({
      tenantId: TENANT,
      eventType: INTERNAL_TOOL_REJECTED,
      actor: { kind: 'agent', id: 'agent_runtime' },
      outcome: 'blocked',
      sourceRefs: [],
      occurredAt: '2026-02-01T00:00:00.000Z',
    });
    expect(h.appended[0]?.payload).toEqual({
      endpoint: '/internal/tools/{tool_name}',
      reason: 'missing_required_permission',
      forwarded_user_id: USER,
      tool: 'get_fixture_figure',
      mode: 'read_only',
      required_permission: 'view_financial_data',
    });
  });

  it('states which Permission each declared mode requires', () => {
    expect(permissionForToolMode('read_only')).toBe('view_financial_data');
    expect(permissionForToolMode('write_capable')).toBe('run_agents');
  });

  it('checks the Permission the invoked tool requires, not a fixed one', async () => {
    const required: string[] = [];
    const recording = createInternalToolRouteHandler({
      registry,
      serviceCredential: createServiceCredentialVerifier(
        new Secret('INTERNAL_TOOL_SERVICE_CREDENTIAL', SERVICE_CREDENTIAL),
      ),
      forwardedSessions: { resolve: async () => session },
      authorization: {
        require: async (_session, requiredPermission) => {
          required.push(String(requiredPermission));
        },
      },
      invocations: () => ({
        invoke: async () => success as ToolResult<unknown>,
      }),
      audit: { append: async () => undefined },
      platformLog: { record: () => undefined },
    });

    await recording.postTool(request(serviceHeaders), 'get_fixture_figure');
    await recording.postTool(
      request(serviceHeaders, { entry_date: '2026-01-01' }),
      'post_fixture_adjustment',
    );

    expect(required).toEqual(['view_financial_data', 'run_agents']);
  });
});

describe('POST /internal/tools/{tool_name} — the tool name', () => {
  it('answers a schema violation rather than a 404 for an unknown name', async () => {
    const h = harness();

    const response = await h.handler.postTool(request(serviceHeaders), 'get_fixture_figures');
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      kind: 'schema_violation',
      violations: [{ argument: 'tool_name', reason: expect.stringContaining('catalogue') }],
    });
    expect(h.invoked).toEqual([]);
    expect(h.appended).toHaveLength(1);
    expect(h.appended[0]?.payload).toEqual({
      endpoint: '/internal/tools/{tool_name}',
      reason: 'unknown_tool_name',
      forwarded_user_id: USER,
      tool: 'get_fixture_figures',
    });
  });

  it('records a malformed name without echoing it into the Audit_Log', async () => {
    const h = harness();
    const injected = "'; DROP TABLE ledger_entries; --";

    const response = await h.handler.postTool(request(serviceHeaders), injected);

    expect(response.status).toBe(400);
    expect(h.appended[0]?.payload).toEqual({
      endpoint: '/internal/tools/{tool_name}',
      reason: 'unknown_tool_name',
      forwarded_user_id: USER,
      tool_name_malformed: true,
    });
    expect(JSON.stringify(h.appended[0]?.payload)).not.toContain('DROP TABLE');
  });
});

describe('POST /internal/tools/{tool_name} — a body tenant_id is rejected, not ignored', () => {
  it('rejects a top-level tenant_id and names it', async () => {
    const h = harness();

    const response = await h.handler.postTool(
      request(serviceHeaders, { as_of: '2026-01-01', tenant_id: TENANT }),
      'get_fixture_figure',
    );
    const body = (await response.json()) as { violations: { argument: string; reason: string }[] };

    expect(response.status).toBe(400);
    expect(body.violations.map((violation) => violation.argument)).toEqual(['tenant_id']);
    expect(body.violations[0]?.reason).toContain('rejected rather than ignored');
    // Rejected before the tool layer, so no connection was ever asked for.
    expect(h.invoked).toEqual([]);
    expect(h.appended[0]?.payload).toEqual({
      endpoint: '/internal/tools/{tool_name}',
      reason: 'body_tenant_id',
      forwarded_user_id: USER,
      tool: 'get_fixture_figure',
      arguments: ['tenant_id'],
    });
  });

  it('rejects a tenant_id nested anywhere in the body', async () => {
    const h = harness();

    const response = await h.handler.postTool(
      request(serviceHeaders, {
        as_of: '2026-01-01',
        entries: [{ account_code: 'cash', scope: { tenant_id: TENANT } }],
      }),
      'get_fixture_figure',
    );
    const body = (await response.json()) as { violations: { argument: string }[] };

    expect(response.status).toBe(400);
    expect(body.violations.map((violation) => violation.argument)).toEqual([
      'entries[0].scope.tenant_id',
    ]);
    expect(h.invoked).toEqual([]);
  });

  it('records the offending paths and never the rejected value', async () => {
    const h = harness();

    await h.handler.postTool(
      request(serviceHeaders, { nested: { tenant_id: TENANT } }),
      'get_fixture_figure',
    );

    expect(h.appended[0]?.payload).toMatchObject({ arguments: ['nested.tenant_id'] });
    expect(JSON.stringify(h.appended[0]?.payload)).not.toContain(TENANT);
  });

  it('finds every tenant_id a body declares, at any depth', () => {
    expect(
      findSessionOnlyKeys({
        tenant_id: 'a',
        rows: [{ tenant_id: 'b' }, { inner: { deeper: [{ tenant_id: 'c' }] } }],
        clean: { as_of: '2026-01-01' },
      }),
    ).toEqual(['tenant_id', 'rows[0].tenant_id', 'rows[1].inner.deeper[0].tenant_id']);
    expect(findSessionOnlyKeys({ as_of: '2026-01-01' })).toEqual([]);
  });

  it('refuses a body nested deeper than the walk will follow', () => {
    let deep: unknown = { tenant_id: 'buried' };
    for (let level = 0; level < 40; level += 1) {
      deep = { level: deep };
    }
    expect(() => findSessionOnlyKeys(deep)).toThrow(RangeError);
  });
});

describe('POST /internal/tools/{tool_name} — a malformed body', () => {
  it('rejects a body that is not JSON', async () => {
    const h = harness();

    const response = await h.handler.postTool(
      request(serviceHeaders, 'not json at all'),
      'get_fixture_figure',
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      kind: 'schema_violation',
      violations: [{ argument: '(body)', reason: 'the request body is not valid JSON' }],
    });
    expect(h.appended[0]?.payload).toMatchObject({ reason: 'malformed_body' });
    expect(h.invoked).toEqual([]);
  });

  it('rejects a body that is not an object', async () => {
    const h = harness();

    const response = await h.handler.postTool(
      request(serviceHeaders, ['as_of']),
      'get_fixture_figure',
    );

    expect(response.status).toBe(400);
    expect(h.appended[0]?.payload).toMatchObject({ reason: 'malformed_body' });
    expect(h.invoked).toEqual([]);
  });
});

describe('POST /internal/tools/{tool_name} — the accepted invocation', () => {
  it('resolves the ToolSession from the forwarded context alone and serialises money as strings', async () => {
    const h = harness();

    const response = await h.handler.postTool(request(serviceHeaders), 'get_fixture_figure');
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(h.invoked).toEqual([
      { tool: 'get_fixture_figure', session, rawInput: { as_of: '2026-01-01' } },
    ]);
    expect(h.invoked[0]?.session.tenant_id).toBe(TENANT);
    expect(body).toMatchObject({
      ok: true,
      value: { total_paise: '90071992547409' },
      evidence: { figure_paise: '99999999999999', steps: [{ result_paise: '99999999999999' }] },
    });
    // Accepted invocations are not endpoint rejections, so nothing is appended here;
    // the tool layer owns the Audit_Events of the invocation itself.
    expect([h.appended.length, h.logged.length]).toEqual([0, 0]);
  });

  it('returns the tool layer tool_failure envelope with cause timeout unchanged', async () => {
    const timedOut: ToolResult<unknown> = {
      ok: false,
      kind: 'tool_failure',
      tool: 'get_fixture_figure',
      cause: 'timeout',
    };
    const h = harness({ result: timedOut });

    const response = await h.handler.postTool(request(serviceHeaders), 'get_fixture_figure');

    // 503, and the body still states the distinction the Python client's longer
    // deadline exists to preserve: the tool timed out, the request did arrive.
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(timedOut);
  });

  it('treats an empty body as an empty argument object', async () => {
    const h = harness();
    const req = new Request('https://financeos.internal/internal/tools/get_fixture_figure', {
      method: 'POST',
      headers: serviceHeaders,
    });

    await h.handler.postTool(req, 'get_fixture_figure');

    expect(h.invoked[0]?.rawInput).toEqual({});
  });
});

describe('POST /internal/tools/{tool_name} — a failing audit sink', () => {
  it('does not report a rejection it could not record', async () => {
    const handler = createInternalToolRouteHandler({
      registry,
      serviceCredential: createServiceCredentialVerifier(
        new Secret('INTERNAL_TOOL_SERVICE_CREDENTIAL', SERVICE_CREDENTIAL),
      ),
      forwardedSessions: { resolve: async () => session },
      authorization: { require: async () => undefined },
      invocations: () => ({ invoke: async () => success as ToolResult<unknown> }),
      audit: {
        append: async () => {
          throw new Error('audit_events is unreachable');
        },
      },
      platformLog: { record: () => undefined },
    });

    const response = await handler.postTool(
      request(serviceHeaders, { tenant_id: TENANT }),
      'get_fixture_figure',
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'internal_error' } });
  });
});
