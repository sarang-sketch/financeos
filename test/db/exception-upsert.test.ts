/**
 * The Exception upsert against Supabase local: the four statements
 * `src/agents/exception-fingerprint.ts` exports, run verbatim, and every constraint
 * on `exceptions` rejecting by name (task 11.4).
 *
 * This is where "a re-run is an update, not a duplicate" is actually proven
 * (Requirement 4.15). The TypeScript side computes the identity and validates the
 * row; nothing it produces can reach a constraint here. What this suite asserts is
 * the half only a database can decide:
 *
 * | Fact | Statement or constraint | Requirement |
 * |---|---|---|
 * | two runs leave one row | `exceptions_fingerprint_uniq` + `DO UPDATE` | 4.15, P5 |
 * | `first_detected_at` never moves | absent from `DO UPDATE SET` | 4.15, P5 |
 * | `last_detected_at` advances | `EXCLUDED.last_detected_at` | 4.15, P5 |
 * | a closed Exception is not reopened | `WHERE exceptions.lifecycle_state = 'open'` | 4.15 |
 * | why nothing was returned | `EXCEPTION_STATE_PROBE_SQL` | 4.15 |
 * | lifecycle and `resolved_at` agree | `exceptions_check` | 4.12 |
 * | detection order | `exceptions_check1` | 4.15 |
 * | the impact is a magnitude | `exceptions_impact_paise_check` | 4.5, 4.12 |
 * | one link per record, relabelled not duplicated | `exception_source_records_pkey` | 4.12 |
 *
 * The statements are run through `PREPARE` / `EXECUTE` so the **exact exported
 * strings** are what Postgres plans, `$8` really is one parameter referenced twice,
 * and the parameter order is `exceptionUpsertParams`' order rather than a
 * hand-written restatement of it. A rewritten statement — a `first_detected_at` line
 * added to `DO UPDATE SET`, a dropped `WHERE` guard, a reordered parameter list —
 * fails here.
 *
 * The constraint names are audited against `pg_constraint` **with their definitions**,
 * because the two lifecycle CHECKs are unnamed in the migration and Postgres derived
 * `exceptions_check` and `exceptions_check1` from declaration order (gap 1 in the
 * module doc comment). Reordering them in a later migration would silently swap the
 * two names a store matches rejections by; here it fails.
 *
 * Every attempt runs inside a rolled-back transaction, and every count is scoped to
 * the fixture Tenant — the suite shares one database.
 *
 * Requirements: 4.12, 4.15. Property: P5.
 */

import { describe, expect, it } from 'vitest';

import {
  EXCEPTION_DETECTION_ORDER_CHECK,
  EXCEPTION_DIRECTION_CHECK,
  EXCEPTION_IMPACT_RANGE_CHECK,
  EXCEPTION_LIFECYCLE_RESOLVED_CHECK,
  EXCEPTION_SOURCE_RECORD_CLEAR_SQL,
  EXCEPTION_SOURCE_RECORD_LINK_SQL,
  EXCEPTION_SOURCE_RECORDS_PKEY,
  EXCEPTION_STATE_PROBE_SQL,
  EXCEPTION_UPSERT_SQL,
  EXCEPTIONS_FINGERPRINT_UNIQ,
  type ExceptionUpsertInput,
  exceptionUpsertParams,
  exceptionWriteFor,
} from '@/agents/exception-fingerprint';

import {
  database,
  type Fixture,
  jsonAt,
  jsonRows,
  lit,
  newFixture,
  provision,
  rolledBack,
  runScript,
} from './pg';

/** `check_violation`. */
const CHECK_VIOLATION = '23514';
/** `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Two run timestamps, hours apart, so "advanced" and "unchanged" are both visible. */
const RUN_1 = '2026-07-28T10:00:00.000Z';
const RUN_2 = '2026-07-29T04:30:00.000Z';

const CHAIN_ID = '55555555-5555-4555-8555-555555555555';

/**
 * The `settlement_mismatch` of the ₹19,000 fee variant: residual 66100, a shortfall.
 * The refs are deliberately in non-canonical order, so the canonical `type` then `id`
 * sort is what the link rows and the fingerprint are built from and not the argument
 * order.
 */
