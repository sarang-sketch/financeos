/**
 * The Exception upsert half of `exception-fingerprint.ts`: what it refuses to write,
 * and what the statement it exports says (task 11.4).
 *
 * `test/db/exception-upsert.test.ts` proves the *behaviour* over real Postgres — one
 * row not two, `first_detected_at` unchanged, `last_detected_at` advanced, a resolved
 * Exception left alone. This file covers what a database cannot:
 *
 * - the rejections that happen **before any statement is issued**, so a malformed
 *   Exception leaves nothing to roll back: a signed impact, a ref-less Exception, a
 *   float where integer paise belong, a `context_refs` list on a category that has no
 *   contributing records;
 * - the **text** of {@link EXCEPTION_UPSERT_SQL}, because the two facts P5 depends on
 *   are structural — `first_detected_at` appears in `VALUES` and not in
 *   `DO UPDATE SET`, and one parameter fills both detection columns. A behavioural
 *   test catches a rewritten statement only if the rewrite happens to be observed;
 *   these catch it in the diff.
 * - the outcome the caller is handed when the row exists but is closed, which is a
 *   **value** rather than a throw.
 *
 * The store here is a real in-memory implementation of the same semantics, not a
 * mock: it keys on the fingerprint, refuses to touch a row that is not `open`, and
 * writes `first_detected_at` once. The db suite is what proves the SQL agrees with it.
 *
 * Fingerprint determinism itself — ref order invariance, impact and timestamps
 * excluded, scope only for the range-scoped categories — is task 11.5's, and is not
 * duplicated here.
 *
 * Requirements: 4.12, 4.15, 15.1, 15.8.
 */

import { describe, expect, it } from 'vitest';

import {
  createExceptionUpserter,
  EXCEPTION_SOURCE_RECORD_CLEAR_SQL,
  EXCEPTION_STATE_PROBE_SQL,
  EXCEPTION_UPSERT_SQL,
  EXCEPTIONS_FINGERPRINT_UNIQ,
  exceptionDirectionFor,
  ExceptionFingerprintError,
  exceptionFingerprint,
  type ExceptionState,
  type ExceptionStore,
  type ExceptionUpsertInput,
  exceptionUpsertParams,
  type ExceptionWrite,
  type ExceptionWriteOutcome,
  exceptionWriteFor,
} from '@/agents/exception-fingerprint';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CHAIN = '55555555-5555-4555-8555-555555555555';
const RUN_1 = '2026-07-28T10:00:00.000Z';
const RUN_2 = '2026-07-29T04:30:00.000Z';

/** The ₹19,000 fee variant of SET-9282: residual 66100, an unexplained shortfall. */
const CONDITION: ExceptionUpsertInput = {
  category: 'settlement_mismatch',
  source_refs: [
    { type: 'settlement_recon_report', id: 'setlrcn_SYNTHETIC9282', role: 'recon_report' },
    { type: 'settlement', id: 'setl_SYNTHETIC9282', role: 'settlement' },
  ],
  impact_paise: 66100n,
  direction: 'shortfall',
  detail: { failing_rule: 'residual_nonzero', residual_paise: '66100', payments_counted: 3 },
  evidence_chain_id: CHAIN,
  detected_at: RUN_1,
};

/** A range-scoped condition: the only shape `context_refs` and `scope` are admissible on. */
const SELLER_CONDITION: ExceptionUpsertInput = {
  category: 'seller_settlement_mismatch',
  source_refs: [{ type: 'linked_account', id: 'acc_SYNTHETIC01' }],
  context_refs: [{ type: 'transfer', id: 'trf_SYNTHETIC01' }],
  scope: { from: '2026-07-01', to: '2026-07-31' },
  impact_paise: 250000n,
  direction: 'shortfall',
  detail: {},
  evidence_chain_id: null,
  detected_at: RUN_1,
};

interface StoredException {
  readonly id: string;
  state: ExceptionState;
  impact_paise: string;
  direction: string;
  detail: string;
  evidence_chain_id: string | null;
  readonly first_detected_at: string;
  last_detected_at: string;
}

