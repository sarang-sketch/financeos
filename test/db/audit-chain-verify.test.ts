/**
 * The Chain_Value recomputation and the verification walk against Supabase local
 * (task 25.2, Requirement 13.4, 13.8).
 *
 * `src/audit/chain.test.ts` pins the encoding in process. This file answers the one
 * question that cannot be answered in process: **does the TypeScript `chainValue`
 * reproduce the `chain_value` `app.append_audit_event` actually stored?** It runs the
 * real append through `AUDIT_EVENT_APPEND_SQL`, reads the rows back through
 * `AUDIT_CHAIN_WALK_SQL`, and walks them with the real `verifyChain`.
 *
 * | Claim | Mechanism | Requirement |
 * |---|---|---|
 * | recomputation reproduces the stored Chain_Value for `{}` / `[]` | 3 real appends, `verifyChain` | 13.4, 13.8 |
 * | the fixed initial Chain_Value is what sequence 1 chains from | `prev_chain_value` = 64 zeros | 13.4 |
 * | the walk statement plans and runs as exported | `PREPARE` over the exact text | 13.8 |
 * | recomputation reproduces it for any other payload too | the same walk, one non-empty payload | 13.4 |
 * | the hashed rendering is `canonicalJson`, not `jsonb::text` | substituting `payload::text` into part 10 breaks the digest | 13.4 |
 * | all 12 hashed parts agree | `chainValueParts` compared part by part | 13.4 |
 *
 * THE DIVERGENCE WAS MEASURED HERE, AND HAS SINCE BEEN REPAIRED
 *
 * FINDING 6(a)(b)(c) of `20260101000004_audit_log_append_only.sql`: the SQL hashed
 * `p_source_refs::text` and `v_payload::text` — `jsonb::text` — while `canonicalJson`
 * is design.md's "sorted keys, preserved array order". The two agree only where
 * `jsonb::text` happens to emit the same bytes, which is the empty object and the
 * empty array. Every other payload made the walk report a mismatch on an Audit_Event
 * nobody touched.
 *
 * This file stated that divergence precisely rather than working around it, so that
 * property P9 (task 25.3) knew exactly what to expect and so that whichever repair
 * design.md chose would announce itself. design.md chose the second of the two
 * candidates in `20260101000010_audit_chain_canonical_json.sql`: `app.canonical_jsonb`
 * renders sorted keys, preserved array order, compact separators and normalised
 * numeric scale; `app.append_audit_event` hashes that; and every existing per-Tenant
 * log is re-chained in sequence order so verification stays valid across the migration
 * boundary. The `it.fails` marker came off with its body untouched.
 *
 * `jsonb::text` itself is unchanged, and the last describe block still measures its
 * three renderings against live Postgres — that is why `app.canonical_jsonb` had to
 * exist, and it stays asserted so the reason cannot be forgotten.
 *
 * Requirements: 13.4, 13.8.
 */

import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  AUDIT_EVENT_APPEND_SQL,
  type AuditEventDraft,
  auditEventAppendParams,
} from '@/audit/audit-service';
import {
  AUDIT_CHAIN_WALK_SQL,
  canonicalJson,
  type ChainedAuditEvent,
  chainValue,
  chainValueParts,
  INITIAL_CHAIN_VALUE,
  verifyChain,
} from '@/audit/chain';
import type { SourceRef } from '@/ledger/posting-rules';

