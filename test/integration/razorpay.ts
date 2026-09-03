/**
 * Gates and fixtures for the Razorpay test-mode integration suite (task 6.5, CI stage 11).
 *
 * HOW TO RUN THIS SUITE
 * ---------------------
 *   npm run test:integration
 *
 * The script loads `.env.local` if it exists, so a Razorpay test-mode key placed there is
 * picked up without exporting it into the shell:
 *
 *   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
 *   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
 *
 * Nothing here reads any other environment variable, and `getEnv()` is deliberately not
 * used: it parses the whole environment through one schema and throws naming every failing
 * variable, so a machine with a Razorpay key but no `GROQ_API_KEY` could not run these
 * tests. `scripts/seed-razorpay-testmode.ts` reads the same two variables the same way for
 * the same reason.
 *
 * THREE INDEPENDENT GATES, BECAUSE THE FOUR SCENARIOS NEED DIFFERENT THINGS
 * ------------------------------------------------------------------------
 * 1. {@link testModeCredential} — a real test-mode key. Needed by paging, by the
 *    single-type-error case, and by every payload-shape confirmation, because none of
 *    those can see an object without one. Absent, those suites skip with the two variable
 *    names printed, exactly as `test/db/pg.ts` skips when Supabase local is down.
 * 2. {@link razorpayApiReachable} — the API answers at all. This is a *separate* gate
 *    because the credential-rejection case of Requirement 1.10 needs **no valid
 *    credential**: a syntactically well-formed but wrong key is all a 401 requires, and a
 *    401 is the whole input to that scenario. So that case runs on a machine that has
 *    network and a database and no Razorpay account whatsoever.
 * 3. `database().reachable` from `test/db/pg.ts` — Supabase local. Needed wherever a
 *    scenario asserts on *stored* state: "zero objects stored for the run", "prior objects
 *    unchanged", "the run is `partially_completed`". Those are state guarantees and only a
 *    real database can answer them.
 *
 * WHY THE PROBE IS ONE REQUEST WITH A FABRICATED KEY
 * -------------------------------------------------
 * {@link razorpayApiReachable} sends a single `GET /v1/payments?count=1` with
 * {@link fabricatedBadCredential}. A network fault and a 401 are then distinguishable: a
 * thrown `fetch` means the API is unreachable, any HTTP status means it answered. The
 * fabricated key belongs to no account, so the request cannot lock anyone out, and it is
 * sent once per worker and memoised. This module never sends a request in a loop and never
 * retries against the live API on purpose — see the rate-limit note in the test file.
 *
 * CREDENTIALS
 * -----------
 * Every credential here is a {@link Secret}, so no half of one can reach a log line, an
 * error message, a thrown object or `JSON.stringify` output without an explicit
 * `.reveal()`, and constructing one registers its value in the value-keyed redaction table
 * so a provider that echoes it back is scrubbed too (Requirement 14.5). No value is
 * printed by anything in this file.
 */

import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import { Secret } from '@/config/env';
import type { IngestionStore, RazorpayObjectRow } from '@/ingestion/ingestion-service';
import {
  RAZORPAY_OBJECT_COLUMNS,
  RAZORPAY_OBJECT_UPDATE_COLUMNS,
} from '@/ingestion/ingestion-store';
import { RAZORPAY_BASE_URL, type RazorpayCredential } from '@/ingestion/razorpay-client';
import { claims, jsonAt, lit, runOk, type Fixture } from '../db/pg';

/* -------------------------------------------------------------------------- */
/* The sentinel (Requirement 14.5)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every credential this suite fabricates carries this string. It must appear in no request
 * URL, no `RazorpayFetchResult`, no error message, no thrown object, no `JSON.stringify`
 * output and no log line. Same discipline as `src/config/configuration-service.test.ts`
 * and `src/ingestion/razorpay-client.test.ts`.
 */
export const SENTINEL = 'SENTINEL_CREDENTIAL_DO_NOT_LEAK';

/**
 * A syntactically well-formed Razorpay test key that belongs to no account.
 *
 * `rzp_test_` prefix and a 14-character body, which is the shape Razorpay issues, so the
 * request is rejected for the reason under test — the credential — rather than for being
 * malformed. Both halves carry {@link SENTINEL}, which is what makes the live 401 path
 * double as a Requirement 14.5 assertion: if Razorpay echoed the key id back in its error
 * body, `redactSecrets` would have to scrub it, and the test checks that it did.
 */
