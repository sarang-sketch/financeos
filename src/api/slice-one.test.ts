import { describe, expect, it } from 'vitest';

import type { ApiSession } from './session';
import { AuthenticationRequiredError, createSessionResolver } from './session';
import {
  createSliceOneRouteHandlers,
  type SliceOneApiServices,
} from './slice-one';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CHAIN = '33333333-3333-4333-8333-333333333333';

const session: ApiSession = {
  access_token: 'validated-token',
  tenant_id: TENANT,
  user_id: USER,
  permissions: ['view_financial_data', 'run_agents', 'manage_credentials'],
};

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://financeos.test${path}`, {
    ...init,
    headers: { authorization: 'Bearer validated-token', ...init.headers },
  });
}

function unavailableTool(tool: string) {
  return { ok: false as const, kind: 'tool_failure' as const, tool, cause: 'execution_error' as const };
}

describe('Slice 1 API routes', () => {
  it('returns one generic authentication-required error without resolving any Tenant service', async () => {
    let delegated = 0;
    const services = new Proxy({}, {
      get: () => async () => { delegated += 1; },
    }) as SliceOneApiServices;
    const handlers = createSliceOneRouteHandlers({
      sessions: { resolve: async () => { throw new AuthenticationRequiredError(); } },
      authorization: { require: async () => { throw new Error('must not authorize'); } },
      services,
    });

    const response = await handlers.getControlTowerMetrics(request('/control-tower/metrics'));
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(JSON.parse(text)).toEqual({
      error: { code: 'authentication_required', message: 'Authentication required' },
    });
    expect(text).not.toContain(TENANT);
    expect(text).not.toContain('validated-token');
    expect(delegated).toBe(0);
  });
  it('resolves once per route, forwards only the session Tenant, and enforces route paging', async () => {
    let resolutions = 0;
    const delegatedTenants: string[] = [];
    let exceptionInput: unknown;
    const services: SliceOneApiServices = {
      async startIngestion(bound) {
        delegatedTenants.push(bound.tenant_id);
        return { id: 'run-1', status: 'completed' };
      },
      async getControlTowerMetrics(bound) {
        delegatedTenants.push(bound.tenant_id);
        return unavailableTool('get_control_tower_metrics');
      },
      async listExceptions(bound, input) {
        delegatedTenants.push(bound.tenant_id);
        exceptionInput = input;
        return unavailableTool('list_exceptions_by_category');
      },
      async getEvidenceChain(bound, chainId, page) {
        delegatedTenants.push(bound.tenant_id);
        expect(chainId).toBe(CHAIN);
        expect(page).toBe(2);
        return {
          evidence_chain_id: CHAIN,
          figure_paise: 99_999_999_999_999n,
          source_count: 101,
          as_of: '2026-01-01T00:00:00.000Z',
          produced_by: 'get_settlement_reconciliation',
          steps: [],
          source_page: {
            page_index: 2,
            page_size: 100,
            sources: [],
            next: null,
            source_count: 101,
          },
        };
      },
      async runReconciliation(bound) {
        delegatedTenants.push(bound.tenant_id);
        return { run_id: 'run-2', exception: { impact_paise: 90_071_992_547_409n } };
      },
    };
    const handlers = createSliceOneRouteHandlers({
      sessions: { resolve: async () => { resolutions += 1; return session; } },
      authorization: { require: async () => undefined },
      services,
    });

    const responses = await Promise.all([
      handlers.postIngestionRun(request('/ingestion/runs', { method: 'POST', body: '{}' })),
      handlers.getControlTowerMetrics(request('/control-tower/metrics')),
      handlers.getExceptions(request('/exceptions?category=settlement_mismatch&page=2')),
      handlers.getEvidenceChain(request(`/evidence-chains/${CHAIN}?page=2`), CHAIN),
      handlers.postReconciliationRun(request('/agents/reconciliation/runs', {
        method: 'POST',
        body: JSON.stringify({ from: '2026-01-01', to: '2026-01-31' }),
      })),
    ]);

    expect(resolutions).toBe(5);
    expect(delegatedTenants).toEqual(Array(5).fill(TENANT));
    expect(exceptionInput).toEqual({
      category: 'settlement_mismatch',
      state: 'open',
      page: { offset: 50, limit: 50 },
    });
    expect(responses.map((response) => response.status)).toEqual([201, 503, 503, 200, 201]);
    expect(await responses[3]?.json()).toMatchObject({ figure_paise: '99999999999999' });
    expect(await responses[4]?.json()).toMatchObject({
      exception: { impact_paise: '90071992547409' },
    });
  });
  it('rejects malformed pages before any financial-data delegate runs', async () => {
    let delegated = 0;
    const services = new Proxy({}, {
      get: () => async () => { delegated += 1; },
    }) as SliceOneApiServices;
    const handlers = createSliceOneRouteHandlers({
      sessions: { resolve: async () => session },
      authorization: { require: async () => undefined },
      services,
    });

    const response = await handlers.getExceptions(request('/exceptions?page=0'));
    expect(response.status).toBe(400);
    expect(delegated).toBe(0);
  });
});

