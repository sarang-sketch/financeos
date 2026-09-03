import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Secret } from '@/config/env';
import { CredentialDecryptionError } from '@/config/credential-crypto';
import {
  CONFIGURATION_SPECS,
  CREDENTIAL_KINDS,
  ConfigurationValidationError,
  CredentialNotConfiguredError,
  CredentialValueError,
  ConfigurationScopeError,
  TDS_DEFAULT_RATE_PERCENT,
  UnknownConfigurationColumnError,
  createConfigurationService,
  effectiveConfiguration,
  maskedReferenceFor,
  permissionCheckDeferredToTask26_2,
  tdsRateForCategory,
  validateConfigurationValue,
  type Actor,
  type ConfigurationAuditEvent,
  type ConfigurationAuditSink,
  type ConfigurationColumn,
  type ConfigurationPermission,
  type ConfigurationRow,
  type ConfigurationRowPatch,
  type ConfigurationSpec,
  type ConfigurationStore,
  type CredentialKind,
  type TenantConfiguration,
} from '@/config/configuration-service';
import { ConfigurationStoreError } from '@/config/configuration-store';

/**
 * The credential sentinel. Every credential value stored in this file contains it, and no
 * stored column, returned object, audit payload, log line, error message, stack, or
 * `JSON.stringify` output may contain it (Requirement 14.5). Same pattern as
 * `SENTINEL_SECRET_DO_NOT_LEAK` in `env.test.ts`.
 */
const SENTINEL = 'SENTINEL_CREDENTIAL_DO_NOT_LEAK';

const KEY = new Secret('CREDENTIAL_ENCRYPTION_KEY', 'unit-test-master-key-0123456789abcdef');
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ACTOR: Actor = { kind: 'user', id: '33333333-3333-4333-8333-333333333333' };
const CLOCK = () => new Date('2026-01-02T03:04:05.678Z');

/** A row with every column unset, which must behave exactly like an absent row. */
const ALL_NULL_ROW: ConfigurationRow = Object.freeze({
  auto_execute_threshold: null,
  approval_window_hours: null,
  compliance_review_threshold_paise: null,
  tds_rates: null,
  valid_gst_rates: null,
  forecast_horizon_days: null,
  safety_buffer_paise: null,
  lookback_window_days: null,
  minimum_sample_size: null,
  maximum_retry_age_days: null,
  unusual_multiple: null,
  model_timeout_ms: null,
  model_monthly_cap_paise: null,
  audit_retention_days: null,
  razorpay_key_id_masked: null,
  razorpay_key_secret_encrypted: null,
  provider_keys_encrypted: null,
  updated_at: null,
  updated_by: null,
});

interface FakeStore extends ConfigurationStore {
  readonly patches: readonly ConfigurationRowPatch[];
  current(): ConfigurationRow | null;
}

function createFakeStore(initial: ConfigurationRow | null = null): FakeStore {
  let row = initial;
  const patches: ConfigurationRowPatch[] = [];
  return {
    patches,
    current: () => row,
    read: async () => row,
    write: async (_tenantId, patch, updatedBy) => {
      patches.push(patch);
      row = Object.freeze({
        ...(row ?? ALL_NULL_ROW),
        ...patch,
        updated_at: CLOCK().toISOString(),
        updated_by: updatedBy,
      });
      return row;
    },
  };
}

interface FakeAudit extends ConfigurationAuditSink {
  readonly events: readonly ConfigurationAuditEvent[];
}

function createFakeAudit(): FakeAudit {
  const events: ConfigurationAuditEvent[] = [];
  return {
    events,
    append: async (event) => {
      events.push(event);
    },
  };
}

interface Harness {
  readonly service: ReturnType<typeof createConfigurationService>;
  readonly store: FakeStore;
  readonly audit: FakeAudit;
  readonly permissions: readonly ConfigurationPermission[];
}

function harness(initial: ConfigurationRow | null = null): Harness {
  const store = createFakeStore(initial);
  const audit = createFakeAudit();
  const permissions: ConfigurationPermission[] = [];
  const service = createConfigurationService({
    store,
    audit,
    requirePermission: async (_actor, permission) => {
      permissions.push(permission);
    },
    encryptionKey: KEY,
    now: CLOCK,
  });
  return { service, store, audit, permissions };
}

/* -------------------------------------------------------------------------- */
/* The documented table, restated                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every default as the acceptance criteria state it, restated here rather than read from
 * `CONFIGURATION_SPECS`. The generated per-column tests below compare the two, so a
 * default edited in the implementation fails against this table instead of agreeing with
 * itself. The type is `TenantConfiguration`, so omitting a column is a compile error.
 */