export function fabricatedBadCredential(): RazorpayCredential {
  return {
    keyId: new Secret('RAZORPAY_KEY_ID', `rzp_test_${SENTINEL}`),
    keySecret: new Secret('RAZORPAY_KEY_SECRET', `rzp_secret_${SENTINEL}`),
  };
}

/* -------------------------------------------------------------------------- */
/* Gate 1: a real test-mode credential                                        */
/* -------------------------------------------------------------------------- */

const KEY_ID_VAR = 'RAZORPAY_KEY_ID';
const KEY_SECRET_VAR = 'RAZORPAY_KEY_SECRET';

export interface CredentialAvailability {
  readonly available: boolean;
  /** Why not, when `available` is false. Names variables, never values. */
  readonly reason: string;
  readonly credential: RazorpayCredential | null;
  readonly missing: readonly string[];
}

function probeCredential(): CredentialAvailability {
  const keyId = process.env[KEY_ID_VAR];
  const keySecret = process.env[KEY_SECRET_VAR];
  const missing: string[] = [];
  if (keyId === undefined || keyId.trim().length === 0) {
    missing.push(KEY_ID_VAR);
  }
  if (keySecret === undefined || keySecret.trim().length === 0) {
    missing.push(KEY_SECRET_VAR);
  }
  if (missing.length > 0 || keyId === undefined || keySecret === undefined) {
    return {
      available: false,
      reason:
        `no Razorpay test-mode credential: ${missing.join(' and ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} unset or empty. Put both in .env.local ` +
        `(RAZORPAY_KEY_ID=rzp_test_..., RAZORPAY_KEY_SECRET=...) and re-run ` +
        `\`npm run test:integration\`; the suite then runs unmodified.`,
      credential: null,
      missing,
    };
  }
  return {
    available: true,
    reason: '',
    credential: {
      keyId: new Secret(KEY_ID_VAR, keyId.trim()),
      keySecret: new Secret(KEY_SECRET_VAR, keySecret.trim()),
    },
    missing: [],
  };
}

let credentialCache: CredentialAvailability | undefined;

/** Memoised per worker. Synchronous, so it is usable from `describe.skipIf`. */
export function testModeCredential(): CredentialAvailability {
  credentialCache ??= probeCredential();
  return credentialCache;
}

let credentialAnnounced = false;

/**
 * Print the skip reason once per worker.
 *
 * Straight to file descriptor 2, not `console.warn`: Vitest intercepts console output and
 * attaches it to the running test, then discards it when that test is skipped — which is
 * exactly the case this message exists for. Same reasoning as `announceIfUnreachable()` in
 * `test/db/pg.ts`.
 */
export function announceIfNoCredential(): void {
  const probe = testModeCredential();
  if (!probe.available && !credentialAnnounced) {
    credentialAnnounced = true;
    writeSync(2, `\n[integration] SKIPPING the credentialed Razorpay cases - ${probe.reason}\n\n`);
  }
}

/** Print an arbitrary skip or finding note on the same channel, for the same reason. */
export function note(message: string): void {
  writeSync(2, `[integration] ${message}\n`);
}

/* -------------------------------------------------------------------------- */
/* Gate 2: the API answers                                                    */
/* -------------------------------------------------------------------------- */

export interface ApiReachability {
  readonly reachable: boolean;
  readonly reason: string;
  /** The status the probe saw, or `null` when nothing answered. */
  readonly status: number | null;
}

let apiCache: Promise<ApiReachability> | undefined;

/**
 * One `GET /v1/payments?count=1` with the fabricated key, memoised per worker.
 *
 * Any HTTP status means the API answered, so the credential-rejection scenario can run.
 * A thrown `fetch` means it did not, and every live case skips with that reason rather
 * than failing: Requirement 1.10 is about how ingestion reacts to a 401, and a machine
 * with no egress cannot produce one.
 */
