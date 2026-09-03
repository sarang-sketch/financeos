/**
 * FinanceOS_Configuration_Service — Tenant configuration and encrypted credentials.
 *
 * Two responsibilities, and they are kept apart on purpose:
 *
 * 1. **Policy values.** Every configuration column in `tenant_configuration` is
 *    nullable and no migration writes defaults into rows, so an unconfigured Tenant
 *    has no row at all. {@link CONFIGURATION_SPECS} is the single table of defaults
 *    and ranges, and {@link createConfigurationService}'s `get` resolves a `NULL`
 *    column — or an absent row — to the documented default. The alternative,
 *    scattering `?? 90` across the Agents, guarantees two callers eventually
 *    disagree about what an unset value means.
 * 2. **Credentials.** Stored AES-256-GCM sealed (see `./credential-crypto`),
 *    returned only as a masked reference, excluded from API responses, logs and
 *    error messages, and audited on store or replace without the value
 *    (Requirement 14.5).
 *
 * `put` cannot touch a credential column and `putCredential` cannot touch a policy
 * column: `TenantConfiguration` names no credential field, so the separation is a
 * type error to violate rather than a convention to remember.
 *
 * ## The safety default that matters most
 *
 * `auto_execute_threshold` defaults to **0**. At 0 no Sensitive_Action clears the
 * threshold, so nothing auto-executes until a Tenant deliberately raises it
 * (Requirement 5.15). A non-zero default would mean a Tenant that never opened the
 * configuration screen has money moving without an approval. Do not change it.
 *
 * The credential columns have no default. An unset credential is unset;
 * `readCredentialForServerUse` raises {@link CredentialNotConfiguredError} rather
 * than returning a placeholder that would reach a provider as if it were a key.
 *
 * ## Ranges agree with the database
 *
 * Every range in {@link CONFIGURATION_SPECS} is the same range as the `CHECK` in
 * `supabase/migrations/20260101000001_money_domains_tenancy_configuration.sql`. A
 * value this module accepts and the database rejects would surface as an opaque
 * constraint violation at write time; a value this module rejects and the database
 * accepts would make the service the tighter of two authorities, which is a
 * different bug with the same cause. The two must be read together when either
 * changes.
 *
 * ## Money
 *
 * The three paise-typed columns are `Paise` (`bigint`) end to end and go through
 * `assertInRange` before the column range is applied. Nothing here calls
 * `Number(...)` on a monetary value (Requirement 15.1, 15.8).
 */

import { assertInRange, type Paise } from '@/calc/paise';
import { getEnv, Secret } from '@/config/env';
import {
  type CredentialBinding,
  type CredentialSlot,
  openCredential,
  sealCredential,
} from '@/config/credential-crypto';

/** A Tenant identifier. UUID, per `tenants.id`. */
export type TenantId = string;

/**
 * The four credential kinds, exactly. The Razorpay test-mode key plus one key per
 * Model_Provider in the routing chains. Frontier reasoning models are reached
 * through OpenRouter under the `openrouter` credential, so there is no separate
 * vendor key for them, and **there is no OpenAI provider in this project**.
 * `razorpay_live` is deliberately absent from the MVP set.
 */
export type CredentialKind = 'razorpay_test' | 'openrouter' | 'gemini' | 'groq';

/** All four kinds, for iteration. */
export const CREDENTIAL_KINDS: readonly CredentialKind[] = [
  'razorpay_test',
  'openrouter',
  'gemini',
  'groq',
] as const;

/** Who performed a configuration change. Mirrors `audit_events.actor_kind` / `actor_id`. */
export interface Actor {
  readonly kind: 'user' | 'agent' | 'policy_engine';
  /** A User identifier, an Agent name, or the Policy_Engine identifier. */
  readonly id: string;
}

/**
 * What a client may learn about a stored credential: that it exists, and which slot
 * it occupies. The reference carries **no character of the value**, matching the
 * `Secret` mask discipline in `./env`: a tail like `sk_…abcd` is friendlier for an
 * operator but still discloses key material, and the kind alone identifies the
 * credential.
 */
export interface MaskedCredential {
  readonly kind: CredentialKind;
  /** `[redacted:credential:<kind>]`. The only representation a client ever sees. */
  readonly reference: string;
  readonly configured: boolean;
}

/**
 * The effective configuration for a Tenant: stored value where set, documented
 * default where unset.
 *
 * `safety_buffer_paise` is the one field that can be `null` in the effective
 * configuration. Its documented default is 10 percent of the obligation amount
 * (Requirement 8.14), which is not a stored constant — it depends on the obligation
 * being asked about. `null` therefore means "no configured buffer, derive the
 * default per obligation", and the Cash_Agent resolves it and records the basis
 * (task 34.3). Returning a fabricated constant here would silently answer
 * affordability questions with the wrong buffer.
 */
