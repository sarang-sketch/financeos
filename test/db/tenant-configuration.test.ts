import { describe, it } from 'vitest';

/**
 * Database-backed checks for `tenant_configuration` and the credential columns.
 *
 * These belong to the `db` project (stage 5: Supabase local, migrations applied) because they
 * assert what only Postgres can produce: the `CHECK` constraints as the backstop behind
 * `ConfigurationService.put`, `BYTEA` round-tripping through PostgREST via
 * `encodeBytea`/`decodeBytea`, `BIGINT` paise arriving on the wire and coercing without a
 * float, and `FORCE ROW LEVEL SECURITY` applying on a service-role connection.
 *
 * They are skipped, with the reasons recorded rather than worked around:
 *
 * 1. **Not yet written.** These four bodies are unimplemented placeholders belonging to task
 *    5.1, not to task 4.8. The original blocker recorded here — no Docker daemon, so no
 *    `supabase start` — no longer holds: task **4.8** brought the local stack up and its
 *    suites in this directory run against it. `test/db/pg.ts` is the harness they should use,
 *    and it also carries the role note that explains which role a `db` test can run as today.
 * 2. **No RLS policies yet.** `tenant_configuration` is `ENABLE`d and `FORCE`d for row-level
 *    security with no policies until task **26.1**, so it matches zero rows for any role
 *    without `BYPASSRLS` — reads return nothing and writes are refused even with a database.
 *    The FORCE-on-service-role case below therefore has to wait for 26.1 regardless.
 * 3. **The audit counter row is unseeded.** `app.append_audit_event` reads
 *    `audit_sequence_counters` with `SELECT ... FOR UPDATE` and never creates the row
 *    (FINDING 4 in `20260101000004_audit_log_append_only.sql`), so a Tenant cannot record its
 *    first Audit_Event until the seeding step is assigned. Task 4.8's fixture works around it
 *    by inserting the counter row explicitly (see `provision` in `test/db/pg.ts`); the
 *    production seeding step still has no owner.
 *
 * A faked pass would be worse than a skip. Everything verifiable without a database — every
 * default, every documented range, the range agreement with the migration, the AES-256-GCM
 * round trip, the tamper and cross-Tenant rejections, and the credential-containment
 * guarantees — is asserted in `src/config/configuration-service.test.ts` and
 * `src/config/credential-crypto.test.ts` against the injectable `ConfigurationStore` and
 * `ConfigurationAuditSink` seams. What remains here is exactly the part that needs the engine.
 */
describe.skip('tenant_configuration against Supabase local (unwritten, task 5.1; the FORCE RLS case needs 26.1)', () => {
  it('accepts every documented range boundary and rejects one step beyond it, per CHECK constraint', () => {
    // Mirrors CONFIGURATION_SPECS: for each column min and max insert cleanly while min-1 and
    // max+1 raise a constraint violation, proving the service gate and the schema agree in
    // both directions rather than only in the unit test's reading of the DDL.
  });

  it('round-trips a sealed credential through a BYTEA column with the bytes unchanged', () => {
    // encodeBytea on write, decodeBytea on read, then openCredential on the result.
  });

  it('returns paise columns in a form that coerces through BigInt without loss', () => {
    // A paise value beyond Number.MAX_SAFE_INTEGER must survive the round trip exactly.
  });

  it('applies the Tenant predicate on a service-role connection, because FORCE ROW LEVEL SECURITY is set', () => {
    // A store scoped to Tenant A must read no row belonging to Tenant B. Needs task 26.1.
  });

  it('records exactly one audit_events row per credential store or replace, with no value in the payload', () => {
    // app.append_audit_event allocates the per-Tenant sequence; the payload must carry only
    // the kind, the masked reference and the encryption label. Needs the counter row seeded.
  });
});