import {
  announceIfUnreachable,
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

const OCCURRED_AT = '2026-02-14T09:30:00.000Z';

/** The hash, rebuilt here rather than taken from the module under test. */
const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** `PREPARE`, so Postgres plans the exported string itself. */
const prepared = (name: string, sql: string): string => `prepare ${name} as\n${sql};`;

const execute = (name: string, params: readonly (string | null)[] = []): string =>
  params.length === 0
    ? `execute ${name};`
    : `execute ${name}(${params.map((p) => (p === null ? 'null' : lit(p))).join(', ')});`;

function draft(overrides: Partial<AuditEventDraft> = {}): AuditEventDraft {
  return {
    eventType: 'agent_stage_completed',
    actor: { kind: 'agent', id: 'reconciliation_agent' },
    payload: {},
    sourceRefs: [],
    occurredAt: OCCURRED_AT,
    ...overrides,
  };
}

const append = (overrides: Partial<AuditEventDraft> = {}): string =>
  execute('audit_append', auditEventAppendParams(draft(overrides)));

/** Exactly what {@link AUDIT_CHAIN_WALK_SQL} returns, as JSON out of `psql`. */
interface WalkRow {
  readonly tenant_id: string;
  /** `sequence_number::text`: digit text for `BigInt(...)`, never a double. */
  readonly sequence_number: string;
  readonly event_type: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly stage: string | null;
  readonly outcome: string | null;
  readonly proposal_id: string | null;
  readonly source_record_refs: unknown;
  readonly payload: unknown;
  readonly occurred_at: string;
  readonly chain_value: string;
}

/** A driver row as the walk consumes it. The only conversion is the `BIGINT`. */
const toChained = (row: WalkRow): ChainedAuditEvent => ({
  ...row,
  sequence_number: BigInt(row.sequence_number),
});

/**
 * Run `appends` for a fresh Tenant and return the rows the walk reads, in ascending
 * sequence order, plus `prev_chain_value` and `payload::text` for the assertions that
 * need the stored bytes rather than the parsed JSON.
 *
 * Every append emits one tuple line, so the JSON queries sit at `appends.length` and
 * `appends.length + 1`. The whole script is rolled back: `audit_events` is append-only
 * and revokes `DELETE`, so a committed row could never be cleaned up.
 */
function walk(
  f: Fixture,
  appends: readonly string[],
): {
  readonly rows: readonly ChainedAuditEvent[];
  readonly stored: readonly { readonly payload_text: string; readonly prev_chain_value: string }[];
} {
  const script = rolledBack(
    [
      provision(f),
      prepared('audit_append', AUDIT_EVENT_APPEND_SQL),
      prepared('audit_walk', AUDIT_CHAIN_WALK_SQL),
      ...appends,
      jsonRows(AUDIT_CHAIN_WALK_SQL),
      jsonRows(
        `select payload::text as payload_text, prev_chain_value
           from audit_events where tenant_id = ${lit(f.tenantId)}
          order by sequence_number`,
      ),
    ].join('\n'),
  );
  const r = runScript(script);
  expect(r.errors, r.rawErr).toHaveLength(0);

  const rows = [...jsonAt<readonly WalkRow[]>(r, appends.length)]
    .map(toChained)
    .sort((a, b) => (a.sequence_number < b.sequence_number ? -1 : 1));
  return {
    rows,
    stored: jsonAt<readonly { payload_text: string; prev_chain_value: string }[]>(
      r,
      appends.length + 1,
    ),
  };
}

beforeAll(announceIfUnreachable);

describe.skipIf(!database().reachable)('the walk statement an adapter runs (Requirement 13.8)', () => {
  it('plans as exported, binds nothing, and returns the 12 columns the walk reads', () => {
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          prepared('audit_append', AUDIT_EVENT_APPEND_SQL),
          // No parameter list: the Tenant comes from app.current_tenant_id().
          prepared('audit_walk', AUDIT_CHAIN_WALK_SQL),
          append(),
          execute('audit_walk'),
          jsonRows(
            `select count(*)::int as params from pg_prepared_statements,
                    unnest(parameter_types) where name = 'audit_walk'`,
          ),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);

    // One row out of the walk, 12 '|'-separated columns; no value here contains a '|'.
    expect((r.out[1] ?? '').split('|')).toHaveLength(12);
    expect(jsonAt<readonly { readonly params: number }[]>(r, 2)).toEqual([{ params: 0 }]);
  });

  it('returns nothing when the session carries no Tenant, and the walk then says intact', async () => {
    // The reported gap in chain.ts: `tenant_id = NULL` matches nothing, so an
    // unauthenticated caller gets a clean verification of zero rows. An adapter must run
    // AUDIT_SESSION_TENANT_PROBE_SQL first; hardening the walk instead would make a newly
    // provisioned Tenant unverifiable.
    const f = newFixture();
    const r = runScript(
      rolledBack(
        [
          provision(f),
          prepared('audit_append', AUDIT_EVENT_APPEND_SQL),
          append(),
          // A claim carrying a User but no tenant_id, which is what leaves
          // `app.current_tenant_id()` NULL. Clearing the setting outright is not the same
          // thing: `set_config(..., null, ...)` stores the empty string and
          // `app.current_tenant_id()` then dies on `''::json` with `22P02`.
          `do $c$ begin perform set_config('request.jwt.claims',
             json_build_object('sub', ${lit(f.userId)})::text, false); end $c$;`,
          jsonRows(AUDIT_CHAIN_WALK_SQL),
        ].join('\n'),
      ),
    );
    expect(r.errors, r.rawErr).toHaveLength(0);
    const rows = jsonAt<readonly WalkRow[]>(r, 1);
    expect(rows).toEqual([]);
    await expect(verifyChain(rows.map(toChained))).resolves.toEqual({
      intact: true,
      first_mismatched_sequence_number: null,
      first_absent_sequence_number: null,
    });
  });
});