export interface TenantConfiguration {
  /** Requirement 5.15. 0 means nothing auto-executes. */
  readonly auto_execute_threshold: number;
  /** Requirement 5.16, in hours. */
  readonly approval_window_hours: number;
  /** Requirement 6.11, in paise. */
  readonly compliance_review_threshold_paise: Paise;
  /** Requirement 6.11. TDS-applicable category to percentage. Unlisted categories fall back to {@link TDS_DEFAULT_RATE_PERCENT}. */
  readonly tds_rates: Readonly<Record<string, number>>;
  /** Requirement 6.10. The set of valid GST rates, as percentages. */
  readonly valid_gst_rates: readonly number[];
  /** Requirement 8.1, in days. */
  readonly forecast_horizon_days: number;
  /** Requirement 8.14, in paise. `null` means derive 10 percent of the obligation. */
  readonly safety_buffer_paise: Paise | null;
  /** Requirement 9.5, in days. */
  readonly lookback_window_days: number;
  /** Requirement 9.6. */
  readonly minimum_sample_size: number;
  /** Requirement 9.11, in days. */
  readonly maximum_retry_age_days: number;
  /** Requirement 10.4. */
  readonly unusual_multiple: number;
  /** Requirement 11.5, in milliseconds. */
  readonly model_timeout_ms: number;
  /** Requirement 11.13, in paise. */
  readonly model_monthly_cap_paise: Paise;
  /** Requirement 13.9, in days. */
  readonly audit_retention_days: number;
}

/** Every configuration column name. */
export type ConfigurationColumn = keyof TenantConfiguration;

/**
 * The rate applied to a TDS-applicable category the Tenant has configured no rate
 * for: 10.00 percent (Requirement 6.11). This is a per-category fallback, not a
 * column default — `tds_rates` itself defaults to the empty map, because the set of
 * TDS-applicable categories is the Compliance_Agent's, not the schema's.
 */
export const TDS_DEFAULT_RATE_PERCENT = 10.0;

/* -------------------------------------------------------------------------- */
/* The defaults and ranges table                                              */
/* -------------------------------------------------------------------------- */

interface SpecCommon {
  /** The acceptance criterion the default and range come from. */
  readonly requirement: string;
  /** Anything about this column that a reader would otherwise have to infer. */
  readonly note?: string;
}

