/**
 * The Chain_Value recomputation and the verification walk (task 25.2, Requirement
 * 13.4, 13.8).
 *
 * Two conventions carried over from `exception-fingerprint.test.ts`, for the same
 * reasons:
 *
 * 1. **The encoding is pinned in this file.** design.md fixes the hashed string, so
 *    every assertion about it builds `createHash('sha256')` over the 12 parts *here*
 *    and compares. Asserting against a digest the module produced would pass after any
 *    encoding change — which is exactly the change that must not pass silently.
 * 2. **The divergence from `jsonb::text` is asserted, not narrated.** The module doc
 *    comment records that `canonicalJson` cannot reproduce what
 *    `app.append_audit_event` hashed for a non-empty payload. The in-process half of
 *    that claim is pinned below to the exact byte; the live half is
 *    `test/db/audit-chain-verify.test.ts`, which runs the real append and this real
 *    walk against Supabase local.
 *
 * Requirements: 13.4, 13.8.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  AUDIT_CHAIN_WALK_SQL,
  AuditChainError,
  canonicalJson,
  chainValue,
  chainValueParts,
  type ChainedAuditEvent,
  createChainVerifier,
  INITIAL_CHAIN_VALUE,
  normalizeOccurredAt,
  verifyChain,
} from './chain';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const OCCURRED_AT = '2026-02-14T09:30:00.000Z';

/** The hash, recomputed here from the 12 parts rather than taken from the module. */
const sha256Hex = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/* -------------------------------------------------------------------------- */
/* Row building                                                               */
/* -------------------------------------------------------------------------- */

type Row = ChainedAuditEvent & { chain_value: string };

function fields(seq: bigint, overrides: Partial<ChainedAuditEvent> = {}): ChainedAuditEvent {
  return {
    tenant_id: TENANT,
    sequence_number: seq,
    event_type: 'agent_stage_completed',
    actor_kind: 'agent',
    actor_id: 'reconciliation_agent',
    stage: null,
    outcome: null,
    proposal_id: null,
    source_record_refs: [],
    payload: { note: `event-${seq}` },
    occurred_at: OCCURRED_AT,
    chain_value: '',
    ...overrides,
  };
}

/** A well-formed chain of `n` Audit_Events, each chained to the one before. */
function chainOf(n: number, patch: (seq: bigint) => Partial<ChainedAuditEvent> = () => ({})): Row[] {
  const rows: Row[] = [];
  let prev = INITIAL_CHAIN_VALUE;
  for (let i = 1; i <= n; i += 1) {
    const seq = BigInt(i);
    const row = fields(seq, patch(seq));
    const value = chainValue(row, prev);
    rows.push({ ...row, chain_value: value });
    prev = value;
  }
  return rows;
}

/**
 * A well-formed chain over exactly `seqs`, each Audit_Event chained to the one that
 * really preceded it. Used for a gap that was never allocated, as distinct from a
 * gap left by deleting a row out of a contiguous chain.
 */
function chainOverSeqs(seqs: readonly bigint[]): Row[] {
  const rows: Row[] = [];
  let prev = INITIAL_CHAIN_VALUE;
  for (const seq of seqs) {
    const row = fields(seq);
    const value = chainValue(row, prev);
    rows.push({ ...row, chain_value: value });
    prev = value;
  }
  return rows;
}

/**
 * Every mismatched sequence number, not just the lowest. `verifyChain` reports only
 * the lowest because Requirement 13.8 asks for that; this is how the tests below
 * assert that a single tampered row does **not** cascade into its successors.
 */
