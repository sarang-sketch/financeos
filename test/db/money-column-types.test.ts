/**
 * Schema type audit against Supabase local (task 4.8).
 *
 * This is property P12's companion assertion, deliberately deferred here from task
 * 2.2: P12 proves the TypeScript money type never loses a paisa, and this proves
 * the schema gives it nowhere to lose one. Requirement 15.8 says no monetary value
 * is held in a `NUMERIC`, `DECIMAL`, `REAL`, `DOUBLE PRECISION`, `FLOAT` or `MONEY`
 * column anywhere, and that is a claim about the whole catalogue, not about any one
 * migration - so it is asserted by querying `information_schema.columns` rather
 * than by reading DDL.
 *
 * ON HOW A DOMAIN COLUMN REPORTS ITSELF
 * `information_schema.columns.data_type` reports a domain column's BASE type, and
 * carries the domain in `domain_name`/`domain_schema`. So a `paise` column reports
 * `data_type = 'bigint'` with `domain_name = 'paise'`. Both halves are asserted:
 * `bigint` alone would also be satisfied by a bare `BIGINT` column that carries no
 * range `CHECK` at all, which is exactly the regression worth catching.
 *
 * Requirements: 15.8. Property: P12.
 */

import { describe, expect, it } from 'vitest';
import { database, jsonAt, jsonRows, runScript } from './pg';

interface ColumnRow {
  readonly table: string;
  readonly column: string;
  readonly dataType: string;
  readonly domain: string | null;
}

const MONEY_DOMAINS = ['paise', 'paise_ingested', 'paise_positive'] as const;

/**
 * The one column in the schema whose type is in the forbidden family and which is
 * legitimately NOT monetary.
 *
 * `tenant_configuration.unusual_multiple` is `NUMERIC(4,1)`: the multiple of a
 * baseline above which an amount is flagged unusual, e.g. 3.5x. It is a RATIO, not
 * an amount of money - it is never added to, subtracted from or compared against a
 * paise figure, it is multiplied by one. Requirement 15.8 constrains where monetary
 * values live, not where every decimal does. It is allowed by NAME rather than by
 * loosening the assertion, so a new `NUMERIC` column has to be justified here
 * before this test will pass.
 */
const NON_MONETARY_DECIMAL_ALLOWLIST: readonly string[] = ['tenant_configuration.unusual_multiple'];

/** The families Requirement 15.8 forbids for a monetary value. */
const FORBIDDEN_TYPES = ['numeric', 'real', 'double precision', 'money'] as const;

/**
 * Every `_paise` column that exists, in every schema.
 *
 * `\_` escapes the LIKE wildcard so `_paise` matches a literal underscore. The
 * schema filter is deliberately absent: a `_paise` column that appeared outside
 * `public` would otherwise slip the audit entirely, and the suffix is this
 * project's own naming convention wherever it is used.
 */
const PAISE_COLUMNS = `
select table_schema as "schema", table_name as "table", column_name as "column",
       data_type as "dataType", domain_name as "domain"
from information_schema.columns
where column_name like '%\\_paise'
order by table_schema, table_name, column_name`;

const FORBIDDEN_TYPE_COLUMNS = `
select table_name as "table", column_name as "column", data_type as "dataType",
       domain_name as "domain"
from information_schema.columns
where table_schema = 'public'
  and data_type in ('numeric', 'real', 'double precision', 'money')
order by table_name, column_name`;

function query<T>(select: string): T {
  const r = runScript(jsonRows(select));
  expect(r.errors, r.rawErr).toEqual([]);
  return jsonAt<T>(r, 0);
}

describe.skipIf(!database().reachable)('schema type audit', () => {
  it('finds the _paise columns, so the audit is not vacuous', () => {
    const rows = query<readonly (ColumnRow & { readonly schema: string })[]>(PAISE_COLUMNS);
    // 21 monetary columns after proposal storage adds impact, observed, and difference.
    // The count is asserted so a query that silently matched nothing cannot pass this file.
    expect(rows.length).toBe(21);
    expect(new Set(rows.map((r) => r.schema))).toEqual(new Set(['public']));
  });

  it('types every _paise column as bigint', () => {
    const rows = query<readonly ColumnRow[]>(PAISE_COLUMNS);
    const offenders = rows.filter((r) => r.dataType !== 'bigint');
    expect(
      offenders,
      `these _paise columns are not bigint: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it('puts every _paise column on a money domain, so the range CHECK travels with it', () => {
    const rows = query<readonly ColumnRow[]>(PAISE_COLUMNS);
    const offenders = rows.filter(
      (r) => r.domain === null || !MONEY_DOMAINS.includes(r.domain as (typeof MONEY_DOMAINS)[number]),
    );
    expect(
      offenders,
      `these _paise columns are bare bigint rather than a money domain, so they carry ` +
        `no range CHECK: ${JSON.stringify(offenders)}`,
    ).toEqual([]);
  });

  it('holds no monetary value in a numeric, real, double precision or money column', () => {
    const rows = query<readonly ColumnRow[]>(FORBIDDEN_TYPE_COLUMNS);
    const found = rows.map((r) => `${r.table}.${r.column}`);

    // Set equality, not containment: an unexpected column fails, and so does an
    // allowlisted column that has been removed or retyped without updating this list.
    expect(
      new Set(found),
      `columns in the ${FORBIDDEN_TYPES.join('/')} family: ${JSON.stringify(rows)}. ` +
        `Any monetary value among them violates Requirement 15.8; a new non-monetary ` +
        `decimal must be added to NON_MONETARY_DECIMAL_ALLOWLIST with a justification.`,
    ).toEqual(new Set(NON_MONETARY_DECIMAL_ALLOWLIST));
  });

  it('puts no _paise column in the forbidden type family', () => {
    // Belt and braces: the two queries above are independent, so this catches a
    // column that somehow satisfied one and not the other.
    const rows = query<readonly ColumnRow[]>(FORBIDDEN_TYPE_COLUMNS);
    expect(rows.filter((r) => r.column.endsWith('_paise'))).toEqual([]);
  });
});