const DOCUMENTED_DEFAULTS: TenantConfiguration = Object.freeze({
  auto_execute_threshold: 0, // Requirement 5.15
  approval_window_hours: 24, // Requirement 5.16
  compliance_review_threshold_paise: 5_000_000n, // Requirement 6.11: INR 50000
  tds_rates: Object.freeze({}), // Requirement 6.11: per-category fallback, not a column default
  valid_gst_rates: Object.freeze([0, 0.25, 3, 5, 12, 18, 28]), // Requirement 6.10
  forecast_horizon_days: 90, // Requirement 8.1
  safety_buffer_paise: null, // Requirement 8.14: derived per obligation, no stored constant
  lookback_window_days: 180, // Requirement 9.5
  minimum_sample_size: 50, // Requirement 9.6
  maximum_retry_age_days: 7, // Requirement 9.11
  unusual_multiple: 5.0, // Requirement 10.4
  model_timeout_ms: 30_000, // Requirement 11.5
  model_monthly_cap_paise: 1_000_000n, // Requirement 11.13: INR 10,000
  audit_retention_days: 2555, // Requirement 13.9
});

/**
 * One entry per configured value, so the defaults and the ranges each get a generated
 * `it` per column rather than one loop inside a single `it`. A loop stops at its first
 * failed assertion, which hides every later column until the first is fixed; 14 named
 * tests fail independently and name the column in the report.
 */
const SPEC_ENTRIES = Object.entries(CONFIGURATION_SPECS) as [
  ConfigurationColumn,
  ConfigurationSpec,
][];

/** A value in an assertion message. `JSON.stringify` refuses a bigint, and paise are bigint. */
function describeValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    return (
      JSON.stringify(value, (_key, inner: unknown) =>
        typeof inner === 'bigint' ? inner.toString() : inner,
      ) ?? String(value)
    );
  }
  return String(value);
}

/** The thrown error, or `null` when nothing was thrown. Keeps assertions out of a catch block. */
function catchOf(action: () => unknown): unknown {
  try {
    action();
    return null;
  } catch (error) {
    return error;
  }
}

/** The rejection reason, or `null` when the promise resolved. */
async function rejectionOf(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    return null;
  } catch (error) {
    return error;
  }
}

/**
 * Requirement 14.5: a stored credential value reaches no returned object, no log line and
 * no error message. Applied to every error the service and its store can throw, over all
 * four channels an error realistically escapes through — the message, the string form, the
 * stack, and an own-property serialisation of the kind an error reporter performs.
 */
function expectNoSentinel(error: unknown, where: string): void {
  expect(error, `${where} must throw`).toBeInstanceOf(Error);
  const thrown = error as Error;
  expect(thrown.message, `${where} message`).not.toContain(SENTINEL);
  expect(String(thrown), `${where} String()`).not.toContain(SENTINEL);
  expect(thrown.stack ?? '', `${where} stack`).not.toContain(SENTINEL);
  expect(
    JSON.stringify(thrown, Object.getOwnPropertyNames(thrown)),
    `${where} own properties`,
  ).not.toContain(SENTINEL);
}

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