describe.skipIf(!database().reachable)(
  'recomputation over the stored rows, where jsonb::text and canonicalJson agree',
  () => {
    it('reproduces every stored Chain_Value for an empty payload and no refs', async () => {
      // `{}`::jsonb::text is `{}` and `[]`::jsonb::text is `[]`, so all 12 hashed parts
      // are byte-identical and the walk is exactly correct: Requirement 13.4's
      // recomputation and Requirement 13.8's verification, end to end against the real
      // append.
      const f = newFixture();
      const { rows, stored } = walk(f, [append(), append(), append()]);

      expect(rows.map((row) => row.sequence_number)).toEqual([1n, 2n, 3n]);
      expect(stored[0]?.prev_chain_value).toBe(INITIAL_CHAIN_VALUE);
      expect(stored.map((s) => s.payload_text)).toEqual(['{}', '{}', '{}']);

      // Part by part, then the walk.
      let prev = INITIAL_CHAIN_VALUE;
      for (const row of rows) {
        expect(chainValue(row, prev), `sequence ${row.sequence_number}`).toBe(row.chain_value);
        prev = row.chain_value;
      }
      await expect(verifyChain(rows)).resolves.toEqual({
        intact: true,
        first_mismatched_sequence_number: null,
        first_absent_sequence_number: null,
      });
    });

    it('reproduces it with a stage, an outcome and the Tenant read off the row', async () => {
      const f = newFixture();
      const { rows } = walk(f, [
        append({ stage: 'DETECT', outcome: 'succeeded' }),
        append({ stage: 'INVESTIGATE', outcome: 'blocked', actor: { kind: 'user', id: 'ops' } }),
      ]);

      expect(rows.map((row) => row.stage)).toEqual(['DETECT', 'INVESTIGATE']);
      // The occurred_at the walk returns is already the text the hash was computed over.
      expect(rows.map((row) => row.occurred_at)).toEqual([OCCURRED_AT, OCCURRED_AT]);
      await expect(verifyChain(rows)).resolves.toMatchObject({ intact: true });
    });
  },
);