/**
 * The upsert's semantics in memory: one row per fingerprint, `first_detected_at`
 * written once, and no field touched at all unless the row is `open`. Every write it
 * accepts is recorded, so a test can assert what was handed to the statement.
 */
function inMemoryStore(): ExceptionStore & {
  readonly rows: Map<string, StoredException>;
  readonly writes: ExceptionWrite[];
} {
  const rows = new Map<string, StoredException>();
  const writes: ExceptionWrite[] = [];
  let next = 0;

  return {
    rows,
    writes,
    upsertException(write: ExceptionWrite): Promise<ExceptionWriteOutcome> {
      writes.push(write);
      const existing = rows.get(write.fingerprint);
      if (existing === undefined) {
        next += 1;
        rows.set(write.fingerprint, {
          id: `exc-${next}`,
          state: 'open',
          impact_paise: write.impact_paise,
          direction: write.direction,
          detail: write.detail,
          evidence_chain_id: write.evidence_chain_id,
          // `VALUES (..., $8, $8)`: one instant, both columns.
          first_detected_at: write.detected_at,
          last_detected_at: write.detected_at,
        });
        return Promise.resolve({ ok: true, exception_id: `exc-${next}`, created: true });
      }
      if (existing.state !== 'open') {
        // `WHERE exceptions.lifecycle_state = 'open'` matched nothing.
        return Promise.resolve({
          ok: false,
          kind: 'not_reopened',
          exception_id: existing.id,
          lifecycle_state: existing.state,
          fingerprint: write.fingerprint,
        });
      }
      existing.impact_paise = write.impact_paise;
      existing.direction = write.direction;
      existing.detail = write.detail;
      existing.evidence_chain_id = write.evidence_chain_id;
      existing.last_detected_at = write.detected_at;
      return Promise.resolve({ ok: true, exception_id: existing.id, created: false });
    },
  };
}

describe('the exported upsert statement', () => {
  it('writes first_detected_at in VALUES and never in DO UPDATE SET', () => {
    const [values, update] = EXCEPTION_UPSERT_SQL.split('DO UPDATE');
    expect(values).toContain('first_detected_at, last_detected_at');
    // The one line that would break P5's "every first_detected_at unchanged".
    expect(update).not.toContain('first_detected_at');
    expect(update).toContain('last_detected_at  = EXCLUDED.last_detected_at');
  });

  it('binds one parameter to both detection columns', () => {
    // Two parameters, or two `now()` reads, could differ in the wrong direction and be
    // rejected by `exceptions_check1` on a first insert.
    expect(EXCEPTION_UPSERT_SQL).toContain('VALUES ($1, $2, \'open\', $3, $4, $5, $6, $7, $8, $8)');
    expect(exceptionUpsertParams(exceptionWriteFor(TENANT, CONDITION))).toHaveLength(8);
  });

  it('guards the update to open Exceptions and names the constraint it conflicts on', () => {
    expect(EXCEPTION_UPSERT_SQL).toContain("WHERE exceptions.lifecycle_state = 'open'");
    expect(EXCEPTION_UPSERT_SQL).toContain(`ON CONFLICT ON CONSTRAINT ${EXCEPTIONS_FINGERPRINT_UNIQ}`);
    expect(EXCEPTION_STATE_PROBE_SQL).toContain('lifecycle_state');
  });

  it('orders its parameters as the statement reads them', () => {
    const write = exceptionWriteFor(TENANT, CONDITION);
    expect(exceptionUpsertParams(write)).toEqual([
      TENANT,
      'settlement_mismatch',
      '66100',
      'shortfall',
      write.detail,
      CHAIN,
      write.fingerprint,
      RUN_1,
    ]);
  });

  it('exports the successful-upsert cleanup that atomically replaces Source_Record links', () => {
    expect(EXCEPTION_SOURCE_RECORD_CLEAR_SQL).toContain('DELETE FROM exception_source_records');
    expect(EXCEPTION_SOURCE_RECORD_CLEAR_SQL).toContain('exception_id = $1');
    expect(EXCEPTION_SOURCE_RECORD_CLEAR_SQL).toContain('tenant_id = $2');
  });
});