describe('defaults for an unconfigured Tenant', () => {
  it.each(SPEC_ENTRIES)(
    'defaults %s to the documented value when the column is NULL or the row is absent',
    (column, spec) => {
      const expected = DOCUMENTED_DEFAULTS[column];

      // The implementation's table agrees with the acceptance criteria.
      expect(spec.default, `${column} default in CONFIGURATION_SPECS`).toEqual(expected);
      // An absent row and a row of NULLs both resolve to it.
      expect(effectiveConfiguration(null)[column], `${column} with no row`).toEqual(expected);
      expect(effectiveConfiguration(ALL_NULL_ROW)[column], `${column} NULL`).toEqual(expected);
    },
  );

  it('defaults auto_execute_threshold to 0', () => {
    // Load-bearing. At 0 no Proposal clears the threshold, so nothing auto-executes until a
    // Tenant deliberately raises it (Requirement 5.15). Every Proposal carrying an action
    // type scores at least 5, so a non-zero default would move money with no approval for a
    // Tenant that never opened the configuration screen. Do not relax this test.
    expect(CONFIGURATION_SPECS.auto_execute_threshold.default).toBe(0);
    expect(effectiveConfiguration(null).auto_execute_threshold).toBe(0);
    expect(effectiveConfiguration(ALL_NULL_ROW).auto_execute_threshold).toBe(0);
  });

  it('resolves exactly the configured columns and nothing else', () => {
    // The per-column tests above cover each value; this pins the shape, so a column added
    // to TenantConfiguration without a documented default is caught here as well as by the
    // compiler.
    expect(Object.keys(effectiveConfiguration(null))).toEqual(Object.keys(DOCUMENTED_DEFAULTS));
  });

  it('treats a row of NULLs identically to an absent row, so no migration writes defaults', () => {
    expect(effectiveConfiguration(ALL_NULL_ROW)).toEqual(effectiveConfiguration(null));
  });

  it('states a default and a range for every configuration column', () => {
    for (const [column, spec] of Object.entries(CONFIGURATION_SPECS)) {
      expect(spec.requirement, column).toMatch(/^\d+\.\d+$/);
      expect(spec, column).toHaveProperty('min');
      expect(spec, column).toHaveProperty('max');
      expect(spec, column).toHaveProperty('default');
    }
  });

  it('prefers a stored value over the default, including a stored zero', () => {
    const row: ConfigurationRow = {
      ...ALL_NULL_ROW,
      auto_execute_threshold: 0,
      approval_window_hours: 48,
      safety_buffer_paise: 0n,
      unusual_multiple: 1.5,
    };

    const config = effectiveConfiguration(row);

    expect(config.auto_execute_threshold).toBe(0);
    expect(config.approval_window_hours).toBe(48);
    expect(config.safety_buffer_paise).toBe(0n);
    expect(config.unusual_multiple).toBe(1.5);
    // Untouched columns still resolve to their documented defaults.
    expect(config.forecast_horizon_days).toBe(90);
  });

  it('falls back to 10.00 percent for a TDS category the Tenant has not configured', () => {
    const configured = effectiveConfiguration({ ...ALL_NULL_ROW, tds_rates: { rent: 2 } });

    expect(tdsRateForCategory(configured, 'rent')).toBe(2);
    expect(tdsRateForCategory(configured, 'professional_fees')).toBe(TDS_DEFAULT_RATE_PERCENT);
    expect(tdsRateForCategory(effectiveConfiguration(null), 'rent')).toBe(10.0);
  });

  it('states Requirement 6.11 in paise: INR 0 to 100000000, default INR 50000', () => {
    // The criterion is written in INR and the column is paise, so the conversion is the
    // thing that can silently drift. 1 INR = 100 paise, and nothing here calls Number().
    const spec = CONFIGURATION_SPECS.compliance_review_threshold_paise;
    expect(spec.kind).toBe('paise');
    expect(spec.default).toBe(50_000n * 100n);
    expect(spec.min).toBe(0n);
    expect(spec.max).toBe(100_000_000n * 100n);
    expect(TDS_DEFAULT_RATE_PERCENT).toBe(10.0);
  });

  it('get resolves defaults through the store, for an absent row and an all-NULL row', async () => {
    await expect(harness(null).service.get(TENANT)).resolves.toEqual(effectiveConfiguration(null));
    await expect(harness(ALL_NULL_ROW).service.get(TENANT)).resolves.toEqual(
      effectiveConfiguration(null),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Ranges                                                                     */
/* -------------------------------------------------------------------------- */

describe('documented ranges', () => {
  /**
   * The two boundary values and the two values one step beyond them, per column kind. The
   * step is the smallest the column can represent: 1 for an integer, 1n for paise, and one
   * unit of the last permitted decimal place for the three fractional kinds. A larger step
   * would leave the boundary itself untested from the outside.
   */
  function boundaryCases(spec: ConfigurationSpec): {
    readonly accepted: readonly [unknown, unknown];
    readonly rejected: readonly [unknown, unknown];
  } {
    switch (spec.kind) {
      case 'integer':
        return { accepted: [spec.min, spec.max], rejected: [spec.min - 1, spec.max + 1] };
      case 'paise':
        return { accepted: [spec.min, spec.max], rejected: [spec.min - 1n, spec.max + 1n] };
      case 'decimal': {
        const step = 10 ** -spec.decimals;
        return { accepted: [spec.min, spec.max], rejected: [spec.min - step, spec.max + step] };
      }
      case 'rate_map': {
        const step = 10 ** -spec.decimals;
        return {
          accepted: [{ rent: spec.min }, { rent: spec.max }],
          rejected: [{ rent: spec.min - step }, { rent: spec.max + step }],
        };
      }
      case 'rate_set': {
        const step = 10 ** -spec.decimals;
        return {
          accepted: [[spec.min], [spec.min, spec.max]],
          rejected: [[spec.min - step], [spec.max + step]],
        };
      }
    }
  }

  it.each(SPEC_ENTRIES)(
    'accepts both boundaries of %s and rejects one step beyond each',
    (column, spec) => {
      const { accepted, rejected } = boundaryCases(spec);

      for (const value of accepted) {
        expect(
          () => validateConfigurationValue(column, value),
          `${column} must accept ${describeValue(value)}`,
        ).not.toThrow();
      }
      for (const value of rejected) {
        // Out of range names the column and the criterion, so the operator learns which
        // configured value they got wrong and where the range is written down.
        const thrown = catchOf(() => validateConfigurationValue(column, value));
        expect(thrown, `${column} must reject ${describeValue(value)}`).toBeInstanceOf(
          ConfigurationValidationError,
        );
        expect((thrown as Error).message, column).toContain(column);
        expect((thrown as Error).message, column).toContain(`Requirement ${spec.requirement}`);
      }
    },
  );

  it('holds safety_buffer_paise at the migration ceiling, which the prose contradicts', () => {
    // KNOWN SPEC DEFECT, not a bug in this module. Requirement 8.14 itself and the DDL both
    // say 100000000000 paise (Rs 100 Crore), while the requirements.md glossary entry for
    // Safety_Buffer and the design.md configuration paragraph both say "Rs 10 Crore"
    // (10000000000 paise). The implementation follows the criterion and the migration,
    // because a value this module accepted and the database rejected would surface as an
    // opaque constraint violation at write time. If this assertion ever fails, check
    // whether the prose was reconciled before treating it as a regression.
    const spec = CONFIGURATION_SPECS.safety_buffer_paise;
    expect(spec.max).toBe(100_000_000_000n);
    // The band the two documents disagree about is accepted, deliberately.
    expect(validateConfigurationValue('safety_buffer_paise', 10_000_000_001n)).toBe(
      10_000_000_001n,
    );
  });

  it('names the column, the offending value class and the requirement in the message', () => {
    try {
      validateConfigurationValue('approval_window_hours', 169);
      expect.unreachable('169 hours is out of range');
    } catch (error) {
      expect((error as Error).message).toContain('approval_window_hours');
      expect((error as Error).message).toContain('1 to 168');
      expect((error as Error).message).toContain('Requirement 5.16');
      expect((error as Error).message).toContain('No value was written');
    }
  });

  it('rejects money supplied as a number, because paise are bigint', () => {
    expect(() => validateConfigurationValue('compliance_review_threshold_paise', 5_000_000)).toThrowError(
      /must be integer paise as a bigint/,
    );
    expect(() => validateConfigurationValue('model_monthly_cap_paise', 1_000_000)).toThrowError(
      ConfigurationValidationError,
    );
    expect(() => validateConfigurationValue('safety_buffer_paise', '5000000')).toThrowError(
      ConfigurationValidationError,
    );
  });

  it('rejects a non-integer where the column is an integer', () => {
    expect(() => validateConfigurationValue('forecast_horizon_days', 90.5)).toThrowError(
      ConfigurationValidationError,
    );
  });

  it('rejects a decimal carrying more places than the column stores', () => {
    // unusual_multiple is NUMERIC(4,1); 5.55 would be silently rounded by the database.
    expect(() => validateConfigurationValue('unusual_multiple', 5.55)).toThrowError(
      /decimal place/,
    );
    expect(validateConfigurationValue('unusual_multiple', 5.5)).toBe(5.5);
  });

  it('validates every rate in tds_rates and rejects an empty category name', () => {
    expect(validateConfigurationValue('tds_rates', { rent: 2, contractor: 1.5 })).toEqual({
      rent: 2,
      contractor: 1.5,
    });
    expect(() => validateConfigurationValue('tds_rates', { rent: 31 })).toThrowError(
      ConfigurationValidationError,
    );
    expect(() => validateConfigurationValue('tds_rates', { '  ': 2 })).toThrowError(
      ConfigurationValidationError,
    );
    expect(() => validateConfigurationValue('tds_rates', [2])).toThrowError(
      ConfigurationValidationError,
    );
  });

  it('normalises valid_gst_rates ascending and rejects an empty or duplicated set', () => {
    expect(validateConfigurationValue('valid_gst_rates', [18, 0, 5])).toEqual([0, 5, 18]);
    expect(() => validateConfigurationValue('valid_gst_rates', [])).toThrowError(
      ConfigurationValidationError,
    );
    expect(() => validateConfigurationValue('valid_gst_rates', [5, 5])).toThrowError(
      ConfigurationValidationError,
    );
    expect(() => validateConfigurationValue('valid_gst_rates', [101])).toThrowError(
      ConfigurationValidationError,
    );
  });

  it('agrees with the CHECK constraints in the migration', () => {
    // A range this module accepts and the database rejects surfaces as an opaque constraint
    // violation; the reverse makes this module the tighter of two authorities. Read the DDL.
    const sql = readFileSync(
      new URL(
        '../../supabase/migrations/20260101000001_money_domains_tenancy_configuration.sql',
        import.meta.url,
      ),
      'utf8',
    ).replace(/\s+/g, ' ');

    for (const [name, spec] of Object.entries(CONFIGURATION_SPECS)) {
      if (spec.kind === 'rate_map' || spec.kind === 'rate_set') continue; // plain JSONB, no CHECK
      const between = new RegExp(`${name} BETWEEN (-?[\\d.]+) AND (-?[\\d.]+)`).exec(sql);
      if (between === null) {
        // audit_retention_days is the one column with a floor and no ceiling. Naming it
        // keeps the fallback from silently weakening the assertion for a column whose CHECK
        // was rewritten in some other form.
        expect(name, 'only audit_retention_days may have no BETWEEN check').toBe(
          'audit_retention_days',
        );
        expect(sql, name).toContain(`${name} >= ${String(spec.min)}`);
        continue;
      }
      // Compared numerically: the DDL writes 20.0 where the spec writes 20, and 1.5 either way.
      expect(Number(between[1]), `${name} lower bound`).toBe(Number(spec.min));
      expect(Number(between[2]), `${name} upper bound`).toBe(Number(spec.max));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* put                                                                        */
/* -------------------------------------------------------------------------- */

describe('put', () => {
  it('writes the validated values and returns the new effective configuration', async () => {
    const { service, store, permissions } = harness();

    const config = await service.put(
      TENANT,
      { auto_execute_threshold: 40, safety_buffer_paise: 250_000n },
      ACTOR,
    );

    expect(permissions).toEqual(['configure_policy']);
    expect(store.patches).toEqual([
      { auto_execute_threshold: 40, safety_buffer_paise: 250_000n },
    ]);
    expect(config.auto_execute_threshold).toBe(40);
    expect(config.safety_buffer_paise).toBe(250_000n);
    expect(config.approval_window_hours).toBe(24); // untouched, still the default
  });

  it('writes nothing when any value in the patch is out of range', async () => {
    const { service, store, audit } = harness();

    await expect(
      service.put(TENANT, { auto_execute_threshold: 40, approval_window_hours: 169 }, ACTOR),
    ).rejects.toThrowError(ConfigurationValidationError);

    expect(store.patches).toEqual([]);
    expect(store.current()).toBeNull();
    expect(audit.events).toEqual([]);
  });

  it('rejects a key that is not a configuration column, credential columns included', async () => {
    const { service } = harness();

    await expect(
      service.put(TENANT, { razorpay_key_secret_encrypted: 'x' } as never, ACTOR),
    ).rejects.toThrowError(UnknownConfigurationColumnError);
    await expect(service.put(TENANT, { nonsense: 1 } as never, ACTOR)).rejects.toThrowError(
      UnknownConfigurationColumnError,
    );
  });

  it('unsets a column when the value is null, so the default applies again', async () => {
    const { service } = harness({ ...ALL_NULL_ROW, approval_window_hours: 48 });

    const config = await service.put(TENANT, { approval_window_hours: null } as never, ACTOR);

    expect(config.approval_window_hours).toBe(24);
  });

  it('appends one Audit_Event recording the change and the default that applies when unset', async () => {
    const { service, audit } = harness();

    await service.put(TENANT, { minimum_sample_size: 200 }, ACTOR);

    expect(audit.events).toHaveLength(1);
    const event = audit.events[0];
    expect(event?.eventType).toBe('configuration_updated');
    expect(event?.actor).toEqual(ACTOR);
    expect(event?.occurredAt).toBe('2026-01-02T03:04:05.678Z');
    expect(event?.payload).toEqual({
      changed: [
        {
          column: 'minimum_sample_size',
          from: null,
          to: 200,
          default_applied_when_unset: 50,
        },
      ],
    });
    // Money in a payload has to survive JSON, which cannot carry a bigint.
    await service.put(TENANT, { model_monthly_cap_paise: 2_000_000n }, ACTOR);
    expect(() => JSON.stringify(audit.events[1]?.payload)).not.toThrow();
  });

  it('requires a Tenant UUID, failing closed on an unscoped call', async () => {
    const { service } = harness();

    await expect(service.get('')).rejects.toThrowError(ConfigurationScopeError);
    await expect(service.put('not-a-uuid', { minimum_sample_size: 20 }, ACTOR)).rejects.toThrowError(
      ConfigurationScopeError,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Credentials                                                                */
/* -------------------------------------------------------------------------- */

const RAZORPAY_VALUE = `rzp_test_abc123:secret_${SENTINEL}`;
const GROQ_VALUE = `gsk_${SENTINEL}_groq`;
const GEMINI_VALUE = `AIza_${SENTINEL}_gemini`;
const OPENROUTER_VALUE = `sk-or-v1-${SENTINEL}`;

/** One sentinel-bearing value per kind, so containment is asserted over all four. */
const CREDENTIAL_VALUES: Readonly<Record<CredentialKind, string>> = Object.freeze({
  razorpay_test: RAZORPAY_VALUE,
  openrouter: OPENROUTER_VALUE,
  gemini: GEMINI_VALUE,
  groq: GROQ_VALUE,
});

describe('credential kinds', () => {
  it('is exactly the four documented kinds, with no OpenAI provider', () => {
    expect([...CREDENTIAL_KINDS]).toEqual(['razorpay_test', 'openrouter', 'gemini', 'groq']);
    expect(CREDENTIAL_KINDS).toHaveLength(4);
    expect(CREDENTIAL_KINDS as readonly string[]).not.toContain('openai');
    expect(CREDENTIAL_KINDS as readonly string[]).not.toContain('razorpay_live');
  });

  it('masks a reference with no character of the value and no length', () => {
    for (const kind of CREDENTIAL_KINDS) {
      expect(maskedReferenceFor(kind)).toBe(`[redacted:credential:${kind}]`);
    }
  });
});

describe('putCredential', () => {
  it('returns a masked reference and nothing else', async () => {
    const { service, permissions } = harness();

    const masked = await service.putCredential(TENANT, 'razorpay_test', RAZORPAY_VALUE, ACTOR);

    expect(permissions).toEqual(['manage_credentials']);
    expect(masked).toEqual({
      kind: 'razorpay_test',
      reference: '[redacted:credential:razorpay_test]',
      configured: true,
    });
    expect(JSON.stringify(masked)).not.toContain(SENTINEL);
  });

  it('stores ciphertext, never plaintext, in the column', async () => {
    const { service, store } = harness();

    await service.putCredential(TENANT, 'razorpay_test', RAZORPAY_VALUE, ACTOR);

    const sealed = store.current()?.razorpay_key_secret_encrypted;
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(sealed ?? new Uint8Array()).toString('utf8')).not.toContain(SENTINEL);
    expect(Buffer.from(sealed ?? new Uint8Array()).toString('latin1')).not.toContain(SENTINEL);
    // The key id column holds the masked reference, not key material.
    expect(store.current()?.razorpay_key_id_masked).toBe('[redacted:credential:razorpay_test]');
  });

  it('appends credential_stored first and credential_replaced on replacement, with no value', async () => {
    const { service, audit } = harness();

    await service.putCredential(TENANT, 'groq', GROQ_VALUE, ACTOR);
    await service.putCredential(TENANT, 'groq', `${GROQ_VALUE}_rotated`, ACTOR);

    expect(audit.events.map((event) => event.eventType)).toEqual([
      'credential_stored',
      'credential_replaced',
    ]);
    expect(audit.events[0]?.payload).toEqual({
      kind: 'groq',
      masked_reference: '[redacted:credential:groq]',
      encryption: 'aes-256-gcm',
    });
    expect(JSON.stringify(audit.events)).not.toContain(SENTINEL);
  });

  it('keeps the other provider keys intact when one is replaced', async () => {
    const { service } = harness();

    await service.putCredential(TENANT, 'gemini', GEMINI_VALUE, ACTOR);
    await service.putCredential(TENANT, 'groq', GROQ_VALUE, ACTOR);

    await expect(
      service.readCredentialForServerUse(TENANT, 'gemini').then((s) => s.reveal()),
    ).resolves.toBe(GEMINI_VALUE);
    await expect(
      service.readCredentialForServerUse(TENANT, 'groq').then((s) => s.reveal()),
    ).resolves.toBe(GROQ_VALUE);
    await expect(service.readCredentialForServerUse(TENANT, 'openrouter')).rejects.toThrowError(
      CredentialNotConfiguredError,
    );
  });

  it('rejects an empty or whitespace-padded value without echoing it', async () => {
    const { service, store } = harness();

    await expect(service.putCredential(TENANT, 'groq', '   ', ACTOR)).rejects.toThrowError(
      CredentialValueError,
    );
    await expect(
      service.putCredential(TENANT, 'groq', ` ${GROQ_VALUE} `, ACTOR),
    ).rejects.toThrowError(CredentialValueError);
    expect(store.patches).toEqual([]);
  });
});

describe('readCredentialForServerUse', () => {
  it('round-trips a stored credential for every kind', async () => {
    const { service } = harness();

    for (const kind of CREDENTIAL_KINDS) {
      await service.putCredential(TENANT, kind, CREDENTIAL_VALUES[kind], ACTOR);
    }

    for (const kind of CREDENTIAL_KINDS) {
      const secret = await service.readCredentialForServerUse(TENANT, kind);
      expect(secret.reveal()).toBe(CREDENTIAL_VALUES[kind]);
      expect(`${secret}`).toBe(`[redacted:credential:${kind}]`);
    }
  });

  it('raises rather than returning a placeholder when nothing is stored', async () => {
    const { service } = harness();

    for (const kind of CREDENTIAL_KINDS) {
      await expect(service.readCredentialForServerUse(TENANT, kind)).rejects.toThrowError(
        CredentialNotConfiguredError,
      );
    }
  });

  it('will not open one Tenant credential under another Tenant, because the tag binds it', async () => {
    const { service, store } = harness();
    await service.putCredential(TENANT, 'razorpay_test', RAZORPAY_VALUE, ACTOR);
    // The same row reached through a different Tenant id: the AAD no longer matches.
    const crossTenant = createConfigurationService({
      store: { read: async () => store.current(), write: store.write },
      audit: createFakeAudit(),
      requirePermission: permissionCheckDeferredToTask26_2,
      encryptionKey: KEY,
      now: CLOCK,
    });

    await expect(
      crossTenant.readCredentialForServerUse(OTHER_TENANT, 'razorpay_test'),
    ).rejects.toThrowError(CredentialDecryptionError);
  });

  it('rejects a tampered ciphertext rather than handing a provider altered bytes', async () => {
    const { service, store } = harness();
    await service.putCredential(TENANT, 'razorpay_test', RAZORPAY_VALUE, ACTOR);
    const sealed = Buffer.from(store.current()?.razorpay_key_secret_encrypted ?? new Uint8Array());
    sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 0xff;
    const tampered = createConfigurationService({
      store: {
        read: async () => ({
          ...(store.current() ?? ALL_NULL_ROW),
          razorpay_key_secret_encrypted: Uint8Array.from(sealed),
        }),
        write: store.write,
      },
      audit: createFakeAudit(),
      requirePermission: permissionCheckDeferredToTask26_2,
      encryptionKey: KEY,
      now: CLOCK,
    });

    await expect(
      tampered.readCredentialForServerUse(TENANT, 'razorpay_test'),
    ).rejects.toThrowError(CredentialDecryptionError);
  });
});

describe('listCredentials', () => {
  it('reports configured state for all four kinds and never a value', async () => {
    const { service } = harness();
    await service.putCredential(TENANT, 'groq', GROQ_VALUE, ACTOR);

    const listed = await service.listCredentials(TENANT);

    expect(listed).toHaveLength(4);
    expect(listed.map((entry) => [entry.kind, entry.configured])).toEqual([
      ['razorpay_test', false],
      ['openrouter', false],
      ['gemini', false],
      ['groq', true],
    ]);
    expect(JSON.stringify(listed)).not.toContain(SENTINEL);
  });
});

describe('credential containment', () => {
  it('keeps the sentinel out of every returned object, stored column and audit payload', async () => {
    const { service, store, audit } = harness();

    // All four kinds, so no kind is contained only because it was never exercised.
    const masked: unknown[] = [];
    for (const kind of CREDENTIAL_KINDS) {
      masked.push(await service.putCredential(TENANT, kind, CREDENTIAL_VALUES[kind], ACTOR));
    }
    const listed = await service.listCredentials(TENANT);
    const config = await service.get(TENANT);

    // Paise are bigint, which JSON.stringify refuses, so money is stringified explicitly.
    const serialise = (subject: unknown): string =>
      JSON.stringify(subject, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ) ?? '';

    for (const subject of [masked, listed, config, audit.events, store.patches, store.current()]) {
      expect(serialise(subject)).not.toContain(SENTINEL);
      // A sealed column serialises as an object of byte indices; check the raw bytes too.
      expect(Buffer.from(serialise(subject), 'utf8').toString('latin1')).not.toContain(SENTINEL);
    }
    const sealedColumns = [
      store.current()?.razorpay_key_secret_encrypted,
      store.current()?.provider_keys_encrypted,
    ];
    for (const column of sealedColumns) {
      expect(column).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(column ?? new Uint8Array()).toString('latin1')).not.toContain(SENTINEL);
    }
    // No configuration field can even hold a credential.
    expect(Object.keys(config)).toEqual(Object.keys(CONFIGURATION_SPECS));
  });

  it('keeps the sentinel out of every thrown error, its string form and its stack', async () => {
    const { service } = harness();
    const attempts = [
      () => service.putCredential(TENANT, 'groq', ` ${GROQ_VALUE} `, ACTOR),
      () => service.putCredential(TENANT, 'groq', '', ACTOR),
      () => service.readCredentialForServerUse(TENANT, 'groq'),
    ];

    for (const attempt of attempts) {
      expectNoSentinel(await rejectionOf(attempt), 'credential attempt');
    }
  });

  it('keeps the sentinel out of a console line built from the service results', async () => {
    const { service, audit } = harness();
    await service.putCredential(TENANT, 'groq', GROQ_VALUE, ACTOR);
    const secret = await service.readCredentialForServerUse(TENANT, 'groq');

    // The three shapes an operator would realistically log.
    const lines = [
      `credential=${String(secret)}`,
      `audit=${JSON.stringify(audit.events)}`,
      `masked=${JSON.stringify(await service.listCredentials(TENANT))}`,
    ];

    for (const line of lines) {
      expect(line).not.toContain(SENTINEL);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Credential masking, per error type                                         */
/* -------------------------------------------------------------------------- */

/**
 * Requirement 14.5 excludes a credential value from error messages, and an error is the
 * channel most likely to carry one by accident: it is built by string concatenation, it is
 * serialised by whatever reporter catches it, and it is the one path a caller sees when a
 * write went wrong. One test per error type the configuration path can raise, so a leak
 * names the error class rather than "an attempt".
 */
describe('credential masking across every error type', () => {
  it('ConfigurationValidationError: no configured value echoes a credential pasted into it', async () => {
    const { service } = harness();

    for (const [column] of SPEC_ENTRIES) {
      // A credential pasted into the wrong field on a configuration screen. The message
      // reports the received type, never the received value.
      const thrown = await rejectionOf(() =>
        service.put(TENANT, { [column]: CREDENTIAL_VALUES.groq } as never, ACTOR),
      );
      expect(thrown, column).toBeInstanceOf(ConfigurationValidationError);
      expectNoSentinel(thrown, `ConfigurationValidationError for ${column}`);
    }
  });

  it('UnknownConfigurationColumnError: names the rejected key without echoing its value', async () => {
    const { service } = harness();

    const thrown = await rejectionOf(() =>
      service.put(
        TENANT,
        { razorpay_key_secret_encrypted: CREDENTIAL_VALUES.razorpay_test } as never,
        ACTOR,
      ),
    );

    expect(thrown).toBeInstanceOf(UnknownConfigurationColumnError);
    expect((thrown as Error).message).toContain('razorpay_key_secret_encrypted');
    expectNoSentinel(thrown, 'UnknownConfigurationColumnError');
  });

  it('CredentialNotConfiguredError: carries no placeholder value, for all four kinds', async () => {
    const { service } = harness();

    for (const kind of CREDENTIAL_KINDS) {
      const thrown = await rejectionOf(() => service.readCredentialForServerUse(TENANT, kind));
      expect(thrown, kind).toBeInstanceOf(CredentialNotConfiguredError);
      expect((thrown as Error).message, kind).toContain(kind);
      expectNoSentinel(thrown, `CredentialNotConfiguredError for ${kind}`);
    }
  });

  it('ConfigurationScopeError: an unscoped call holding a credential does not echo it', async () => {
    const { service, store } = harness();

    for (const kind of CREDENTIAL_KINDS) {
      // The scope check runs before the value is looked at, which is exactly when the
      // value is still in hand and easiest to interpolate into a message.
      const stored = await rejectionOf(() =>
        service.putCredential('not-a-uuid', kind, CREDENTIAL_VALUES[kind], ACTOR),
      );
      expect(stored, kind).toBeInstanceOf(ConfigurationScopeError);
      expectNoSentinel(stored, `ConfigurationScopeError storing ${kind}`);

      const read = await rejectionOf(() => service.readCredentialForServerUse('', kind));
      expect(read, kind).toBeInstanceOf(ConfigurationScopeError);
      expectNoSentinel(read, `ConfigurationScopeError reading ${kind}`);
    }
    expect(store.patches).toEqual([]);
  });

  it('CredentialValueError: a padded value is rejected without being echoed, for all four kinds', async () => {
    const { service } = harness();

    for (const kind of CREDENTIAL_KINDS) {
      const thrown = await rejectionOf(() =>
        service.putCredential(TENANT, kind, ` ${CREDENTIAL_VALUES[kind]}\n`, ACTOR),
      );
      expect(thrown, kind).toBeInstanceOf(CredentialValueError);
      expect((thrown as Error).message, kind).toContain(kind);
      expectNoSentinel(thrown, `CredentialValueError for ${kind}`);
    }
  });

  it('CredentialDecryptionError: a failed open names the slot only, for both slots', async () => {
    // Both slots, because the three provider keys share one column and the Razorpay secret
    // has its own: a decryption failure has two distinct code paths to leak from.
    for (const kind of ['razorpay_test', 'groq'] as const) {
      const { service, store } = harness();
      await service.putCredential(TENANT, kind, CREDENTIAL_VALUES[kind], ACTOR);
      const crossTenant = createConfigurationService({
        store: { read: async () => store.current(), write: store.write },
        audit: createFakeAudit(),
        requirePermission: permissionCheckDeferredToTask26_2,
        encryptionKey: KEY,
        now: CLOCK,
      });

      const thrown = await rejectionOf(() =>
        crossTenant.readCredentialForServerUse(OTHER_TENANT, kind),
      );

      expect(thrown, kind).toBeInstanceOf(CredentialDecryptionError);
      expectNoSentinel(thrown, `CredentialDecryptionError for ${kind}`);
    }
  });

  it('ConfigurationStoreError: masks a credential value embedded in database error text', async () => {
    // The store error is the one message built from text this process did not write, so
    // key-name redaction cannot help: `redactSecrets` matches on the credential **value**,
    // which every Secret registers on construction. Reading the credential for server use
    // is what registers it here, and that is also the only path that has the plaintext.
    const { service } = harness();
    await service.putCredential(TENANT, 'groq', GROQ_VALUE, ACTOR);
    const secret = await service.readCredentialForServerUse(TENANT, 'groq');

    // PostgREST hands back the offending row in some conflict messages verbatim.
    const thrown = new ConfigurationStoreError(
      'write',
      `duplicate key value violates unique constraint: (provider_keys)=(${secret.reveal()})`,
    );

    expect(thrown.message).toContain('[redacted:credential:groq]');
    expect(thrown.message).toContain('configuration write failed');
    expectNoSentinel(thrown, 'ConfigurationStoreError');
  });
});
