// Feature: financeos-control-tower, Property 9: Audit chain integrity — for all generated
// Audit_Event sequences, the recomputed Chain_Value equals the stored Chain_Value for every
// Audit_Event, the Tenant-scoped sequence numbers form the contiguous range 1..n with no gap
// and no duplicate, re-reading an Audit_Event returns identical field values, and when
// tampering or a gap is injected the verification walk reports the lowest mismatched sequence
// number and the lowest absent sequence number at the injected positions.
//
// **Validates: Requirements 13.1, 13.4, 13.8, 13.10**
//
// P9 IS SPLIT IN TWO, AND THE SPLIT IS THE POINT OF THIS HEADER
// ------------------------------------------------------------
// design.md's P9 assertion has two independent halves, they are testable to different degrees
// today, and pretending otherwise would produce a green suite over a known defect. So:
//
//   HALF A — `describe('P9 half A ...')`, in process, over the FULL generated input space.
//     `chainValue` is the producer and `chainValue` is the recomputation, and `verifyChain` is
//     the walk under test. Every claim about what the walk REPORTS — intact on a sound chain,
//     the lowest mismatch and the lowest gap at the injected positions, neither anomaly
//     masking the other — is asserted here, over varied event types, actor kinds, stages,
//     outcomes, Source_Record reference arrays, payloads including ones over 65536 bytes, and
//     interleaved aborted appends. PASSES TODAY.
//
//   HALF B — `describe('P9 half B ...')`, against the real `app.append_audit_event` on
//     Supabase local, also over the FULL input space, in two tests:
//       B1 the allocator: n committed appends carry sequence numbers 1..n, an aborted append
//          consumes no sequence number, the stored fields are the supplied ones, an oversized
//          payload comes back reduced with its Source_Record identifiers unreduced, and two
//          successive reads return identical field values. PASSES TODAY.
//       B2 the recomputation: `chainValue` over the stored fields reproduces the stored
//          `chain_value`. PASSES TODAY, since migration 10 landed. See below.
//
// WHY B2 WAS BLOCKED, AND WHICH REPAIR UNBLOCKED IT
// ------------------------------------------------
// FINDING 6(a)(b)(c) of `20260101000004_audit_log_append_only.sql`, measured against live
// local Postgres by task 25.2: `app.append_audit_event` hashed `p_source_refs::text` and
// `v_payload::text` — `jsonb::text` — while `canonicalJson` is design.md's "sorted keys,
// preserved array order". `jsonb::text` orders object keys by length then bytewise, emits
// `': '` after every key and `', '` between every member, and preserves the numeric scale it
// parsed. The two renderings agree on exactly two values, `{}` and `[]`, so recomputation
// reproduced the stored Chain_Value for an empty payload with no references and reported a
// false mismatch for every other Audit_Event. `test/db/audit-chain-verify.test.ts` localises
// it to part 10 of the 12 hashed parts and reproduces the stored digest byte for byte by
// substituting the stored `payload::text` into that one part, so the payload rendering was the
// whole of the difference.
//
// This file named two candidate repairs and took neither into its own hands: it did not weaken
// `canonicalJson`, did not touch the migration, and did not restrict B2's generator to empty
// payloads to make it green. B2 drew from the same generator as B1 and failed, which was the
// honest report. `20260101000010_audit_chain_canonical_json.sql` then landed the second
// repair — `app.canonical_jsonb` in SQL, hashed by `app.append_audit_event`, with every
// existing per-Tenant log re-chained in sequence order so verification stays valid across the
// migration boundary. The `it.fails` marker came off exactly as prescribed, the generator was
// never narrowed, and half A's oracle lifted onto stored rows unchanged — it is written
// against sequence numbers and injection positions, not against the in-memory producer.
//
// HALF A IS NOT `x === x`, AND HERE IS WHY
// ---------------------------------------
// A recomputation asserted against the value it just produced proves nothing. So every row
// half A recomputes over is first put through {@link asReRead}: `JSON.parse(JSON.stringify(…))`
// on `payload` and `source_record_refs` with the key order of every object REVERSED at every
// depth, which is how a driver that preserved a different insertion order would hand the row
// back. `canonicalJson` exists precisely so that recomputation survives that, and reversing
// the keys is the cheapest mutation guaranteed to differ for every object with 2 or more keys.
// The falsification log below confirms the assertion is load-bearing: unsorting `canonicalJson`
// breaks it on the first counterexample.
//
// The "sequence numbers form 1..n" clause is the one claim half A CANNOT own — in half A the
// model allocates them, so asserting it there is circular. It is asserted anyway, because the
// oracle's gap positions are meaningless without it, and the real claim about the real
// allocator is B1's, against `audit_sequence_counters` under the row lock.
//
// GAPLESSNESS UNDER ROLLBACK: WHAT THE INTERLEAVED ABORTED APPENDS MEASURE
// ----------------------------------------------------------------------
// design.md's P9 generator asks for "interleaved aborted transactions so that gaplessness is
// tested under rollback". `app.append_audit_event` allocates from `audit_sequence_counters`
// with `SELECT last_sequence + 1 … FOR UPDATE` and advances that row at the end, so the
// allocation is undone with the transaction. **Measured before this property was written,
// twice, and both directions hold:**
//
//   - subtransaction granularity: append → seq 1; `savepoint`, append → seq 2, counter reads 2
//     inside the subtransaction; `rollback to savepoint` → counter reads 1 again; next append →
//     seq 2. Committed rows end up `1:e1, 2:e3, 3:e4_big` with no gap.
//   - top-level granularity: `begin; append; rollback;` leaves `last_sequence = 0`, and the
//     next transaction's append takes seq 1.
//
// So a rolled-back append leaves NO gap, which is exactly what the migration's comment claims
// and what a Postgres sequence would not give. B1 asserts it over generated interleavings
// rather than over the one hand-built case. It uses `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` for
// the aborted appends and throws the whole outer transaction away afterwards: that is the
// per-iteration rollback discipline design.md asks for, and it is the only form available,
// because `audit_events` revokes `DELETE` so a committed iteration could never be cleaned up.
// The difference from two genuinely concurrent transactions is the counter row LOCK — a second
// session would block on it — and that is serialization rather than gaplessness, is not what
// P9 asserts, and is not reachable from one `psql` session at all.
//
// HOW TAMPERING AND A GAP ARE INJECTED WITHOUT AN UPDATE OR A DELETE
// -----------------------------------------------------------------
// `audit_events` revokes `UPDATE` and `DELETE` for every role and `reject_mutation_and_audit()`
// fires on both, so a tamper cannot be written and a row cannot be removed — nor should this
// file want to, since that barrier is task 25.5's subject. Both anomalies are injected into the
// **walk's input** instead, after the rows exist:
//
//   - a TAMPER is a field edited on the row handed to the walk while its `chain_value` is left
//     alone. That is precisely the state an out-of-band edit would leave the walk looking at,
//     and it is the state the walk must detect. 9 kinds are drawn, one per hashed field plus
//     `chain_value` itself, and each is constructed to change the value it replaces.
//   - a GAP comes in two kinds, because they are genuinely different failure modes and
//     `verifyChain` reports them differently:
//       `withheld`     — the row is dropped from the walk's input: an Audit_Event that was
//                        allocated and is now absent. Its successor was chained to it, so the
//                        walk reports the gap AND an induced mismatch on that successor. Not a
//                        weakness: a deletion that left no mismatch would be a chain that
//                        failed to chain.
//       `unallocated`  — the sequence number was never allocated, so every surviving row is
//                        chained to the row that really preceded it and the ONLY anomaly is the
//                        gap. This is the failure mode a Postgres sequence would produce on
//                        rollback and the counter row exists to prevent; it is unreachable
//                        through `app.append_audit_event`, so it is half A's alone.
//
// The oracle {@link expectedVerification} derives the expected report from the injection
// positions in SEQUENCE-NUMBER space, never by re-running the walk's loop. Note that design.md
// writes the assertion as `first_mismatched_sequence_number === i+1`: that index-to-sequence
// identity holds only on a contiguous chain, so with an `unallocated` gap below the tampered
// row the expected value is its ACTUAL sequence number. The oracle uses the actual number,
// which is the stronger and the honest reading.
//
// ITERATIONS AND SEED
// -------------------
// Half A: `numRuns: 400`. design.md's floor is 100 and P9 is not one of the four raised to
// 1000; 400 is used because the coverage assertion below demands all 9 tamper kinds, both gap
// kinds, all 4 injection combinations, an oversized payload and an aborted append, and 100 runs
// leave individual tamper kinds unreached. Half A is in process, so the extra runs cost
// milliseconds. B1: `numRuns: 100`, design.md's stated minimum, one `psql` session per
// iteration (~150 ms against this container), so about 15 s. B2: `numRuns: 20` with
// `endOnFailure` so the known failure is reported from the first counterexample instead of
// shrinking a 65 kB payload. The seed is explicit and committed.
//
// NOT VACUOUS
// -----------
// Checked by falsification three times. All three mutations were reverted and no regression
// test is committed for any of them: the counterexamples came from deliberately broken code,
// not from a defect in the system.
//
//   - `canonicalJson` in `src/audit/chain.ts` left in insertion order (the `entries.sort(…)`
//     line removed), which is the mutation half A's key reversal exists to catch:
//
//       Error: Property failed after 1 tests
//       { seed: 20260521, path: "0:0:0:0:0:1:1:1:1:1:1:1:0:0", endOnFailure: true }
//       Counterexample: [{"appends":[{"draft":{"eventType":"agent_stage_completed",
//         "actor":{"kind":"user","id":"1f0d9c8b-…"},"stage":null,"outcome":"succeeded",
//         "proposalId":null,"sourceRefs":[{"type":"payment","id":"pay_P9AAA1"}],
//         "payload":{},"occurredAt":"2026-02-14T00:00:00.000Z"},"aborted":false}],
//         "tamperAt":null,"tamperKind":"event_type","gapAt":null,"gapKind":"withheld"}]
//       Shrunk 13 time(s)
//       Caused by: AssertionError: sequence 1: part 9 of 12:
//         "[{\"type\":\"payment\",\"id\":\"pay_P9AAA1\"}]" vs
//         "[{\"id\":\"pay_P9AAA1\",\"type\":\"payment\"}]":
//         expected '505127dd…' to be '99dca307…' // Object.is equality
//
//     Shrinking empties the payload entirely and lands on the `{type, id}` Source_Record
//     reference instead — the smallest 2-key object in the input space, and the smallest input
//     on which key order can differ at all. `firstDifferingPart` names part 9 of 12, so the
//     counterexample says WHERE the divergence is rather than only that two digests differ.
//   - `verifyChain` reporting a gap at `row.sequence_number` instead of at `expectedSeq`:
//
//       Error: Property failed after 2 tests
//       { seed: 20260521, path: "1:220:2", endOnFailure: true }
//       Counterexample: [{"appends":[ … {"aborted":true}, {"aborted":false}],
//         "tamperAt":null,"gapAt":0,"gapKind":"unallocated"}]
//       Shrunk 2 time(s)
//       Caused by: AssertionError: expected { intact: false, …(2) } to deeply equal
//         { intact: false, …(2) }
//         -   "first_absent_sequence_number": 1n,
//         +   "first_absent_sequence_number": 2n,
//             "first_mismatched_sequence_number": null,
//
//     The one committed Audit_Event carries sequence number 2 because number 1 was never
//     allocated, so the gap is 1 and the mutation answers 2 — the number that revealed the gap
//     rather than the one that should have been there. That is the distinction chain.ts's doc
//     comment draws and the one an off-by-one hides in.
//   - B1's aborted appends `RELEASE`d instead of `ROLLBACK TO SAVEPOINT`, i.e. the interleaved
//     aborts silently becoming commits, which is the mutation that would make the gaplessness
//     claim vacuous:
//
//       Error: Property failed after 1 tests
//       { seed: 20260521, path: "0:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:0:0", endOnFailure: true }
//       Shrunk 18 time(s)
//       Caused by: AssertionError: expected [ 1n, 2n ] to deeply equal [ 1n ]
//
//     One append committed and one aborted, and the stored rows carry sequence numbers 1 and 2:
//     the aborted append consumed a number. Both figures came out of `AUDIT_CHAIN_WALK_SQL`,
//     which is the evidence that the read path is live rather than modelled.
//
// AND B2 FAILS FOR THE STATED REASON, NOT FOR SOME OTHER ONE
// ---------------------------------------------------------
// `it.fails` passes on ANY throw, so the marker was checked by removing it once and reading the
// failure. It is the divergence and nothing else:
//
//       Error: Property failed after 1 tests
//       { seed: 20260521, path: "0", endOnFailure: true }
//       Counterexample: [{"appends":[{…,"aborted":true},
//         {"draft":{"eventType":"agent_stage_completed", …,
//          "payload":{"amount_paise":15697}, …},"aborted":false}], …}]
//       Caused by: AssertionError: sequence 1: expected 'b5baa4c3…' to be 'd4e0dca6…'
//
// The committed Audit_Event carries sequence number 1 even though an aborted append preceded
// it, which is B1's claim showing up inside B2, and the mismatch is on the payload
// `{"amount_paise":15697}` — stored as `{"amount_paise": 15697}` by `jsonb::text`, one 0x20
// after the colon. `.fails` comes off when that byte stops being there.