describe('the row a condition becomes', () => {
  it('carries the impact as an integer string and the fingerprint of its identity', () => {
    const write = exceptionWriteFor(TENANT, CONDITION);
    expect(write.impact_paise).toBe('66100');
    expect(write.fingerprint).toBe(
      exceptionFingerprint({
        tenant_id: TENANT,
        category: 'settlement_mismatch',
        source_refs: CONDITION.source_refs,
      }),
    );
    expect(write.detail).toBe(
      '{"failing_rule":"residual_nonzero","residual_paise":"66100","payments_counted":3}',
    );
  });

  it('links every cited record once, in canonical order, with a role', () => {
    const write = exceptionWriteFor(TENANT, SELLER_CONDITION);
    // Sorted on type then id, so two runs issue the same statements in the same order.
    expect(write.links).toEqual([
      { source_record_type: 'linked_account', source_record_id: 'acc_SYNTHETIC01', role: 'identifying' },
      { source_record_type: 'transfer', source_record_id: 'trf_SYNTHETIC01', role: 'contributing' },
    ]);
  });

  it('leaves context_refs out of the identity but keeps them linked (Requirement 7.10)', () => {
    const moreContext: ExceptionUpsertInput = {
      ...SELLER_CONDITION,
      context_refs: [
        { type: 'transfer', id: 'trf_SYNTHETIC01' },
        { type: 'transfer_reversal', id: 'rvrsl_SYNTHETIC01' },
      ],
    };
    const first = exceptionWriteFor(TENANT, SELLER_CONDITION);
    const second = exceptionWriteFor(TENANT, moreContext);
    // A changed contributing set is the same Exception with a new impact, which is
    // what makes 7.10's "update the impact and the Source_Record identifiers"
    // reachable at all.
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.links).toHaveLength(3);
  });

  it('maps a ResidualDirection onto the label the column admits', () => {
    expect(exceptionDirectionFor('unexplained_shortfall')).toBe('shortfall');
    expect(exceptionDirectionFor('unexplained_excess')).toBe('excess');
    expect(exceptionDirectionFor('not_applicable')).toBe('not_applicable');
  });
});

describe('what is refused before any statement is issued', () => {
  const reject = (input: ExceptionUpsertInput, matching: RegExp): void => {
    expect(() => exceptionWriteFor(TENANT, input)).toThrow(ExceptionFingerprintError);
    expect(() => exceptionWriteFor(TENANT, input)).toThrow(matching);
  };

  it('rejects a signed residual rather than making it positive', () => {
    // The whole reason `residualImpactPaise` exists: `impact_paise` is a magnitude and
    // the sign lives in `direction`. Coercing here would hide the misreading forever.
    reject({ ...CONDITION, impact_paise: -66100n, direction: 'excess' }, /ABSOLUTE impact/);
  });

  it('rejects an impact that is not integer paise', () => {
    reject(
      { ...CONDITION, impact_paise: 66100 as unknown as bigint },
      /impact_paise must be Paise \(bigint\)/,
    );
  });

  it('rejects an impact of zero that claims a direction', () => {
    // `exceptions_direction_check` admits any label against any impact, so a
    // "shortfall of ₹0" would persist unremarked.
    reject({ ...CONDITION, impact_paise: 0n }, /points nowhere/);
  });

  it('rejects an Exception that references no Source_Record (Requirement 4.12)', () => {
    reject({ ...CONDITION, source_refs: [] }, /at least 1 Source_Record/);
  });

  it('rejects context_refs on a category whose whole ref set is its identity', () => {
    reject(
      { ...CONDITION, context_refs: [{ type: 'refund', id: 'rfnd_SYNTHETIC01' }] },
      /admissible only for/,
    );
  });

  it('rejects a record that is both an identity and a contributor', () => {
    reject(
      {
        ...SELLER_CONDITION,
        context_refs: [{ type: 'linked_account', id: 'acc_SYNTHETIC01' }],
      },
      /in both source_refs and context_refs/,
    );
  });

  it('rejects money in detail carried as a number', () => {
    // JSONB would keep `66100.5` as an IEEE-754 double and nothing downstream could
    // recover the paisa (Requirement 15.1, 15.8).
    reject({ ...CONDITION, detail: { residual_paise: 66100 } }, /reads as a monetary field/);
    reject({ ...CONDITION, detail: { impact_paise: 1 } }, /reads as a monetary field/);
  });

  it('rejects a bigint in detail, which JSON cannot carry', () => {
    reject(
      { ...CONDITION, detail: { residual: 66100n } as never },
      /bigint, which JSON cannot carry/,
    );
  });

  it('rejects a field JSON.stringify would silently drop', () => {
    reject(
      { ...CONDITION, detail: { failing_rule: undefined } as never },
      /JSON\.stringify drops silently/,
    );
  });

  it('rejects a detection timestamp that is not ISO-8601 UTC to the millisecond', () => {
    reject({ ...CONDITION, detected_at: '2026-07-28 10:00:00+00' }, /detected_at must be ISO-8601/);
  });

  it('rejects a non-UUID evidence chain identifier, which no foreign key would catch', () => {
    reject({ ...CONDITION, evidence_chain_id: 'chain-1' }, /evidence_chain_id must be a UUID/);
  });
});

