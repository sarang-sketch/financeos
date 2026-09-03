/**
 * `settlement_reconciliations` against Supabase local: the three CHECKs, the
 * uniqueness that makes a re-run an update, and the two things the schema cannot
 * check (task 11.1).
 *
 * `src/agents/reconciliation/reconcile-settlement.ts` validates every row before it
 * issues a statement, so nothing it produces can reach these barriers. That is
 * exactly why they are worth asserting here: they are what stops **another** write
 * path — a hand-written backfill, a future tool, a psql session — from storing a
 * reconciliation result whose figures do not add up. Every assertion targets the
 * constraint **by name**, because the service matches by name too and a rename must
 * break loudly rather than be reinterpreted as an unrelated check violation.
 *
 * | Constraint | What it forbids | Requirement |
 * |---|---|---|
 * | `unreconciled_has_no_figures` | an unreconciled Settlement carrying a figure | 4.13 |
 * | `difference_decomposes_exactly` | fee + gst + residual ≠ difference | 4.3, P3 |
 * | `explained_iff_zero_residual` | "explained" with a non-zero residual, and the converse | 4.4, 4.5 |
 * | `settlement_recon_uniq` | a second result row for one Settlement | 4.2, 4.15 |
 *
 * Two known gaps are asserted as gaps rather than left implicit, so the split
 * between the database and the service is recorded in a test rather than only in a
 * comment: FINDING 2 of the migration (a row of NULLs satisfies all three CHECKs)
 * and the absence of a `direction` column (FINDING 1).
 *
 * Every attempt runs inside a rolled-back transaction, so nothing is left behind and
 * no assertion depends on a global row count — every count here is scoped to the
 * fixture Tenant.
 *
 * Requirements: 4.2, 4.3, 4.4, 4.5, 4.13, 4.15. Property: P3.
 */

import { describe, expect, it } from 'vitest';

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

const SETTLEMENT = 'setl_SYNTHETIC9281';
const REPORT = 'setlrcn_SYNTHETIC9281';

interface Figures {
  readonly status: 'difference_explained' | 'mismatch' | 'unreconciled';
  readonly reconReportId: string | null;
  /** Integer paise as SQL literals, or `null`. Never a float. */
  readonly expected: string | null;
  readonly received: string;
  readonly difference: string | null;
  readonly fee: string | null;
  readonly gst: string | null;
  readonly residual: string | null;
  readonly paymentsCounted?: number;
}

/** SET-9281 as it is actually computed: residual exactly 0, difference explained. */
const EXPLAINED: Figures = {
  status: 'difference_explained',
  reconReportId: REPORT,
  expected: '84260000',
  received: '81940000',
  difference: '2320000',
  fee: '1966100',
  gst: '353900',
  residual: '0',
  paymentsCounted: 3,
};

/** The ₹19,000 fee variant: residual 66100, an unexplained shortfall. */
const MISMATCH: Figures = {
  ...EXPLAINED,
  status: 'mismatch',
  fee: '1900000',
  residual: '66100',
};

/** Requirement 4.13: an absent report computes nothing but the received amount. */
const UNRECONCILED: Figures = {
  status: 'unreconciled',
  reconReportId: null,
  expected: null,
  received: '81940000',
  difference: null,
  fee: null,
  gst: null,
  residual: null,
  paymentsCounted: 0,
};

const nullable = (value: string | null): string => (value === null ? 'null' : value);