import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  ACTION_PIPELINE_STAGES,
  type ActionPipelineStage,
  AUDIT_EVENT_APPEND_SQL,
  AUDIT_OUTCOMES,
  AUDIT_PAYLOAD_MAX_BYTES,
  type AuditEventDraft,
  auditEventAppendParams,
  type AuditOutcome,
  payloadExceedsAuditLimit,
  projectAuditSourceRefs,
} from '@/audit/audit-service';
import {
  AUDIT_CHAIN_WALK_SQL,
  type ChainedAuditEvent,
  type ChainedAuditEventFields,
  chainValue,
  chainValueParts,
  type ChainVerification,
  createChainVerifier,
  INITIAL_CHAIN_VALUE,
  verifyChain,
} from '@/audit/chain';
import type { Actor } from '@/config/configuration-service';
import { SOURCE_RECORD_TYPES, type SourceRef } from '@/ledger/posting-rules';

import {
  announceIfUnreachable,
  claims,
  database,
  jsonAt,
  jsonRows,
  lit,
  newFixture,
  provision,
  runOk,
  runScript,
} from '../db/pg';

announceIfUnreachable();

const reachable = database().reachable;
const f = newFixture();

/** Explicit and committed, so any counterexample is reproducible from this file alone. */
const SEED = 20260521;

