/**
 * Raw SQL access to the Supabase local database, for the `db` Vitest project.
 *
 * HOW TO RUN THIS SUITE
 * ---------------------
 *   1. Start Docker Desktop (or any Docker daemon).
 *   2. `npx supabase start`        - brings up the local stack and applies every
 *                                    migration in `supabase/migrations/` in filename
 *                                    order. First run pulls images and is slow.
 *   3. `npm run test:db`           - runs this project.
 *   4. `npx supabase stop`         - when finished. Add `--no-backup` to discard the
 *                                    volume.
 *
 * Already running but the schema looks wrong: `npx supabase db reset` reapplies the
 * migrations from scratch. That is also how to clear the rows the append-only suite
 * necessarily leaves behind - see the note at the top of `append-only.test.ts`.
 *
 * The suite finds the database by looking for the `supabase_db_*` container, so no
 * connection string or credential is configured anywhere. Set
 * `FINANCEOS_DB_CONTAINER` to point at a differently named container. When nothing
 * is found, every suite skips with the reason printed rather than failing.
 *
 * WHY NOT A POSTGRES DRIVER
 * -------------------------
 * These tests assert on things no PostgREST client can reach: SQLSTATE codes,
 * constraint names, `SET LOCAL ROLE`, and a `DEFERRABLE INITIALLY DEFERRED`
 * constraint trigger that only fires at `COMMIT`. That needs a raw SQL session.
 * A driver (`pg`) could not be added: `npm install` fails in this project for a
 * reason unrelated to the dependency (an npm/arborist `Invalid Version` fault on
 * `@rolldown/binding-openharmony-arm64`, an optional dependency of `rolldown`
 * reached through `vitest`), and it fails identically with no arguments at all.
 * So this module drives `psql` inside the `supabase_db_*` container instead,
 * which is dependency-free and speaks the same protocol the migrations were
 * written against. If the npm fault is fixed later, swapping this module for
 * `pg` changes no assertion in any test file.
 *
 * WHICH ROLE THE ASSERTIONS RUN AS - AN ORDERING CONSTRAINT, REVISIT AT 26.1/26.4
 * ------------------------------------------------------------------------------
 * Task 4.8 asks for the application role rather than the owner. That is not yet
 * reachable, and the reason is an ordering hazard rather than an oversight:
 *
 *   - Migrations 4.1..4.7 set `ENABLE ROW LEVEL SECURITY` and
 *     `FORCE ROW LEVEL SECURITY` on every tenant-scoped table, but the policies
 *     bound to `app.current_tenant_id()` do not land until task 26.1. Until then
 *     every one of those tables matches zero rows for any role without
 *     `BYPASSRLS`, including `authenticated` and `service_role`.
 *   - Supabase's `auto_expose_new_tables` is unset in `supabase/config.toml`, so
 *     `authenticated` holds no `INSERT`/`SELECT` grant on most of these tables
 *     either. The two exceptions are `ledger_entries` and `audit_events`, which
 *     migrations 4.3 and 4.4 grant explicitly.
 *
 * So the assertions 4.8 owns - domain ranges, the two ledger balance barriers,
 * append-only, the four idempotency constraints, the schema type audit - run as
 * `postgres`, which on Supabase local is NOT a superuser but does hold
 * `BYPASSRLS` (asserted by the probe below, so a change of that fact fails
 * loudly rather than silently reintroducing an owner-only read path). None of
 * those assertions is about RLS, so none needs the tenant predicate active.
 *
 * Every session still sets `request.jwt.claims`, so `app.current_tenant_id()`
 * and `app.current_user_id()` resolve to real values. `reject_mutation_and_audit`
 * reads `app.current_user_id()`, and the policies added in 26.1 will read the
 * tenant claim, so the fixture is already shaped for them.
 *
 * NOTHING HERE WEAKENS A MIGRATION. No policy is added and
 * `FORCE ROW LEVEL SECURITY` is not removed: fail-closed is the correct
 * direction. RLS behaviour is task 26.4's to assert, not this task's. What this
 * file does assert about roles is the fail-closed state itself - see
 * `append-only.test.ts`, which exercises the privilege barrier as
 * `authenticated`.
 *
 * TASK 26.1 / 26.4: once policies and grants exist, move the fixture setup to
 * the owner and the assertions to `authenticated`, and delete this note.
 */

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';