interface IntegerSpec extends SpecCommon {
  readonly kind: 'integer';
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

interface PaiseSpec extends SpecCommon {
  readonly kind: 'paise';
  /** `null` where the documented default is derived rather than constant. */
  readonly default: Paise | null;
  readonly min: Paise;
  readonly max: Paise;
}

interface DecimalSpec extends SpecCommon {
  readonly kind: 'decimal';
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly decimals: number;
}

interface RateMapSpec extends SpecCommon {
  readonly kind: 'rate_map';
  readonly default: Readonly<Record<string, number>>;
  readonly min: number;
  readonly max: number;
  readonly decimals: number;
}

interface RateSetSpec extends SpecCommon {
  readonly kind: 'rate_set';
  readonly default: readonly number[];
  readonly min: number;
  readonly max: number;
  readonly decimals: number;
}

export type ConfigurationSpec =
  | IntegerSpec
  | PaiseSpec
  | DecimalSpec
  | RateMapSpec
  | RateSetSpec;

/**
 * Every documented default and range, in one auditable place.
 *
 * The type is a `Record` over `ConfigurationColumn` rather than an array, so adding
 * a field to {@link TenantConfiguration} without stating its default and range is a
 * compile error rather than a silently missing default.
 *
 * Each range below is the same range as the column's `CHECK` in migration
 * `20260101000001_money_domains_tenancy_configuration.sql`.
 */
export const CONFIGURATION_SPECS: Readonly<Record<ConfigurationColumn, ConfigurationSpec>> =
  Object.freeze({
    auto_execute_threshold: {
      kind: 'integer',
      default: 0,
      min: 0,
      max: 100,
      requirement: '5.15',
      note:
        'Defaults to 0 so nothing auto-executes until a Tenant deliberately raises it. ' +
        'This is a safety rule, not a placeholder.',
    },
    approval_window_hours: {
      kind: 'integer',
      default: 24,
      min: 1,
      max: 168,
      requirement: '5.16',
    },
    compliance_review_threshold_paise: {
      kind: 'paise',
      // Requirement 6.11 states the threshold in INR: 0 to 100000000, default 50000.
      default: 5_000_000n, // ₹50,000
      min: 0n,
      max: 10_000_000_000n, // ₹10,00,00,000
      requirement: '6.11',
    },
    tds_rates: {
      kind: 'rate_map',
      default: Object.freeze({}),
      min: 0,
      max: 30,
      decimals: 2,
      requirement: '6.11',
      note:
        'The column default is the empty map; an unlisted TDS-applicable category ' +
        'resolves to TDS_DEFAULT_RATE_PERCENT (10.00). The column is plain JSONB with ' +
        'no CHECK, so the 0.00-30.00 range is enforced here only.',
    },
    valid_gst_rates: {
      kind: 'rate_set',
      default: Object.freeze([0, 0.25, 3, 5, 12, 18, 28]),
      min: 0,
      max: 100,
      decimals: 2,
      requirement: '6.10',
      note:
        'design.md and Requirement 6.10 state the default set but no range. The column ' +
        'is plain JSONB with no CHECK, so only structural validation is documented: ' +
        'a non-empty set of distinct percentages. The 0-100 bound is a sanity bound, ' +
        'not a documented one.',
    },
    forecast_horizon_days: {
      kind: 'integer',
      default: 90,
      min: 30,
      max: 180,
      requirement: '8.1',
    },
    safety_buffer_paise: {
      kind: 'paise',
      default: null,
      min: 0n,
      max: 100_000_000_000n,
      requirement: '8.14',
      note:
        'No constant default: Requirement 8.14 derives an unset buffer as 10 percent of ' +
        'the obligation rounded half up, which depends on the obligation. get() returns ' +
        'null and the Cash_Agent records the basis as default. ' +
        'design.md contradicts itself on the ceiling — the prose says "0-Rs 10 Crore" ' +
        '(10000000000 paise) while the DDL and the migration CHECK say 100000000000 ' +
        'paise. The migration wins, because a value this module accepted and the ' +
        'database rejected would be the worse failure.',
    },
    lookback_window_days: {
      kind: 'integer',
      default: 180,
      min: 30,
      max: 730,
      requirement: '9.5',
    },
    minimum_sample_size: {
      kind: 'integer',
      default: 50,
      min: 10,
      max: 1000,
      requirement: '9.6',
    },
    maximum_retry_age_days: {
      kind: 'integer',
      default: 7,
      min: 1,
      max: 30,
      requirement: '9.11',
    },
    unusual_multiple: {
      kind: 'decimal',
      default: 5.0,
      min: 1.5,
      max: 20.0,
      decimals: 1, // NUMERIC(4,1)
      requirement: '10.4',
    },
    model_timeout_ms: {
      kind: 'integer',
      default: 30_000,
      min: 1_000,
      max: 60_000,
      requirement: '11.5',
    },
    model_monthly_cap_paise: {
      kind: 'paise',
      // Requirement 11.13 states the cap in INR: Rs 1 to Rs 10,00,000, default Rs 10,000.
      default: 1_000_000n, // ₹10,000
      min: 100n, // ₹1
      max: 100_000_000n, // ₹10,00,000
      requirement: '11.13',
    },
    audit_retention_days: {
      kind: 'integer',
      default: 2555,
      min: 2555,
      max: 2_147_483_647,
      requirement: '13.9',
      note:
        'The CHECK is `>= 2555` with no upper bound; the maximum here is the INT ' +
        'ceiling, which is the bound the database actually enforces. Retention is a ' +
        'floor, so the default is the floor.',
    },
  } satisfies Record<ConfigurationColumn, ConfigurationSpec>);

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Thrown when a configuration value is outside its documented range or malformed. */
export class ConfigurationValidationError extends RangeError {
  override readonly name = 'ConfigurationValidationError';

  readonly column: string;

  constructor(column: string, problem: string, permitted: string, requirement: string) {
    super(
      `${column} ${problem}. Permitted: ${permitted} (Requirement ${requirement}). ` +
        `No value was written.`,
    );
    this.column = column;
  }
}

/** Thrown when a patch names something that is not a configuration column. */
export class UnknownConfigurationColumnError extends TypeError {
  override readonly name = 'UnknownConfigurationColumnError';

  readonly column: string;

  constructor(column: string) {
    super(
      `'${column}' is not a configuration column. Credential columns are not writable ` +
        `through put(); use putCredential(). Known columns: ` +
        `${Object.keys(CONFIGURATION_SPECS).join(', ')}.`,
    );
    this.column = column;
  }
}

/** Thrown when a credential is read for server use but the Tenant has not set one. */
export class CredentialNotConfiguredError extends Error {
  override readonly name = 'CredentialNotConfiguredError';

  readonly kind: CredentialKind;