describe.skipIf(!database().reachable)(
  'recomputation over any other payload, which is FINDING 6(b) repaired',
  () => {
    it('reproduces the stored Chain_Value for a non-empty payload', async () => {
      const f = newFixture();
      const { rows, stored } = walk(f, [append({ payload: { note: 'db-test' } })]);

      // `payload::text` still renders with a space after the colon — that is `jsonb::text`
      // and migration 10 did not change it. What changed is which rendering the hash is
      // computed over: `app.append_audit_event` now hashes `app.canonical_jsonb(payload)`,
      // which is byte-for-byte `canonicalJson`. So the two renderings still differ and the
      // Chain_Value now agrees anyway, which is the whole point of the repair.
      expect(stored[0]?.payload_text).toBe('{"note": "db-test"}');
      expect(canonicalJson(rows[0]?.payload)).toBe('{"note":"db-test"}');
      await expect(verifyChain(rows)).resolves.toEqual({
        intact: true,
        first_mismatched_sequence_number: null,
        first_absent_sequence_number: null,
      });
    });

    it('hashes the canonical rendering at part 10, and not the jsonb::text one', () => {
      // The inverse of what this test asserted before migration 10, and it is the assertion
      // that pins WHICH rendering is hashed rather than merely that the digests match.
      // Part 10 carries `canonicalJson`; substituting the stored `payload::text` into it
      // now BREAKS the digest, because that is no longer the text the SQL hashed.
      const f = newFixture();
      const { rows, stored } = walk(f, [append({ payload: { note: 'db-test' } })]);
      const row = rows[0];
      const payloadText = stored[0]?.payload_text;
      expect(row).toBeDefined();
      expect(payloadText).toBeDefined();

      const parts = [...chainValueParts(row!, INITIAL_CHAIN_VALUE)];
      expect(parts).toHaveLength(12);
      // All 12 parts as `chainValue` builds them reproduce the stored digest exactly.
      expect(sha256Hex(parts.join('|'))).toBe(row!.chain_value);

      const asJsonbText = [...parts];
      asJsonbText[9] = payloadText!;
      expect(sha256Hex(asJsonbText.join('|'))).not.toBe(row!.chain_value);

      // The two renderings still differ by one 0x20 after the `:`; only the choice of
      // which one is hashed changed.
      expect(parts[9]).toHaveLength(18);
      expect(payloadText).toHaveLength(19);
      expect(payloadText!.indexOf(' ')).toBe(8);
      expect(`${payloadText!.slice(0, 8)}${payloadText!.slice(9)}`).toBe(parts[9]);
    });

    it('agrees on non-empty source_record_refs for the same reason', async () => {
      const f = newFixture();
      const refs: readonly SourceRef[] = [{ type: 'settlement', id: 'setl_SYNTHETIC9281' }];
      const { rows } = walk(f, [append({ sourceRefs: refs })]);

      expect(rows[0]?.source_record_refs).toEqual([...refs]);
      // Part 9 is `[{"id":"setl_SYNTHETIC9281","type":"settlement"}]` on both sides now:
      // `app.canonical_jsonb` sorts keys and drops the separators' spaces exactly as
      // `canonicalJson` does.
      await expect(verifyChain(rows)).resolves.toMatchObject({
        intact: true,
        first_mismatched_sequence_number: null,
      });
    });

    /**
     * The case that had to eventually pass, and now does.
     *
     * It was `it.fails` with the CORRECT expectation in the body so that whichever repair
     * design.md chose would turn it into a reported error rather than leaving the
     * divergence forgotten. design.md chose the second of the two candidates —
     * `app.append_audit_event` hashes a canonical form, and every stored Chain_Value is
     * migrated — in `20260101000010_audit_chain_canonical_json.sql`. The marker came off
     * with the body untouched, which is the outcome the marker existed to produce.
     */
    it('verifies a real Audit_Log with a real payload (Requirement 13.4, 13.8)', async () => {
      const f = newFixture();
      const { rows } = walk(f, [
        append({ payload: { note: 'first' } }),
        append({ payload: { note: 'second' } }),
      ]);
      await expect(verifyChain(rows)).resolves.toEqual({
        intact: true,
        first_mismatched_sequence_number: null,
        first_absent_sequence_number: null,
      });
    });
  },
);

describe.skipIf(!database().reachable)(
  'the three jsonb::text renderings canonicalJson does not reproduce',
  () => {
    it('measures key order, separators and numeric scale against live Postgres', () => {
      // Asked of the database rather than asserted from the migration's comment, so
      // FINDING 6(a)(b)(c) stays true of the Postgres actually running.
      const r = runScript(
        [
          `select ('{"b":1,"aa":2}'::jsonb)::text;`,
          `select ('{"a":1.0}'::jsonb)::text;`,
          `select ('[{"type":"settlement","id":"setl_X"}]'::jsonb)::text;`,
          `select ('{}'::jsonb)::text || '|' || ('[]'::jsonb)::text;`,
        ].join('\n'),
      );
      expect(r.errors, r.rawErr).toHaveLength(0);

      // (a) key length first, then bytewise — not lexicographic.
      expect(r.out[0]).toBe('{"b": 1, "aa": 2}');
      expect(canonicalJson({ b: 1, aa: 2 })).toBe('{"aa":2,"b":1}');
      // (c) the parsed numeric scale is preserved.
      expect(r.out[1]).toBe('{"a": 1.0}');
      expect(canonicalJson({ a: 1.0 })).toBe('{"a":1}');
      // (b) `': '` and `', '` after every key and between every member.
      expect(r.out[2]).toBe('[{"id": "setl_X", "type": "settlement"}]');
      expect(canonicalJson([{ type: 'settlement', id: 'setl_X' }])).toBe(
        '[{"id":"setl_X","type":"settlement"}]',
      );
      // The one agreement, which is why the empty-payload walk above verifies.
      expect(r.out[3]).toBe('{}|[]');
      expect(`${canonicalJson({})}|${canonicalJson([])}`).toBe('{}|[]');
    });
  },
);