function insertRecon(
  f: Fixture,
  figures: Figures,
  options: { readonly settlementId?: string; readonly onConflictUpdate?: boolean } = {},
): string {
  const settlementId = options.settlementId ?? SETTLEMENT;
  const conflict =
    options.onConflictUpdate === true
      ? `
on conflict on constraint settlement_recon_uniq do update set
  recon_report_id = excluded.recon_report_id,
  expected_paise = excluded.expected_paise,
  received_paise = excluded.received_paise,
  difference_paise = excluded.difference_paise,
  fee_component_paise = excluded.fee_component_paise,
  gst_component_paise = excluded.gst_component_paise,
  residual_paise = excluded.residual_paise,
  status = excluded.status,
  payments_counted = excluded.payments_counted,
  run_id = excluded.run_id,
  computed_at = now()`
      : '';
  return `
insert into settlement_reconciliations
  (tenant_id, settlement_id, recon_report_id, settlement_date, expected_paise,
   received_paise, difference_paise, fee_component_paise, gst_component_paise,
   residual_paise, status, payments_counted, run_id)
values (${lit(f.tenantId)}, ${lit(settlementId)},
        ${figures.reconReportId === null ? 'null' : lit(figures.reconReportId)},
        date '2026-07-28', ${nullable(figures.expected)}, ${figures.received},
        ${nullable(figures.difference)}, ${nullable(figures.fee)}, ${nullable(figures.gst)},
        ${nullable(figures.residual)}, ${lit(figures.status)},
        ${figures.paymentsCounted ?? 0}, ${lit(f.runId)})${conflict};`;
}

/** Rows for the fixture Tenant only. Never a global count (the suite shares a database). */
const reconRows = (f: Fixture): string =>
  jsonRows(
    `select settlement_id, status, expected_paise::text, difference_paise::text,
            fee_component_paise::text, gst_component_paise::text, residual_paise::text,
            payments_counted, run_id::text
       from settlement_reconciliations
      where tenant_id = ${lit(f.tenantId)}
      order by settlement_id`,
  );

interface ReconRow {
  readonly settlement_id: string;
  readonly status: string;
  readonly expected_paise: string | null;
  readonly difference_paise: string | null;
  readonly fee_component_paise: string | null;
  readonly gst_component_paise: string | null;
  readonly residual_paise: string | null;
  readonly payments_counted: number;
  readonly run_id: string;
}

/** One rejected insert, matched by SQLSTATE and constraint name. */
function expectRejected(figures: Figures, sqlstate: string, constraint: string): void {
  const f = newFixture();
  const r = runScript(rolledBack(`${provision(f)}\n${insertRecon(f, figures)}`));
  expect(r.errors, `expected exactly one rejection, got:\n${r.rawErr}`).toHaveLength(1);
  const [error] = r.errors;
  expect(error?.sqlstate).toBe(sqlstate);
  expect(error?.constraint).toBe(constraint);
}