describe('session resolution', () => {
  it('uses the validated credential claim as the sole Tenant source', async () => {
    const payload = Buffer.from(JSON.stringify({ tenant_id: TENANT, permissions: ['run_agents'] }))
      .toString('base64url');
    const token = `header.${payload}.signature`;
    const resolver = createSessionResolver(async () => ({
      user: { id: USER, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '' } as never,
      claims: { tenant_id: TENANT, permissions: ['run_agents'] },
    }));

    const resolved = await resolver.resolve(new Request('https://financeos.test', {
      headers: { authorization: `Bearer ${token}` },
    }));

    expect(resolved).toEqual({
      access_token: token,
      tenant_id: TENANT,
      user_id: USER,
      permissions: ['run_agents'],
    });
  });

  it('maps absent, rejected, and conflicting Tenant credentials to the same generic error', async () => {
    const absent = createSessionResolver(async () => { throw new Error('not called'); });
    await expect(absent.resolve(new Request('https://financeos.test')))
      .rejects.toBeInstanceOf(AuthenticationRequiredError);

    const rejected = createSessionResolver(async () => { throw new Error('expired token details'); });
    await expect(rejected.resolve(request('/'))).rejects.toMatchObject({
      name: 'AuthenticationRequiredError',
      message: 'Authentication required',
    });

    const conflicting = createSessionResolver(async () => ({
      user: {
        id: USER,
        app_metadata: { tenant_id: '44444444-4444-4444-8444-444444444444' },
        user_metadata: {},
        aud: 'authenticated',
        created_at: '',
      } as never,
      claims: { tenant_id: TENANT },
    }));
    await expect(conflicting.resolve(request('/')))
      .rejects.toBeInstanceOf(AuthenticationRequiredError);
  });
});


async function loadActualSliceOneRoutes() {
  const [runtime, ingestion, metrics, exceptions, evidence, reconciliation] = await Promise.all([
    import('./runtime'),
    import('../app/ingestion/runs/route'),
    import('../app/control-tower/metrics/route'),
    import('../app/exceptions/route'),
    import('../app/evidence-chains/[id]/route'),
    import('../app/agents/reconciliation/runs/route'),
  ]);
  return {
    configure: runtime.configureSliceOneApi,
    postIngestion: ingestion.POST,
    getMetrics: metrics.GET,
    getExceptions: exceptions.GET,
    getEvidence: evidence.GET,
    postReconciliation: reconciliation.POST,
  };
}

function inertServices(overrides: Partial<SliceOneApiServices> = {}): SliceOneApiServices {
  return {
    startIngestion: async () => ({ id: 'unused' }),
    getControlTowerMetrics: async () => unavailableTool('get_control_tower_metrics'),
    listExceptions: async () => unavailableTool('list_exceptions_by_category'),
    getEvidenceChain: async () => null,
    runReconciliation: async () => ({ id: 'unused' }),
    ...overrides,
  };
}