function allMismatches(rows: readonly Row[]): bigint[] {
  const out: bigint[] = [];
  let prev = INITIAL_CHAIN_VALUE;
  for (const row of rows) {
    if (chainValue(row, prev) !== row.chain_value) {
      out.push(row.sequence_number);
    }
    prev = row.chain_value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* canonicalJson                                                              */
/* -------------------------------------------------------------------------- */

describe('canonicalJson sorts object keys and preserves array order', () => {
  it('sorts keys lexicographically at every depth', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { d: 1, c: 2 }, a: 3 })).toBe('{"a":3,"z":{"c":2,"d":1}}');
    // Insertion order must make no difference: the same logical event, either way round.
    expect(canonicalJson({ a: 3, z: { c: 2, d: 1 } })).toBe(canonicalJson({ z: { d: 1, c: 2 }, a: 3 }));
  });

  it('leaves array order exactly as given, duplicates included', () => {
    const refs = [
      { type: 'settlement', id: 'setl_B' },
      { type: 'payment', id: 'pay_A' },
      { type: 'settlement', id: 'setl_B' },
    ];
    // Order preserved, duplicates kept: source_record_refs is an ordered JSONB array,
    // and collapsing or sorting it would change what the append hashed.
    expect(canonicalJson(refs)).toBe(
      '[{"id":"setl_B","type":"settlement"},{"id":"pay_A","type":"payment"},' +
        '{"id":"setl_B","type":"settlement"}]',
    );
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('writes the scalars, the empty forms and nested nulls the way JSON does', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson({ a: null, b: true, c: false, d: 'x' })).toBe(
      '{"a":null,"b":true,"c":false,"d":"x"}',
    );
    // Money is digit text, never a JSON number: encodePaise's output is a string here.
    expect(canonicalJson({ amount_paise: '38200000' })).toBe('{"amount_paise":"38200000"}');
  });

  it('honours toJSON, so a Secret that reached a payload renders as its mask', () => {
    const masked = { toJSON: () => '***REDACTED***' };
    expect(canonicalJson({ credential: masked })).toBe('{"credential":"***REDACTED***"}');
  });

  it('names every construct JSON.stringify would drop, null out, or throw on', () => {
    // Each of these is a field that quietly stopped saying what it said, which in a
    // Chain_Value input is a false tamper report rather than a cosmetic problem.
    expect(() => canonicalJson({ paise: 100n })).toThrow(AuditChainError);
    expect(() => canonicalJson({ paise: 100n })).toThrow(/encodePaise/);
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/NaN/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/Infinity/);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ a: Symbol('s') })).toThrow(/symbol/);

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => canonicalJson(circular)).toThrow(/circular/);
  });

  it('reports the JSON path of the offending value', () => {
    expect(() => canonicalJson({ outer: [{ inner: 1n }] })).toThrow('$.outer[0].inner');
  });
});

describe('canonicalJson is NOT jsonb::text, which is the unresolved divergence', () => {
  it('omits the `: ` and `, ` that Postgres jsonb::text emits', () => {
    // Measured against Supabase local: '{"note":"db-test"}'::jsonb::text is
    // `{"note": "db-test"}` — one 0x20 inserted at byte offset 8, after the `:` at 7.
    const ours = canonicalJson({ note: 'db-test' });
    const postgres = '{"note": "db-test"}';
    expect(ours).toBe('{"note":"db-test"}');
    expect(ours).not.toBe(postgres);
    expect(ours).toHaveLength(18);
    expect(postgres).toHaveLength(19);
    expect(postgres.indexOf(' ')).toBe(8);
    // The whole difference, spelled out: one 0x20 spliced in after the `:` at index 7.
    expect(`${postgres.slice(0, 8)}${postgres.slice(9)}`).toBe(ours);
  });

  it('sorts keys lexicographically where jsonb sorts by length first, then bytewise', () => {
    // FINDING 6(a) of migration 4.4: {"b":1,"aa":2} is `{"b": 1, "aa": 2}` in jsonb.
    expect(canonicalJson({ b: 1, aa: 2 })).toBe('{"aa":2,"b":1}');
    expect(canonicalJson({ b: 1, aa: 2 })).not.toBe('{"b": 1, "aa": 2}');
  });

  it('collapses numeric scale where jsonb preserves the scale it parsed', () => {
    // FINDING 6(c): '{"a":1.0}'::jsonb::text is `{"a": 1.0}`.
    expect(canonicalJson({ a: 1.0 })).toBe('{"a":1}');
  });

  it('agrees with jsonb::text byte for byte for the empty object and the empty array', () => {
    // The one shape where recomputation genuinely reproduces the stored Chain_Value —
    // see test/db/audit-chain-verify.test.ts, which proves it end to end.
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });
});