/** Coverage-driven, above design.md's floor of 100. See the header. */
const HALF_A_NUM_RUNS = 400;

/** design.md's stated minimum. One `psql` session per iteration. */
const HALF_B_NUM_RUNS = 100;

const HALF_A_PARAMS = { numRuns: HALF_A_NUM_RUNS, seed: SEED } as const;
const HALF_B_PARAMS = { numRuns: HALF_B_NUM_RUNS, seed: SEED } as const;

/* -------------------------------------------------------------------------- */
/* Fixed identifiers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The one Proposal generated Audit_Events may cite.
 *
 * A drawn UUID is not usable: task 21.1 added
 * `audit_events_proposal_id_fkey REFERENCES proposals(id)`, so an identifier for a row that
 * does not exist is rejected with SQLSTATE `23503`. Half B seeds exactly this Proposal (and
 * the Evidence_Chain its own foreign key needs), so part 8 of the hashed join is exercised
 * with a real value in both halves rather than being pinned to `null` in one of them.
 * Varying the UUID itself would add nothing: `src/audit/chain.test.ts` already pins that the
 * Chain_Value depends on every one of the 12 parts.
 */
const P9_PROPOSAL_ID = '9ce1b0a4-3f6d-4f0a-8f3b-1d2c4e5a6b70';

/** A second Proposal identifier, used only as a tampered value. Never inserted. */
const TAMPERED_PROPOSAL_ID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

/** The Evidence_Chain {@link P9_PROPOSAL_ID} points at. Half B only. */
const P9_EVIDENCE_CHAIN_ID = 'c0ffee00-1111-4222-8333-444455556666';

const TAMPER_REF: SourceRef = { type: 'payment', id: 'pay_P9TAMPER' };

/** A payload key the generator never draws, so adding it always changes the payload. */
const TAMPER_KEY = '__p9_tampered__';

/* -------------------------------------------------------------------------- */
/* Generators — design.md's `arbitraryAuditEventSequence`                     */
/* -------------------------------------------------------------------------- */

/** Snake case by the convention the services share; none contains a `|`. */
const EVENT_TYPES = [
  'agent_stage_completed',
  'proposal_authorized',
  'ledger_set_posted',
  'mutation_rejected',
  'credential_stored',
  'exception_opened',
  'ingestion_run_completed',
] as const;

const AGENT_NAMES = [
  'reconciliation_agent',
  'marketplace_agent',
  'compliance_agent',
  'cash_agent',
] as const;

/**
 * Exactly one of a User identifier, an Agent name, or the Policy_Engine identifier
 * (Requirement 13.1).
 *
 * The User identifiers are drawn from a fixed pool rather than generated: `actor_id` is
 * `TEXT` with no foreign key, so any string stores, and a pool keeps the counterexamples
 * legible.
 */
const arbitraryActor: fc.Arbitrary<Actor> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<Actor>({ kind: 'policy_engine', id: 'policy_engine' }) },
  {
    weight: 3,
    arbitrary: fc.constantFrom(...AGENT_NAMES).map((id): Actor => ({ kind: 'agent', id })),
  },
  {
    weight: 3,
    arbitrary: fc
      .constantFrom(
        '1f0d9c8b-7a65-4432-8110-aabbccddeeff',
        '2e1c8b7a-6954-4321-9001-bbccddeeff00',
        'ops_operator',
      )
      .map((id): Actor => ({ kind: 'user', id })),
  },
);

/**
 * Payload strings: printable, and never a control character.
 *
 * `U+0000` has no representation in `jsonb` at all (SQLSTATE `22P05`) and task 25.1 rejects it
 * at the boundary, so it is out of the input space by construction rather than by filtering. A
 * literal newline is excluded for a second, mechanical reason: `psql -tA` writes one line per
 * tuple, and a real newline inside a returned `payload` would split that line and shift the
 * output indices half B reads. (Half B also indexes its JSON reads from the END of the output
 * for that reason, so the two guards are independent.)
 *
 * `|` IS drawn, deliberately. The 12 hashed parts are joined with a bare `'|'` and task 25.1
 * rejects the separator only in `event_type`, `actor_id` and Source_Record identifiers — the
 * payload is unconstrained, which is the reported non-injectivity of the join. P9 asserts
 * nothing about injectivity, but it must not quietly avoid the shape.
 */
const arbitraryPayloadString: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: fc.string({ unit: 'grapheme-ascii', maxLength: 24 }) },
  {
    weight: 2,
    arbitrary: fc.constantFrom('₹1,00,000', 'सेटलमेंट', '日本語', 'Ω≈ç√', 'receipt 🧾'),
  },
  { weight: 1, arbitrary: fc.constantFrom('a|b', '|', 'pipe|in|payload') },
  { weight: 1, arbitrary: fc.constant('') },
);

/**
 * Payload leaves.
 *
 * No `bigint`: `canonicalJson` throws on one on purpose, because a monetary value crosses a
 * JSON boundary as digit text (Requirement 15.1, 15.8). Money therefore appears here as the
 * digit strings `arbitraryPayloadString` can produce and as the `amount_paise` key below, never
 * as a JSON number. No `NaN` and no `Infinity` either, for the same reason: `canonicalJson`
 * names them rather than writing `null`, and both are caller faults rather than stored states.
 */
const arbitraryPayloadLeaf: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 5, arbitrary: arbitraryPayloadString },
  { weight: 3, arbitrary: fc.integer({ min: -100_000, max: 100_000 }) },
  { weight: 2, arbitrary: fc.constantFrom('0', '1', '99999999999999') },
  { weight: 1, arbitrary: fc.boolean() },
  { weight: 1, arbitrary: fc.constant(null) },
  // Fractional numbers as hundredths rather than through `fc.double`, and the reason is half
  // B's Requirement 13.10 assertion rather than taste: a stored `payload` is compared field by
  // field against the supplied one, and `-0`, a denormal and a 17-significant-digit double do
  // not survive JSON -> jsonb `numeric` -> JSON unchanged (`-0` renders as `0`, and `numeric`
  // has its own text form). A hundredth always round-trips exactly, and it still exercises
  // FINDING 6(c) — Postgres preserves the scale it parsed where `canonicalJson` collapses it.
  { weight: 1, arbitrary: fc.integer({ min: -100_000, max: 100_000 }).map((n) => n / 100) },
);