  constructor(kind: CredentialKind) {
    super(
      `no '${kind}' credential is configured for this Tenant. An unset credential is ` +
        `unset; there is no placeholder value.`,
    );
    this.kind = kind;
  }
}

/** Thrown when the Tenant scope is absent or not a UUID. Fails closed. */
export class ConfigurationScopeError extends Error {
  override readonly name = 'ConfigurationScopeError';
}

/**
 * Thrown when a credential value is structurally unusable. The message describes the
 * shape only — never the value, because an error message is one of the channels
 * Requirement 14.5 excludes a credential value from.
 */
export class CredentialValueError extends Error {
  override readonly name = 'CredentialValueError';

  readonly kind: CredentialKind;

  constructor(kind: CredentialKind, problem: string) {
    super(`the '${kind}' credential value ${problem}. The value is not echoed.`);
    this.kind = kind;
  }
}

/* -------------------------------------------------------------------------- */
/* Storage seam                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One `tenant_configuration` row, already coerced out of the wire format. Every
 * column is nullable, exactly as the table declares it, and an absent row is
 * `null` rather than a row of nulls — `get` must behave identically for both.
 *
 * The paise columns are `Paise` here, not `number` or `string`: the coercion from
 * the PostgREST representation belongs to the store adapter
 * (`./configuration-store`), so nothing in this module calls `Number(...)` on a
 * monetary value.
 */
export interface ConfigurationRow {
  readonly auto_execute_threshold: number | null;
  readonly approval_window_hours: number | null;
  readonly compliance_review_threshold_paise: Paise | null;
  readonly tds_rates: Readonly<Record<string, number>> | null;
  readonly valid_gst_rates: readonly number[] | null;
  readonly forecast_horizon_days: number | null;
  readonly safety_buffer_paise: Paise | null;
  readonly lookback_window_days: number | null;
  readonly minimum_sample_size: number | null;
  readonly maximum_retry_age_days: number | null;
  readonly unusual_multiple: number | null;
  readonly model_timeout_ms: number | null;
  readonly model_monthly_cap_paise: Paise | null;
  readonly audit_retention_days: number | null;
  /** The masked reference held for the Razorpay credential. Never a value. */
  readonly razorpay_key_id_masked: string | null;
  /** AES-256-GCM envelope for the `razorpay_test` credential. */
  readonly razorpay_key_secret_encrypted: Uint8Array | null;
  /** AES-256-GCM envelope over a JSON map of the three Model_Provider keys. */
  readonly provider_keys_encrypted: Uint8Array | null;
  readonly updated_at: string | null;
  readonly updated_by: string | null;
}

/** The subset of a row a write may set. */
export type ConfigurationRowPatch = Partial<Omit<ConfigurationRow, 'updated_at' | 'updated_by'>>;

/**
 * Persistence for `tenant_configuration`. Injected rather than imported so the
 * service is unit-testable without a database, and so the Tenant scope is the
 * adapter's concern rather than being re-derived at every call site.
 */
export interface ConfigurationStore {
  /** The Tenant's row, or `null` when the Tenant has never been configured. */
  read(tenantId: TenantId): Promise<ConfigurationRow | null>;
  /** Insert or update the row, setting `updated_at` and `updated_by`. Returns the stored row. */
  write(
    tenantId: TenantId,
    patch: ConfigurationRowPatch,
    updatedBy: string | null,
  ): Promise<ConfigurationRow>;
}

/* -------------------------------------------------------------------------- */
/* Audit seam                                                                 */
/* -------------------------------------------------------------------------- */

/** The Audit_Event types this service appends. */
export type ConfigurationAuditEventType =
  | 'configuration_updated'
  | 'credential_stored'
  | 'credential_replaced';

/**
 * One Audit_Event to append. `payload` never contains a credential value: for a
 * credential event it carries the kind and the masked reference only
 * (Requirement 14.5, 13.2).
 */
export interface ConfigurationAuditEvent {
  readonly tenantId: TenantId;
  readonly eventType: ConfigurationAuditEventType;
  readonly actor: Actor;
  readonly payload: Readonly<Record<string, unknown>>;
  /** UTC, ISO-8601 to millisecond precision (Requirement 13.1). */
  readonly occurredAt: string;
}

/**
 * Where Audit_Events go. Injected behind this interface for two reasons.
 *
 * The first is testability: a fake sink lets the audit contract be asserted in a
 * unit test.
 *
 * The second is that the live path is **not yet reachable**, and pretending
 * otherwise would hide it. `app.append_audit_event` (migration
 * `20260101000004_audit_log_append_only.sql`) reads `audit_sequence_counters` with
 * `SELECT ... FOR UPDATE` and never creates the row, so a Tenant with no counter row
 * cannot record its first Audit_Event — recorded as FINDING 4 in that migration, and
 * the seeding step is still unassigned. Separately, `tenant_configuration`,
 * `audit_events` and `audit_sequence_counters` are all `FORCE ROW LEVEL SECURITY`
 * with no policies until task 26.1, so they match zero rows for every role without
 * `BYPASSRLS`. Integration-testing the append against a live database is therefore
 * deferred to task 26.1, and the assertions here run against a fake.
 *
 * The real `FinanceOS_Audit_Service` is **task 25.1** (`src/audit/audit-service.ts`),
 * which owns the serialized per-Tenant sequence allocation, the 65536-byte payload
 * reduction and the Source_Record referencing rules. This interface is deliberately
 * narrower than that service — one method, three fields plus a timestamp, which is all
 * a configuration or credential change needs. When 25.1 lands,
 * `createSupabaseAuditSink` in `./configuration-store` delegates to it rather than
 * calling the RPC itself, and nothing in this module changes. The append itself is not
 * deferred: Requirement 14.5 requires a credential store or replace to be recorded, so
 * `putCredential` appends on every call.
 */
export interface ConfigurationAuditSink {
  append(event: ConfigurationAuditEvent): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Permission seam                                                            */
/* -------------------------------------------------------------------------- */

/** The two Permissions a configuration write can require (design.md, FinanceOS_API). */
export type ConfigurationPermission = 'configure_policy' | 'manage_credentials';

/** Throws when `actor` does not hold `permission` in `tenantId`. */
export type RequirePermission = (
  actor: Actor,
  permission: ConfigurationPermission,
  tenantId: TenantId,
) => Promise<void>;

/**
 * TODO(task 26.2): replace with `AuthorizationService.require`.
 *
 * FinanceOS_Authorization_Service does not exist yet — `src/authz` is empty and the
 * service is task 26.2 — and inventing a second authorisation mechanism here would
 * have to be unwound when the real one lands. So the check is a required constructor
 * dependency with this explicit, grep-able placeholder as the only way to opt out:
 * `git grep permissionCheckDeferredToTask26_2` finds every unauthorised call site,
 * which a silently optional dependency would not.
 *
 * Every FinanceOS_API route reaching `put` or `putCredential` must pass the real
 * check — `configure_policy` for policy values, `manage_credentials` for credentials
 * (Requirement 14.6) — before this placeholder is removed.
 */
export const permissionCheckDeferredToTask26_2: RequirePermission = async () => {
  // Intentionally empty. See the doc comment.
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** Decimal places in a number's plain decimal form. Exponential notation yields `Infinity`. */
function decimalPlaces(value: number): number {
  const text = String(value);
  if (text.includes('e') || text.includes('E')) {
    return Number.POSITIVE_INFINITY;
  }
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

function describeRange(spec: ConfigurationSpec): string {
  switch (spec.kind) {
    case 'integer':
      return `an integer from ${spec.min} to ${spec.max}`;
    case 'paise':
      return `integer paise from ${spec.min} to ${spec.max}`;
    case 'decimal':
      return `a number from ${spec.min} to ${spec.max} to ${spec.decimals} decimal place(s)`;
    case 'rate_map':
      return (
        `an object mapping category names to percentages from ${spec.min} to ${spec.max} ` +
        `to ${spec.decimals} decimal places`
      );
    case 'rate_set':
      return (
        `a non-empty array of distinct percentages from ${spec.min} to ${spec.max} ` +
        `to ${spec.decimals} decimal places`
      );
  }
}

function checkRate(
  column: string,
  spec: RateMapSpec | RateSetSpec,
  rate: unknown,
  where: string,
): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new ConfigurationValidationError(
      column,
      `has a non-numeric percentage ${where}`,
      describeRange(spec),
      spec.requirement,
    );
  }
  if (rate < spec.min || rate > spec.max) {
    throw new ConfigurationValidationError(
      column,
      `has the out-of-range percentage ${rate} ${where}`,
      describeRange(spec),
      spec.requirement,
    );
  }
  if (decimalPlaces(rate) > spec.decimals) {
    throw new ConfigurationValidationError(
      column,
      `has the percentage ${rate} ${where} with more than ${spec.decimals} decimal places`,
      describeRange(spec),
      spec.requirement,
    );
  }
  return rate;
}

/**
 * Validate one configuration value against its documented range, returning the value
 * in the shape the row holds. `null` is always accepted: it unsets the column, and an
 * unset column resolves to the documented default.
 *
 * @throws {ConfigurationValidationError} naming the column and the permitted range.
 */
export function validateConfigurationValue(
  column: ConfigurationColumn,
  value: unknown,
): ConfigurationRow[ConfigurationColumn] {
  const spec = CONFIGURATION_SPECS[column];
  if (value === null) {
    return null;
  }

  switch (spec.kind) {
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new ConfigurationValidationError(
          column,
          `must be an integer, received ${typeof value}`,
          describeRange(spec),
          spec.requirement,
        );
      }
      if (value < spec.min || value > spec.max) {
        throw new ConfigurationValidationError(
          column,
          `is out of range: ${value}`,
          describeRange(spec),
          spec.requirement,
        );
      }
      return value;
    }

