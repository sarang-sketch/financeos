import { describe, expect, it } from 'vitest';
import { EnvLoadError, loadEnv, redactSecrets, type EnvSource } from '@/config/env';

/**
 * Every credential in the fake environment carries this sentinel. No serialisation of the
 * parsed configuration may contain it (Requirement 14.5).
 */
const SENTINEL = 'SENTINEL_SECRET_DO_NOT_LEAK';

function fakeEnv(overrides: Record<string, string | undefined> = {}): EnvSource {
  const base: Record<string, string | undefined> = {
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
  };
  return { ...base, ...overrides };
}

describe('loadEnv', () => {
  it('parses a complete valid environment', () => {
    const env = loadEnv(fakeEnv());

    expect(env.SUPABASE_URL).toBe('http://127.0.0.1:54321');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.NODE_ENV).toBe('test');
    expect(env.RAZORPAY_KEY_SECRET.reveal()).toBe(`rzp_secret_${SENTINEL}`);
  });

  it('fails naming the missing variable', () => {
    let thrown: unknown;
    try {
      loadEnv(fakeEnv({ RAZORPAY_KEY_SECRET: undefined }));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvLoadError);
    const error = thrown as EnvLoadError;
    expect(error.variables).toEqual(['RAZORPAY_KEY_SECRET']);
    expect(error.message).toContain('RAZORPAY_KEY_SECRET');
  });

  it('names every failing variable at once rather than stopping at the first', () => {
    let thrown: unknown;
    try {
      loadEnv(fakeEnv({ GROQ_API_KEY: undefined, GEMINI_API_KEY: '' }));
    } catch (error) {
      thrown = error;
    }

    const error = thrown as EnvLoadError;
    expect(error.variables).toContain('GROQ_API_KEY');
    expect(error.variables).toContain('GEMINI_API_KEY');
  });

  it('rejects a malformed SUPABASE_URL', () => {
    expect(() => loadEnv(fakeEnv({ SUPABASE_URL: 'not-a-url' }))).toThrowError(EnvLoadError);
    try {
      loadEnv(fakeEnv({ SUPABASE_URL: 'not-a-url' }));
    } catch (error) {
      expect((error as EnvLoadError).variables).toEqual(['SUPABASE_URL']);
    }
  });

  it('rejects an invalid LOG_LEVEL', () => {
    try {
      loadEnv(fakeEnv({ LOG_LEVEL: 'verbose' }));
      expect.unreachable('an invalid LOG_LEVEL must not parse');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvLoadError);
      expect((error as EnvLoadError).variables).toEqual(['LOG_LEVEL']);
    }
  });

  it('rejects an invalid NODE_ENV', () => {
    try {
      loadEnv(fakeEnv({ NODE_ENV: 'staging' }));
      expect.unreachable('an invalid NODE_ENV must not parse');
    } catch (error) {
      expect((error as EnvLoadError).variables).toEqual(['NODE_ENV']);
    }
  });

  it('rejects a CREDENTIAL_ENCRYPTION_KEY shorter than 32 characters', () => {
    try {
      loadEnv(fakeEnv({ CREDENTIAL_ENCRYPTION_KEY: 'too-short' }));
      expect.unreachable('a short encryption key must not parse');
    } catch (error) {
      expect((error as EnvLoadError).variables).toEqual(['CREDENTIAL_ENCRYPTION_KEY']);
    }
  });

  it('never echoes a value in the failure message', () => {
    try {
      loadEnv(fakeEnv({ SUPABASE_URL: `not-a-url-${SENTINEL}`, LOG_LEVEL: SENTINEL }));
      expect.unreachable('a malformed environment must not parse');
    } catch (error) {
      expect((error as Error).message).not.toContain(SENTINEL);
      expect(String(error)).not.toContain(SENTINEL);
    }
  });
});

describe('credential containment', () => {
  it('does not leak a credential through JSON.stringify of the parsed environment', () => {
    const env = loadEnv(fakeEnv());

    const serialized = JSON.stringify(env);

    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).toContain('[redacted:RAZORPAY_KEY_SECRET]');
  });

  it('does not leak a credential through template-literal interpolation', () => {
    const env = loadEnv(fakeEnv());

    const interpolated = `key=${env.RAZORPAY_KEY_SECRET} anon=${env.SUPABASE_ANON_KEY}`;

    expect(interpolated).not.toContain(SENTINEL);
    expect(interpolated).toBe(
      'key=[redacted:RAZORPAY_KEY_SECRET] anon=[redacted:SUPABASE_ANON_KEY]',
    );
  });

  it('does not leak a credential through String(), concatenation, or Object.keys', () => {
    const env = loadEnv(fakeEnv());

    expect(String(env.GROQ_API_KEY)).not.toContain(SENTINEL);
    expect('' + String(env.GEMINI_API_KEY)).not.toContain(SENTINEL);
    expect(JSON.stringify(Object.keys(env))).not.toContain(SENTINEL);
    expect(JSON.stringify({ nested: { deep: env.CREDENTIAL_ENCRYPTION_KEY } })).not.toContain(
      SENTINEL,
    );
  });

  it('exposes the plaintext only through an explicit reveal()', () => {
    const env = loadEnv(fakeEnv());

    expect(env.SUPABASE_SERVICE_ROLE_KEY.reveal()).toContain(SENTINEL);
    expect(env.SUPABASE_SERVICE_ROLE_KEY.mask).toBe('[redacted:SUPABASE_SERVICE_ROLE_KEY]');
  });

  it('redacts a credential that reached an unexpected field, matching on value', () => {
    const env = loadEnv(fakeEnv());
    // A key name the redaction filter could not have predicted.
    const stray = `request failed: {"x_unexpected_field":"${env.GROQ_API_KEY.reveal()}"}`;

    const scrubbed = redactSecrets(stray);

    expect(scrubbed).not.toContain(SENTINEL);
    expect(scrubbed).toContain('[redacted:GROQ_API_KEY]');
  });
});