/** Keys the payload generator draws from. {@link TAMPER_KEY} is deliberately absent. */
const PAYLOAD_KEYS = [
  'note',
  'count',
  'flag',
  'amount_paise',
  'nested',
  'items',
  'ratio',
] as const;

function arbitraryPayloadValue(depth: number): fc.Arbitrary<unknown> {
  if (depth <= 0) {
    return arbitraryPayloadLeaf;
  }
  return fc.oneof(
    { weight: 6, arbitrary: arbitraryPayloadLeaf },
    { weight: 1, arbitrary: fc.array(arbitraryPayloadValue(depth - 1), { maxLength: 3 }) },
    { weight: 1, arbitrary: arbitraryPayloadObject(depth - 1) },
  );
}

function arbitraryPayloadObject(depth: number): fc.Arbitrary<Record<string, unknown>> {
  return fc.dictionary(fc.constantFrom(...PAYLOAD_KEYS), arbitraryPayloadValue(depth), {
    maxKeys: PAYLOAD_KEYS.length,
  });
}

/**
 * A payload over Requirement 13.3's 65536 bytes, built from single-byte characters only.
 *
 * The single-byte restriction is FINDING 6(e) of migration 4.4, not a convenience: the SQL
 * reduction takes `left(v_payload::text, 60000)`, which counts CHARACTERS, while
 * `payload_bytes` and the threshold count BYTES — so a multi-byte oversized payload reduces to
 * as much as 240000 bytes and the append then dies on
 * `audit_events_payload_bytes_check` instead of reducing. That defect is task 4.4's to fix, and
 * generating it here would test the defect rather than Requirement 13.3. Measured with this
 * shape against local Postgres: a 70000-character blob stores `payload_bytes = 60035` with
 * `payload_reduced = true`.
 */
const arbitraryOversizedPayload: fc.Arbitrary<Record<string, unknown>> = fc
  .integer({ min: 1, max: 4000 })
  .map((extra) => ({ blob: 'x'.repeat(AUDIT_PAYLOAD_MAX_BYTES + extra) }));

const arbitraryPayload: fc.Arbitrary<Record<string, unknown>> = fc.oneof(
  { weight: 11, arbitrary: arbitraryPayloadObject(2) },
  { weight: 1, arbitrary: arbitraryOversizedPayload },
);

/**
 * 0..4 Source_Record references over all 13 type labels, from a small identifier pool so
 * duplicates are common.
 *
 * Duplicates and order are both kept by `projectAuditSourceRefs`, because
 * `source_record_refs` is a JSONB array whose text is hashed — collapsing entries would change
 * what the Chain_Value was computed over. Drawing from a small pool is what makes the
 * duplicate case dense rather than theoretical.
 */
const arbitrarySourceRefs: fc.Arbitrary<readonly SourceRef[]> = fc.array(
  fc
    .tuple(
      fc.constantFrom(...SOURCE_RECORD_TYPES),
      fc.constantFrom('pay_P9AAA1', 'setl_P9BBB2', 'rfnd_P9CCC3', 'order_P9DDD4'),
    )
    .map(([type, id]): SourceRef => ({ type, id })),
  { maxLength: 4 },
);

/**
 * A stage with its outcome, an outcome alone, or neither.
 *
 * A stage without an outcome is refused by `auditAppendPlan` (Requirement 5.2), so it is not
 * in the input space. An outcome WITHOUT a stage is legal and is drawn, because it is the only
 * way to reach part 7 of the hashed join while part 6 is the empty string.
 */
const arbitraryStageAndOutcome: fc.Arbitrary<{
  readonly stage: ActionPipelineStage | null;
  readonly outcome: AuditOutcome | null;
}> = fc.oneof(
  { weight: 2, arbitrary: fc.constant({ stage: null, outcome: null }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(...AUDIT_OUTCOMES).map((outcome) => ({ stage: null, outcome })),
  },
  {
    weight: 5,
    arbitrary: fc
      .tuple(fc.constantFrom(...ACTION_PIPELINE_STAGES), fc.constantFrom(...AUDIT_OUTCOMES))
      .map(([stage, outcome]) => ({ stage, outcome })),
  },
);

/** UTC ISO-8601 to millisecond precision, over a 30-day window (Requirement 13.1). */
const arbitraryOccurredAt: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 30 * 86_400_000 - 1 })
  .map((ms) => new Date(Date.UTC(2026, 1, 14) + ms).toISOString());

const arbitraryAuditEventDraft: fc.Arbitrary<AuditEventDraft> = fc
  .record({
    eventType: fc.constantFrom(...EVENT_TYPES),
    actor: arbitraryActor,
    stageAndOutcome: arbitraryStageAndOutcome,
    proposalId: fc.option(fc.constant(P9_PROPOSAL_ID), { nil: null, freq: 3 }),
    sourceRefs: arbitrarySourceRefs,
    payload: arbitraryPayload,
    occurredAt: arbitraryOccurredAt,
  })
  .map(
    ({ eventType, actor, stageAndOutcome, proposalId, sourceRefs, payload, occurredAt }): AuditEventDraft => ({
      eventType,
      actor,
      stage: stageAndOutcome.stage,
      outcome: stageAndOutcome.outcome,
      proposalId,
      sourceRefs,
      payload,
      occurredAt,
    }),
  );

/** One of the 12 hashed fields, or the stored Chain_Value itself. */
const TAMPER_KINDS = [
  'event_type',
  'actor_id',
  'stage',
  'outcome',
  'proposal_id',
  'source_record_refs',
  'payload',
  'occurred_at',
  'chain_value',
] as const;

type TamperKind = (typeof TAMPER_KINDS)[number];

/** See the header: two genuinely different failure modes, reported differently. */
const GAP_KINDS = ['withheld', 'unallocated'] as const;

type GapKind = (typeof GAP_KINDS)[number];

interface PlannedAppend {
  readonly draft: AuditEventDraft;
  /** `true` → the append is rolled back and must consume no sequence number. */
  readonly aborted: boolean;
}

interface AuditEventSequence {
  /** In submission order, aborted appends interleaved. */
  readonly appends: readonly PlannedAppend[];
  /** Index into the COMMITTED events, or `null` for no tamper. */
  readonly tamperAt: number | null;
  readonly tamperKind: TamperKind;
  /** Index into the COMMITTED events, or `null` for no gap. */
  readonly gapAt: number | null;
  readonly gapKind: GapKind;
}