const RUN_1_CONDITION: ExceptionUpsertInput = {
  category: 'settlement_mismatch',
  source_refs: [
    { type: 'settlement_recon_report', id: 'setlrcn_SYNTHETIC9282', role: 'recon_report' },
    { type: 'settlement', id: 'setl_SYNTHETIC9282', role: 'settlement' },
  ],
  impact_paise: 66100n,
  direction: 'shortfall',
  // Money in `detail` is the integer string `toWire` produces, never a number.
  detail: { failing_rule: 'residual_nonzero', residual_paise: '66100', payments_counted: 3 },
  evidence_chain_id: null,
  detected_at: RUN_1,
};

/** The same condition, re-detected: a different impact, direction, detail and chain. */
const RUN_2_CONDITION: ExceptionUpsertInput = {
  ...RUN_1_CONDITION,
  impact_paise: 77200n,
  direction: 'excess',
  detail: { failing_rule: 'residual_nonzero', residual_paise: '-77200', payments_counted: 4 },
  evidence_chain_id: CHAIN_ID,
  detected_at: RUN_2,
};

const UTC_MS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const utc = (column: string): string =>
  `to_char(${column} at time zone 'utc', ${UTC_MS}) as ${column}`;

interface ExceptionRow {
  readonly category: string;
  readonly lifecycle_state: string;
  readonly impact_paise: string;
  readonly direction: string | null;
  readonly detail: string;
  readonly evidence_chain_id: string | null;
  readonly fingerprint: string;
  readonly first_detected_at: string;
  readonly last_detected_at: string;
}

/** Exceptions for the fixture Tenant only. Never a global count. */
const exceptionRows = (f: Fixture): string =>
  jsonRows(
    `select category::text, lifecycle_state::text, impact_paise::text, direction,
            detail::text, evidence_chain_id::text, fingerprint,
            ${utc('first_detected_at')}, ${utc('last_detected_at')}
       from exceptions
      where tenant_id = ${lit(f.tenantId)}
      order by fingerprint`,
  );

interface LinkRow {
  readonly source_record_type: string;
  readonly source_record_id: string;
  readonly role: string | null;
}

const linkRows = (f: Fixture): string =>
  jsonRows(
    `select source_record_type::text, source_record_id, role
       from exception_source_records
      where tenant_id = ${lit(f.tenantId)}
      order by source_record_type, source_record_id`,
  );

/** `PREPARE`, so the exported string itself is what Postgres plans. */
const prepared = (name: string, sql: string): string => `prepare ${name} as\n${sql};`;

const execute = (name: string, params: readonly (string | null)[]): string =>
  `execute ${name}(${params.map((p) => (p === null ? 'null' : lit(p))).join(', ')});`;

/** The upsert of one condition, bound to `exceptionUpsertParams`' order. */
const upsert = (f: Fixture, input: ExceptionUpsertInput): string =>
  execute('exception_upsert', exceptionUpsertParams(exceptionWriteFor(f.tenantId, input)));

/** Remove the prior link set after a successful open-row upsert. */
const clearLinks = (f: Fixture, exceptionId: string): string =>
  execute('exception_clear_links', [exceptionId, f.tenantId]);

/** Every link of one condition, in the canonical order the write states. */
function links(f: Fixture, exceptionId: string, input: ExceptionUpsertInput): string {
  return exceptionWriteFor(f.tenantId, input)
    .links.map((link) =>
      execute('exception_link', [
        exceptionId,
        f.tenantId,
        link.source_record_type,
        link.source_record_id,
        link.role,
      ]),
    )
    .join('\n');
}

const PREPARE_ALL = [
  prepared('exception_upsert', EXCEPTION_UPSERT_SQL),
  prepared('exception_probe', EXCEPTION_STATE_PROBE_SQL),
  prepared('exception_clear_links', EXCEPTION_SOURCE_RECORD_CLEAR_SQL),
  prepared('exception_link', EXCEPTION_SOURCE_RECORD_LINK_SQL),
].join('\n');

/** One rejected statement, matched by SQLSTATE **and** constraint name. */
function expectRejected(body: string, sqlstate: string, constraint: string): void {
  const f = newFixture();
  const r = runScript(rolledBack(`${provision(f)}\n${body.replace(/__TENANT__/g, lit(f.tenantId))}`));
  expect(r.errors, `expected exactly one rejection, got:\n${r.rawErr}`).toHaveLength(1);
  expect(r.errors[0]?.sqlstate).toBe(sqlstate);
  expect(r.errors[0]?.constraint).toBe(constraint);
}