/* -------------------------------------------------------------------------- */
/* occurred_at                                                                */
/* -------------------------------------------------------------------------- */

describe('the occurred_at normalisation (Requirement 13.1)', () => {
  it('is the identity on the form the append already returns', () => {
    // AUDIT_EVENT_APPEND_SQL renders occurred_at through the same to_char expression the
    // Chain_Value was hashed over, so the normal case is a no-op.
    expect(normalizeOccurredAt(OCCURRED_AT)).toBe(OCCURRED_AT);
    expect(normalizeOccurredAt('2026-12-31T23:59:59.999Z')).toBe('2026-12-31T23:59:59.999Z');
  });

  it('truncates sub-millisecond digits rather than rounding them, as to_char does', () => {
    // Verified against Postgres: to_char('...09:30:00.999999', '...MS"Z"') is
    // `09:30:00.999`. Rounding would give `09:30:01.000` and a false mismatch on every
    // microsecond timestamp.
    expect(normalizeOccurredAt('2026-02-14 09:30:00.999999+00')).toBe('2026-02-14T09:30:00.999Z');
    expect(normalizeOccurredAt('2026-02-14T09:30:00.123456Z')).toBe('2026-02-14T09:30:00.123Z');
    expect(normalizeOccurredAt('2026-02-14T09:30:00.1Z')).toBe('2026-02-14T09:30:00.100Z');
    expect(normalizeOccurredAt('2026-02-14T09:30:00Z')).toBe('2026-02-14T09:30:00.000Z');
  });

  it('shifts an offset to UTC, because the hash is computed AT TIME ZONE UTC', () => {
    expect(normalizeOccurredAt('2026-02-14T15:00:00.000+05:30')).toBe('2026-02-14T09:30:00.000Z');
    expect(normalizeOccurredAt('2026-02-14 15:00:00+0530')).toBe('2026-02-14T09:30:00.000Z');
  });

  it('refuses to guess a zone, and refuses an instant that is not real', () => {
    // TIMESTAMPTZ is an instant; assuming UTC for a value that stated no zone would hash
    // a different instant than the one stored.
    expect(() => normalizeOccurredAt('2026-02-14 09:30:00')).toThrow(/no UTC offset/);
    // Shape-valid but not an instant: Date maps 30 February onto 2 March.
    expect(() => normalizeOccurredAt('2026-02-30T00:00:00.000Z')).toThrow(/not a real instant/);
    expect(() => normalizeOccurredAt('not a timestamp')).toThrow(AuditChainError);
  });
});

/* -------------------------------------------------------------------------- */
/* chainValue                                                                 */
/* -------------------------------------------------------------------------- */