/** At most 6, so one iteration of half B stays one `psql` session of a manageable size. */
const MAX_APPENDS = 6;

const arbitraryAuditEventSequence: fc.Arbitrary<AuditEventSequence> = fc
  .array(
    fc.record({
      draft: arbitraryAuditEventDraft,
      aborted: fc.oneof(
        { weight: 2, arbitrary: fc.constant(false) },
        { weight: 1, arbitrary: fc.constant(true) },
      ),
    }),
    { minLength: 1, maxLength: MAX_APPENDS },
  )
  // At least one append must commit. A Tenant with zero Audit_Events is a real case and
  // `verifyChain` answers it correctly (`src/audit/chain.test.ts` pins that), but here it would
  // make every injection index vacuous, so the first append is forced to commit rather than the
  // whole draw being filtered away.
  .map((appends) =>
    appends.some((a) => !a.aborted)
      ? appends
      : appends.map((a, index) => (index === 0 ? { ...a, aborted: false } : a)),
  )
  .chain((appends) => {
    const committed = appends.filter((a) => !a.aborted).length;
    const index = fc.nat({ max: committed - 1 });
    return fc.record({
      appends: fc.constant(appends),
      tamperAt: fc.option(index, { nil: null, freq: 2 }),
      tamperKind: fc.constantFrom(...TAMPER_KINDS),
      gapAt: fc.option(index, { nil: null, freq: 2 }),
      gapKind: fc.constantFrom(...GAP_KINDS),
    });
  });

/* -------------------------------------------------------------------------- */
/* The model: stored fields, the chain over them, and the re-read             */
/* -------------------------------------------------------------------------- */

/**
 * The Requirement 13.3 reduction as an ANALOGUE, not a reproduction.
 *
 * SQL replaces an oversized payload with `{"reduced": true, "excerpt": left(jsonb::text,
 * 60000)}`, and `jsonb::text` is exactly the rendering `canonicalJson` cannot produce — so the
 * excerpt here is sliced from `JSON.stringify` text instead. Half A does not claim to match
 * the stored bytes (that is B2's blocked claim); what it needs from this is a reduced payload
 * SHAPE in the input space, so that the walk is exercised over `{reduced, excerpt}` objects
 * and not only over drafted ones. Half B reads the real reduction off the row.
 */
function reducedPayloadAnalogue(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!payloadExceedsAuditLimit(payload)) {
    return payload;
  }
  return { reduced: true, excerpt: JSON.stringify(payload).slice(0, 60_000) };
}

/** The stored fields of one committed draft, as the walk would read them back. */
function storedFieldsOf(
  draft: AuditEventDraft,
  tenantId: string,
  sequenceNumber: bigint,
): ChainedAuditEventFields {
  return {
    tenant_id: tenantId,
    sequence_number: sequenceNumber,
    event_type: draft.eventType,
    actor_kind: draft.actor.kind,
    actor_id: draft.actor.id,
    stage: draft.stage ?? null,
    outcome: draft.outcome ?? null,
    proposal_id: draft.proposalId ?? null,
    source_record_refs: projectAuditSourceRefs(draft.sourceRefs).map((ref) => ({ ...ref })),
    payload: reducedPayloadAnalogue(draft.payload),
    occurred_at: draft.occurredAt,
  };
}

/**
 * The sequence numbers the model allocates: `1..n`, with one number skipped when an
 * `unallocated` gap is injected at `skipAt`.
 */
function allocatedSequenceNumbers(n: number, skipAt: number | null): readonly bigint[] {
  const seqs: bigint[] = [];
  let next = 1n;
  for (let index = 0; index < n; index += 1) {
    if (index === skipAt) {
      next += 1n;
    }
    seqs.push(next);
    next += 1n;
  }
  return seqs;
}

/** The chain: each row's Chain_Value over its own stored fields and the predecessor's stored one. */
function chainOver(
  drafts: readonly AuditEventDraft[],
  seqs: readonly bigint[],
  tenantId: string,
): readonly ChainedAuditEvent[] {
  let prev = INITIAL_CHAIN_VALUE;
  const rows: ChainedAuditEvent[] = [];
  drafts.forEach((draft, index) => {
    const fields = storedFieldsOf(draft, tenantId, seqs[index] ?? 0n);
    const chain = chainValue(fields, prev);
    rows.push({ ...fields, chain_value: chain });
    prev = chain;
  });
  return rows;
}

/**
 * `value` with the key order of every object reversed at every depth, after a JSON round trip.
 *
 * This is what makes half A's recomputation a claim rather than a tautology — see the header.
 * Reversal is chosen over a shuffle because it needs no randomness and is guaranteed to differ
 * for every object with 2 or more keys.
 */
function reverseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).reverse()) {
      out[key] = reverseKeysDeep(source[key]);
    }
    return out;
  }
  return value;
}

/** One row as a driver with a different key order would hand it back. */
function asReRead(row: ChainedAuditEvent): ChainedAuditEvent {
  const json = JSON.stringify({
    source_record_refs: row.source_record_refs,
    payload: row.payload,
  });
  const parsed = JSON.parse(json) as {
    source_record_refs: unknown;
    payload: unknown;
  };
  return {
    ...row,
    source_record_refs: reverseKeysDeep(parsed.source_record_refs),
    payload: reverseKeysDeep(parsed.payload),
  };
}

/* -------------------------------------------------------------------------- */
/* The injected anomalies                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `row` with one field edited and its stored `chain_value` left alone — except for the
 * `chain_value` kind, which edits the stored value and leaves the fields alone.
 *
 * Every kind is constructed to CHANGE the value it replaces, whatever it was, so the injection
 * is never a silent no-op that would make the assertion vacuous for that draw. No `UPDATE` is
 * issued anywhere: this edits the row the walk is looking at, which is the state an out-of-band
 * edit leaves behind. See the header.
 */
function tamper(row: ChainedAuditEvent, kind: TamperKind): ChainedAuditEvent {
  switch (kind) {
    case 'event_type':
      return { ...row, event_type: `${row.event_type}_tampered` };
    case 'actor_id':
      return { ...row, actor_id: `${row.actor_id}_tampered` };
    case 'stage':
      return { ...row, stage: row.stage === 'VERIFY' ? 'DETECT' : 'VERIFY' };
    case 'outcome':
      return { ...row, outcome: row.outcome === 'blocked' ? 'failed' : 'blocked' };
    case 'proposal_id':
      // Stored is `null` or P9_PROPOSAL_ID, so this always moves.
      return { ...row, proposal_id: TAMPERED_PROPOSAL_ID };
    case 'source_record_refs':
      return {
        ...row,
        source_record_refs: [...(row.source_record_refs as readonly SourceRef[]), TAMPER_REF],
      };
    case 'payload':
      return {
        ...row,
        payload: { ...(row.payload as Record<string, unknown>), [TAMPER_KEY]: true },
      };
    case 'occurred_at':
      return {
        ...row,
        occurred_at: new Date(new Date(row.occurred_at).getTime() + 1).toISOString(),
      };
    case 'chain_value':
      return {
        ...row,
        chain_value: `${row.chain_value.startsWith('0') ? '1' : '0'}${row.chain_value.slice(1)}`,
      };
  }
}

