import { z } from 'zod';

/**
 * Platform environment and secret loading.
 *
 * The variables here are the **platform's own** keys, used for the reference Tenant and
 * for tests. Per-Tenant Razorpay and Model_Provider credentials are never environment
 * variables: they live encrypted at rest in `tenant_configuration` and are read only
 * through `ConfigurationService.readCredentialForServerUse`, a server-only path with no
 * HTTP surface (Requirement 14.5, docs/09_SECURITY.md, docs/16_DEPLOYMENT.md).
 *
 * Two disciplines are enforced by construction rather than by convention:
 *
 * 1. **Fail fast, fail loudly.** `loadEnv` parses the whole environment through one Zod
 *    schema and throws `EnvLoadError` naming every variable that failed. The application
 *    must not start on partial configuration.
 * 2. **A credential cannot leak by accident.** Every credential is wrapped in `Secret`,
 *    whose `toString`, `toJSON`, `Symbol.toPrimitive` and Node inspect hook all return a
 *    mask. `JSON.stringify(env)` and a bare template-literal interpolation therefore
 *    cannot emit plaintext; obtaining it requires an explicit `.reveal()` call, which is
 *    grep-able in review.
 *
 * Why `Secret` rather than a branded string: a brand is erased at runtime, so
 * `JSON.stringify` and string interpolation would still emit the plaintext. The leak
 * channels that matter — logs, error payloads, Model prompts — are all runtime
 * serialisation, so the guard has to exist at runtime. The mask carries no characters of
 * the underlying value at all: a tail like `sk_…abcd` is friendlier for operators but
 * still discloses key material, and the variable name alone is enough to identify which
 * credential is loaded.
 */

/** A masked reference to a credential. The plaintext is reachable only via `reveal()`. */
export class Secret {
  /** Private field, so it is invisible to `JSON.stringify`, spread, and `Object.keys`. */
  readonly #value: string;

  /** The environment variable name. Safe to log; it is not the value. */
  readonly #label: string;

  constructor(label: string, value: string) {
    this.#label = label;
    this.#value = value;
    registerSecretValue(value, `[redacted:${label}]`);
  }

  /** The only sanctioned way to obtain the plaintext. */
  reveal(): string {
    return this.#value;
  }

  /** The masked reference. This is what every serialisation path yields. */
  get mask(): string {
    return `[redacted:${this.#label}]`;
  }

  /** Covers `String(secret)` and `` `${secret}` ``. */
  toString(): string {
    return this.mask;
  }

  /** Covers `JSON.stringify(env)`. */
  toJSON(): string {
    return this.mask;
  }

  /** Covers template literals and any coercion, ahead of `toString`. */
  [Symbol.toPrimitive](): string {
    return this.mask;
  }

  /** Covers `console.log`, `util.inspect` and Vitest diff output under Node. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.mask;
  }
}

/**
 * Value-keyed redaction registry.
 *
 * docs/09_SECURITY.md and docs/12_OBSERVABILITY.md require the redaction filter to match
 * on credential **value**, not on key name: key-based redaction only catches credentials
 * in fields you predicted. Every `Secret` registers its plaintext here on construction,
 * so `redactSecrets` scrubs a credential that reached an unexpected field, a nested
 * payload, or a stringified error.
 */
const secretValues = new Map<string, string>();

function registerSecretValue(value: string, mask: string): void {
  // Very short values would turn `redactSecrets` into a shredder over ordinary text.
  if (value.length >= 8) {
    secretValues.set(value, mask);
  }
}

/**
 * Replace every known credential value in `text` with its mask. Any log line, error
 * message, or outbound Model payload must pass through this before it leaves the process.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [value, mask] of secretValues) {
    if (out.includes(value)) {
      out = out.split(value).join(mask);
    }
  }
  return out;
}

/** Thrown when configuration is missing or malformed. Names variables, never values. */
export class EnvLoadError extends Error {
  readonly variables: readonly string[];