/** A parsed Postgres error. `sqlstate` and `constraint` are what tests assert on. */
export interface PgError {
  readonly sqlstate: string;
  readonly message: string;
  readonly constraint?: string;
  readonly datatype?: string;
  readonly table?: string;
}

/** The result of one `psql` session: its tuple lines and every error it raised. */
export interface ScriptResult {
  /** Tuple output, one line per emitted row, blanks stripped. */
  readonly out: readonly string[];
  /** Every `ERROR:` block, in the order Postgres raised them. */
  readonly errors: readonly PgError[];
  /** Raw stderr, for failure messages. */
  readonly rawErr: string;
}

const CONTAINER_ENV = 'FINANCEOS_DB_CONTAINER';

function dockerCapture(args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('docker', [...args], { encoding: 'utf8', windowsHide: true, timeout: 1500 });
  if (r.error) {
    return { code: -1, stdout: '', stderr: String(r.error.message) };
  }
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The `supabase_db_*` container, or `null` when the local stack is not running. */
function resolveContainer(): string | null {
  const override = process.env[CONTAINER_ENV];
  if (override !== undefined && override.trim().length > 0) {
    return override.trim();
  }
  const r = dockerCapture(['ps', '--filter', 'name=supabase_db', '--format', '{{.Names}}']);
  if (r.code !== 0) {
    return null;
  }
  const first = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)[0];
  return first ?? null;
}

/**
 * Reachability, decided once per worker at import time.
 *
 * The suite is gated on this rather than on a hardcoded skip, so the same files
 * run unmodified wherever the local stack is up.
 */
export interface Reachability {
  readonly reachable: boolean;
  /** Why not, when `reachable` is false. Named so the skip is self-explaining. */
  readonly reason: string;
  readonly container: string | null;
  /** `postgres` must hold `BYPASSRLS` for the fixture to see its own rows. */
  readonly bypassRls: boolean;
  readonly superuser: boolean;
}

const UNREACHABLE_HINT =
  'Supabase local not reachable: run `npx supabase start` (needs a running Docker daemon).';

function probe(): Reachability {
  const container = resolveContainer();
  if (container === null) {
    return {
      reachable: false,
      reason: `${UNREACHABLE_HINT} No supabase_db container found (set ${CONTAINER_ENV} to override).`,
      container: null,
      bypassRls: false,
      superuser: false,
    };
  }

  const r = dockerCapture([
    'exec',
    '-i',
    container,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-tAq',
    '--no-psqlrc',
    '-c',
    "select coalesce(to_regclass('public.ledger_entries')::text, 'MISSING') || '|' " +
      "|| coalesce(to_regclass('public.audit_events')::text, 'MISSING') || '|' " +
      // `boolean::text` yields 'true'/'false', not psql's 'f'/'t' display form.
      '|| rolsuper::text || \'|\' || rolbypassrls::text ' +
      'from pg_roles where rolname = current_user',
  ]);

  if (r.code !== 0) {
    return {
      reachable: false,
      reason: `${UNREACHABLE_HINT} psql in ${container} exited ${r.code}: ${r.stderr.trim()}`,
      container,
      bypassRls: false,
      superuser: false,
    };
  }

  const [ledger, audit, superuser, bypassRls] = r.stdout.trim().split('|');
  if (ledger === 'MISSING' || audit === 'MISSING') {
    return {
      reachable: false,
      reason:
        `Supabase local is up but the migrations are not applied ` +
        `(public.ledger_entries / public.audit_events absent): run \`npx supabase db reset\`.`,
      container,
      bypassRls: bypassRls === 'true',
      superuser: superuser === 'true',
    };
  }

  return {
    reachable: true,
    reason: '',
    container,
    bypassRls: bypassRls === 'true',
    superuser: superuser === 'true',
  };
}