/**
 * The verification result the injections imply, derived in sequence-number space.
 *
 * Never by re-running the walk's loop: `firstAbsent` is the lowest member of
 * `1..max(fed)` that is not fed, which is a set-theoretic restatement of "the lowest sequence
 * number that should exist and does not", and `firstMismatch` is the lowest of the sequence
 * numbers the injections make unverifiable.
 */
function expectedVerification(
  fedSeqs: readonly bigint[],
  mismatchCandidates: readonly bigint[],
): ChainVerification {
  const present = new Set(fedSeqs.map((seq) => seq.toString()));
  const highest = fedSeqs.length === 0 ? 0n : (fedSeqs[fedSeqs.length - 1] ?? 0n);
  let absent: bigint | null = null;
  for (let candidate = 1n; candidate <= highest; candidate += 1n) {
    if (!present.has(candidate.toString())) {
      absent = candidate;
      break;
    }
  }
  const mismatch =
    mismatchCandidates.length === 0
      ? null
      : mismatchCandidates.reduce((low, seq) => (seq < low ? seq : low));
  return {
    intact: absent === null && mismatch === null,
    first_mismatched_sequence_number: mismatch,
    first_absent_sequence_number: absent,
  };
}

/** Which of the 12 hashed parts diverged, for a counterexample that says where rather than that. */
function firstDifferingPart(a: readonly string[], b: readonly string[]): string {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) {
      return `part ${index + 1} of ${length}: ${JSON.stringify(a[index])} vs ${JSON.stringify(
        b[index],
      )}`;
    }
  }
  return 'no part differs';
}

/* -------------------------------------------------------------------------- */
/* Coverage counters                                                          */
/* -------------------------------------------------------------------------- */

const seen = new Map<string, number>();

function note(key: string): void {
  seen.set(key, (seen.get(key) ?? 0) + 1);
}

const countOf = (key: string): number => seen.get(key) ?? 0;

/* -------------------------------------------------------------------------- */
/* HALF A — in process, over the full input space                             */
/* -------------------------------------------------------------------------- */

describe('P9 half A: the chain and the walk over generated Audit_Event sequences', () => {
  it('recomputes every stored Chain_Value and reports both anomalies at the injected positions', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryAuditEventSequence, async (sequence) => {
        const committed = sequence.appends.filter((a) => !a.aborted).map((a) => a.draft);
        const unallocatedAt = sequence.gapKind === 'unallocated' ? sequence.gapAt : null;
        const withheldAt = sequence.gapKind === 'withheld' ? sequence.gapAt : null;
        const seqs = allocatedSequenceNumbers(committed.length, unallocatedAt);
        const stored = chainOver(committed, seqs, f.tenantId);

        note(`appends:${sequence.appends.length}`);
        note(`committed:${committed.length}`);
        if (sequence.appends.some((a) => a.aborted)) {
          note('aborted-interleaved');
        }
        note(`injection:${sequence.tamperAt === null ? 'no-tamper' : 'tamper'}/${
          sequence.gapAt === null ? 'no-gap' : sequence.gapKind
        }`);
        if (sequence.tamperAt !== null) {
          note(`tamper-kind:${sequence.tamperKind}`);
        }
        for (const draft of committed) {
          note(`actor-kind:${draft.actor.kind}`);
          if (payloadExceedsAuditLimit(draft.payload)) {
            note('payload-oversized');
          }
          if (Object.keys(draft.payload).length >= 2) {
            note('payload-multi-key');
          }
          if ((draft.sourceRefs ?? []).length >= 1) {
            note('source-refs-present');
          }
          if (draft.stage !== null) {
            note('stage-present');
          }
        }

        // ---- Requirement 13.4: the recomputation reproduces every stored Chain_Value, over
        // rows re-read with a different key order at every depth.
        let prev = INITIAL_CHAIN_VALUE;
        for (const row of stored) {
          const reRead = asReRead(row);
          expect(
            chainValue(reRead, prev),
            `sequence ${row.sequence_number}: ${firstDifferingPart(
              chainValueParts(row, prev),
              chainValueParts(reRead, prev),
            )}`,
          ).toBe(row.chain_value);
          prev = row.chain_value;
        }

        // ---- Requirement 13.1: the allocated numbers are 1..n, with no gap and no duplicate,
        // unless a gap was deliberately injected into the allocation. The real allocator's
        // version of this claim is half B's.
        if (unallocatedAt === null) {
          expect(seqs).toEqual(
            Array.from({ length: committed.length }, (_, index) => BigInt(index + 1)),
          );
        }
        expect(new Set(seqs.map(String)).size).toBe(seqs.length);

        // ---- Requirement 13.10: re-reading returns identical field values. In process that is
        // the key-reordered round trip: the 12 hashed parts must be byte-identical.
        for (const row of stored) {
          expect(chainValueParts(asReRead(row), INITIAL_CHAIN_VALUE)).toEqual(
            chainValueParts(row, INITIAL_CHAIN_VALUE),
          );
        }

        // ---- The walk's input, with the injections applied.
        const withheldSeq = withheldAt === null ? null : (seqs[withheldAt] ?? null);
        const fed = stored
          .filter((_, index) => index !== withheldAt)
          .map((row) =>
            sequence.tamperAt !== null && sequence.tamperAt === indexOfSeq(seqs, row.sequence_number)
              ? tamper(row, sequence.tamperKind)
              : row,
          );

        const candidates: bigint[] = [];
        // A tamper on the WITHHELD row is invisible: that row is not in the walk's input at all.
        if (sequence.tamperAt !== null && sequence.tamperAt !== withheldAt) {
          candidates.push(seqs[sequence.tamperAt] ?? 0n);
          if (sequence.tamperKind === 'chain_value') {
            // Rewriting a stored Chain_Value breaks the link its successor was chained to, so
            // the evidence is two rows wide. The lowest is still the edited row.
            const successor = seqs[sequence.tamperAt + 1];
            if (successor !== undefined && successor !== withheldSeq) {
              candidates.push(successor);
            }
          }
        }
        // A withheld row removes the link its successor was chained to.
        if (withheldSeq !== null) {
          const successor = fed.find((row) => row.sequence_number > withheldSeq);
          if (successor !== undefined) {
            candidates.push(successor.sequence_number);
          }
        }

        const expected = expectedVerification(
          fed.map((row) => row.sequence_number),
          candidates,
        );

        // The verifier seam, so the property drives design.md's `verifyChain()` rather than the
        // bare function.
        const verifier = createChainVerifier({ eventsAscendingBySequence: () => fed });
        expect(await verifier.verifyChain()).toEqual(expected);
        // And the bare walk over an async row source, which is what a streaming adapter feeds.
        expect(await verifyChain(asyncRows(fed))).toEqual(expected);
      }),
      HALF_A_PARAMS,
    );
  });

  it('reached every tamper kind, both gap kinds, all four injection combinations and the shapes design.md names', () => {
    // A property whose interesting branches stopped occurring passes just as greenly as one
    // that exercises them, so the shapes are counted rather than assumed.
    for (const kind of TAMPER_KINDS) {
      expect(countOf(`tamper-kind:${kind}`), `tamper kind ${kind}`).toBeGreaterThan(0);
    }
    for (const combination of [
      'no-tamper/no-gap',
      'no-tamper/withheld',
      'no-tamper/unallocated',
      'tamper/no-gap',
      'tamper/withheld',
      'tamper/unallocated',
    ]) {
      expect(countOf(`injection:${combination}`), combination).toBeGreaterThan(0);
    }
    for (const kind of ['user', 'agent', 'policy_engine']) {
      expect(countOf(`actor-kind:${kind}`), `actor kind ${kind}`).toBeGreaterThan(0);
    }
    // design.md's generator note, item by item.
    expect(countOf('payload-oversized'), 'payloads over 65536 bytes').toBeGreaterThan(0);
    expect(countOf('payload-multi-key'), 'payloads where key order can differ').toBeGreaterThan(0);
    expect(countOf('source-refs-present'), 'non-empty source ref arrays').toBeGreaterThan(0);
    expect(countOf('stage-present'), 'stage events').toBeGreaterThan(0);
    expect(countOf('aborted-interleaved'), 'interleaved aborted appends').toBeGreaterThan(0);
    // Sequences longer than one event, so the chain is a chain.
    expect(countOf('committed:1') + countOf('committed:2')).toBeLessThan(HALF_A_NUM_RUNS);
  });
});

