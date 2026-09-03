import { describe, expect, it } from 'vitest';
import { loadEnv } from '@/config/env';
import {
  ClientScopeError,
  createReadOnlyClient,
  createServiceClient,
  createTenantScopedClient,
} from '@/db/clients';

/**
 * Construction only. No factory opens a connection, so these run without Supabase local
 * and with fake credentials.
 */
const SENTINEL = 'SENTINEL_SECRET_DO_NOT_LEAK';
const TENANT_ID = '4f9e1b2c-3d4a-4b5c-8d6e-7f8a9b0c1d2e';
const ACCESS_TOKEN = `header.payload.${SENTINEL}`;

const env = loadEnv({
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: `anon_${SENTINEL}`,
  SUPABASE_SERVICE_ROLE_KEY: `service_${SENTINEL}`,
  RAZORPAY_KEY_ID: `rzp_test_${SENTINEL}`,
  RAZORPAY_KEY_SECRET: `rzp_secret_${SENTINEL}`,
  OPENROUTER_API_KEY: `openrouter_${SENTINEL}`,
  GEMINI_API_KEY: `gemini_${SENTINEL}`,
  GROQ_API_KEY: `groq_${SENTINEL}`,
  CREDENTIAL_ENCRYPTION_KEY: `credential_encryption_key_${SENTINEL}`,
  LOG_LEVEL: 'info',
  NODE_ENV: 'test',
});

describe('createTenantScopedClient', () => {
  it('constructs a client for a session token', () => {
    expect(createTenantScopedClient(ACCESS_TOKEN, env)).toBeDefined();
  });

  it('rejects an empty session token without echoing it', () => {
    expect(() => createTenantScopedClient('   ', env)).toThrowError(ClientScopeError);
    try {
      createTenantScopedClient('', env);
    } catch (error) {
      expect((error as Error).message).not.toContain(SENTINEL);
    }
  });
});

describe('createServiceClient', () => {
  it('returns the client with its Tenant scope attached', () => {
    const scoped = createServiceClient({ tenantId: TENANT_ID }, env);

    expect(scoped.tenantId).toBe(TENANT_ID);
    expect(scoped.client).toBeDefined();
  });

  it('refuses a call with no usable Tenant identifier', () => {
    expect(() => createServiceClient({ tenantId: '' }, env)).toThrowError(ClientScopeError);
    expect(() => createServiceClient({ tenantId: 'all' }, env)).toThrowError(ClientScopeError);
  });
});

describe('createReadOnlyClient', () => {
  it('constructs a client for a read-only role token', () => {
    expect(createReadOnlyClient(ACCESS_TOKEN, env)).toBeDefined();
  });

  it('rejects an empty token', () => {
    expect(() => createReadOnlyClient('', env)).toThrowError(ClientScopeError);
  });
});