    case 'paise': {
      if (typeof value !== 'bigint') {
        throw new ConfigurationValidationError(
          column,
          `must be integer paise as a bigint, received ${typeof value}`,
          describeRange(spec),
          spec.requirement,
        );
      }
      // The paise domain first, then the column's own narrower range. Never Number().
      assertInRange(value);
      if (value < spec.min || value > spec.max) {
        throw new ConfigurationValidationError(
          column,
          `is out of range: ${value}`,
          describeRange(spec),
          spec.requirement,
        );
      }
      return value;
    }

    case 'decimal': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ConfigurationValidationError(
          column,
          `must be a finite number, received ${typeof value}`,
          describeRange(spec),
          spec.requirement,
        );
      }
      if (value < spec.min || value > spec.max) {
        throw new ConfigurationValidationError(
          column,
          `is out of range: ${value}`,
          describeRange(spec),
          spec.requirement,
        );
      }
      if (decimalPlaces(value) > spec.decimals) {
        throw new ConfigurationValidationError(
          column,
          `has more than ${spec.decimals} decimal place(s): ${value}`,
          describeRange(spec),
          spec.requirement,
        );
      }
      return value;
    }

    case 'rate_map': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ConfigurationValidationError(
          column,
          `must be an object mapping category names to percentages`,
          describeRange(spec),
          spec.requirement,
        );
      }
      const out: Record<string, number> = {};
      for (const [category, rate] of Object.entries(value)) {
        if (category.trim().length === 0) {
          throw new ConfigurationValidationError(
            column,
            `has an empty category name`,
            describeRange(spec),
            spec.requirement,
          );
        }
        out[category] = checkRate(column, spec, rate, `for category '${category}'`);
      }
      return Object.freeze(out);
    }

    case 'rate_set': {
      if (!Array.isArray(value)) {
        throw new ConfigurationValidationError(
          column,
          `must be an array of percentages`,
          describeRange(spec),
          spec.requirement,
        );
      }
      if (value.length === 0) {
        throw new ConfigurationValidationError(
          column,
          `must not be empty: an empty valid-rate set would make every examined tax ` +
            `amount anomalous`,
          describeRange(spec),
          spec.requirement,
        );
      }
      const rates = value.map((rate, index) =>
        checkRate(column, spec, rate, `at index ${index}`),
      );
      if (new Set(rates).size !== rates.length) {
        throw new ConfigurationValidationError(
          column,
          `contains a duplicate percentage`,
          describeRange(spec),
          spec.requirement,
        );
      }
      // Ascending, so the stored set has one canonical form and equal sets compare equal.
      return Object.freeze([...rates].sort((a, b) => a - b));
    }
  }
}