/** The index of `seq` in `seqs`, or `-1`. Kept explicit because an `unallocated` gap breaks `index + 1 === seq`. */
function indexOfSeq(seqs: readonly bigint[], seq: bigint): number {
  return seqs.findIndex((candidate) => candidate === seq);
}

async function* asyncRows(rows: readonly ChainedAuditEvent[]): AsyncGenerator<ChainedAuditEvent> {
  for (const row of rows) {
    yield await Promise.resolve(row);
  }
}

/* -------------------------------------------------------------------------- */
/* HALF B — against the real app.append_audit_event on Supabase local         */
/* -------------------------------------------------------------------------- */

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

const prepared = (name: string, sql: string): string => `prepare ${name} as\n${sql};`;

const execute = (name: string, params: readonly (string | null)[]): string =>
  `execute ${name}(${params.map((p) => (p === null ? 'null' : lit(p))).join(', ')});`;

/**
 * The Tenant, the User, the counter row, and the one Evidence_Chain and Proposal a generated
 * `proposal_id` can cite. Committed, once.
 *
 * Committed because the appends below sit in transactions that are thrown away, and a separate
 * `psql` session — or the same session after a `ROLLBACK` — cannot see rows that were never
 * committed. Nothing here is append-only, and every row is scoped to this run's fresh Tenant
 * (`newFixture()` draws a new UUID), so it perturbs no other suite's figures.
 *
 * The Evidence_Chain and the Proposal are deleted first. Their identifiers are FIXED constants
 * — the generator draws {@link P9_PROPOSAL_ID}, and a per-run UUID would make a counterexample
 * unreproducible from this file — so the rows a previous run committed collide on the primary
 * key. Deleting them is legal because neither table is append-only and because no Audit_Event
 * is ever committed here, so nothing references them; if that ever stopped being true the
 * foreign key would refuse the delete and `runOk` would say so rather than absorbing it.
 */
function seedScript(): string {
  return `begin;
delete from proposals where id = ${lit(P9_PROPOSAL_ID)};
delete from evidence_chains where id = ${lit(P9_EVIDENCE_CHAIN_ID)};
${provision(f)}
insert into evidence_chains (id, tenant_id, figure_paise, source_count, as_of, produced_by)
values (${lit(P9_EVIDENCE_CHAIN_ID)}, ${lit(f.tenantId)}, 1, 1,
        '2026-02-14T09:30:00Z'::timestamptz, 'p9_property');
insert into proposals (id, tenant_id, agent_name, action_type, target_source_records,
                       target_fingerprint, impact_paise, evidence_chain_id, expected_outcome)
values (${lit(P9_PROPOSAL_ID)}, ${lit(f.tenantId)}, 'reconciliation_agent', 'p9_property',
        '[]'::jsonb, 'p9-target-fingerprint', 1, ${lit(P9_EVIDENCE_CHAIN_ID)}, '{}'::jsonb);
commit;`;
}

/**
 * One iteration: every planned append through the real `AUDIT_EVENT_APPEND_SQL`, the aborted
 * ones rolled back to their savepoint, then the walk twice and the counter, then the whole
 * transaction discarded.
 *
 * `SAVEPOINT` / `ROLLBACK TO SAVEPOINT` is the abort mechanism, and `ROLLBACK` at the end is
 * design.md's per-iteration reset — see the header for both. The two walks back to back are
 * Requirement 13.10: re-reading must return identical field values.
 */
function appendSequenceScript(sequence: AuditEventSequence): string {
  const statements = sequence.appends.map(({ draft, aborted }, index) => {
    const savepoint = `p9_${index}`;
    return [
      `savepoint ${savepoint};`,
      execute('audit_append', auditEventAppendParams(draft)),
      aborted ? `rollback to savepoint ${savepoint};` : `release savepoint ${savepoint};`,
    ].join('\n');
  });
  return `begin;
${claims(f)}
${prepared('audit_append', AUDIT_EVENT_APPEND_SQL)}
${statements.join('\n')}
${jsonRows(AUDIT_CHAIN_WALK_SQL)}
${jsonRows(AUDIT_CHAIN_WALK_SQL)}
${jsonRows(
  `select last_sequence::text as last_sequence
     from audit_sequence_counters where tenant_id = ${lit(f.tenantId)}`,
)}
rollback;`;
}

interface StoredSequence {
  readonly first: readonly WalkRow[];
  readonly second: readonly WalkRow[];
  readonly lastSequence: bigint;
}

/**
 * Run one iteration and return what came back.
 *
 * The three JSON lines are indexed from the END of the output rather than from the start.
 * Each append emits its returned row as a tuple line, and a `payload` carrying a real newline
 * would split that line and shift every index after it — the generators exclude control
 * characters, and indexing from the end means the reads do not depend on that holding.
 */