describe.skipIf(!database().reachable)('the Exception upsert (Requirement 4.15)', () => {
  it('a re-run updates the one Exception and never moves first_detected_at', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          upsert(f, RUN_1_CONDITION),
          upsert(f, RUN_2_CONDITION),
          exceptionRows(f),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);

    // `RETURNING id, (xmax = 0) AS created`: inserted, then updated in place.
    const [firstRun, secondRun] = [r.out[0], r.out[1]];
    expect(firstRun?.endsWith('|t')).toBe(true);
    expect(secondRun?.endsWith('|f')).toBe(true);
    expect(firstRun?.split('|')[0]).toBe(secondRun?.split('|')[0]);

    const rows = jsonAt<readonly ExceptionRow[]>(r, 2);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    // The values a re-run is allowed to replace (Requirement 4.15).
    expect(row?.impact_paise).toBe('77200');
    expect(row?.direction).toBe('excess');
    expect(row?.evidence_chain_id).toBe(CHAIN_ID);
    expect(JSON.parse(row?.detail ?? 'null')).toEqual({
      failing_rule: 'residual_nonzero',
      residual_paise: '-77200',
      payments_counted: 4,
    });
    // The two halves of P5's timestamp assertion.
    expect(row?.first_detected_at).toBe(RUN_1);
    expect(row?.last_detected_at).toBe(RUN_2);
    // Still open, and still the same identity.
    expect(row?.lifecycle_state).toBe('open');
    expect(row?.fingerprint).toBe(exceptionWriteFor(f.tenantId, RUN_1_CONDITION).fingerprint);
  });

  it('binds one timestamp to both detection columns, so a first insert cannot be out of order', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack([provision(f), PREPARE_ALL, upsert(f, RUN_1_CONDITION), exceptionRows(f)].join('\n')),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    const row = jsonAt<readonly ExceptionRow[]>(r, 1)[0];
    // `VALUES (..., $8, $8)`. Two separate `now()` reads could not promise this.
    expect(row?.first_detected_at).toBe(RUN_1);
    expect(row?.last_detected_at).toBe(RUN_1);
  });

  it('does not reopen or touch an Exception a User resolved, and says which one', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          upsert(f, RUN_1_CONDITION),
          `update exceptions
              set lifecycle_state = 'resolved', resolved_at = now(), resolved_by = ${lit(f.userId)}
            where tenant_id = ${lit(f.tenantId)};`,
          // The second run re-detects the same condition with a larger impact.
          upsert(f, RUN_2_CONDITION),
          execute('exception_probe', [
            f.tenantId,
            exceptionWriteFor(f.tenantId, RUN_2_CONDITION).fingerprint,
          ]),
          exceptionRows(f),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);

    // The upsert emitted nothing at all: the guard matched no row.
    expect(r.out).toHaveLength(3);
    const [inserted, probed] = [r.out[0], r.out[1]];
    expect(inserted?.endsWith('|t')).toBe(true);
    // The probe is what turns a zero-row return into a reportable fact.
    expect(probed).toBe(`${inserted?.split('|')[0]}|resolved`);

    const row = jsonAt<readonly ExceptionRow[]>(r, 2)[0];
    expect(row?.lifecycle_state).toBe('resolved');
    // Nothing moved: not the impact, not the chain, not last_detected_at.
    expect(row?.impact_paise).toBe('66100');
    expect(row?.direction).toBe('shortfall');
    expect(row?.evidence_chain_id).toBeNull();
    expect(row?.last_detected_at).toBe(RUN_1);
  });

  it('writes one link per Source_Record and relabels a re-linked record rather than duplicating it', () => {
    const f = newFixture();
    const exceptionId = '66666666-6666-4666-8666-666666666666';
    const relabelled: ExceptionUpsertInput = {
      ...RUN_1_CONDITION,
      source_refs: [
        { type: 'settlement', id: 'setl_SYNTHETIC9282', role: 'settlement' },
        // The same record, cited under a different label by the second run.
        { type: 'settlement_recon_report', id: 'setlrcn_SYNTHETIC9282', role: 'recon_report_v2' },
      ],
    };
    const r = runScript(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          `insert into exceptions (id, tenant_id, category, impact_paise, fingerprint)
             values (${lit(exceptionId)}, ${lit(f.tenantId)}, 'settlement_mismatch', 66100,
                     ${lit(exceptionWriteFor(f.tenantId, RUN_1_CONDITION).fingerprint)});`,
          links(f, exceptionId, RUN_1_CONDITION),
          links(f, exceptionId, relabelled),
          linkRows(f),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    expect(jsonAt<readonly LinkRow[]>(r, 0)).toEqual([
      { source_record_type: 'settlement', source_record_id: 'setl_SYNTHETIC9282', role: 'settlement' },
      {
        source_record_type: 'settlement_recon_report',
        source_record_id: 'setlrcn_SYNTHETIC9282',
        role: 'recon_report_v2',
      },
    ]);
  });

  it('replaces stale Marketplace Source_Record links on a successful same-range rerun', () => {
    const f = newFixture();
    const exceptionId = '77777777-7777-4777-8777-777777777777';
    const first: ExceptionUpsertInput = {
      category: 'seller_settlement_mismatch',
      source_refs: [{ type: 'linked_account', id: 'acc_SYNTHETIC01' }],
      context_refs: [{ type: 'transfer', id: 'trf_OLD' }],
      scope: { from: '2026-07-01', to: '2026-07-31' },
      impact_paise: 100n,
      direction: 'shortfall',
      detail: {},
      evidence_chain_id: null,
      detected_at: RUN_1,
    };
    const current: ExceptionUpsertInput = {
      ...first,
      context_refs: [{ type: 'transfer', id: 'trf_CURRENT' }],
      impact_paise: 50n,
      detected_at: RUN_2,
    };
    const r = runScript(
      rolledBack(
        [
          provision(f),
          PREPARE_ALL,
          `insert into exceptions (id, tenant_id, category, impact_paise, fingerprint)
             values (${lit(exceptionId)}, ${lit(f.tenantId)}, 'seller_settlement_mismatch', 100,
                     ${lit(exceptionWriteFor(f.tenantId, first).fingerprint)});`,
          links(f, exceptionId, first),
          clearLinks(f, exceptionId),
          links(f, exceptionId, current),
          linkRows(f),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    expect(jsonAt<readonly LinkRow[]>(r, 0)).toEqual([
      {
        source_record_type: 'linked_account',
        source_record_id: 'acc_SYNTHETIC01',
        role: 'identifying',
      },
      {
        source_record_type: 'transfer',
        source_record_id: 'trf_CURRENT',
        role: 'contributing',
      },
    ]);
  });
});

describe.skipIf(!database().reachable)('what the exceptions constraints reject', () => {
  const insertException = (columns: string, values: string): string =>
    `insert into exceptions (tenant_id, ${columns})
       values (__TENANT__, ${values});`;

  it(`${EXCEPTIONS_FINGERPRINT_UNIQ} rejects a second Exception for one identity`, () => {
    // Without the ON CONFLICT clause, which is exactly what the clause is for.
    expectRejected(
      [
        insertException(
          `category, impact_paise, fingerprint`,
          `'settlement_mismatch', 66100, 'fp-identity'`,
        ),
        insertException(
          `category, impact_paise, fingerprint`,
          `'settlement_mismatch', 77200, 'fp-identity'`,
        ),
      ].join('\n'),
      UNIQUE_VIOLATION,
      EXCEPTIONS_FINGERPRINT_UNIQ,
    );
  });

  it(`${EXCEPTION_LIFECYCLE_RESOLVED_CHECK} rejects a resolved Exception with no resolved_at`, () => {
    expectRejected(
      insertException(
        `category, impact_paise, fingerprint, lifecycle_state`,
        `'gst_anomaly', 0, 'fp-closed-without-time', 'resolved'`,
      ),
      CHECK_VIOLATION,
      EXCEPTION_LIFECYCLE_RESOLVED_CHECK,
    );
  });

  it(`${EXCEPTION_LIFECYCLE_RESOLVED_CHECK} rejects an open Exception that states a resolved_at`, () => {
    // The other direction of the biconditional: an Exception cannot be open and closed.
    expectRejected(
      insertException(
        `category, impact_paise, fingerprint, resolved_at`,
        `'gst_anomaly', 0, 'fp-open-with-time', now()`,
      ),
      CHECK_VIOLATION,
      EXCEPTION_LIFECYCLE_RESOLVED_CHECK,
    );
  });

  it(`${EXCEPTION_DETECTION_ORDER_CHECK} rejects a last_detected_at before first_detected_at`, () => {
    // The reason the upsert spends one parameter on both columns: two independently
    // supplied instants can arrive in this order, and a clock that moved backwards
    // between two runs is reported rather than absorbed.
    expectRejected(
      insertException(
        `category, impact_paise, fingerprint, first_detected_at, last_detected_at`,
        `'gst_anomaly', 0, 'fp-time-travel', '2026-07-30T00:00:00Z', '2026-07-29T00:00:00Z'`,
      ),
      CHECK_VIOLATION,
      EXCEPTION_DETECTION_ORDER_CHECK,
    );
  });

  it(`${EXCEPTION_IMPACT_RANGE_CHECK} rejects a signed impact`, () => {
    // `impact_paise` is the ABSOLUTE impact and the sign lives in `direction`. A
    // caller handing over a signed residual is rejected in TypeScript first — see
    // `src/agents/exception-fingerprint.upsert.test.ts` — so this is the second barrier.
    expectRejected(
      insertException(
        `category, impact_paise, fingerprint, direction`,
        `'settlement_mismatch', -66100, 'fp-signed-impact', 'shortfall'`,
      ),
      CHECK_VIOLATION,
      EXCEPTION_IMPACT_RANGE_CHECK,
    );
  });

  it(`${EXCEPTION_DIRECTION_CHECK} rejects a direction outside the three labels`, () => {
    expectRejected(
      insertException(
        `category, impact_paise, fingerprint, direction`,
        `'settlement_mismatch', 66100, 'fp-bad-direction', 'unexplained_shortfall'`,
      ),
      CHECK_VIOLATION,
      EXCEPTION_DIRECTION_CHECK,
    );
  });
});

/**
 * The names `src/agents/exception-fingerprint.ts` matches rejections by, audited
 * against the schema **with their definitions**.
 *
 * `exceptions_check` and `exceptions_check1` are generated names whose suffix follows
 * declaration order (gap 1 in the module doc comment). If a later migration reorders
 * or names the two CHECKs, a store matching by name would reinterpret one rejection
 * as the other — so the mapping is asserted here rather than assumed.
 */
describe.skipIf(!database().reachable)('the constraint names are the schema’s own', () => {
  interface ConstraintRow {
    readonly conname: string;
    readonly definition: string;
  }

  const constraints = (relation: string): string =>
    jsonRows(
      `select conname, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = ${lit(relation)}::regclass
        order by conname`,
    );

  it('exceptions carries every constraint the module names, with the definition it claims', () => {
    const r = runScript(constraints('public.exceptions'));
    expect(r.errors, r.rawErr).toHaveLength(0);
    const byName = new Map(
      jsonAt<readonly ConstraintRow[]>(r, 0).map((row) => [row.conname, row.definition]),
    );

    // The upsert's conflict target. design.md writes it as the column list
    // `ON CONFLICT (tenant_id, fingerprint)`; the statement names the constraint. This
    // is what keeps the two forms the same target.
    expect(byName.get(EXCEPTIONS_FINGERPRINT_UNIQ)).toBe('UNIQUE (tenant_id, fingerprint)');

    expect(byName.get(EXCEPTION_LIFECYCLE_RESOLVED_CHECK)).toContain('resolved_at IS NULL');
    expect(byName.get(EXCEPTION_DETECTION_ORDER_CHECK)).toContain(
      'last_detected_at >= first_detected_at',
    );
    expect(byName.get(EXCEPTION_IMPACT_RANGE_CHECK)).toContain('>= 0');
    expect(byName.get(EXCEPTION_DIRECTION_CHECK)).toContain('shortfall');
  });

  it('exception_source_records carries the primary key the link statement names', () => {
    const r = runScript(constraints('public.exception_source_records'));
    expect(r.errors, r.rawErr).toHaveLength(0);
    const byName = new Map(
      jsonAt<readonly ConstraintRow[]>(r, 0).map((row) => [row.conname, row.definition]),
    );
    expect(byName.get(EXCEPTION_SOURCE_RECORDS_PKEY)).toBe(
      'PRIMARY KEY (exception_id, source_record_type, source_record_id)',
    );
  });
});