/**
 * Validate a whole patch before anything is written, so a patch with one bad value
 * writes none of its values.
 *
 * @throws {UnknownConfigurationColumnError} for a key that is not a configuration column.
 * @throws {ConfigurationValidationError} for an out-of-range or malformed value.
 */
export function validateConfigurationPatch(
  patch: Readonly<Record<string, unknown>>,
): ConfigurationRowPatch {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(CONFIGURATION_SPECS, key)) {
      throw new UnknownConfigurationColumnError(key);
    }
    if (value === undefined) {
      continue; // absent from the patch, not an instruction to unset
    }
    out[key] = validateConfigurationValue(key as ConfigurationColumn, value);
  }
  return out as ConfigurationRowPatch;
}

/* -------------------------------------------------------------------------- */
/* Defaults resolution                                                        */
/* -------------------------------------------------------------------------- */

function defaultFor(column: ConfigurationColumn): TenantConfiguration[ConfigurationColumn] {
  return CONFIGURATION_SPECS[column].default as TenantConfiguration[ConfigurationColumn];
}

/**
 * The effective configuration: stored value where set, documented default where the
 * column is `NULL` or the row is absent entirely.
 *
 * Exported because it is pure and worth asserting directly: it is the function that
 * makes "an unconfigured Tenant behaves exactly as specified" true.
 */