function runSequence(sequence: AuditEventSequence): StoredSequence {
  const r = runScript(appendSequenceScript(sequence));
  if (r.errors.length > 0) {
    throw new Error(`the generated Audit_Event sequence did not append:\n${r.rawErr}`);
  }
  const lines = r.out.length;
  const counter = jsonAt<readonly { readonly last_sequence: string }[]>(r, lines - 1);
  return {
    first: jsonAt<readonly WalkRow[]>(r, lines - 3),
    second: jsonAt<readonly WalkRow[]>(r, lines - 2),
    lastSequence: BigInt(counter[0]?.last_sequence ?? '-1'),
  };
}

beforeAll(() => {
  if (reachable) {
    runOk(seedScript());
  }
});

describe.skipIf(!reachable)(
  'P9 half B: the real allocator, the stored fields, and re-reading (Requirement 13.1, 13.3, 13.10)',
  () => {
    it('allocates 1..n over committed appends, and an aborted append consumes no sequence number', async () => {
      await fc.assert(
        fc.asyncProperty(arbitraryAuditEventSequence, async (sequence) => {
          const committed = sequence.appends.filter((a) => !a.aborted).map((a) => a.draft);
          const { first, second, lastSequence } = runSequence(sequence);

          note('half-b-iteration');
          if (sequence.appends.some((a) => a.aborted)) {
            note('half-b-aborted-interleaved');
          }

          // ---- Requirement 13.1: the Tenant-scoped sequence numbers are 1..n with no gap and
          // no duplicate, where n counts the appends that COMMITTED. This is the claim the
          // counter row under `FOR UPDATE` exists to make, and the aborted appends are what
          // make it a claim rather than a restatement of "n rows were inserted".
          expect(first.map((row) => BigInt(row.sequence_number))).toEqual(
            Array.from({ length: committed.length }, (_, index) => BigInt(index + 1)),
          );
          expect(lastSequence).toBe(BigInt(committed.length));

          // ---- Requirement 13.10: re-reading returns identical field values.
          expect(second).toEqual(first);

          // ---- Requirement 13.1 / 13.3 on the stored fields, draft by draft.
          committed.forEach((draft, index) => {
            const row = first[index];
            expect(row, `no stored row for committed append ${index}`).toBeDefined();
            if (row === undefined) {
              return;
            }
            expect(row.tenant_id).toBe(f.tenantId);
            expect(row.event_type).toBe(draft.eventType);
            expect(row.actor_kind).toBe(draft.actor.kind);
            expect(row.actor_id).toBe(draft.actor.id);
            expect(row.stage).toBe(draft.stage ?? null);
            expect(row.outcome).toBe(draft.outcome ?? null);
            expect(row.proposal_id).toBe(draft.proposalId ?? null);
            // The timestamp comes back through the same `to_char` expression the Chain_Value was
            // hashed over, so this is the stored UTC millisecond text (Requirement 13.1).
            expect(row.occurred_at).toBe(draft.occurredAt);
            // Requirement 13.3: the Source_Record identifiers are stored unreduced, in the order
            // supplied, duplicates kept — whether or not the payload was reduced.
            expect(row.source_record_refs).toEqual(
              projectAuditSourceRefs(draft.sourceRefs).map((ref) => ({ ...ref })),
            );
            if (payloadExceedsAuditLimit(draft.payload)) {
              // Requirement 13.3: reduced, with the indicator, and inside the 65536-byte limit.
              note('half-b-payload-oversized');
              expect((row.payload as { readonly reduced?: unknown }).reduced).toBe(true);
            } else {
              // Requirement 13.10 against the supplied payload rather than against a re-read of
              // the stored one.
              expect(row.payload).toEqual(draft.payload);
            }
          });
        }),
        HALF_B_PARAMS,
      );
    });

    it('reached the database, the aborted interleaving and the oversized payload', () => {
      expect(countOf('half-b-iteration')).toBe(HALF_B_NUM_RUNS);
      expect(countOf('half-b-aborted-interleaved')).toBeGreaterThan(0);
      expect(countOf('half-b-payload-oversized')).toBeGreaterThan(0);
    });

    it('committed nothing: the Tenant still holds no Audit_Event and the counter is still 0', () => {
      // What proves the per-iteration rollbacks rolled back. `audit_events` revokes DELETE, so a
      // committed row here would be permanent and every later iteration's 1..n claim would be
      // false — this is the tripwire for that.
      const r = runOk(
        `${claims(f)}
${jsonRows(
  `select count(*)::int as events from audit_events where tenant_id = ${lit(f.tenantId)}`,
)}
${jsonRows(
  `select last_sequence::text as last_sequence
     from audit_sequence_counters where tenant_id = ${lit(f.tenantId)}`,
)}`,
      );
      expect(jsonAt<readonly { readonly events: number }[]>(r, 0)).toEqual([{ events: 0 }]);
      expect(jsonAt<readonly { readonly last_sequence: string }[]>(r, 1)).toEqual([
        { last_sequence: '0' },
      ]);
    });
  },
);

describe.skipIf(!reachable)(
  'P9 half B: recomputation against the stored Chain_Value (Requirement 13.4, 13.8)',
  () => {
    /**
     * The other half of P9: `chainValue` over the stored fields reproduces the stored
     * `chain_value`, so the Audit_Log is independently verifiable rather than merely
     * self-consistent.
     *
     * UNBLOCKED, and by which repair. This was `it.fails` for as long as
     * `app.append_audit_event` hashed `jsonb::text`, which `canonicalJson` cannot reproduce —
     * FINDING 6(a)(b)(c) of migration 4.4, localised to part 10 of the 12 hashed parts. The
     * header named two candidate remedies and migration
     * `20260101000010_audit_chain_canonical_json.sql` landed the second: it defines
     * `app.canonical_jsonb` (object keys sorted under C collation, array order preserved,
     * compact separators), hashes that rendering in `app.append_audit_event`, and re-chains
     * every existing per-Tenant log in sequence order so verification stays valid across the
     * migration boundary.
     *
     * So the marker came off exactly as the header prescribed, and the generator was never
     * restricted to the `{}` / `[]` region where the two renderings happened to agree — a
     * property that passed only there would have asserted that the Audit_Log is verifiable
     * when it was not. It now draws from the same generator half B1 draws from, at design.md's
     * stated 100 iterations rather than the 20 that were enough to reach a counterexample.
     */
    it(
      'reproduces every stored Chain_Value and reports the Audit_Log intact',
      async () => {
        await fc.assert(
          fc.asyncProperty(arbitraryAuditEventSequence, async (sequence) => {
            const rows = runSequence(sequence).first.map(toChained);

            let prev = INITIAL_CHAIN_VALUE;
            for (const row of rows) {
              expect(chainValue(row, prev), `sequence ${row.sequence_number}`).toBe(
                row.chain_value,
              );
              prev = row.chain_value;
            }
            expect(await verifyChain(rows)).toEqual({
              intact: true,
              first_mismatched_sequence_number: null,
              first_absent_sequence_number: null,
            });
          }),
          HALF_B_PARAMS,
        );
      },
    );
  },
);