  constructor(problems: readonly { readonly variable: string; readonly reason: string }[]) {
    const lines = problems.map((p) => `  - ${p.variable}: ${p.reason}`).join('\n');
    super(
      `Invalid environment configuration. The application will not start on partial ` +
        `configuration. ${problems.length} variable(s) failed:\n${lines}\n` +
        `See .env.example for the key names. Values are never echoed.`,
    );
    this.name = 'EnvLoadError';
    this.variables = problems.map((p) => p.variable);
  }
}

const MISSING = 'must be set to a non-empty value';

/** A required credential: present, non-empty, wrapped so it cannot serialise in plaintext. */
function secret(label: string, minLength = 1) {
  return z
    .string({ error: MISSING })
    .min(minLength, {
      error:
        minLength > 1
          ? `must be set and at least ${minLength} characters long`
          : MISSING,
    })
    .transform((value) => new Secret(label, value));
}

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export const NODE_ENVS = ['development', 'test', 'production'] as const;

const envSchema = z.object({
  // Supabase. The URL is not a credential; the keys are.
  SUPABASE_URL: z.url({ error: 'must be set to a valid absolute URL' }),
  SUPABASE_ANON_KEY: secret('SUPABASE_ANON_KEY'),
  SUPABASE_SERVICE_ROLE_KEY: secret('SUPABASE_SERVICE_ROLE_KEY'),

  // Razorpay test mode. The key id is the basic-auth username, i.e. half of a credential
  // pair, so it is masked too rather than treated as a public identifier.
  RAZORPAY_KEY_ID: secret('RAZORPAY_KEY_ID'),
  RAZORPAY_KEY_SECRET: secret('RAZORPAY_KEY_SECRET'),

  // Model providers, consumed by the Python AI_Gateway adapters (Slice 4).
  OPENROUTER_API_KEY: secret('OPENROUTER_API_KEY'),
  GEMINI_API_KEY: secret('GEMINI_API_KEY'),
  GROQ_API_KEY: secret('GROQ_API_KEY'),

  // Encrypts per-Tenant credentials at rest in `tenant_configuration`.
  CREDENTIAL_ENCRYPTION_KEY: secret('CREDENTIAL_ENCRYPTION_KEY', 32),

  // Operational.
  LOG_LEVEL: z.enum(LOG_LEVELS, {
    error: `must be one of ${LOG_LEVELS.join(', ')}`,
  }),
  NODE_ENV: z.enum(NODE_ENVS, {
    error: `must be one of ${NODE_ENVS.join(', ')}`,
  }),
});

export type Env = Readonly<z.infer<typeof envSchema>>;

/** The raw source shape: `process.env` or, in tests, a fake. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Parse and validate configuration. Pure: no module state, no caching, no I/O.
 * Throws `EnvLoadError` naming every failing variable, with no value in the message.
 */
export function loadEnv(source: EnvSource): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) {
    return Object.freeze(parsed.data);
  }

  // Only the issue path and our own message are surfaced. A Zod default message is never
  // used verbatim, so no library formatting change can start echoing a received value.
  const problems = parsed.error.issues.map((issue) => ({
    variable: issue.path.map(String).join('.') || '(unknown)',
    reason: reasonFor(issue),
  }));
  throw new EnvLoadError(problems);
}

/** Our own messages only, so a value can never reach the error text. */
function reasonFor(issue: z.core.$ZodIssue): string {
  const ours = issue.message;
  return ours.length > 0 && !ours.startsWith('Invalid input') ? ours : 'is missing or malformed';
}

let cached: Env | undefined;

/**
 * The process-wide configuration, parsed once on first use. Server-only: importing this
 * from a client component would attempt to read server secrets in the browser.
 */
export function getEnv(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}

/** Test seam: drop the memoised configuration. */
export function resetEnvCache(): void {
  cached = undefined;
}