export function razorpayApiReachable(): Promise<ApiReachability> {
  apiCache ??= (async (): Promise<ApiReachability> => {
    const bad = fabricatedBadCredential();
    const authorization = `Basic ${Buffer.from(
      `${bad.keyId.reveal()}:${bad.keySecret.reveal()}`,
      'utf8',
    ).toString('base64')}`;
    try {
      const response = await fetch(new URL('/v1/payments?count=1', RAZORPAY_BASE_URL), {
        method: 'GET',
        headers: { authorization, accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      return { reachable: true, reason: '', status: response.status };
    } catch (cause) {
      return {
        reachable: false,
        reason:
          `the Razorpay API did not answer (${
            cause instanceof Error ? cause.name : 'unknown fault'
          }); this machine has no egress to ${RAZORPAY_BASE_URL}, so no live case can run.`,
        status: null,
      };
    }
  })();
  return apiCache;
}

/* -------------------------------------------------------------------------- */
/* Gate 3's fixture: a psql-backed IngestionStore                             */
/* -------------------------------------------------------------------------- */

function paise(value: bigint | null): string {
  return value === null ? 'null' : value.toString();
}

function text(value: string | null): string {
  return value === null ? 'null' : lit(value);
}

function rowValues(row: RazorpayObjectRow): string {
  return (
    `(${lit(row.tenant_id)}, ${lit(row.razorpay_id)}, ` +
    `${lit(row.object_type)}::razorpay_object_type, ${lit(row.ingestion_run_id)}, ` +
    `${lit(row.retrieved_at)}, ${lit(row.created_at_rzp)}, ${paise(row.amount_paise)}, ` +
    `${paise(row.fee_paise)}, ${paise(row.gst_on_fee_paise)}, ${lit(row.currency)}, ` +
    `${text(row.status_rzp)}, ${lit(JSON.stringify(row.payload))}::jsonb)`
  );
}

const UPSERT_TAIL =
  `on conflict on constraint razorpay_objects_tenant_rzp_uniq do update set ` +
  RAZORPAY_OBJECT_UPDATE_COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ');

/**
 * The same {@link IngestionStore} the PostgREST adapter implements, driven over `psql`.
 *
 * `test/db/ingestion-run.test.ts` has a store of this shape for the same reason — the
 * PostgREST path cannot be exercised until task 26.1 adds the RLS policies, since every
 * ingestion table is `FORCE ROW LEVEL SECURITY` with no policies today. It is written here
 * rather than imported from that file because importing a `.test.ts` from another Vitest
 * project would collect its suite too. What actually keeps the two from drifting is that
 * both compose their statements from `RAZORPAY_OBJECT_COLUMNS` and
 * `RAZORPAY_OBJECT_UPDATE_COLUMNS`, which are exported by
 * `src/ingestion/ingestion-store.ts` and shared with the PostgREST path.
 */
export function psqlIngestionStore(f: Fixture): IngestionStore {
  return {
    async createRun(run) {
      const id = randomUUID();
      runOk(
        `${claims(f)}
insert into ingestion_runs
  (id, tenant_id, started_at, status, window_from, window_basis, initiated_by)
values (${lit(id)}, ${lit(run.tenantId)}, ${lit(run.startedAt)}, 'in_progress',
        ${lit(run.windowFrom)}, ${lit(run.windowBasis)}, ${lit(run.initiatedBy)});`,
      );
      return { id, startedAt: run.startedAt };
    },

    async upsertObjects(rows) {
      if (rows.length === 0) {
        return;
      }
      runOk(
        `${claims(f)}
insert into razorpay_objects (${RAZORPAY_OBJECT_COLUMNS.join(', ')})
values ${rows.map(rowValues).join(',\n       ')}
${UPSERT_TAIL};`,
      );
    },

    async recordErrors(tenantId, runId, errors) {
      if (errors.length === 0) {
        return;
      }
      const values = errors
        .map(
          (e) =>
            `(${lit(tenantId)}, ${lit(runId)}, ${lit(e.objectType)}::razorpay_object_type, ` +
            `${lit(e.errorCode)}, ${lit(e.errorCategory)}, ${e.retryCount}, ` +
            `${lit(e.requestedAt)})`,
        )
        .join(',\n       ');
      runOk(
        `${claims(f)}
insert into ingestion_errors
  (tenant_id, ingestion_run_id, object_type, error_code, error_category, retry_count,
   requested_at)
values ${values};`,
      );
    },

    async completeRun(completion) {
      runOk(
        `${claims(f)}
update ingestion_runs set
  ended_at = ${lit(completion.endedAt)},
  status = ${lit(completion.status)}::ingestion_status,
  failure_kind = ${text(completion.failureKind)},
  per_type_stored = ${lit(JSON.stringify(completion.perTypeStored))}::jsonb,
  per_type_errors = ${completion.totalErrors}
where id = ${lit(completion.runId)} and tenant_id = ${lit(completion.tenantId)};`,
      );
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Reading stored state back                                                  */
/* -------------------------------------------------------------------------- */

export interface StoredRow {
  /** `md5` of the whole row, so a change to any column shows up. */
  readonly md5: string;
  readonly payload: string;
  readonly retrieved_at: string;
  readonly ingestion_run_id: string;
  readonly amount_paise: string;
}

export function storedRow(f: Fixture, razorpayId: string): StoredRow {
  const r = runOk(
    `${claims(f)}
select to_jsonb(x)::text from (
  select md5(o::text) as md5, o.payload::text as payload, o.retrieved_at::text as retrieved_at,
         o.ingestion_run_id::text as ingestion_run_id, o.amount_paise::text as amount_paise
  from razorpay_objects o
  where o.tenant_id = ${lit(f.tenantId)} and o.razorpay_id = ${lit(razorpayId)}
) x;`,
  );
  return jsonAt<StoredRow>(r, 0);
}

export function objectCountForRun(f: Fixture, runId: string): number {
  const r = runOk(
    `${claims(f)}
select to_jsonb(count(*))::text from razorpay_objects
where tenant_id = ${lit(f.tenantId)} and ingestion_run_id = ${lit(runId)};`,
  );
  return jsonAt<number>(r, 0);
}

export interface StoredRun {
  readonly status: string;
  readonly failure_kind: string | null;
  readonly ended_at: string | null;
  readonly per_type_stored: Record<string, number>;
  readonly per_type_errors: number;
  readonly window_basis: string;
}

export function storedRun(f: Fixture, runId: string): StoredRun {
  const r = runOk(
    `${claims(f)}
select to_jsonb(x)::text from (
  select status::text, failure_kind, ended_at::text, per_type_stored, per_type_errors,
         window_basis
  from ingestion_runs where id = ${lit(runId)} and tenant_id = ${lit(f.tenantId)}
) x;`,
  );
  return jsonAt<StoredRun>(r, 0);
}

export interface StoredError {
  readonly object_type: string;
  readonly error_code: string;
  readonly error_category: string;
  readonly retry_count: number;
}

export function storedErrors(f: Fixture, runId: string): readonly StoredError[] {
  const r = runOk(
    `${claims(f)}
select coalesce(jsonb_agg(x), '[]'::jsonb)::text from (
  select object_type::text, error_code, error_category, retry_count
  from ingestion_errors
  where tenant_id = ${lit(f.tenantId)} and ingestion_run_id = ${lit(runId)}
  order by object_type::text, error_code
) x;`,
  );
  return jsonAt<readonly StoredError[]>(r, 0);
}

/** Remove everything a fixture committed. FK order. */
export function cleanUp(f: Fixture): void {
  runOk(
    `${claims(f)}
delete from razorpay_objects where tenant_id = ${lit(f.tenantId)};
delete from ingestion_errors where tenant_id = ${lit(f.tenantId)};
delete from ingestion_runs where tenant_id = ${lit(f.tenantId)};
delete from chart_of_accounts where tenant_id = ${lit(f.tenantId)};
delete from audit_sequence_counters where tenant_id = ${lit(f.tenantId)};
delete from tenants where id = ${lit(f.tenantId)};
delete from users where id = ${lit(f.userId)};`,
  );
}

/* -------------------------------------------------------------------------- */
/* Log capture (Requirement 14.5)                                             */
/* -------------------------------------------------------------------------- */

export interface LogCapture {
  /** Everything written while the capture was open. */
  readonly lines: readonly string[];
  readonly stop: () => void;
}

/**
 * Capture `console` output and direct `process.stdout` / `process.stderr` writes, so "the
 * credential value appears in no log line" is asserted against what would actually have
 * been printed rather than against a mock logger.
 */
export function captureLogs(): LogCapture {
  const lines: string[] = [];
  const consoleKeys = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const originalConsole = new Map<string, unknown>();
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;

  for (const key of consoleKeys) {
    originalConsole.set(key, target[key]);
    target[key] = (...args: unknown[]): void => {
      lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }

  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const tap =
    (fallthrough: typeof originalOut) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      lines.push(typeof chunk === 'string' ? chunk : String(chunk));
      return (fallthrough as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
  process.stdout.write = tap(originalOut) as typeof process.stdout.write;
  process.stderr.write = tap(originalErr) as typeof process.stderr.write;

  return {
    lines,
    stop: () => {
      for (const key of consoleKeys) {
        target[key] = originalConsole.get(key) as (...args: unknown[]) => void;
      }
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
  };
}