let cached: Reachability | undefined;

/** Memoised per worker. `spawnSync` keeps this usable from `describe.skipIf`. */
export function database(): Reachability {
  cached ??= probe();
  return cached;
}

let announced = false;

/**
 * Print the skip reason, once per worker, so a skipped `npm run test:db` explains
 * itself instead of reporting a silent green.
 *
 * Written straight to file descriptor 2 rather than through `console.warn`: Vitest
 * intercepts console output and attaches it to the running test, then discards it
 * when that test is skipped - which is precisely the case this message exists for.
 */
export function announceIfUnreachable(): void {
  const db = database();
  if (!db.reachable && !announced) {
    announced = true;
    writeSync(2, `\n[db] SKIPPING the db suite - ${db.reason}\n\n`);
  }
}

const ERROR_LINE = /^(?:psql:[^\n]*?:\s*)?ERROR:\s+([0-9A-Z]{5}):\s*(.*)$/;
const FIELD_LINE = /^([A-Z ]+):\s{2}(.*)$/;

function parseErrors(stderr: string): PgError[] {
  const lines = stderr.split(/\r?\n/);
  const errors: PgError[] = [];
  let current: { sqlstate: string; message: string; fields: Record<string, string> } | null = null;

  const flush = (): void => {
    if (current === null) {
      return;
    }
    errors.push({
      sqlstate: current.sqlstate,
      message: current.message,
      ...(current.fields['CONSTRAINT NAME'] === undefined
        ? {}
        : { constraint: current.fields['CONSTRAINT NAME'] }),
      ...(current.fields['DATATYPE NAME'] === undefined
        ? {}
        : { datatype: current.fields['DATATYPE NAME'] }),
      ...(current.fields['TABLE NAME'] === undefined
        ? {}
        : { table: current.fields['TABLE NAME'] }),
    });
    current = null;
  };

  for (const line of lines) {
    const start = ERROR_LINE.exec(line);
    if (start !== null) {
      flush();
      current = { sqlstate: start[1] ?? '', message: start[2] ?? '', fields: {} };
      continue;
    }
    if (current !== null) {
      const field = FIELD_LINE.exec(line);
      if (field !== null && field[1] !== undefined && field[2] !== undefined) {
        current.fields[field[1]] = field[2].trim();
      }
    }
  }
  flush();
  return errors;
}

/**
 * Run one `psql` session over `script`, fed on stdin so each statement is its own
 * query and `BEGIN`/`COMMIT` mean what they say.
 *
 * `ON_ERROR_STOP` is off: a script that expects a rejection still needs its
 * trailing `ROLLBACK` and its "how many rows persisted?" query to run. Every
 * caller asserts on the exact error list, so an unexpected extra error is a test
 * failure rather than something absorbed.
 */
export function runScript(script: string): ScriptResult {
  const db = database();
  if (db.container === null) {
    throw new Error(db.reason);
  }
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      db.container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-tAq',
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=0',
      '-v',
      'VERBOSITY=verbose',
    ],
    { encoding: 'utf8', input: script, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
  );
  if (r.error) {
    throw new Error(`docker exec psql failed: ${r.error.message}`);
  }
  return {
    out: (r.stdout ?? '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
    errors: parseErrors(r.stderr ?? ''),
    rawErr: r.stderr ?? '',
  };
}