describe('actual Next.js Slice 1 route handlers', () => {
  it.each([
    ['absent', undefined],
    ['expired', 'Bearer expired-session-token'],
    ['invalid', 'Bearer invalid-session-token'],
  ] as const)(
    'uses the same non-leaking authentication-required path for an %s credential',
    async (_credentialKind, authorization) => {
      const routes = await loadActualSliceOneRoutes();
      let delegated = 0;
      let authorized = 0;
      const services = new Proxy({}, {
        get: () => async () => {
          delegated += 1;
          return { tenant_id: TENANT, impact_paise: 99_999_999_999_999n };
        },
      }) as SliceOneApiServices;
      routes.configure({
        sessions: createSessionResolver(async (token) => {
          throw new Error(`credential ${token} rejected for Tenant ${TENANT}; impact 99999999999999`);
        }),
        authorization: {
          require: async () => {
            authorized += 1;
          },
        },
        services,
      });

      const headers = authorization === undefined ? undefined : { authorization };
      const calls = [
        routes.postIngestion(new Request('https://financeos.test/ingestion/runs', {
          method: 'POST',
          headers,
        })),
        routes.getMetrics(new Request('https://financeos.test/control-tower/metrics', { headers })),
        routes.getExceptions(new Request('https://financeos.test/exceptions?page=1', { headers })),
        routes.getEvidence(
          new Request(`https://financeos.test/evidence-chains/${CHAIN}?page=1`, { headers }),
          { params: Promise.resolve({ id: CHAIN }) },
        ),
        routes.postReconciliation(new Request('https://financeos.test/agents/reconciliation/runs', {
          method: 'POST',
          headers,
        })),
      ];
      const responses = await Promise.all(calls);
      const texts = await Promise.all(responses.map((response) => response.text()));

      expect(responses.map((response) => response.status)).toEqual(Array(5).fill(401));
      expect(new Set(texts)).toEqual(new Set([
        JSON.stringify({
          error: { code: 'authentication_required', message: 'Authentication required' },
        }),
      ]));
      for (const text of texts) {
        expect(text.toLowerCase()).not.toContain('tenant');
        expect(text).not.toContain(TENANT);
        expect(text).not.toContain('99999999999999');
        expect(text).not.toContain(authorization?.replace('Bearer ', '') ?? 'missing-token');
        expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      }
      expect(authorized).toBe(0);
      expect(delegated).toBe(0);
    },
  );

  it('enforces malformed, duplicate, missing, maximum, and over-boundary page parameters', async () => {
    const routes = await loadActualSliceOneRoutes();
    const [{ MAX_PAGE_OFFSET }, { MAX_EXCEPTION_PAGE_SIZE }, { UI_SOURCE_PAGE_SIZE }] =
      await Promise.all([
        import('../tools/paging'),
        import('../tools/exception-tools'),
        import('../evidence/chain-builder'),
      ]);
    const exceptionInputs: unknown[] = [];
    const evidencePages: number[] = [];
    routes.configure({
      sessions: { resolve: async () => session },
      authorization: { require: async () => undefined },
      services: inertServices({
        async listExceptions(_bound, input) {
          exceptionInputs.push(input);
          return unavailableTool('list_exceptions_by_category');
        },
        async getEvidenceChain(_bound, chainId, page) {
          expect(chainId).toBe(CHAIN);
          evidencePages.push(page);
          return null;
        },
      }),
    });

    const maximumExceptionPage = Math.floor(MAX_PAGE_OFFSET / MAX_EXCEPTION_PAGE_SIZE) + 1;
    const maximumEvidencePage = Math.floor(MAX_PAGE_OFFSET / UI_SOURCE_PAGE_SIZE) + 1;
    const acceptedExceptions = await routes.getExceptions(new Request(
      `https://financeos.test/exceptions?category=settlement_mismatch&page=${maximumExceptionPage}`,
    ));
    const acceptedEvidence = await routes.getEvidence(
      new Request(`https://financeos.test/evidence-chains/${CHAIN}?page=${maximumEvidencePage}`),
      { params: Promise.resolve({ id: CHAIN }) },
    );

    expect(acceptedExceptions.status).toBe(503);
    expect(exceptionInputs).toEqual([{
      category: 'settlement_mismatch',
      state: 'open',
      page: {
        offset: (maximumExceptionPage - 1) * MAX_EXCEPTION_PAGE_SIZE,
        limit: MAX_EXCEPTION_PAGE_SIZE,
      },
    }]);
    expect(acceptedEvidence.status).toBe(404);
    expect(evidencePages).toEqual([maximumEvidencePage]);

    const malformedExceptionUrls = [
      'https://financeos.test/exceptions',
      'https://financeos.test/exceptions?page=0',
      'https://financeos.test/exceptions?page=-1',
      'https://financeos.test/exceptions?page=1.5',
      'https://financeos.test/exceptions?page=01',
      'https://financeos.test/exceptions?page=1&page=2',
      `https://financeos.test/exceptions?page=${maximumExceptionPage + 1}`,
      'https://financeos.test/exceptions?page=1&cursor=unexpected',
    ];
    for (const url of malformedExceptionUrls) {
      const response = await routes.getExceptions(new Request(url));
      expect(response.status, url).toBe(400);
    }

    const malformedEvidenceUrls = [
      `https://financeos.test/evidence-chains/${CHAIN}`,
      `https://financeos.test/evidence-chains/${CHAIN}?page=0`,
      `https://financeos.test/evidence-chains/${CHAIN}?page=1&page=2`,
      `https://financeos.test/evidence-chains/${CHAIN}?page=${maximumEvidencePage + 1}`,
      `https://financeos.test/evidence-chains/${CHAIN}?page=1&limit=100`,
    ];
    for (const url of malformedEvidenceUrls) {
      const response = await routes.getEvidence(new Request(url), {
        params: Promise.resolve({ id: CHAIN }),
      });
      expect(response.status, url).toBe(400);
    }

    expect(exceptionInputs).toHaveLength(1);
    expect(evidencePages).toHaveLength(1);
  });

  it('surfaces successful metric cells when another cell fails and stringifies every bigint', async () => {
    const routes = await loadActualSliceOneRoutes();
    const asOf = '2026-01-31T12:00:00.000Z';
    const revenue = 99_999_999_999_999n;
    const pending = 90_071_992_547_409n;
    routes.configure({
      sessions: { resolve: async () => session },
      authorization: { require: async () => undefined },
      services: inertServices({
        getControlTowerMetrics: async () => ({
          ok: true,
          value: {
            cash: { state: 'failed', failure_kind: 'error' },
            revenue_30d: {
              state: 'ready',
              value_paise: revenue,
              evidence_chain_id: CHAIN,
              evidence_as_of: asOf,
              last_ingested_at: asOf,
            },
            pending_settlement: {
              state: 'ready',
              value_paise: pending,
              evidence_chain_id: '44444444-4444-4444-8444-444444444444',
              evidence_as_of: asOf,
            },
            runway: { state: 'unavailable', reason: 'not_yet_available' },
          },
          evidence: {
            evidence_chain_id: CHAIN,
            figure_paise: revenue,
            sources: [{ type: 'payment', id: 'pay_route_metric' }],
            source_count: 1,
            steps: [],
            as_of: asOf,
            produced_by: 'get_control_tower_metrics',
          },
        }),
      }),
    });

    const response = await routes.getMetrics(
      new Request('https://financeos.test/control-tower/metrics'),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.value.cash).toEqual({ state: 'failed', failure_kind: 'error' });
    expect(body.value.cash).not.toHaveProperty('value_paise');
    expect(body.value.revenue_30d).toMatchObject({
      state: 'ready',
      value_paise: revenue.toString(),
      evidence_chain_id: CHAIN,
    });
    expect(body.value.pending_settlement).toMatchObject({
      state: 'ready',
      value_paise: pending.toString(),
    });
    expect(body.value.runway).toEqual({
      state: 'unavailable',
      reason: 'not_yet_available',
    });
    expect(body.evidence.figure_paise).toBe(revenue.toString());
    expect(typeof body.value.revenue_30d.value_paise).toBe('string');
    expect(typeof body.value.pending_settlement.value_paise).toBe('string');
    expect(typeof body.evidence.figure_paise).toBe('string');
  });
});