describe('the initial Chain_Value (Requirement 13.4)', () => {
  it('is 64 zeros, which is what audit_sequence_counters defaults to', () => {
    expect(INITIAL_CHAIN_VALUE).toBe('0'.repeat(64));
    expect(INITIAL_CHAIN_VALUE).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('chainValue, with the hashed string rebuilt in this file', () => {
  it('is sha256 over the 12 parts joined with a single |, in design.md order', () => {
    const event = fields(7n, {
      stage: 'AUTHORIZE',
      outcome: 'succeeded',
      proposal_id: '33333333-3333-4333-8333-333333333333',
      source_record_refs: [{ type: 'settlement', id: 'setl_SYNTHETIC9281' }],
      payload: { note: 'worked' },
    });
    const prev = 'a'.repeat(64);

    // Written out rather than derived from the module, so an "improvement" fails here.
    const expected = sha256Hex(
      [
        TENANT,
        '7',
        'agent_stage_completed',
        'agent',
        'reconciliation_agent',
        'AUTHORIZE',
        'succeeded',
        '33333333-3333-4333-8333-333333333333',
        '[{"id":"setl_SYNTHETIC9281","type":"settlement"}]',
        '{"note":"worked"}',
        OCCURRED_AT,
        prev,
      ].join('|'),
    );

    expect(chainValue(event, prev)).toBe(expected);
    expect(chainValue(event, prev)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders an absent stage, outcome and Proposal as the empty string', () => {
    const event = fields(1n, { payload: {}, source_record_refs: [] });
    expect(chainValueParts(event, INITIAL_CHAIN_VALUE)).toEqual([
      TENANT,
      '1',
      'agent_stage_completed',
      'agent',
      'reconciliation_agent',
      '',
      '',
      '',
      '[]',
      '{}',
      OCCURRED_AT,
      INITIAL_CHAIN_VALUE,
    ]);
  });

  it('depends on every one of the 12 parts', () => {
    const base = fields(1n);
    const prev = INITIAL_CHAIN_VALUE;
    const baseline = chainValue(base, prev);
    const changes: readonly Partial<ChainedAuditEvent>[] = [
      { tenant_id: OTHER_TENANT },
      { sequence_number: 2n },
      { event_type: 'other_event' },
      { actor_kind: 'user' },
      { actor_id: 'cash_agent' },
      { stage: 'DETECT' },
      { outcome: 'failed' },
      { proposal_id: '33333333-3333-4333-8333-333333333333' },
      { source_record_refs: [{ type: 'payment', id: 'pay_A' }] },
      { payload: { note: 'different' } },
      { occurred_at: '2026-02-14T09:30:00.001Z' },
    ];
    for (const change of changes) {
      const label = Object.keys(change).join(',');
      expect(chainValue({ ...base, ...change }, prev), label).not.toBe(baseline);
    }
    expect(chainValue(base, 'b'.repeat(64))).not.toBe(baseline);
  });

  it('holds sequence_number to a bigint and the preceding value to 64 hex characters', () => {
    // audit_events.sequence_number is BIGINT: digit text then BigInt(...), never Number(...).
    expect(() =>
      chainValue({ ...fields(1n), sequence_number: 1 as unknown as bigint }, INITIAL_CHAIN_VALUE),
    ).toThrow(/bigint/);
    expect(() => chainValue(fields(1n), 'deadbeef')).toThrow(/64 lower-case hex/);
    // `encode(digest(...), 'hex')` emits lower case, so upper case is not a Chain_Value.
    expect(() => chainValue(fields(1n), 'A'.repeat(64))).toThrow(/64 lower-case hex/);
  });
});

/* -------------------------------------------------------------------------- */
/* verifyChain                                                                */
/* -------------------------------------------------------------------------- */

describe('the verification walk on an untampered Audit_Log (Requirement 13.8)', () => {
  it('reports intact with both anomaly fields null', async () => {
    await expect(verifyChain(chainOf(5))).resolves.toEqual({
      intact: true,
      first_mismatched_sequence_number: null,
      first_absent_sequence_number: null,
    });
  });

  it('reports intact for a Tenant with no Audit_Events at all', async () => {
    // Vacuously true, and the honest answer: nothing is mismatched and nothing is absent.
    await expect(verifyChain([])).resolves.toEqual({
      intact: true,
      first_mismatched_sequence_number: null,
      first_absent_sequence_number: null,
    });
  });

  it('accepts an async row source, so an adapter can stream instead of buffering', async () => {
    const rows = chainOf(3);
    async function* pages(): AsyncGenerator<Row> {
      for (const row of rows) {
        yield await Promise.resolve(row);
      }
    }
    await expect(verifyChain(pages())).resolves.toMatchObject({ intact: true });
  });

  it('verifies a varied Audit_Log: stages, outcomes, refs and reduced payloads', async () => {
    const rows = chainOf(4, (seq) =>
      seq === 2n
        ? { stage: 'PROPOSE', outcome: 'succeeded', source_record_refs: [{ type: 'payment', id: 'pay_A' }] }
        : seq === 3n
          ? { payload: { reduced: true, excerpt: 'x'.repeat(200) }, actor_kind: 'policy_engine', actor_id: 'policy_engine' }
          : {},
    );
    await expect(verifyChain(rows)).resolves.toMatchObject({ intact: true });
  });
});

describe('a tampered Audit_Event (Requirement 13.8)', () => {
  it('reports the lowest mismatched sequence number', async () => {
    const rows = chainOf(5);
    // A field edit: the stored chain_value is left alone, so only the recomputation moves.
    rows[2] = { ...rows[2]!, payload: { note: 'edited' } };
    await expect(verifyChain(rows)).resolves.toEqual({
      intact: false,
      first_mismatched_sequence_number: 3n,
      first_absent_sequence_number: null,
    });
  });

  it('does not cascade: exactly the edited Audit_Event reports as mismatched', async () => {
    // This is why the walk advances `prev` to the STORED chain_value rather than the
    // recomputed one. Chaining from the recomputed value would mark 3, 4 and 5 mismatched
    // and the result would no longer locate the edit.
    const rows = chainOf(5);
    rows[2] = { ...rows[2]!, payload: { note: 'edited' } };
    expect(allMismatches(rows)).toEqual([3n]);
  });

  it('reports two independent edits at the lowest of them', async () => {
    const rows = chainOf(5);
    rows[1] = { ...rows[1]!, actor_id: 'someone_else' };
    rows[3] = { ...rows[3]!, occurred_at: '2026-02-14T09:30:00.001Z' };
    expect(allMismatches(rows)).toEqual([2n, 4n]);
    await expect(verifyChain(rows)).resolves.toMatchObject({
      first_mismatched_sequence_number: 2n,
    });
  });

  it('detects an edited chain_value on the edited row and on its successor', async () => {
    // Rewriting a stored chain_value breaks the link the next row depends on, so the
    // evidence is two rows wide rather than one. That is stronger evidence, not weaker:
    // no single-row edit of chain_value can be made to verify.
    const rows = chainOf(4);
    rows[1] = { ...rows[1]!, chain_value: 'f'.repeat(64) };
    expect(allMismatches(rows)).toEqual([2n, 3n]);
    await expect(verifyChain(rows)).resolves.toMatchObject({
      intact: false,
      first_mismatched_sequence_number: 2n,
    });
  });

  it('reports a mismatch when chain_value is not a Chain_Value at all', async () => {
    const rows = chainOf(2);
    rows[0] = { ...rows[0]!, chain_value: '' };
    await expect(verifyChain(rows)).resolves.toMatchObject({
      intact: false,
      first_mismatched_sequence_number: 1n,
    });
  });
});

describe('an absent sequence number (Requirement 13.8)', () => {
  it('reports a never-allocated sequence number as a gap and nothing else', async () => {
    // A number that was never allocated: 1, 2 and 4 each chained to the Audit_Event that
    // really preceded them, so every link is sound and the ONLY anomaly is the gap. This is
    // the shape a Postgres sequence would produce on rollback, and it is why allocation uses
    // a counter row that advances on commit instead (Requirement 13.1).
    await expect(verifyChain(chainOverSeqs([1n, 2n, 4n]))).resolves.toEqual({
      intact: false,
      first_mismatched_sequence_number: null,
      first_absent_sequence_number: 3n,
    });
  });

  it('reports a deleted Audit_Event as a gap AND a mismatch on its successor', async () => {
    // Distinct from the case above, and worth separating: a deletion removes a link its
    // successor was chained to, so the successor's recomputation no longer reproduces its
    // stored value. Two independent signals for one edit, which is what makes a deletion
    // from the middle of the Audit_Log unforgeable without also rewriting every later
    // chain_value — and UPDATE is revoked outright (Requirement 13.5).
    const rows = chainOf(5).filter((r) => r.sequence_number !== 3n);
    await expect(verifyChain(rows)).resolves.toEqual({
      intact: false,
      first_mismatched_sequence_number: 4n,
      first_absent_sequence_number: 3n,
    });
  });

  it('reports the gap at the missing number, not at the row that revealed it', async () => {
    const rows = chainOverSeqs([1n, 4n, 5n]);
    // 2 and 3 are both absent; the answer is the lowest of them.
    await expect(verifyChain(rows)).resolves.toEqual({
      intact: false,
      first_mismatched_sequence_number: null,
      first_absent_sequence_number: 2n,
    });
  });

  it('reports a missing first Audit_Event as an absent sequence number 1', async () => {
    const rows = chainOf(3).filter((r) => r.sequence_number !== 1n);
    await expect(verifyChain(rows)).resolves.toMatchObject({
      intact: false,
      first_absent_sequence_number: 1n,
      // Removing event 1 also breaks event 2's link, which chained to it.
      first_mismatched_sequence_number: 2n,
    });
  });
});

describe('a gap and a mismatch report independently, neither masking the other', () => {
  it('reports both, each at its own lowest, when the mismatch is the lower', async () => {
    const rows = chainOf(6);
    rows[1] = { ...rows[1]!, event_type: 'edited_event' };
    const withGap = rows.filter((r) => r.sequence_number !== 4n);
    await expect(verifyChain(withGap)).resolves.toEqual({
      intact: false,
      first_mismatched_sequence_number: 2n,
      first_absent_sequence_number: 4n,
    });
  });

  it('reports both when the gap is the lower', async () => {
    const rows = chainOf(6);
    rows[4] = { ...rows[4]!, event_type: 'edited_event' };
    const withGap = rows.filter((r) => r.sequence_number !== 2n);
    await expect(verifyChain(withGap)).resolves.toEqual({
      intact: false,
      // Removing 2 breaks 3's link as well; 3 is the lower mismatch, and the edit at 5 is
      // still there. Requirement 13.8 asks for the lowest of each, independently.
      first_mismatched_sequence_number: 3n,
      first_absent_sequence_number: 2n,
    });
  });
});

describe('a row source that breaks the walk contract', () => {
  it('refuses Audit_Events from more than one Tenant', async () => {
    const rows = chainOf(3);
    rows[1] = { ...rows[1]!, tenant_id: OTHER_TENANT };
    // Not a tamper report: a result computed over a mixture of Tenants would be
    // meaningless, and the walk is scoped to the session's Tenant.
    await expect(verifyChain(rows)).rejects.toThrow(/more than one Tenant/);
  });

  it('refuses a sequence order that is not strictly ascending', async () => {
    const rows = chainOf(3);
    await expect(verifyChain([rows[1]!, rows[0]!])).rejects.toThrow(/strictly ascending/);
    await expect(verifyChain([rows[0]!, rows[0]!])).rejects.toThrow(/strictly ascending/);
  });

  it('refuses a sequence number that arrived as a number', async () => {
    const rows = chainOf(1);
    const broken = { ...rows[0]!, sequence_number: 1 as unknown as bigint };
    await expect(verifyChain([broken])).rejects.toThrow(/BIGINT/);
  });
});

describe('the verifier seam and the statement an adapter runs', () => {
  it('walks whatever the store yields, with no Tenant argument anywhere', async () => {
    const rows = chainOf(3);
    const verifier = createChainVerifier({ eventsAscendingBySequence: () => rows });
    await expect(verifier.verifyChain()).resolves.toMatchObject({ intact: true });
    // design.md's AuditService.verifyChain(tenantId) takes one; this does not, because the
    // Tenant is the session's and a second source of truth for it is the hazard
    // (Requirement 14.1, 14.2).
    expect(verifier.verifyChain).toHaveLength(0);
  });

  it('scopes the read on the session Tenant and binds no parameter', () => {
    expect(AUDIT_CHAIN_WALK_SQL).toContain('app.current_tenant_id()');
    expect(AUDIT_CHAIN_WALK_SQL).not.toContain('$1');
    // Digit text for BigInt(...), and the exact to_char text the Chain_Value was hashed over.
    expect(AUDIT_CHAIN_WALK_SQL).toContain('e.sequence_number::text AS sequence_number');
    expect(AUDIT_CHAIN_WALK_SQL).toContain(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
    expect(AUDIT_CHAIN_WALK_SQL).toContain('ORDER BY e.sequence_number');
    // prev_chain_value is deliberately absent: the walk chains from the preceding row.
    expect(AUDIT_CHAIN_WALK_SQL).not.toContain('prev_chain_value');
  });
});