/** Run `script` and fail with the raw stderr if Postgres raised anything at all. */
export function runOk(script: string): ScriptResult {
  const r = runScript(script);
  if (r.errors.length > 0) {
    throw new Error(`expected a clean script, got:\n${r.rawErr}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// SQL emission helpers. Every value these quote is a test constant.
// ---------------------------------------------------------------------------

/** Single-quoted SQL literal with quotes doubled. */
export function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Emit one line of JSON per statement, so `out[i]` is parseable. */
export function jsonRows(select: string): string {
  return `select coalesce(jsonb_agg(t), '[]'::jsonb)::text from (${select}) t;`;
}

/** Emit a single scalar as JSON. */
export function jsonScalar(expr: string): string {
  return `select to_jsonb(${expr})::text;`;
}

/**
 * Wrap `body` in a transaction that is always rolled back, so a test leaves no
 * rows behind. A statement inside `body` that fails aborts the transaction, and
 * the trailing `ROLLBACK` still runs because `ON_ERROR_STOP` is off - so put any
 * "how many rows persisted?" query AFTER this, not inside it.
 *
 * A `DEFERRABLE INITIALLY DEFERRED` constraint trigger never fires here: it fires
 * at `COMMIT`, and there is none. That is deliberate - it keeps the domain-range
 * and uniqueness tests isolated from the ledger balance barrier.
 */
export function rolledBack(body: string): string {
  return `begin;\n${body.trim()}\nrollback;`;
}

/** Parse the i-th emitted JSON line. */
export function jsonAt<T>(r: ScriptResult, index: number): T {
  const line = r.out[index];
  if (line === undefined) {
    throw new Error(
      `no output line ${index}; got ${r.out.length} line(s): ${JSON.stringify(r.out)}\n${r.rawErr}`,
    );
  }
  return JSON.parse(line) as T;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Identifiers for one throwaway Tenant. Fresh per test, so tests never collide. */
export interface Fixture {
  readonly tenantId: string;
  readonly userId: string;
  readonly runId: string;
  readonly debitAccount: string;
  readonly creditAccount: string;
}

export function newFixture(): Fixture {
  return {
    tenantId: randomUUID(),
    userId: randomUUID(),
    runId: randomUUID(),
    debitAccount: '1000',
    creditAccount: '4000',
  };
}

/**
 * SQL that provisions `f`: a Tenant, a User, its chart of accounts, an
 * ingestion run, and its `audit_sequence_counters` row.
 *
 * The counter row is inserted explicitly because of FINDING 4 in
 * `20260101000004_audit_log_append_only.sql`: `app.append_audit_event` reads the
 * counter with `SELECT ... FOR UPDATE` and never creates it, so with no row
 * `v_seq`/`v_prev` stay NULL and the insert dies on `sequence_number NOT NULL` -
 * a Tenant can never record its first Audit_Event. design.md's ER diagram says
 * `TENANTS ||--|| AUDIT_SEQUENCE_COUNTERS`, so the row is clearly intended, but
 * nothing in any migration, trigger or service creates it. This fixture works
 * around it for the tests; the production seeding step still has no owner and
 * needs to land either in tenant provisioning or as an upsert inside
 * `app.append_audit_event`.
 *
 * `request.jwt.claims` is set so `app.current_tenant_id()` and
 * `app.current_user_id()` resolve - see the role note at the top of this file.
 */
export function provision(f: Fixture): string {
  return `
${claims(f)}
insert into tenants (id, name) values (${lit(f.tenantId)}, 'db-test');
insert into users (id, email) values (${lit(f.userId)}, ${lit(`${f.userId}@financeos.test`)});
insert into audit_sequence_counters (tenant_id) values (${lit(f.tenantId)});
insert into chart_of_accounts (tenant_id, account_code, account_name, kind) values
  (${lit(f.tenantId)}, ${lit(f.debitAccount)}, 'Bank', 'asset'),
  (${lit(f.tenantId)}, ${lit(f.creditAccount)}, 'Revenue', 'income');
insert into ingestion_runs (id, tenant_id, window_from, window_basis, initiated_by)
  values (${lit(f.runId)}, ${lit(f.tenantId)}, now() - interval '1 day',
          'first_run_365d', ${lit(f.userId)});
`.trim();
}

/**
 * Re-establish the session claim. Needed in every session, since each `runScript`
 * call is its own connection. Wrapped in a `DO` block so it emits no tuple line
 * and never shifts the `out` indices the tests read.
 */
export function claims(f: Fixture): string {
  return `do $claims$ begin perform set_config('request.jwt.claims',
  json_build_object('tenant_id', ${lit(f.tenantId)}, 'sub', ${lit(f.userId)})::text, false);
end $claims$;`;
}