describe.skipIf(!database().reachable)('settlement_reconciliations invariants', () => {
  it('accepts the three shapes the reconciler actually produces', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          insertRecon(f, EXPLAINED),
          insertRecon(f, MISMATCH, { settlementId: 'setl_SYNTHETIC9282' }),
          insertRecon(f, UNRECONCILED, { settlementId: 'setl_SYNTHETIC9283' }),
          reconRows(f),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    const rows = jsonAt<readonly ReconRow[]>(r, 0);
    expect(rows.map((row) => row.status)).toEqual([
      'difference_explained',
      'mismatch',
      'unreconciled',
    ]);
    expect(rows[0]?.residual_paise).toBe('0');
    expect(rows[1]?.residual_paise).toBe('66100');
    expect(rows[2]?.expected_paise).toBeNull();
  });

  it('unreconciled_has_no_figures rejects an unreconciled row that states a figure', () => {
    // A 0 here would aggregate as a real value and understate the reported total
    // shortfall the Settlement must be excluded from (Requirement 4.13).
    expectRejected(
      { ...UNRECONCILED, expected: '0' },
      CHECK_VIOLATION,
      'unreconciled_has_no_figures',
    );
  });

  it('difference_decomposes_exactly rejects a decomposition off by a single paisa', () => {
    // 1966099 + 353900 + 0 = 2319999, not 2320000. Requirement 4.3, property P3.
    expectRejected(
      { ...EXPLAINED, fee: '1966099' },
      CHECK_VIOLATION,
      'difference_decomposes_exactly',
    );
  });

  it('explained_iff_zero_residual rejects "explained" with a non-zero residual', () => {
    expectRejected(
      { ...EXPLAINED, gst: '353899', residual: '1' },
      CHECK_VIOLATION,
      'explained_iff_zero_residual',
    );
  });

  it('explained_iff_zero_residual rejects a mismatch whose residual is zero', () => {
    // The other direction of the biconditional: a fully explained Settlement cannot
    // be parked as a mismatch and counted into a shortfall it does not contribute to.
    expectRejected({ ...EXPLAINED, status: 'mismatch' }, CHECK_VIOLATION, 'explained_iff_zero_residual');
  });

  it('settlement_recon_uniq rejects a second result row for one Settlement', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack([provision(f), insertRecon(f, EXPLAINED), insertRecon(f, MISMATCH)].join('\n')),
    );
    expect(r.errors, `expected exactly one rejection, got:\n${r.rawErr}`).toHaveLength(1);
    expect(r.errors[0]?.sqlstate).toBe(UNIQUE_VIOLATION);
    expect(r.errors[0]?.constraint).toBe('settlement_recon_uniq');
  });

  it('a re-run updates the one row rather than adding a second (Requirement 4.15)', () => {
    const f = newFixture();
    const rerunId = '44444444-4444-4444-8444-444444444444';
    const r = runScript(
      rolledBack(
        [
          provision(f),
          insertRecon(f, EXPLAINED, { onConflictUpdate: true }),
          // The second run sees a different fee in the report and recomputes.
          insertRecon(f, MISMATCH, { onConflictUpdate: true }).replace(
            `${lit(f.runId)})`,
            `${lit(rerunId)})`,
          ),
          reconRows(f),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    const rows = jsonAt<readonly ReconRow[]>(r, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('mismatch');
    expect(rows[0]?.fee_component_paise).toBe('1900000');
    expect(rows[0]?.residual_paise).toBe('66100');
    expect(rows[0]?.run_id).toBe(rerunId);
  });

  it('records the Evidence_Chain identifier the figures came from', () => {
    const f = newFixture();
    const chainId = '55555555-5555-4555-8555-555555555555';
    const r = runScript(
      rolledBack(
        [
          provision(f),
          `insert into evidence_chains (id, tenant_id, figure_paise, source_count, as_of, produced_by)
             values (${lit(chainId)}, ${lit(f.tenantId)}, 0, 8, now(),
                     'get_settlement_reconciliation');`,
          insertRecon(f, EXPLAINED).replace(
            `${lit(f.runId)})`,
            `${lit(f.runId)}, ${lit(chainId)})`,
          ).replace('run_id)', 'run_id, evidence_chain_id)'),
          jsonRows(
            `select evidence_chain_id::text from settlement_reconciliations
              where tenant_id = ${lit(f.tenantId)}`,
          ),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    expect(jsonAt<readonly { readonly evidence_chain_id: string }[]>(r, 0)).toEqual([
      { evidence_chain_id: chainId },
    ]);
  });
});

/**
 * The two invariants the schema does **not** enforce, asserted as accepted rows so
 * the split with `reconcile-settlement.ts` is recorded rather than assumed. If a
 * later migration closes either gap, these fail and the module doc comment stops
 * being true — which is the point.
 */
describe.skipIf(!database().reachable)('settlement_reconciliations: what the schema cannot check', () => {
  it('accepts a mismatch row with all five figures NULL (migration FINDING 2)', () => {
    // Every CHECK evaluates to NULL on this row, and a SQL CHECK passes when it does.
    // `assertReconPersistable` is the only barrier; see the module doc comment.
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          insertRecon(f, { ...UNRECONCILED, status: 'mismatch' }),
          reconRows(f),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    const rows = jsonAt<readonly ReconRow[]>(r, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('mismatch');
    expect(rows[0]?.residual_paise).toBeNull();
  });

  it('has no direction column, so the shortfall/excess classification is not stored (FINDING 1)', () => {
    const r = runScript(
      jsonRows(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'settlement_reconciliations'
            and column_name = 'direction'`,
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    expect(jsonAt<readonly unknown[]>(r, 0)).toEqual([]);
  });
});