export function effectiveConfiguration(row: ConfigurationRow | null): TenantConfiguration {
  const resolved: Record<string, unknown> = {};
  for (const column of Object.keys(CONFIGURATION_SPECS) as ConfigurationColumn[]) {
    const stored = row === null ? null : row[column];
    resolved[column] = stored ?? defaultFor(column);
  }
  return Object.freeze(resolved as unknown as TenantConfiguration);
}

/**
 * The TDS rate for a category: the Tenant's configured rate, or 10.00 percent where
 * the Tenant has configured none (Requirement 6.11).
 */
export function tdsRateForCategory(
  configuration: TenantConfiguration,
  category: string,
): number {
  return configuration.tds_rates[category] ?? TDS_DEFAULT_RATE_PERCENT;
}

/* -------------------------------------------------------------------------- */
/* The service                                                                */
/* -------------------------------------------------------------------------- */

/** design.md's `ConfigurationService`, plus the masked read that Requirement 14.5 implies. */
export interface ConfigurationService {
  /** The full effective configuration: stored values with documented defaults applied. */
  get(tenantId: TenantId): Promise<TenantConfiguration>;

  /**
   * Validate against the documented ranges, write, audit, and return the new effective
   * configuration. Requires `configure_policy`.
   */
  put(
    tenantId: TenantId,
    patch: Partial<TenantConfiguration>,
    actor: Actor,
  ): Promise<TenantConfiguration>;

  /**
   * Seal a credential at rest and return a masked reference only. Requires
   * `manage_credentials`.
   */
  putCredential(
    tenantId: TenantId,
    kind: CredentialKind,
    value: string,
    actor: Actor,
  ): Promise<MaskedCredential>;

  /**
   * The masked reference for every credential kind, with whether one is set. This is
   * what "return only a masked reference for every subsequent read request"
   * (Requirement 14.5) looks like on the read side.
   */
  listCredentials(tenantId: TenantId): Promise<readonly MaskedCredential[]>;

  /**
   * The only path to a credential plaintext. Server-only: no HTTP route returns this.
   *
   * Returns a {@link Secret} rather than design.md's bare `string`, so the value
   * inherits the masking of `toString`, `toJSON`, `Symbol.toPrimitive` and the Node
   * inspect hook and cannot reach a log line or an error payload without an explicit
   * `.reveal()`.
   */
  readCredentialForServerUse(tenantId: TenantId, kind: CredentialKind): Promise<Secret>;
}