describe('the upserter', () => {
  it('creates once and updates in place on the second run', async () => {
    const store = inMemoryStore();
    const upserter = createExceptionUpserter({ store, tenantId: TENANT });

    const first = await upserter.upsert(CONDITION);
    const second = await upserter.upsert({
      ...CONDITION,
      impact_paise: 77200n,
      detected_at: RUN_2,
    });

    expect(first).toEqual({
      ok: true,
      exception_id: 'exc-1',
      fingerprint: first.fingerprint,
      created: true,
    });
    expect(second).toEqual({ ...first, created: false });
    expect(store.rows.size).toBe(1);

    const row = store.rows.get(first.fingerprint);
    expect(row?.impact_paise).toBe('77200');
    expect(row?.first_detected_at).toBe(RUN_1);
    expect(row?.last_detected_at).toBe(RUN_2);
  });

  it('reports a re-detected closed Exception as a value rather than throwing', async () => {
    const store = inMemoryStore();
    const upserter = createExceptionUpserter({ store, tenantId: TENANT });
    const first = await upserter.upsert(CONDITION);

    const row = store.rows.get(first.fingerprint);
    if (row === undefined) {
      throw new Error('the first run wrote nothing');
    }
    row.state = 'resolved';

    const second = await upserter.upsert({
      ...CONDITION,
      impact_paise: 99999n,
      detected_at: RUN_2,
    });

    expect(second).toEqual({
      ok: false,
      kind: 'not_reopened',
      exception_id: 'exc-1',
      lifecycle_state: 'resolved',
      fingerprint: first.fingerprint,
    });
    // Not reopened, and not touched: task 13.2 counts this, it does not absorb it.
    expect(row.impact_paise).toBe('66100');
    expect(row.last_detected_at).toBe(RUN_1);
    expect(store.rows.size).toBe(1);
  });

  it('binds the Tenant once, so the identity cannot be computed for another', async () => {
    const store = inMemoryStore();
    await createExceptionUpserter({ store, tenantId: TENANT }).upsert(CONDITION);
    const other = '22222222-2222-4222-8222-222222222222';
    await createExceptionUpserter({ store, tenantId: other }).upsert(CONDITION);

    // The same condition under two Tenants is two identities, so two rows — and one
    // Tenant's fingerprint can never name another's Exception.
    expect(store.rows.size).toBe(2);
    expect(store.writes[0]?.fingerprint).not.toBe(store.writes[1]?.fingerprint);
  });

  it('refuses a session Tenant that is not a UUID', () => {
    expect(() => createExceptionUpserter({ store: inMemoryStore(), tenantId: 'tenant-1' })).toThrow(
      ExceptionFingerprintError,
    );
  });

  it('treats a CHECK rejection as a fault, because the validation funnel excludes it', async () => {
    const store: ExceptionStore = {
      upsertException: () =>
        Promise.resolve({ ok: false, kind: 'malformed_row', constraint: 'exceptions_check1' }),
    };
    await expect(
      createExceptionUpserter({ store, tenantId: TENANT }).upsert(CONDITION),
    ).rejects.toThrow(/validation funnel already excludes/);
  });
});