export interface ConfigurationServiceDeps {
  readonly store: ConfigurationStore;
  readonly audit: ConfigurationAuditSink;
  /** Pass `permissionCheckDeferredToTask26_2` only where task 26.2 is not yet wired. */
  readonly requirePermission: RequirePermission;
  /** `CREDENTIAL_ENCRYPTION_KEY`. Defaults to the loaded environment; never hardcoded. */
  readonly encryptionKey?: Secret;
  /** Test seam for `occurred_at`. */
  readonly now?: () => Date;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireTenantId(tenantId: TenantId): TenantId {
  if (!UUID_RE.test(tenantId)) {
    throw new ConfigurationScopeError(
      `a Tenant identifier as a UUID is required; configuration and credentials are ` +
        `per-Tenant and an unscoped call has no meaning.`,
    );
  }
  return tenantId;
}

/** The masked reference for a kind. Carries no character of the value. */
export function maskedReferenceFor(kind: CredentialKind): string {
  return `[redacted:credential:${kind}]`;
}

/** Which `BYTEA` column a kind lives in. The schema gives the three provider keys one column. */
function slotFor(kind: CredentialKind): CredentialSlot {
  return kind === 'razorpay_test' ? 'razorpay_test' : 'provider_keys';
}

function bindingFor(tenantId: TenantId, kind: CredentialKind): CredentialBinding {
  return { tenantId, slot: slotFor(kind) };
}

/** Paise cannot go through `JSON.stringify`, and an audit payload is JSON. */
function auditable(value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function createConfigurationService(
  deps: ConfigurationServiceDeps,
): ConfigurationService {
  const { store, audit, requirePermission } = deps;
  const clock = deps.now ?? (() => new Date());
  // Resolved lazily so constructing the service in a test never demands a real key.
  const keyOf = (): Secret => deps.encryptionKey ?? getEnv().CREDENTIAL_ENCRYPTION_KEY;

  /**
   * The plaintext Model_Provider key map.
   *
   * This is the one place a decrypted map exists as bare strings, and it exists because
   * the schema stores all three provider keys in a single `provider_keys_encrypted`
   * column: replacing one key requires opening the map, merging, and re-sealing. The
   * return value never leaves this module — `putCredential` re-seals it,
   * `listCredentials` reads only its keys, and `readCredentialForServerUse` immediately
   * wraps the selected value in a `Secret`.
   */
  function openProviderKeys(
    row: ConfigurationRow | null,
    tenantId: TenantId,
  ): Record<string, string> {
    const sealed = row?.provider_keys_encrypted ?? null;
    if (sealed === null) {
      return {};
    }
    const opened = openCredential(sealed, keyOf(), {
      tenantId,
      slot: 'provider_keys',
    }).reveal();
    const parsed: unknown = JSON.parse(opened);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [kind, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        out[kind] = value;
      }
    }
    return out;
  }

  function isConfigured(
    row: ConfigurationRow | null,
    kind: CredentialKind,
    tenantId: TenantId,
  ): boolean {
    if (kind === 'razorpay_test') {
      return (row?.razorpay_key_secret_encrypted ?? null) !== null;
    }
    return Object.hasOwn(openProviderKeys(row, tenantId), kind);
  }

  return {
    async get(tenantId) {
      const id = requireTenantId(tenantId);
      return effectiveConfiguration(await store.read(id));
    },

    async put(tenantId, patch, actor) {
      const id = requireTenantId(tenantId);
      await requirePermission(actor, 'configure_policy', id);

      // Validated in full before anything is written, so a patch with one bad value
      // leaves the row untouched.
      const rowPatch = validateConfigurationPatch(patch as Readonly<Record<string, unknown>>);
      const columns = Object.keys(rowPatch) as ConfigurationColumn[];
      const before = await store.read(id);
      const stored = await store.write(
        id,
        rowPatch,
        actor.kind === 'user' ? actor.id : null,
      );

      await audit.append({
        tenantId: id,
        eventType: 'configuration_updated',
        actor,
        occurredAt: clock().toISOString(),
        payload: {
          changed: columns.map((column) => ({
            column,
            from: auditable(before === null ? null : (before[column] ?? null)),
            to: auditable(rowPatch[column] ?? null),
            default_applied_when_unset: auditable(CONFIGURATION_SPECS[column].default),
          })),
        },
      });

      return effectiveConfiguration(stored);
    },

    async putCredential(tenantId, kind, value, actor) {
      const id = requireTenantId(tenantId);
      await requirePermission(actor, 'manage_credentials', id);

      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new CredentialValueError(kind, 'must be a non-empty string');
      }
      if (value !== value.trim()) {
        throw new CredentialValueError(
          kind,
          'must not carry leading or trailing whitespace, which would be sent verbatim ' +
            'to the provider and fail authentication for a reason no log would show',
        );
      }

      const before = await store.read(id);
      const replacing = isConfigured(before, kind, id);
      const reference = maskedReferenceFor(kind);

      const patch: ConfigurationRowPatch =
        kind === 'razorpay_test'
          ? {
              razorpay_key_secret_encrypted: sealCredential(
                value,
                keyOf(),
                bindingFor(id, kind),
              ),
              // The migration designates this column as the masked reference held for
              // the Razorpay credential. It holds the reference, never key material.
              razorpay_key_id_masked: reference,
            }
          : {
              provider_keys_encrypted: sealCredential(
                JSON.stringify({ ...openProviderKeys(before, id), [kind]: value }),
                keyOf(),
                bindingFor(id, kind),
              ),
            };

      await store.write(id, patch, actor.kind === 'user' ? actor.id : null);

      // The payload carries the kind and the masked reference. No value, no length, no
      // prefix, no fingerprint (Requirement 14.5, 13.2).
      await audit.append({
        tenantId: id,
        eventType: replacing ? 'credential_replaced' : 'credential_stored',
        actor,
        occurredAt: clock().toISOString(),
        payload: { kind, masked_reference: reference, encryption: 'aes-256-gcm' },
      });

      return Object.freeze({ kind, reference, configured: true });
    },

    async listCredentials(tenantId) {
      const id = requireTenantId(tenantId);
      const row = await store.read(id);
      return Object.freeze(
        CREDENTIAL_KINDS.map((kind) =>
          Object.freeze({
            kind,
            reference: maskedReferenceFor(kind),
            configured: isConfigured(row, kind, id),
          }),
        ),
      );
    },

    async readCredentialForServerUse(tenantId, kind) {
      const id = requireTenantId(tenantId);
      const row = await store.read(id);

      if (kind === 'razorpay_test') {
        const sealed = row?.razorpay_key_secret_encrypted ?? null;
        if (sealed === null) {
          throw new CredentialNotConfiguredError(kind);
        }
        return openCredential(sealed, keyOf(), bindingFor(id, kind));
      }

      const value = openProviderKeys(row, id)[kind];
      if (value === undefined) {
        throw new CredentialNotConfiguredError(kind);
      }
      return new Secret(`credential:${kind}`, value);
    },
  };
}
