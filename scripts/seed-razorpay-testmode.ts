/**
 * Razorpay test-mode seeding for the demo path (task 7.1).
 *
 * Produces `test/fixtures/razorpay-seed.json`, the fixture task 16.1's end-to-end demo
 * path and task 7.2's worked-example module consume. Requirements 1.1, 4.4, 4.5.
 *
 * ## The constraint that shapes this script: Razorpay will not let you create a Settlement
 *
 * Razorpay's Settlement APIs are **read-only**. There is fetch-all, fetch-by-id and the
 * combined recon report, and there is no create endpoint: Settlements are produced by
 * Razorpay's own settlement cycle, and a test-mode account may hold none at all. The one
 * Settlement-shaped object an API client can create is an **Instant Settlement**
 * (`POST /v1/settlements/ondemand`), which is a different entity (`setlod_…`, its own
 * status vocabulary), needs the Instant Settlements feature enabled and a real available
 * balance, and still gives you no control over the recon report — which has no create
 * endpoint either.
 *
 * So this task's headline deliverable — "one Settlement whose residual is exactly zero and
 * one whose residual is non-zero" — **cannot be produced through the Razorpay API**, and
 * this script does not pretend otherwise. It is split in two, and the split is visible in
 * the fixture:
 *
 * - **Part A, genuinely live.** Orders are created with `POST /v1/orders`. Refunds are
 *   created with `POST /v1/payments/{id}/refund` against a captured Payment. Payments,
 *   Settlements and recon reports are **discovered** by listing them through the real
 *   ingestion transport. Every identifier in `part_a_live` came back from Razorpay.
 * - **Part B, synthetic.** The two Settlements, their recon report lines, and the
 *   Payments, Refunds and Orders they enumerate are built locally, deterministically, in
 *   the Razorpay payload shapes. Every record carries `_financeos_synthetic: true` and a
 *   `_financeos_synthetic_note`, the containing block is `part_b_synthetic`, and its
 *   `warning` field says so in words. Nothing downstream can mistake one for retrieved
 *   data without ignoring three separate markers.
 *
 * ### What Razorpay test mode does and does not allow, item by item
 *
 * | Object | Creatable via API | How this script gets it |
 * |---|---|---|
 * | Order | **yes**, `POST /v1/orders` | Part A, live |
 * | Payment | **no** — a Payment is produced by Checkout, or by an S2S endpoint that needs per-account activation | Part A discovers existing captured Payments; Part B synthesises them |
 * | Refund | **yes**, but only against an existing captured Payment | Part A, live, when a captured Payment was discovered |
 * | Settlement | **no** — read-only API; Instant Settlement is a different entity | Part B only |
 * | Settlement_Recon_Report | **no** — read-only, addressed by year and month | Part B only |
 *
 * **Task 6.5 owns confirming the Part B shapes against test mode.** The recon report line
 * fields in particular (`entity_id`, `type`, `debit`/`credit`, whether a chargeback
 * arrives as `type: 'dispute'` or as an adjustment) are transcribed from Razorpay's
 * published shape and have not been observed on this account, because no credential is
 * available here. Every such field is listed in the fixture's `confirm_in_task_6_5` array.
 *
 * ## Idempotency
 *
 * Razorpay has no upsert, so idempotency is explicit and comes from two mechanisms, both
 * used:
 *
 * 1. **The fixture is read before it is written.** An existing
 *    `test/fixtures/razorpay-seed.json` supplies the previously created Order and Refund
 *    identifiers and the Part B anchor date. Each identifier is re-fetched to confirm it
 *    still exists; only an identifier that no longer resolves is created again.
 * 2. **A deterministic marker on every created object.** Each seeded Order carries
 *    `receipt = 'financeos-seed/v1/order/<n>'` and
 *    `notes.financeos_seed_key = '<the same string>'`; each seeded Refund carries
 *    `notes.financeos_seed_key`. Before creating anything the script lists the collection
 *    and reuses an object already carrying the marker. So a run against an account seeded
 *    by an earlier run whose fixture was deleted still does not duplicate.
 *
 * Part B is deterministic given the anchor date, and the anchor date is itself read back
 * from the previous fixture, so a second run writes a **byte-identical** file. Deleting
 * the fixture re-anchors it to 30 days before today.
 *
 * ## Money
 *
 * Every monetary value is `Paise` (`bigint`) in this script. There is no `Number(...)` on
 * a monetary value, no `toFixed`, and no float anywhere on the path.
 *
 * JSON has no bigint, so **every monetary value in the fixture is a decimal string** —
 * `"84260000"`, never `84260000` — produced by `toWire` from `@/wire/paise-wire`. That is
 * the money wire contract (design.md structural decision 6, Requirement 15.1, 15.8), and
 * it holds *inside* the `payload` mirrors too, not only in the FinanceOS-side figures. A
 * JSON numeric literal parses to an IEEE-754 double, and a double is exactly what must
 * never hold a monetary value.
 *
 * **This is the one place a Part B payload deliberately departs from Razorpay's own
 * bytes**, and it is a safe departure: `toIngestedPaise` has an explicit digit-string
 * branch that goes straight to `BigInt` with no `Number` and no `parseInt`, so a
 * decimal-string amount projects identically to a numeric one. Field names, nesting and
 * every non-monetary type (`created_at` as Unix seconds, `attempts` as a count, `status`
 * as text) mirror Razorpay exactly. The departure is recorded in the fixture's
 * `money_encoding.payload_departure` and in the task 6.5 list.
 *
 * ## Run it
 *
 *     npm run seed:razorpay
 *
 * which is `node --env-file-if-exists=.env.local --import
 * ./scripts/register-ts-path-alias.mjs scripts/seed-razorpay-testmode.ts`. Node 24 strips
 * the types; the `--import` shim teaches it the `@/*` alias. Add `--store-credential` to
 * also seal the reference Tenant's `key_id:key_secret` pair (see
 * {@link storeReferenceTenantCredential}).
 *
 * Without `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` the script names both variables,
 * skips Part A, and still writes Part B, so tasks 7.2, 11.3 and 16.1 are never blocked on
 * a credential. It exits 0 in that case: an absent credential is a documented outcome
 * here, not a failure.
 *
 * ## Not this script's
 *
 * - `test/fixtures/set-9281.ts`, the typed worked-example module with the twelve-step
 *   Evidence_Chain, is **task 7.2**. This script writes the figures 7.2 must agree with,
 *   and they are exactly design.md's.
 * - Confirming the Part B payload shapes against live test mode is **task 6.5**.
 */

import type { Paise } from '@/calc/paise';
import {
  createSupabaseAuditSink,
  createSupabaseConfigurationStore,
} from '@/config/configuration-store';
import {
  createConfigurationService,
  permissionCheckDeferredToTask26_2,
  type Actor,
  type ConfigurationService,
  type TenantId,
} from '@/config/configuration-service';
import { getEnv, redactSecrets, Secret } from '@/config/env';
import {
  ObjectProjectionError,
  projectRazorpayObject,
  RAZORPAY_ID_FIELD,
} from '@/ingestion/ingestion-service';
import {
  createRazorpayClient,
  RAZORPAY_BASE_URL,
  type IngestedObjectType,
  type RazorpayCredential,
  type RazorpayObject,
} from '@/ingestion/razorpay-client';
import { toWire } from '@/wire/paise-wire';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* -------------------------------------------------------------------------- */
/* Output, and the one place a synthetic record is labelled                    */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = new URL('../', import.meta.url);
const FIXTURE_URL = new URL('test/fixtures/razorpay-seed.json', REPO_ROOT);
const FIXTURE_PATH = fileURLToPath(FIXTURE_URL);

/** Bumped when the fixture's shape changes in a way a consumer must notice. */
const FIXTURE_SCHEMA_VERSION = 2;

/**
 * Stamped on every Part B payload, alongside `_financeos_synthetic: true`.
 *
 * Razorpay never sends a field beginning `_financeos_`, so its presence is proof the
 * record did not come from the provider. `razorpay_objects.payload` is stored verbatim
 * (Requirement 1.2), so the marker survives ingestion and is visible in the database.
 */
const SYNTHETIC_NOTE =
  'SYNTHETIC. Not retrieved from Razorpay. Settlement and Settlement_Recon_Report ' +
  'fixtures are local because Razorpay exposes no create endpoint for them. Route ' +
  'fixtures are local because deterministic linked-account, reversal, on-hold, pending, ' +
  'and invalid over-allocation states cannot be safely guaranteed on a test account. ' +
  'Task 6.5 confirms the payload shapes against test mode.';

/** The `receipt` and `notes.financeos_seed_key` prefix that makes Part A idempotent. */
const SEED_MARKER_PREFIX = 'financeos-seed/v1';

/**
 * The reference Tenant the demo path runs as, and the Tenant
 * `RazorpayCredentialSource.referenceTenantId` names. Fixed so a re-run and the e2e test
 * agree without passing it around.
 */
const DEMO_TENANT_ID: TenantId = '11111111-1111-4111-8111-111111111111';

/** Recorded on the projection self-check rows. Not a real `ingestion_runs` identifier. */
const SELF_CHECK_RUN_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Who a credential store is audited as. `actor_kind` admits `user`, `agent` and
 * `policy_engine` only, and a seeding script is none of the three; `user` is the honest
 * choice of the three because the script runs under an operator's hands, and the actor id
 * says plainly which operator tool it was.
 */
const SEED_ACTOR: Actor = { kind: 'user', id: 'scripts/seed-razorpay-testmode.ts' };

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Script output. `console.log` is banned by the lint config (`no-console` allows `warn`
 * and `error` only) and `console.warn` would misreport ordinary progress as a warning, so
 * this writes to stdout directly.
 */
function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` in UTC. */
function isoDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Razorpay states every timestamp as Unix **seconds**, and so must every mirror. */
function epochSeconds(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/** Σ over integer paise. bigint throughout; no `reduce` into a `number`. */
function sum(values: readonly Paise[]): Paise {
  let total = 0n;
  for (const value of values) {
    total += value;
  }
  return total;
}

/** Every element as a decimal string, in order. */
function toWireList(values: readonly Paise[]): readonly string[] {
  return values.map((value) => toWire(value));
}

/* -------------------------------------------------------------------------- */
/* Part B — the two Settlements                                               */
/* -------------------------------------------------------------------------- */

/**
 * The recon report lines for one Settlement, in the shape design.md's
 * `ReconReportLines` names them. Every value is integer paise.
 *
 * `adjustments` is **signed** — negative for a debit — because Requirement 4.2 takes the
 * *signed* sum of adjustments. The raw recon line payload carries Razorpay's own
 * convention instead, a positive `amount` with the sign in `debit`/`credit`; see
 * {@link reconLinePayload}. The two must agree, and {@link assertSettlementInvariants}
 * checks that they do.
 */
interface ReconLines {
  readonly payments: readonly Paise[];
  readonly refunds: readonly Paise[];
  readonly chargebacks: readonly Paise[];
  readonly adjustments: readonly Paise[];
  readonly fees: readonly Paise[];
  readonly gstOnFees: readonly Paise[];
}

interface SettlementSpec {
  /** design.md's name for the worked example. */
  readonly displayName: string;
  /** Synthetic, and unmistakably so, while keeping Razorpay's `setl_` prefix. */
  readonly settlementId: string;
  /** `settlement_recon_reconciliations.recon_report_id`. */
  readonly reconReportId: string;
  /** Which half of Requirement 4.4 / 4.5 this Settlement demonstrates. */
  readonly residualClass: 'zero_residual' | 'non_zero_residual';
  /** The Settlement object's own `amount`: what actually landed in the bank. */
  readonly receivedPaise: Paise;
  readonly lines: ReconLines;
  /** Suffix distinguishing this Settlement's synthetic entity identifiers. */
  readonly idBatch: string;
  /** Days after the anchor date this Settlement is dated. */
  readonly dayOffset: number;
  /** What a reader needs to know about these particular figures. */
  readonly commentary: readonly string[];
}

/**
 * **SET-9281, the zero-residual Settlement.** design.md's worked example, figure for
 * figure: expected `84260000`, received `81940000`, difference `2320000`, Razorpay_Fee
 * component `1966100`, GST_On_Fee component `353900`, residual `0`.
 *
 * `1966100 + 353900 = 2320000`, so the residual is exactly `0n` and Requirement 4.4
 * applies: status `difference_explained`, and **no Exception is created**. Requirement 4.4
 * admits no tolerance band — "difference explained" means the residual *equals* 0 paise —
 * so the line-level figures below are chosen to sum to design.md's totals **exactly**
 * rather than approximately.
 *
 * The line breakdown reconstructs the Expected Amount by Requirement 4.2's formula,
 * exercising all four line kinds so the twelve-step Evidence_Chain of task 7.2 has a
 * non-empty operand at every step:
 *
 *     Σpayments      52000000 + 30000000 + 8000000  =  90000000
 *     − Σrefunds     − 4500000                      =  85500000
 *     − Σchargebacks − 750000                       =  84750000
 *     + Σadjustments + (−300000 + −190000)          =  84260000   ← Expected Amount
 *     − received     − 81940000                     =   2320000   ← Difference
 *     − Σfees        − 1966100                      =    353900
 *     − Σgst         − 353900                       =         0   ← residual
 */
const SET_9281: SettlementSpec = {
  displayName: 'SET-9281',
  settlementId: 'setl_SYNTHETIC9281',
  reconReportId: 'setlrcn_SYNTHETIC9281',
  residualClass: 'zero_residual',
  receivedPaise: 81_940_000n,
  idBatch: '9281',
  dayOffset: 0,
  lines: {
    payments: [52_000_000n, 30_000_000n, 8_000_000n],
    refunds: [4_500_000n],
    chargebacks: [750_000n],
    adjustments: [-300_000n, -190_000n],
    fees: [1_040_000n, 600_000n, 326_100n],
    gstOnFees: [187_200n, 108_000n, 58_700n],
  },
  commentary: [
    'design.md worked example, figures unchanged: 1966100 + 353900 = 2320000, residual 0.',
    'Requirement 4.4: status difference_explained, no Exception, and the Expected Amount, ' +
      'received amount, Difference, fee component and GST component all recorded against ' +
      'the Settlement identifier.',
    'GST-on-fee is NOT exactly 18% of the fee at design.md\'s totals: 1966100 x 18% = ' +
      '353898, and design.md states 353900. The 2-paise gap is design.md\'s, not this ' +
      'fixture\'s, and it is carried on the third GST line (58700 against a fee of 326100, ' +
      'where 18% would be 58698). The line totals match design.md exactly, which is what ' +
      'Requirement 4.4 constrains; the per-line rate does not enter the computation.',
  ],
};

/**
 * **The non-zero-residual Settlement.** design.md's own variant of SET-9281: "had the
 * report enumerated a fee of ₹19,000.00 instead, the residual would be
 * `2320000n − 1900000n − 353900n = 66100n`".
 *
 * Expected, received and Difference are unchanged. The report's fee lines total `1900000`
 * instead of `1966100`, so `66100` of the Difference is left unexplained. Positive, so
 * Requirement 4.5 gives direction `unexplained_shortfall`, status `mismatch`, and a
 * `settlement_mismatch` Exception whose impact is `|residual| = 66100` (₹661.00).
 *
 * The inconsistency is deliberate and is the anomaly itself: the report enumerates
 * ₹19,000.00 of fee while still enumerating ₹3,539.00 of GST on that fee, which is 18.63%
 * rather than 18%. A report that under-enumerated the fee *and* proportionally
 * under-enumerated its GST would balance to a different, smaller residual and would not
 * reproduce design.md's `66100`. The distortion is concentrated on the third line
 * (`fee 320000`, `gst 69500`) so the first two lines stay at a clean 18%.
 */
const SET_9282: SettlementSpec = {
  displayName: 'SET-9282',
  settlementId: 'setl_SYNTHETIC9282',
  reconReportId: 'setlrcn_SYNTHETIC9282',
  residualClass: 'non_zero_residual',
  receivedPaise: 81_940_000n,
  idBatch: '9282',
  dayOffset: 1,
  lines: {
    payments: [52_000_000n, 30_000_000n, 8_000_000n],
    refunds: [4_500_000n],
    chargebacks: [750_000n],
    adjustments: [-300_000n, -190_000n],
    fees: [1_000_000n, 580_000n, 320_000n],
    gstOnFees: [180_000n, 104_400n, 69_500n],
  },
  commentary: [
    'design.md\'s Rs 19,000 fee variant of SET-9281: 2320000 - 1900000 - 353900 = 66100.',
    'Requirement 4.5: status mismatch, direction unexplained_shortfall (residual > 0), and ' +
      'a settlement_mismatch Exception with impact 66100 paise (Rs 661.00).',
    'The report enumerates a fee of 1900000 while still enumerating 353900 of GST on it. ' +
      'That inconsistency is the anomaly under test, not a transcription slip.',
  ],
};

const SETTLEMENT_SPECS: readonly SettlementSpec[] = [SET_9281, SET_9282];

/* -------------------------------------------------------------------------- */
/* The reconciliation the fixture asserts, and its invariants                  */
/* -------------------------------------------------------------------------- */

/**
 * What task 11.3 and 16.1 must observe for one Settlement. Names match
 * `settlement_reconciliations`' columns so the fixture reads as the expected row.
 */
interface ReconOutcome {
  readonly expected: Paise;
  readonly received: Paise;
  readonly difference: Paise;
  readonly fee: Paise;
  readonly gst: Paise;
  readonly residual: Paise;
  readonly status: 'difference_explained' | 'mismatch' | 'unreconciled';
  readonly direction: 'unexplained_shortfall' | 'unexplained_excess' | 'not_applicable';
  /** Requirement 4.4 creates none; Requirement 4.5 creates a `settlement_mismatch`. */
  readonly createsException: boolean;
  /** `|residual|`, the Exception's INR impact in paise, or `null` when none is created. */
  readonly impact: Paise | null;
  readonly paymentsCounted: number;
  readonly refundsCounted: number;
  readonly chargebacksCounted: number;
  readonly adjustmentsCounted: number;
}

/**
 * design.md's `reconcileSettlement`, restated over integer paise.
 *
 * This is a **transcription, not the implementation**: the Reconciliation_Agent is task
 * 13.x and does not exist yet, so there is nothing to import. When it does, task 11.3
 * drives the real function from task 7.2's fixture module and this computation becomes the
 * fixture's stated expectation, which is exactly what it is here.
 *
 * Requirement 4.2 for the Expected Amount, 4.3 for the three-way decomposition, 4.4 for
 * the zero-residual case and 4.5 for the non-zero one.
 */
function reconcile(spec: SettlementSpec): ReconOutcome {
  const { lines } = spec;

  // Requirement 4.2: payments - refunds - chargebacks + signed adjustments.
  const expected =
    sum(lines.payments) -
    sum(lines.refunds) -
    sum(lines.chargebacks) +
    sum(lines.adjustments);

  const difference = expected - spec.receivedPaise;
  const fee = sum(lines.fees);
  const gst = sum(lines.gstOnFees);
  // Residual is defined by subtraction, so difference = fee + gst + residual is exact by
  // construction. No rounding step exists on this path (Requirement 4.3, property P3).
  const residual = difference - fee - gst;

  const status = residual === 0n ? 'difference_explained' : 'mismatch';
  const direction =
    residual === 0n
      ? 'not_applicable'
      : residual > 0n
        ? 'unexplained_shortfall'
        : 'unexplained_excess';

  return {
    expected,
    received: spec.receivedPaise,
    difference,
    fee,
    gst,
    residual,
    status,
    direction,
    createsException: residual !== 0n,
    impact: residual === 0n ? null : residual < 0n ? -residual : residual,
    paymentsCounted: lines.payments.length,
    refundsCounted: lines.refunds.length,
    chargebacksCounted: lines.chargebacks.length,
    adjustmentsCounted: lines.adjustments.length,
  };
}

/** Raised when the fixture's own figures fail a stated invariant. Nothing is written. */
class SeedInvariantError extends Error {
  override readonly name = 'SeedInvariantError';
}

function mustHold(condition: boolean, what: string): void {
  if (!condition) {
    throw new SeedInvariantError(`fixture invariant violated: ${what}`);
  }
}

/**
 * Every invariant the fixture's figures must satisfy, checked before the file is written.
 *
 * The first three are the three CHECK constraints on `settlement_reconciliations` in
 * `supabase/migrations/20260101000007_settlement_reconciliations.sql`. If a figure here
 * violated one of them, the e2e test would fail on an opaque constraint violation at
 * insert time rather than on a legible assertion, so they are checked at the source.
 *
 * `unreconciled_has_no_figures` is vacuous for both Settlements — neither is
 * `unreconciled`, because both have a present report enumerating three Payments
 * (Requirement 4.13 is the absent-or-empty case and is not what task 7.1 asks for). It is
 * still stated, so adding an unreconciled Settlement later cannot slip past it.
 */
function assertSettlementInvariants(spec: SettlementSpec, out: ReconOutcome): void {
  const where = `${spec.displayName} (${spec.settlementId})`;

  // --- the three database CHECKs -------------------------------------------------
  mustHold(
    out.status !== 'unreconciled' ||
      (out.expected === 0n &&
        out.difference === 0n &&
        out.fee === 0n &&
        out.gst === 0n &&
        out.residual === 0n),
    `${where}: unreconciled_has_no_figures — an unreconciled Settlement carries no figures`,
  );
  mustHold(
    out.difference === out.fee + out.gst + out.residual,
    `${where}: difference_decomposes_exactly — ${out.difference} !== ${out.fee} + ` +
      `${out.gst} + ${out.residual}`,
  );
  mustHold(
    (out.status === 'difference_explained') === (out.residual === 0n),
    `${where}: explained_iff_zero_residual — status ${out.status} against residual ` +
      `${out.residual}; Requirement 4.4 admits no tolerance band`,
  );

  // --- Requirement 4.2 and 4.5 ----------------------------------------------------
  mustHold(
    out.expected ===
      sum(spec.lines.payments) -
        sum(spec.lines.refunds) -
        sum(spec.lines.chargebacks) +
        sum(spec.lines.adjustments),
    `${where}: Expected Amount must be the report's payments − refunds − chargebacks + ` +
      `signed adjustments (Requirement 4.2)`,
  );
  mustHold(
    out.difference === out.expected - out.received,
    `${where}: Difference must be expected − received (Requirement 4.2)`,
  );
  mustHold(
    out.impact === null || out.impact >= 0n,
    `${where}: an Exception impact is the absolute residual and is never negative ` +
      `(Requirement 4.5)`,
  );
  mustHold(
    out.createsException === (out.status === 'mismatch'),
    `${where}: an Exception is created exactly when the residual is non-zero ` +
      `(Requirement 4.4, 4.5)`,
  );

  // --- the fee lines pair with the payment lines -----------------------------------
  mustHold(
    spec.lines.fees.length === spec.lines.payments.length &&
      spec.lines.gstOnFees.length === spec.lines.payments.length,
    `${where}: the report enumerates one Razorpay_Fee line and one GST_On_Fee line per ` +
      `enumerated Payment`,
  );
  for (const value of [
    ...spec.lines.payments,
    ...spec.lines.refunds,
    ...spec.lines.chargebacks,
    ...spec.lines.fees,
    ...spec.lines.gstOnFees,
  ]) {
    mustHold(value > 0n, `${where}: a payment, refund, chargeback, fee or GST line is > 0`);
  }
}

/**
 * The raw recon lines must net to **received + residual**, not to received.
 *
 * Σcredit − Σdebit over the lines is the report's own view of what should have landed net
 * of the fees it enumerates. Expanding it gives `expected − fee − gst`, which is
 * `received + residual`. So the gap between the report's net and the money that actually
 * arrived *is* the unexplained residual — which is what "unexplained" means, restated over
 * Razorpay's own debit/credit columns rather than over the FinanceOS figures.
 *
 * Checking this catches the mistake that the signed-adjustment convention invites: the
 * FinanceOS-side `recon_report_lines.adjustments` carries `-300000` while the payload
 * carries `debit: "300000"`, and a sign flipped in either direction would leave both the
 * decomposition and the Expected Amount intact while making the payloads disagree with the
 * figures derived from them.
 */
function assertReconLinesNetToReceivedPlusResidual(
  spec: SettlementSpec,
  out: ReconOutcome,
  lines: readonly SeededObject[],
): void {
  /** A recon line's `debit` or `credit`, which the fixture writes as a decimal string. */
  const wireField = (line: SeededObject, field: 'debit' | 'credit'): Paise => {
    const value = line.payload[field];
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw new SeedInvariantError(
        `${spec.displayName}: the recon line '${line.razorpay_id}' must carry '${field}' as ` +
          `a decimal string of integer paise`,
      );
    }
    return BigInt(value);
  };

  let net = 0n;
  for (const line of lines) {
    net += wireField(line, 'credit') - wireField(line, 'debit');
  }
  mustHold(
    net === out.received + out.residual,
    `${spec.displayName}: the recon lines net to ${net}, but expected + received + ` +
      `residual arithmetic requires ${out.received + out.residual} ` +
      `(received ${out.received} + residual ${out.residual})`,
  );
}

/**
 * The task's headline claim, checked rather than asserted in prose: the fixture carries at
 * least one Settlement whose residual is exactly `0n` and at least one whose residual is
 * non-zero.
 */
function assertBothResidualShapesPresent(outcomes: readonly ReconOutcome[]): void {
  mustHold(
    outcomes.some((o) => o.residual === 0n && o.status === 'difference_explained'),
    'the fixture must carry at least one Settlement whose residual is exactly 0n ' +
      '(Requirement 4.4)',
  );
  mustHold(
    outcomes.some((o) => o.residual !== 0n && o.status === 'mismatch'),
    'the fixture must carry at least one Settlement whose residual is non-zero ' +
      '(Requirement 4.5)',
  );
}

/* -------------------------------------------------------------------------- */
/* Part B — payload mirrors                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A synthetic Razorpay identifier. Keeps the provider's real prefix — `pay_`, `order_`,
 * `rfnd_` — so the shape and every prefix-matching consumer still work, while the body
 * spells `SYNTHETIC`, so no reader and no log line can mistake it for a live identifier.
 * Explicitly **not** a plausible-looking random suffix: task 7.1 must not fabricate
 * real-looking Razorpay identifiers.
 */
function synId(prefix: string, batch: string, index: number): string {
  return `${prefix}_SYNTHETIC${batch}${index}`;
}

/** The two markers stamped on every Part B payload. Spread into each mirror. */
const syntheticMarkers = {
  _financeos_synthetic: true,
  _financeos_synthetic_note: SYNTHETIC_NOTE,
} as const;

/**
 * One entry in the flat list a consumer ingests or inserts: the object type
 * `razorpay_objects.object_type` takes, the identifier the type keys on per
 * {@link RAZORPAY_ID_FIELD}, and the payload.
 */
interface SeededObject {
  readonly object_type: IngestedObjectType;
  readonly razorpay_id: string;
  readonly payload: RazorpayObject;
}

/** Every synthetic object belonging to one Settlement, grouped by role. */
interface SettlementObjects {
  readonly settlement: SeededObject;
  readonly orders: readonly SeededObject[];
  readonly payments: readonly SeededObject[];
  readonly refunds: readonly SeededObject[];
  readonly reconReportLines: readonly SeededObject[];
}

/**
 * Builds every payload for one Settlement, deterministically from the anchor date.
 *
 * The Payment, Order and Refund mirrors exist because a Settlement's recon report
 * *enumerates* them: reconciliation matches a Payment to its Order and its Settlement using
 * only stored identifier links (Requirement 4.1), and the Semantic_Ledger derives its
 * entries from the Payment, Refund and Settlement objects. A fixture with Settlements but
 * no enumerated Payments would be `unreconciled` under Requirement 4.13, which is the
 * opposite of what task 7.1 asks for.
 */
function buildSettlementObjects(spec: SettlementSpec, anchor: Date): SettlementObjects {
  const settledAt = addDays(anchor, spec.dayOffset);
  const { lines } = spec;

  const orders: SeededObject[] = [];
  const payments: SeededObject[] = [];
  const reconReportLines: SeededObject[] = [];

  const refundId = synId('rfnd', spec.idBatch, 1);
  const disputeId = synId('disp', spec.idBatch, 1);

  lines.payments.forEach((amount, index) => {
    const n = index + 1;
    const orderId = synId('order', spec.idBatch, n);
    const paymentId = synId('pay', spec.idBatch, n);
    const fee = lines.fees[index] ?? 0n;
    const tax = lines.gstOnFees[index] ?? 0n;
    // Payments are dated before the Settlement that pays them out.
    const createdAt = addDays(settledAt, -(lines.payments.length - index) - 1);
    // The first enumerated Payment is the one the Refund and the chargeback act on.
    const refunded = index === 0 ? (lines.refunds[0] ?? 0n) : 0n;

    orders.push({
      object_type: 'order',
      razorpay_id: orderId,
      payload: {
        id: orderId,
        entity: 'order',
        amount: toWire(amount),
        amount_paid: toWire(amount),
        amount_due: '0',
        currency: 'INR',
        receipt: `${SEED_MARKER_PREFIX}/synthetic/order/${spec.idBatch}/${n}`,
        offer_id: null,
        status: 'paid',
        attempts: 1,
        notes: { financeos_seed_key: `${SEED_MARKER_PREFIX}/synthetic/${spec.idBatch}/${n}` },
        created_at: epochSeconds(createdAt),
        ...syntheticMarkers,
      },
    });

    payments.push({
      object_type: 'payment',
      razorpay_id: paymentId,
      payload: {
        id: paymentId,
        entity: 'payment',
        amount: toWire(amount),
        currency: 'INR',
        status: 'captured',
        order_id: orderId,
        invoice_id: null,
        international: false,
        method: 'card',
        amount_refunded: toWire(refunded),
        refund_status: refunded > 0n ? 'partial' : null,
        captured: true,
        description: `${spec.displayName} enumerated Payment ${n} of ${lines.payments.length}`,
        card_id: synId('card', spec.idBatch, n),
        bank: null,
        wallet: null,
        vpa: null,
        email: 'demo@financeos.invalid',
        contact: '+919900000000',
        notes: { financeos_seed_key: `${SEED_MARKER_PREFIX}/synthetic/${spec.idBatch}/${n}` },
        // `fee` and `tax` are what `RAZORPAY_MONEY_FIELDS.payment` projects into
        // `fee_paise` and `gst_on_fee_paise`. `tax` is the GST charged on the fee.
        fee: toWire(fee),
        tax: toWire(tax),
        error_code: null,
        error_description: null,
        created_at: epochSeconds(createdAt),
        ...syntheticMarkers,
      },
    });

    reconReportLines.push(
      reconLine({
        entityId: paymentId,
        type: 'payment',
        amount,
        fee,
        tax,
        settlementId: spec.settlementId,
        createdAt,
        settledAt,
        extra: { order_id: orderId, payment_method: 'card', payment_capture: true },
      }),
    );
  });

  const refunds: SeededObject[] = [];
  lines.refunds.forEach((amount, index) => {
    const firstPaymentId = synId('pay', spec.idBatch, 1);
    const createdAt = addDays(settledAt, -1);
    refunds.push({
      object_type: 'refund',
      razorpay_id: refundId,
      payload: {
        id: refundId,
        entity: 'refund',
        amount: toWire(amount),
        currency: 'INR',
        payment_id: firstPaymentId,
        notes: { financeos_seed_key: `${SEED_MARKER_PREFIX}/synthetic/${spec.idBatch}/refund` },
        receipt: null,
        acquirer_data: { arn: null },
        created_at: epochSeconds(createdAt),
        batch_id: null,
        status: 'processed',
        speed_processed: 'normal',
        speed_requested: 'normal',
        ...syntheticMarkers,
      },
    });
    reconReportLines.push(
      reconLine({
        entityId: refundId,
        type: 'refund',
        amount,
        settlementId: spec.settlementId,
        createdAt,
        settledAt,
        debit: true,
        extra: { payment_id: firstPaymentId },
      }),
    );
    // One Refund line only; `index` is present so a second one would be a compile-visible
    // change rather than a silent overwrite of `refundId`.
    mustHold(index === 0, `${spec.displayName}: the fixture enumerates exactly one Refund`);
  });

  lines.chargebacks.forEach((amount, index) => {
    const createdAt = addDays(settledAt, -1);
    reconReportLines.push(
      reconLine({
        entityId: disputeId,
        type: 'dispute',
        amount,
        settlementId: spec.settlementId,
        createdAt,
        settledAt,
        debit: true,
        extra: { dispute_id: disputeId, payment_id: synId('pay', spec.idBatch, 1) },
      }),
    );
    mustHold(index === 0, `${spec.displayName}: the fixture enumerates exactly one chargeback`);
  });

  lines.adjustments.forEach((signedAmount, index) => {
    const adjustmentId = synId('adj', spec.idBatch, index + 1);
    const createdAt = addDays(settledAt, -1);
    // Razorpay carries the sign in `debit` versus `credit` and keeps `amount` positive;
    // the signed value lives in the FinanceOS-side `recon_report_lines.adjustments`.
    const magnitude = signedAmount < 0n ? -signedAmount : signedAmount;
    reconReportLines.push(
      reconLine({
        entityId: adjustmentId,
        type: 'adjustment',
        amount: magnitude,
        settlementId: spec.settlementId,
        createdAt,
        settledAt,
        debit: signedAmount < 0n,
        extra: { description: 'synthetic settlement adjustment' },
      }),
    );
  });

  const settlement: SeededObject = {
    object_type: 'settlement',
    razorpay_id: spec.settlementId,
    payload: {
      id: spec.settlementId,
      entity: 'settlement',
      // The Settlement object's own amount is the received amount reconciliation compares
      // the Expected Amount against.
      amount: toWire(spec.receivedPaise),
      status: 'processed',
      // `fees` and `tax` mirror the report's totals, so
      // amount + fees + tax === expected exactly when the residual is 0. For SET-9282 they
      // mirror the report's under-enumerated fee, which is why 66100 is left unexplained.
      fees: toWire(sum(lines.fees)),
      tax: toWire(sum(lines.gstOnFees)),
      utr: `SYNTHETICUTR${spec.idBatch}`,
      created_at: epochSeconds(settledAt),
      ...syntheticMarkers,
    },
  };

  return { settlement, orders, payments, refunds, reconReportLines };
}

/**
 * One combined-recon-report line.
 *
 * **`entity_id` is the identifier of the settled entity itself** — the Payment, Refund,
 * dispute or adjustment the line describes — which is what Razorpay sends and what
 * `RAZORPAY_ID_FIELD.settlement_recon_report` reads. It is deliberately *not* given a
 * fabricated line-scoped identifier: that would hide the identifier collision documented in
 * `src/ingestion/ingestion-service.ts` from the very fixture meant to exercise it. See the
 * fixture's `known_findings`.
 *
 * `_financeos_composite_id` is offered alongside as the identifier a
 * `(tenant_id, object_type, razorpay_id)` key or a settlement-scoped composite would use,
 * so a consumer that needs a collision-free key has one without editing the fixture.
 */
function reconLine(input: {
  readonly entityId: string;
  readonly type: 'payment' | 'refund' | 'dispute' | 'adjustment';
  readonly amount: Paise;
  readonly fee?: Paise;
  readonly tax?: Paise;
  readonly settlementId: string;
  readonly createdAt: Date;
  readonly settledAt: Date;
  readonly debit?: boolean;
  readonly extra?: Readonly<Record<string, unknown>>;
}): SeededObject {
  const fee = input.fee ?? 0n;
  const tax = input.tax ?? 0n;
  const isDebit = input.debit === true;
  const net = input.amount - fee - tax;

  return {
    object_type: 'settlement_recon_report',
    razorpay_id: input.entityId,
    payload: {
      entity_id: input.entityId,
      type: input.type,
      debit: isDebit ? toWire(input.amount) : '0',
      credit: isDebit ? '0' : toWire(net),
      amount: toWire(input.amount),
      currency: 'INR',
      fee: toWire(fee),
      tax: toWire(tax),
      on_hold: false,
      settled: true,
      created_at: epochSeconds(input.createdAt),
      settled_at: epochSeconds(input.settledAt),
      settlement_id: input.settlementId,
      posted_at: null,
      credit_type: 'default',
      settlement_utr: `SYNTHETICUTR${input.settlementId.slice(-4)}`,
      dispute_id: null,
      ...input.extra,
      _financeos_composite_id: `${input.settlementId}:${input.entityId}`,
      ...syntheticMarkers,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Part B — deterministic Razorpay Route fixtures                              */
/* -------------------------------------------------------------------------- */

interface RouteTransferSpec {
  readonly id: string;
  readonly paymentId: string;
  readonly linkedAccountId: string;
  readonly amount: Paise;
  readonly reversalAmounts: readonly Paise[];
  readonly onHold: boolean;
  readonly settlementId: string | null;
  readonly dayOffset: number;
}

const ROUTE_ACCOUNT_SETTLED = 'acc_SYNTHETICROUTE_SETTLED';
const ROUTE_ACCOUNT_ON_HOLD = 'acc_SYNTHETICROUTE_ONHOLD';
const ROUTE_ACCOUNT_PENDING = 'acc_SYNTHETICROUTE_PENDING';
const ROUTE_SETTLEMENT_ID = 'setl_SYNTHETICROUTE_SETTLED';
const ROUTE_PAYMENT_ID = synId('pay', SET_9281.idBatch, 1);
const OVER_ALLOCATED_PAYMENT_ID = synId('pay', SET_9281.idBatch, 3);

const ROUTE_TRANSFERS: readonly RouteTransferSpec[] = [
  {
    id: 'trf_SYNTHETICROUTE_PARTIAL',
    paymentId: ROUTE_PAYMENT_ID,
    linkedAccountId: ROUTE_ACCOUNT_SETTLED,
    amount: 20_000_000n,
    reversalAmounts: [5_000_000n],
    onHold: false,
    settlementId: ROUTE_SETTLEMENT_ID,
    dayOffset: -3,
  },
  {
    id: 'trf_SYNTHETICROUTE_FULL',
    paymentId: ROUTE_PAYMENT_ID,
    linkedAccountId: ROUTE_ACCOUNT_SETTLED,
    amount: 8_000_000n,
    reversalAmounts: [8_000_000n],
    onHold: false,
    settlementId: ROUTE_SETTLEMENT_ID,
    dayOffset: -2,
  },
  {
    id: 'trf_SYNTHETICROUTE_ONHOLD',
    paymentId: ROUTE_PAYMENT_ID,
    linkedAccountId: ROUTE_ACCOUNT_ON_HOLD,
    amount: 10_000_000n,
    reversalAmounts: [],
    onHold: true,
    settlementId: null,
    dayOffset: -1,
  },
  {
    id: 'trf_SYNTHETICROUTE_PENDING',
    paymentId: ROUTE_PAYMENT_ID,
    linkedAccountId: ROUTE_ACCOUNT_PENDING,
    amount: 5_000_000n,
    reversalAmounts: [],
    onHold: false,
    settlementId: null,
    dayOffset: 0,
  },
  {
    id: 'trf_SYNTHETICROUTE_OVERALLOC_A',
    paymentId: OVER_ALLOCATED_PAYMENT_ID,
    linkedAccountId: ROUTE_ACCOUNT_SETTLED,
    amount: 5_000_000n,
    reversalAmounts: [],
    onHold: false,
    settlementId: ROUTE_SETTLEMENT_ID,
    dayOffset: 1,
  },
  {
    id: 'trf_SYNTHETICROUTE_OVERALLOC_B',
    paymentId: OVER_ALLOCATED_PAYMENT_ID,
    linkedAccountId: ROUTE_ACCOUNT_SETTLED,
    amount: 4_000_000n,
    reversalAmounts: [],
    onHold: false,
    settlementId: ROUTE_SETTLEMENT_ID,
    dayOffset: 1,
  },
] as const;

function buildRouteBlock(anchor: Date) {
  const linkedAccount = (
    id: string,
    name: string,
    email: string,
    dayOffset: number,
  ): SeededObject => ({
    object_type: 'linked_account',
    razorpay_id: id,
    payload: {
      id,
      entity: 'account',
      type: 'route',
      status: 'activated',
      email,
      phone: '+919900000000',
      legal_business_name: name,
      customer_facing_business_name: name,
      profile: { category: 'ecommerce', subcategory: 'marketplace' },
      notes: { financeos_seed_key: `${SEED_MARKER_PREFIX}/synthetic/route/${id}` },
      created_at: epochSeconds(addDays(anchor, dayOffset)),
      ...syntheticMarkers,
    },
  });

  const linkedAccounts = [
    linkedAccount(
      ROUTE_ACCOUNT_SETTLED,
      'FinanceOS Synthetic Settled Seller',
      'settled-seller@financeos.invalid',
      -10,
    ),
    linkedAccount(
      ROUTE_ACCOUNT_ON_HOLD,
      'FinanceOS Synthetic On-Hold Seller',
      'on-hold-seller@financeos.invalid',
      -9,
    ),
    linkedAccount(
      ROUTE_ACCOUNT_PENDING,
      'FinanceOS Synthetic Pending Seller',
      'pending-seller@financeos.invalid',
      -8,
    ),
  ];

  const transfers: SeededObject[] = [];
  const transferReversals: SeededObject[] = [];
  for (const transfer of ROUTE_TRANSFERS) {
    const createdAt = addDays(anchor, transfer.dayOffset);
    const amountReversed = sum(transfer.reversalAmounts);
    mustHold(
      amountReversed <= transfer.amount,
      `${transfer.id}: Transfer_Reversals cannot exceed their Transfer amount`,
    );

    transfers.push({
      object_type: 'transfer',
      razorpay_id: transfer.id,
      payload: {
        id: transfer.id,
        entity: 'transfer',
        source: transfer.paymentId,
        recipient: transfer.linkedAccountId,
        amount: toWire(transfer.amount),
        currency: 'INR',
        amount_reversed: toWire(amountReversed),
        fees: '0',
        tax: '0',
        on_hold: transfer.onHold,
        on_hold_until: transfer.onHold
          ? epochSeconds(addDays(anchor, transfer.dayOffset + 7))
          : null,
        recipient_settlement_id: transfer.settlementId,
        settlement_status: transfer.onHold
          ? 'on_hold'
          : transfer.settlementId === null
            ? 'pending'
            : 'settled',
        status: 'processed',
        notes: {
          financeos_seed_key: `${SEED_MARKER_PREFIX}/synthetic/route/${transfer.id}`,
        },
        created_at: epochSeconds(createdAt),
        ...syntheticMarkers,
      },
    });

    transfer.reversalAmounts.forEach((amount, index) => {
      const reversalId = `rvrsl_SYNTHETICROUTE_${transfer.id.endsWith('PARTIAL') ? 'PARTIAL' : 'FULL'}_${index + 1}`;
      transferReversals.push({
        object_type: 'transfer_reversal',
        razorpay_id: reversalId,
        payload: {
          id: reversalId,
          entity: 'reversal',
          transfer_id: transfer.id,
          amount: toWire(amount),
          currency: 'INR',
          fees: '0',
          tax: '0',
          created_at: epochSeconds(addDays(createdAt, 1)),
          ...syntheticMarkers,
        },
      });
    });
  }

  const routeSettlementAmount = 24_000_000n;
  const settlements: SeededObject[] = [
    {
      object_type: 'settlement',
      razorpay_id: ROUTE_SETTLEMENT_ID,
      payload: {
        id: ROUTE_SETTLEMENT_ID,
        entity: 'settlement',
        amount: toWire(routeSettlementAmount),
        status: 'processed',
        fees: '0',
        tax: '0',
        currency: 'INR',
        utr: 'SYNTHETICUTRROUTE',
        linked_account_id: ROUTE_ACCOUNT_SETTLED,
        created_at: epochSeconds(addDays(anchor, 4)),
        ...syntheticMarkers,
      },
    },
  ];

  const normalTransfers = ROUTE_TRANSFERS.filter(
    (transfer) => transfer.paymentId === ROUTE_PAYMENT_ID,
  );
  const normalNetTransfers = sum(
    normalTransfers.map((transfer) => transfer.amount - sum(transfer.reversalAmounts)),
  );
  const normalPaymentAmount = SET_9281.lines.payments[0] ?? 0n;
  const normalFee = SET_9281.lines.fees[0] ?? 0n;
  const normalGst = SET_9281.lines.gstOnFees[0] ?? 0n;
  const platformCommission = normalPaymentAmount - normalNetTransfers - normalFee - normalGst;
  mustHold(platformCommission >= 0n, 'the normal Route split has non-negative commission');
  mustHold(
    normalNetTransfers + platformCommission + normalFee + normalGst === normalPaymentAmount,
    'the normal Route split conserves Payment = net Transfers + commission + fee + GST',
  );

  const settledExpected = sum(
    ROUTE_TRANSFERS.filter(
      (transfer) =>
        transfer.linkedAccountId === ROUTE_ACCOUNT_SETTLED && !transfer.onHold,
    ).map((transfer) => transfer.amount - sum(transfer.reversalAmounts)),
  );
  mustHold(
    settledExpected === routeSettlementAmount,
    'the settled Linked_Account payout equals its received Settlement exactly',
  );

  const pendingTransfers = ROUTE_TRANSFERS.filter(
    (transfer) => transfer.linkedAccountId === ROUTE_ACCOUNT_PENDING,
  );
  const pendingAmount = sum(pendingTransfers.map((transfer) => transfer.amount));
  mustHold(pendingAmount > 0n, 'the zero-settlement Linked_Account has a pending payout');

  const onHoldTransfers = ROUTE_TRANSFERS.filter((transfer) => transfer.onHold);
  const onHoldAmount = sum(onHoldTransfers.map((transfer) => transfer.amount));
  mustHold(
    onHoldTransfers.length === 1 && onHoldAmount > 0n,
    'the Route fixture has one positive on-hold Transfer',
  );

  const overAllocatedTransfers = ROUTE_TRANSFERS.filter(
    (transfer) => transfer.paymentId === OVER_ALLOCATED_PAYMENT_ID,
  );
  const overAllocatedPaymentAmount = SET_9281.lines.payments[2] ?? 0n;
  const overAllocatedTotal = sum(overAllocatedTransfers.map((transfer) => transfer.amount));
  const overAllocatedImpact = overAllocatedTotal - overAllocatedPaymentAmount;
  mustHold(overAllocatedImpact > 0n, 'the deliberate split is over-allocated');

  const partial = ROUTE_TRANSFERS.find((transfer) => transfer.id.endsWith('PARTIAL'));
  const full = ROUTE_TRANSFERS.find((transfer) => transfer.id.endsWith('FULL'));
  mustHold(
    partial !== undefined &&
      sum(partial.reversalAmounts) > 0n &&
      sum(partial.reversalAmounts) < partial.amount,
    'the partial Transfer_Reversal is positive and less than its Transfer',
  );
  mustHold(
    full !== undefined && sum(full.reversalAmounts) === full.amount,
    'the full Transfer_Reversal equals its Transfer amount',
  );

  return {
    warning:
      'SYNTHETIC Route fixtures. These deterministic states were not created or retrieved ' +
      'through Razorpay. Every payload carries both synthetic markers.',
    commentary: [
      'The normal split conserves integer paise exactly and contains both partial and full reversals.',
      'The on-hold Transfer remains in split conservation but is excluded from expected Seller payout.',
      'The pending seller has no Settlement in this block and therefore creates no seller settlement mismatch.',
      'The over-allocated split is deliberately invalid and must create only the specified over_allocated_split finding.',
    ],
    linked_accounts: linkedAccounts,
    settlements_received: settlements,
    transfers,
    transfer_reversals: transferReversals,
    expected: {
      normal_split: {
        payment_id: ROUTE_PAYMENT_ID,
        payment_amount_paise: toWire(normalPaymentAmount),
        net_transfers_paise: toWire(normalNetTransfers),
        platform_commission_paise: toWire(platformCommission),
        razorpay_fee_paise: toWire(normalFee),
        gst_on_fee_paise: toWire(normalGst),
        difference_paise: '0',
      },
      reversals: {
        partial: {
          transfer_id: partial?.id,
          transfer_amount_paise: toWire(partial?.amount ?? 0n),
          reversal_amount_paise: toWire(sum(partial?.reversalAmounts ?? [])),
        },
        full: {
          transfer_id: full?.id,
          transfer_amount_paise: toWire(full?.amount ?? 0n),
          reversal_amount_paise: toWire(sum(full?.reversalAmounts ?? [])),
        },
      },
      settled_linked_account: {
        linked_account_id: ROUTE_ACCOUNT_SETTLED,
        expected_payout_paise: toWire(settledExpected),
        received_settlement_paise: toWire(routeSettlementAmount),
        difference_paise: '0',
        creates_seller_settlement_mismatch: false,
      },
      on_hold: {
        linked_account_id: ROUTE_ACCOUNT_ON_HOLD,
        transfer_id: onHoldTransfers[0]?.id,
        amount_paise: toWire(onHoldAmount),
        expected_payout_paise: '0',
        excluded_from_expected_payout: true,
      },
      zero_settlement: {
        linked_account_id: ROUTE_ACCOUNT_PENDING,
        settlement_ids: [],
        classification: 'pending',
        pending_amount_paise: toWire(pendingAmount),
        oldest_transfer_id: pendingTransfers[0]?.id,
        creates_seller_settlement_mismatch: false,
      },
      over_allocated_split: {
        payment_id: OVER_ALLOCATED_PAYMENT_ID,
        payment_amount_paise: toWire(overAllocatedPaymentAmount),
        transfer_ids: overAllocatedTransfers.map((transfer) => transfer.id),
        transfers_total_paise: toWire(overAllocatedTotal),
        exception_category: 'over_allocated_split',
        exception_impact_paise: toWire(overAllocatedImpact),
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Part A — credentials                                                       */
/* -------------------------------------------------------------------------- */

const RAZORPAY_KEY_ID_VAR = 'RAZORPAY_KEY_ID';
const RAZORPAY_KEY_SECRET_VAR = 'RAZORPAY_KEY_SECRET';

interface CredentialCheck {
  readonly credential: RazorpayCredential | null;
  /** The variables that are absent or empty. Names only — never a value. */
  readonly missing: readonly string[];
}

/**
 * The Razorpay pair, or the names of the variables that are missing.
 *
 * `getEnv()` is deliberately **not** used. It parses the whole environment through one
 * schema and throws naming *every* failing variable, so a machine with a Razorpay key but
 * no `GROQ_API_KEY` could not seed — and the seeding script needs Supabase and the model
 * providers only for the optional credential-store step. Reading the two variables
 * directly keeps the failure message about the two variables that matter here.
 *
 * Both halves are wrapped in `Secret`, so neither can reach a log line, an error message
 * or `JSON.stringify` output without an explicit `.reveal()`, and both register in the
 * value-keyed redaction table so a provider that echoes the key id back is scrubbed too
 * (Requirement 14.5).
 */
function readRazorpayCredential(source: NodeJS.ProcessEnv = process.env): CredentialCheck {
  const keyId = source[RAZORPAY_KEY_ID_VAR];
  const keySecret = source[RAZORPAY_KEY_SECRET_VAR];
  const missing: string[] = [];
  if (keyId === undefined || keyId.trim().length === 0) missing.push(RAZORPAY_KEY_ID_VAR);
  if (keySecret === undefined || keySecret.trim().length === 0) {
    missing.push(RAZORPAY_KEY_SECRET_VAR);
  }
  if (missing.length > 0 || keyId === undefined || keySecret === undefined) {
    return { credential: null, missing };
  }
  return {
    credential: {
      keyId: new Secret(RAZORPAY_KEY_ID_VAR, keyId.trim()),
      keySecret: new Secret(RAZORPAY_KEY_SECRET_VAR, keySecret.trim()),
    },
    missing: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Part A — the write path Razorpay's read transport does not cover            */
/* -------------------------------------------------------------------------- */

/**
 * A single `POST`, because `RazorpayClient` has no write method.
 *
 * `src/ingestion/razorpay-client.ts` exposes exactly one method, `fetchPages`, and tasks
 * 6.3, 6.4 and 6.6 are editing `src/ingestion/` in this same wave, so adding a shared
 * write transport there is not task 7.1's to do. **Reported rather than worked around:** a
 * `RazorpayClient.post` sharing the 30 s per-request timeout, the 1/2/4/8/16 s retry
 * schedule and the four-way classification belongs in that module, and task 9.x's
 * `initiate_payment_retry` will need it too. Until then this is the one narrow write path,
 * used for two endpoints only, and it does **not** reimplement retries: a seeding script
 * that fails is re-run, whereas an ingestion run that fails loses a window.
 *
 * The `Authorization` header is built inline from `.reveal()` and is never stored on an
 * object, returned, or logged — the same discipline as `basicAuthorization` in the client.
 */
async function razorpayPost(
  credential: RazorpayCredential,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<
  | { readonly ok: true; readonly object: RazorpayObject }
  | { readonly ok: false; readonly status: number | null; readonly detail: string }
> {
  const authorization = `Basic ${Buffer.from(
    `${credential.keyId.reveal()}:${credential.keySecret.reveal()}`,
    'utf8',
  ).toString('base64')}`;

  try {
    const response = await fetch(new URL(path, RAZORPAY_BASE_URL), {
      method: 'POST',
      headers: {
        authorization,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, detail: redact(text) };
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, status: response.status, detail: 'response body is not an object' };
    }
    return { ok: true, object: parsed as RazorpayObject };
  } catch (cause) {
    return {
      ok: false,
      status: null,
      detail: redact(cause instanceof Error ? cause.message : String(cause)),
    };
  }
}

/** Bounded, credential-scrubbed provider text. Nothing unredacted reaches stdout. */
function redact(text: string): string {
  // `redactSecrets` matches on credential *value*, so it scrubs a key echoed back in an
  // error body even though nothing here ever formats a credential deliberately.
  const scrubbed = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…` : scrubbed;
}

/* -------------------------------------------------------------------------- */
/* Part A — reads, through the real ingestion transport                        */
/* -------------------------------------------------------------------------- */

/** Every object of one type in the window, or the classified failure that stopped it. */
async function listAll(
  credential: RazorpayCredential,
  type: IngestedObjectType,
  from: Date,
  to: Date,
  query?: Readonly<Record<string, string>>,
): Promise<
  | { readonly ok: true; readonly objects: readonly RazorpayObject[] }
  | { readonly ok: false; readonly detail: string }
> {
  // The real transport: paging on the short-page rule, the 30 s per-request timeout and
  // the 1/2/4/8/16 s retry schedule all come from task 6.1 rather than being re-derived.
  const client = createRazorpayClient({ credential });
  const objects: RazorpayObject[] = [];

  for await (const result of client.fetchPages(type, { from, to }, { query })) {
    if (result.kind === 'page') {
      objects.push(...result.objects);
      continue;
    }
    const { failure } = result;
    return {
      ok: false,
      detail:
        `${failure.category}/${failure.errorCode}` +
        `${failure.httpStatus === null ? '' : ` (HTTP ${failure.httpStatus})`}: ` +
        `${redact(failure.detail)}`,
    };
  }
  return { ok: true, objects };
}

/* -------------------------------------------------------------------------- */
/* Part A — the seeded Orders and Refunds                                     */
/* -------------------------------------------------------------------------- */

/**
 * The Orders Part A creates. Amounts are one-hundredth of Part B's enumerated Payment
 * amounts, so the correspondence is legible without approaching any per-order ceiling that
 * could turn a seeding run into a `provider_error` for a reason nobody would diagnose.
 */
const SEED_ORDER_AMOUNTS: readonly Paise[] = [5_200_000n, 3_000_000n, 800_000n];

/** The deterministic marker for one seeded Order. Both the `receipt` and a note. */
function orderMarker(index: number): string {
  return `${SEED_MARKER_PREFIX}/order/${index}`;
}

function refundMarker(paymentId: string): string {
  return `${SEED_MARKER_PREFIX}/refund/${paymentId}`;
}

/** What one live object contributes to the fixture. Identifiers only, plus its figures. */
interface LiveRecord {
  readonly razorpay_id: string;
  /** `created` when this run created it, `reused` when the marker already existed. */
  readonly origin: 'created' | 'reused';
  readonly amount_paise: string | null;
  readonly status: string | null;
  readonly marker: string | null;
}

function readString(object: RazorpayObject, field: string): string | null {
  const value = object[field];
  return typeof value === 'string' ? value : null;
}

/** A note value, for the marker lookup. Razorpay returns `notes` as a string map. */
function readNote(object: RazorpayObject, key: string): string | null {
  const notes = object.notes;
  if (typeof notes !== 'object' || notes === null || Array.isArray(notes)) return null;
  const value = (notes as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * A monetary field of a **live** payload as a decimal string.
 *
 * Razorpay sends a JSON number, which `JSON.parse` has already turned into a double before
 * this function sees it, so the only safe move is to reject anything that is not an exact
 * integer rather than to record a value whose digits are already unreliable. Nothing is
 * scaled: Razorpay states its money in paise.
 */
function liveMoney(object: RazorpayObject, field: string): string | null {
  const value = object[field];
  if (typeof value === 'string' && /^\d+$/.test(value)) return toWire(BigInt(value));
  if (typeof value !== 'number') return null;
  if (!Number.isSafeInteger(value)) {
    throw new SeedInvariantError(
      `live payload field '${field}' is not an exact integer number of paise; its digits ` +
        `are already unreliable and it will not be recorded`,
    );
  }
  return toWire(BigInt(value));
}

/**
 * Create the three seeded Orders, reusing any that already carry the marker.
 *
 * Razorpay has no upsert and no create-idempotency header on `/v1/orders`, so the lookup
 * is the whole mechanism: the collection is listed first and an Order whose `receipt`
 * equals the deterministic marker is reused as-is. `receipt` uniqueness is *not* relied on
 * — it is only enforced when a Tenant enables "reject duplicate receipt" on the dashboard —
 * which is precisely why the lookup happens here rather than being delegated to Razorpay.
 */
async function seedOrders(
  credential: RazorpayCredential,
  from: Date,
  to: Date,
): Promise<{ readonly records: readonly LiveRecord[]; readonly notes: readonly string[] }> {
  const notes: string[] = [];
  const listed = await listAll(credential, 'order', from, to);
  if (!listed.ok) {
    notes.push(`could not list Orders, so no Order was created: ${listed.detail}`);
    return { records: [], notes };
  }

  const byMarker = new Map<string, RazorpayObject>();
  for (const object of listed.objects) {
    const marker = readString(object, 'receipt') ?? readNote(object, 'financeos_seed_key');
    if (marker !== null && marker.startsWith(SEED_MARKER_PREFIX)) {
      byMarker.set(marker, object);
    }
  }
  notes.push(
    `listed ${listed.objects.length} Order(s) in the window; ${byMarker.size} already ` +
      `carried a '${SEED_MARKER_PREFIX}' marker`,
  );

  const records: LiveRecord[] = [];
  for (const [index, amount] of SEED_ORDER_AMOUNTS.entries()) {
    const marker = orderMarker(index + 1);
    const existing = byMarker.get(marker);
    if (existing !== undefined) {
      const id = readString(existing, 'id');
      if (id !== null) {
        records.push({
          razorpay_id: id,
          origin: 'reused',
          amount_paise: liveMoney(existing, 'amount'),
          status: readString(existing, 'status'),
          marker,
        });
        continue;
      }
    }

    const created = await razorpayPost(credential, '/v1/orders', {
      // Razorpay takes the amount in paise, so the decimal string of the bigint is exact
      // and needs no scaling. A JSON number here would be a double.
      amount: toWire(amount),
      currency: 'INR',
      receipt: marker,
      notes: { financeos_seed_key: marker },
    });
    if (!created.ok) {
      notes.push(
        `Order '${marker}' was not created (HTTP ${created.status ?? 'none'}): ${created.detail}`,
      );
      continue;
    }
    const id = readString(created.object, 'id');
    if (id === null) {
      notes.push(`Order '${marker}' was created but the response carried no id`);
      continue;
    }
    records.push({
      razorpay_id: id,
      origin: 'created',
      amount_paise: liveMoney(created.object, 'amount'),
      status: readString(created.object, 'status'),
      marker,
    });
  }
  return { records, notes };
}

/**
 * Create one Refund against a discovered captured Payment, reusing an existing marked one.
 *
 * A Refund needs a Payment, and **a Payment cannot be created through the API** — it comes
 * from Checkout, or from an S2S endpoint that needs per-account activation. So this step
 * is conditional on the account already holding a captured Payment with headroom, and when
 * it holds none the fixture says so rather than inventing one.
 */
async function seedRefund(
  credential: RazorpayCredential,
  payments: readonly RazorpayObject[],
  from: Date,
  to: Date,
): Promise<{ readonly records: readonly LiveRecord[]; readonly notes: readonly string[] }> {
  const notes: string[] = [];

  const candidate = payments.find((payment) => {
    if (readString(payment, 'status') !== 'captured') return false;
    const amount = liveMoney(payment, 'amount');
    const refunded = liveMoney(payment, 'amount_refunded') ?? '0';
    return amount !== null && BigInt(amount) - BigInt(refunded) >= 10_000n;
  });
  if (candidate === undefined) {
    notes.push(
      'no captured Payment with at least Rs 100.00 of unrefunded headroom was found, so no ' +
        'Refund was created. A Payment cannot be created through the Razorpay API, so this ' +
        'step depends on the test-mode account already holding one.',
    );
    return { records: [], notes };
  }
  const paymentId = readString(candidate, 'id');
  if (paymentId === null) {
    notes.push('the candidate Payment carried no id, so no Refund was created');
    return { records: [], notes };
  }
  const marker = refundMarker(paymentId);

  const listed = await listAll(credential, 'refund', from, to);
  if (listed.ok) {
    const existing = listed.objects.find(
      (refund) => readNote(refund, 'financeos_seed_key') === marker,
    );
    if (existing !== undefined) {
      const id = readString(existing, 'id');
      if (id !== null) {
        notes.push(`reused the Refund already marked '${marker}'`);
        return {
          records: [
            {
              razorpay_id: id,
              origin: 'reused',
              amount_paise: liveMoney(existing, 'amount'),
              status: readString(existing, 'status'),
              marker,
            },
          ],
          notes,
        };
      }
    }
  } else {
    notes.push(
      `could not list Refunds to check for an existing marked Refund, so none was ` +
        `created rather than risking a duplicate: ${listed.detail}`,
    );
    return { records: [], notes };
  }

  const created = await razorpayPost(credential, `/v1/payments/${paymentId}/refund`, {
    amount: toWire(10_000n), // Rs 100.00, a partial refund
    speed: 'normal',
    notes: { financeos_seed_key: marker },
  });
  if (!created.ok) {
    notes.push(
      `Refund against ${paymentId} was not created (HTTP ${created.status ?? 'none'}): ` +
        `${created.detail}`,
    );
    return { records: [], notes };
  }
  const id = readString(created.object, 'id');
  if (id === null) {
    notes.push('the Refund was created but the response carried no id');
    return { records: [], notes };
  }
  return {
    records: [
      {
        razorpay_id: id,
        origin: 'created',
        amount_paise: liveMoney(created.object, 'amount'),
        status: readString(created.object, 'status'),
        marker,
      },
    ],
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Part A — discovery of what cannot be created                                */
/* -------------------------------------------------------------------------- */

/** A discovered Settlement, recorded so task 6.5 can compare Part B against reality. */
interface DiscoveredSettlement {
  readonly razorpay_id: string;
  readonly amount_paise: string | null;
  readonly fees_paise: string | null;
  readonly tax_paise: string | null;
  readonly status: string | null;
}

/**
 * List whatever Settlements and recon report lines the account already holds.
 *
 * Read-only, and that is the point: this is the honest half of the settlement story. If the
 * account holds none — which is the normal test-mode outcome, because test mode runs no
 * settlement cycle — the fixture records an empty list and the note explaining why, and
 * Part B carries the demo.
 *
 * The recon report is addressed by year and month, not by a window, so only the two months
 * ending at `to` are requested. A full 365-day window is 13 requests for data the demo does
 * not depend on; task 6.5, which owns the live-shape confirmation, can widen it.
 */
async function discoverSettlementData(
  credential: RazorpayCredential,
  from: Date,
  to: Date,
): Promise<{
  readonly settlements: readonly DiscoveredSettlement[];
  readonly reconLineEntityIds: readonly string[];
  readonly notes: readonly string[];
}> {
  const notes: string[] = [];

  const listedSettlements = await listAll(credential, 'settlement', from, to);
  const settlements: DiscoveredSettlement[] = [];
  if (listedSettlements.ok) {
    for (const object of listedSettlements.objects) {
      const id = readString(object, 'id');
      if (id === null) continue;
      settlements.push({
        razorpay_id: id,
        amount_paise: liveMoney(object, 'amount'),
        // `RAZORPAY_MONEY_FIELDS.settlement` reads `fee` then `fees`; mirror that order.
        fees_paise: liveMoney(object, 'fee') ?? liveMoney(object, 'fees'),
        tax_paise: liveMoney(object, 'tax'),
        status: readString(object, 'status'),
      });
    }
    notes.push(
      `discovered ${settlements.length} live Settlement(s). Razorpay exposes no create ` +
        `endpoint for a Settlement, so this list is whatever the settlement cycle has ` +
        `already produced; it is never seeded.`,
    );
  } else {
    notes.push(`could not list Settlements: ${listedSettlements.detail}`);
  }

  const reconLineEntityIds: string[] = [];
  const months = [addDays(to, -31), to];
  for (const month of months) {
    const year = String(month.getUTCFullYear());
    const monthNumber = String(month.getUTCMonth() + 1);
    const listed = await listAll(credential, 'settlement_recon_report', from, to, {
      year,
      month: monthNumber,
    });
    if (!listed.ok) {
      notes.push(`could not read the ${year}-${monthNumber} recon report: ${listed.detail}`);
      continue;
    }
    for (const line of listed.objects) {
      // `RAZORPAY_ID_FIELD.settlement_recon_report` is `entity_id`, not `id`.
      const entityId = readString(line, RAZORPAY_ID_FIELD.settlement_recon_report);
      if (entityId !== null) reconLineEntityIds.push(entityId);
    }
    notes.push(`read ${listed.objects.length} recon line(s) for ${year}-${monthNumber}`);
  }

  return { settlements, reconLineEntityIds, notes };
}

/* -------------------------------------------------------------------------- */
/* The credential write side of task 6.2's shape decision                      */
/* -------------------------------------------------------------------------- */

/**
 * The value a Tenant's `razorpay_test` credential is stored as: **`key_id:key_secret`**.
 *
 * `src/ingestion/razorpay-credential.ts` resolves the basic-auth pair by splitting the
 * sealed credential at its **first** `:`, and its doc comment names task 7.1 as the write
 * side of that decision. This function is that write side, and it is the only place the
 * joining happens, so the two halves of the contract are one grep apart.
 *
 * A Razorpay key id contains no colon, so the first-colon split is unambiguous. Both halves
 * stay inside one sealed AES-256-GCM envelope, so neither is readable without the
 * encryption key. The returned string is a plaintext credential: it is handed straight to
 * `putCredential`, which seals it, and it is never logged, returned to a caller, or stored
 * on an object.
 */
function referenceTenantCredentialValue(credential: RazorpayCredential): string {
  const keyId = credential.keyId.reveal();
  if (keyId.includes(':')) {
    // Would make the first-colon split lose part of the key id, and the failure would
    // surface much later as an unexplained credential rejection.
    throw new SeedInvariantError(
      'the Razorpay key id contains a colon, so the key_id:key_secret shape that ' +
        'src/ingestion/razorpay-credential.ts splits on is not usable for it. The value is ' +
        'not echoed.',
    );
  }
  return `${keyId}:${credential.keySecret.reveal()}`;
}

/**
 * Seal the reference Tenant's `key_id:key_secret` pair into `tenant_configuration`.
 *
 * Opt-in behind `--store-credential`, for two reasons worth stating rather than hiding.
 * First, it needs the **whole** platform environment — `getEnv()` validates Supabase, the
 * three model provider keys and `CREDENTIAL_ENCRYPTION_KEY` — so a Razorpay-only machine
 * can still seed. Second, `tenant_configuration` is `FORCE ROW LEVEL SECURITY` with no
 * policies until task 26.1, so the write only succeeds for a role that bypasses RLS.
 *
 * `permissionCheckDeferredToTask26_2` is passed because
 * FinanceOS_Authorization_Service does not exist yet; it is the grep-able placeholder that
 * module documents, not a silent opt-out.
 */
async function storeReferenceTenantCredential(
  credential: RazorpayCredential,
  tenantId: TenantId = DEMO_TENANT_ID,
): Promise<string> {
  const env = getEnv();
  const configuration: ConfigurationService = createConfigurationService({
    store: createSupabaseConfigurationStore(env),
    audit: createSupabaseAuditSink(env),
    requirePermission: permissionCheckDeferredToTask26_2,
    encryptionKey: env.CREDENTIAL_ENCRYPTION_KEY,
  });
  const masked = await configuration.putCredential(
    tenantId,
    'razorpay_test',
    referenceTenantCredentialValue(credential),
    SEED_ACTOR,
  );
  // A masked reference, by construction. There is no path here that could print a value.
  return masked.reference;
}

/* -------------------------------------------------------------------------- */
/* The projection self-check                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Push every Part B payload through the **real** `projectRazorpayObject` before the fixture
 * is written.
 *
 * This is the check that matters most about Part B. A synthetic payload that ingestion
 * cannot project is not fixture data, it is an `ingestion_errors` row: a missing
 * `entity_id`, a `created_at` that is not Unix seconds, a currency other than INR, or a
 * monetary field outside the `paise_ingested` domain all become recorded errors rather than
 * stored objects. Running the actual projection here means the fixture cannot ship in a
 * state where task 16.1 would ingest it into errors.
 *
 * @returns the identifier collisions found, which are a real finding rather than a failure.
 */
function selfCheckProjection(objects: readonly SeededObject[]): readonly string[] {
  const seen = new Map<string, IngestedObjectType>();
  const collisions: string[] = [];

  for (const object of objects) {
    let row;
    try {
      row = projectRazorpayObject({
        tenantId: DEMO_TENANT_ID,
        runId: SELF_CHECK_RUN_ID,
        objectType: object.object_type,
        object: object.payload,
        retrievedAt: new Date(0),
      });
    } catch (cause) {
      if (cause instanceof ObjectProjectionError) {
        throw new SeedInvariantError(
          `the synthetic ${object.object_type} '${object.razorpay_id}' does not project ` +
            `into a razorpay_objects row (${cause.code}): ${cause.message}. Ingestion would ` +
            `record it as an error instead of storing it.`,
        );
      }
      throw cause;
    }

    mustHold(
      row.razorpay_id === object.razorpay_id,
      `the declared identifier '${object.razorpay_id}' must equal the one ` +
        `RAZORPAY_ID_FIELD.${object.object_type} ('${RAZORPAY_ID_FIELD[object.object_type]}') ` +
        `extracts, which was '${row.razorpay_id}'`,
    );

    const previous = seen.get(object.razorpay_id);
    if (previous !== undefined && previous !== object.object_type) {
      collisions.push(`${object.razorpay_id} (${previous} and ${object.object_type})`);
    }
    seen.set(object.razorpay_id, object.object_type);
  }
  return collisions;
}

/* -------------------------------------------------------------------------- */
/* Fixture assembly                                                          */
/* -------------------------------------------------------------------------- */

/** The Part B anchor date read back from a previous fixture, so a re-run does not churn. */
function readPreviousAnchor(previous: unknown): string | null {
  if (typeof previous !== 'object' || previous === null) return null;
  const partB = (previous as Record<string, unknown>).part_b_synthetic;
  if (typeof partB !== 'object' || partB === null) return null;
  const anchor = (partB as Record<string, unknown>).anchor_date;
  return typeof anchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : null;
}

function buildSettlementBlock(spec: SettlementSpec, anchor: Date) {
  const outcome = reconcile(spec);
  assertSettlementInvariants(spec, outcome);
  const objects = buildSettlementObjects(spec, anchor);
  assertReconLinesNetToReceivedPlusResidual(spec, outcome, objects.reconReportLines);
  const settledAt = addDays(anchor, spec.dayOffset);

  return {
    display_name: spec.displayName,
    settlement_id: spec.settlementId,
    recon_report_id: spec.reconReportId,
    settlement_date: isoDate(settledAt),
    residual_class: spec.residualClass,
    commentary: spec.commentary,
    /**
     * The expected `settlement_reconciliations` row. Column names, so task 16.1 can compare
     * field by field. Every monetary value is a decimal string of integer paise.
     */
    expected_recon: {
      settlement_id: spec.settlementId,
      recon_report_id: spec.reconReportId,
      settlement_date: isoDate(settledAt),
      expected_paise: toWire(outcome.expected),
      received_paise: toWire(outcome.received),
      difference_paise: toWire(outcome.difference),
      fee_component_paise: toWire(outcome.fee),
      gst_component_paise: toWire(outcome.gst),
      residual_paise: toWire(outcome.residual),
      status: outcome.status,
      direction: outcome.direction,
      payments_counted: outcome.paymentsCounted,
      refunds_counted: outcome.refundsCounted,
      chargebacks_counted: outcome.chargebacksCounted,
      adjustments_counted: outcome.adjustmentsCounted,
      creates_exception: outcome.createsException,
      exception_category: outcome.createsException ? 'settlement_mismatch' : null,
      exception_impact_paise: outcome.impact === null ? null : toWire(outcome.impact),
    },
    /** design.md's `ReconReportLines`, ready to drive `expectedAmount` directly. */
    recon_report_lines: {
      payments: toWireList(spec.lines.payments),
      refunds: toWireList(spec.lines.refunds),
      chargebacks: toWireList(spec.lines.chargebacks),
      // Signed: negative is a debit adjustment (Requirement 4.2's signed sum).
      adjustments: toWireList(spec.lines.adjustments),
      fees: toWireList(spec.lines.fees),
      gst_on_fees: toWireList(spec.lines.gstOnFees),
    },
    /** The arithmetic, written out, so a reader can check it without running anything. */
    arithmetic: [
      `Sum(payments) = ${toWire(sum(spec.lines.payments))}`,
      `− Sum(refunds) ${toWire(sum(spec.lines.refunds))} = ` +
        `${toWire(sum(spec.lines.payments) - sum(spec.lines.refunds))}`,
      `− Sum(chargebacks) ${toWire(sum(spec.lines.chargebacks))} = ` +
        `${toWire(
          sum(spec.lines.payments) - sum(spec.lines.refunds) - sum(spec.lines.chargebacks),
        )}`,
      `+ signed Sum(adjustments) ${toWire(sum(spec.lines.adjustments))} = ` +
        `${toWire(outcome.expected)}  (Expected Amount, Requirement 4.2)`,
      `− received ${toWire(outcome.received)} = ${toWire(outcome.difference)}  (Difference)`,
      `− Sum(fees) ${toWire(outcome.fee)} = ${toWire(outcome.difference - outcome.fee)}`,
      `− Sum(gst_on_fees) ${toWire(outcome.gst)} = ${toWire(outcome.residual)}  (residual)`,
      `check: ${toWire(outcome.fee)} + ${toWire(outcome.gst)} + ${toWire(outcome.residual)} ` +
        `= ${toWire(outcome.difference)}  (difference_decomposes_exactly)`,
    ],
    objects: {
      settlement: objects.settlement,
      orders: objects.orders,
      payments: objects.payments,
      refunds: objects.refunds,
      recon_report_lines: objects.reconReportLines,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

const WINDOW_DAYS = 365;

async function main(): Promise<void> {
  const storeCredential = process.argv.includes('--store-credential');

  say('FinanceOS — Razorpay test-mode seeding (task 7.1)');
  say('');

  // --- read the previous fixture, which is half of the idempotency mechanism -------
  let previous: unknown = null;
  try {
    previous = JSON.parse(await readFile(FIXTURE_PATH, 'utf8')) as unknown;
    say(`found an existing fixture at test/fixtures/razorpay-seed.json; reusing its anchor`);
  } catch {
    say('no existing fixture; this is a first run');
  }

  // --- Part B: deterministic, and it runs unconditionally ---------------------------
  // Normalised to UTC midnight, not just to a date string. The payload mirrors carry
  // `created_at` as Unix seconds derived from this instant, so an anchor holding the
  // first run's time-of-day would make the second run — which parses the date back from
  // the fixture — differ by that many seconds. Midnight makes the first run and every
  // later run produce the same bytes.
  const previousAnchor = readPreviousAnchor(previous);
  const anchorDate = previousAnchor ?? isoDate(addDays(new Date(), -30));
  const anchor = new Date(`${anchorDate}T00:00:00Z`);

  const settlementBlocks = SETTLEMENT_SPECS.map((spec) => buildSettlementBlock(spec, anchor));
  assertBothResidualShapesPresent(SETTLEMENT_SPECS.map((spec) => reconcile(spec)));
  const routeBlock = buildRouteBlock(anchor);

  const syntheticObjects: SeededObject[] = [
    ...settlementBlocks.flatMap((block) => [
      block.objects.settlement,
      ...block.objects.orders,
      ...block.objects.payments,
      ...block.objects.refunds,
      ...block.objects.recon_report_lines,
    ]),
    ...routeBlock.linked_accounts,
    ...routeBlock.settlements_received,
    ...routeBlock.transfers,
    ...routeBlock.transfer_reversals,
  ];
  const collisions = selfCheckProjection(syntheticObjects);

  say('');
  say('Part B (synthetic — Razorpay has no create endpoint for these):');
  for (const block of settlementBlocks) {
    const recon = block.expected_recon;
    say(
      `  ${block.display_name} ${block.settlement_id}  expected ${recon.expected_paise}  ` +
        `received ${recon.received_paise}  difference ${recon.difference_paise}`,
    );
    say(
      `    fee ${recon.fee_component_paise} + gst ${recon.gst_component_paise} + residual ` +
        `${recon.residual_paise} = ${recon.difference_paise}  → ${recon.status}` +
        `${recon.creates_exception ? `, ${recon.exception_category} impact ${recon.exception_impact_paise} (${recon.direction})` : ', no Exception'}`,
    );
  }
  say(
    `  Route: ${routeBlock.linked_accounts.length} Linked_Accounts, ` +
      `${routeBlock.transfers.length} Transfers, ` +
      `${routeBlock.transfer_reversals.length} Transfer_Reversals`,
  );
  say(
    `    pending ${routeBlock.expected.zero_settlement.pending_amount_paise}; on hold ` +
      `${routeBlock.expected.on_hold.amount_paise}; over-allocation impact ` +
      `${routeBlock.expected.over_allocated_split.exception_impact_paise}`,
  );
  say(`  ${syntheticObjects.length} synthetic objects, all projecting into razorpay_objects`);
  say(`  anchor date ${anchorDate}`);

  // --- Part A: live, and it needs a credential --------------------------------------
  const to = new Date();
  const from = addDays(to, -WINDOW_DAYS);
  const { credential, missing } = readRazorpayCredential();

  let partA: Record<string, unknown>;
  if (credential === null) {
    say('');
    say('Part A (live) SKIPPED — these environment variables are not set:');
    for (const name of missing) {
      say(`  - ${name}`);
    }
    say('  Copy .env.example to .env.local and fill them in, then re-run. Part B is written');
    say('  regardless, so tasks 7.2, 11.3 and 16.1 are not blocked on a credential.');
    partA = {
      status: 'skipped_missing_credentials',
      missing_environment_variables: missing,
      note:
        'No Razorpay credential was available, so nothing was created and nothing was ' +
        'discovered. Every identifier in this file is therefore synthetic and lives in ' +
        'part_b_synthetic. No real-looking Razorpay identifier was fabricated for Part A.',
      orders: [],
      refunds: [],
      payments_discovered: [],
      settlements_discovered: [],
      recon_line_entity_ids_discovered: [],
      log: [],
    };
  } else {
    say('');
    say('Part A (live) — creating Orders and Refunds, discovering the rest');
    const log: string[] = [];

    const orders = await seedOrders(credential, from, to);
    log.push(...orders.notes);

    const listedPayments = await listAll(credential, 'payment', from, to);
    const payments = listedPayments.ok ? listedPayments.objects : [];
    log.push(
      listedPayments.ok
        ? `discovered ${payments.length} Payment(s). A Payment cannot be created through ` +
            `the Razorpay API, so these were not seeded.`
        : `could not list Payments: ${listedPayments.detail}`,
    );

    const refunds = await seedRefund(credential, payments, from, to);
    log.push(...refunds.notes);

    const discovered = await discoverSettlementData(credential, from, to);
    log.push(...discovered.notes);

    for (const line of log) {
      say(`  ${line}`);
    }

    partA = {
      status: 'seeded',
      missing_environment_variables: [],
      note:
        'Every identifier in this block came back from the Razorpay test-mode API. Orders ' +
        'and Refunds were created; Payments, Settlements and recon report lines were only ' +
        'discovered, because Razorpay exposes no create endpoint for them.',
      orders: orders.records,
      refunds: refunds.records,
      payments_discovered: payments
        .map((payment) => ({
          razorpay_id: readString(payment, 'id'),
          amount_paise: liveMoney(payment, 'amount'),
          status: readString(payment, 'status'),
        }))
        .filter((entry) => entry.razorpay_id !== null),
      settlements_discovered: discovered.settlements,
      recon_line_entity_ids_discovered: discovered.reconLineEntityIds,
      log,
    };

    if (storeCredential) {
      try {
        const reference = await storeReferenceTenantCredential(credential);
        say(`  stored the reference Tenant credential as key_id:key_secret → ${reference}`);
        partA = { ...partA, credential_stored: { tenant_id: DEMO_TENANT_ID, reference } };
      } catch (cause) {
        const detail = redact(cause instanceof Error ? cause.message : String(cause));
        say(`  credential NOT stored: ${detail}`);
        partA = { ...partA, credential_stored: null, credential_store_error: detail };
      }
    } else {
      partA = {
        ...partA,
        credential_stored: null,
        credential_store_note:
          'Pass --store-credential to seal the reference Tenant credential as ' +
          "'key_id:key_secret' (the shape src/ingestion/razorpay-credential.ts splits on). " +
          'It is opt-in because it needs the whole platform environment and a role that ' +
          'bypasses the RLS still pending on tenant_configuration until task 26.1.',
      };
    }
  }

  const fixture = {
    schema_version: FIXTURE_SCHEMA_VERSION,
    produced_by: 'scripts/seed-razorpay-testmode.ts (tasks 7.1 and 19.8)',
    requirements: ['1.1', '4.4', '4.5', '7.1', '7.7', '7.8', '7.9'],
    read_this_first:
      'This file has two halves and they are not the same kind of data. part_a_live holds ' +
      'identifiers that came back from the Razorpay test-mode API. part_b_synthetic holds ' +
      'records built locally for deterministic Settlement and Razorpay Route scenarios. ' +
      'Never treat a part_b_synthetic record as retrieved.',
    money_encoding: {
      rule:
        'Every monetary value in this file is a decimal string of integer paise — ' +
        '"84260000", never 84260000. JSON has no bigint and a JSON numeric literal parses ' +
        'to an IEEE-754 double, which must never hold a monetary value (design.md ' +
        'structural decision 6, Requirement 15.1, 15.8).',
      payload_departure:
        'This applies inside the payload mirrors too, which is the one place a mirror ' +
        'departs from Razorpay\'s own bytes: Razorpay sends a JSON number. The departure is ' +
        'safe because toIngestedPaise has an explicit digit-string branch that goes ' +
        'straight to BigInt with no Number and no parseInt. Field names, nesting and every ' +
        'non-monetary type mirror Razorpay exactly.',
      non_monetary:
        'created_at and settled_at are Unix seconds and stay JSON numbers, because that is ' +
        'what extractCreatedAt reads. Counts (attempts, *_counted) are counts, not money.',
    },
    razorpay_test_mode_capabilities: {
      creatable_via_api: {
        order: 'POST /v1/orders',
        refund: 'POST /v1/payments/{id}/refund, and only against a captured Payment',
      },
      not_creatable_via_api: {
        payment:
          'A Payment is produced by Checkout, or by an S2S endpoint that needs per-account ' +
          'activation. There is no general create-payment API.',
        settlement:
          'The Settlement API is read-only: fetch all, fetch by id, fetch recon report. ' +
          'Settlements are produced by Razorpay\'s settlement cycle, and test mode may hold ' +
          'none. POST /v1/settlements/ondemand creates an Instant Settlement, which is a ' +
          'different entity (setlod_…, its own status vocabulary), needs the feature enabled ' +
          'and a real available balance, and still yields no controllable recon report.',
        settlement_recon_report:
          'Read-only, and addressed by year and month rather than by a from/to window.',
      },
    },
    part_a_live: partA,
    part_b_synthetic: {
      status: 'synthetic',
      warning:
        'NOT RETRIEVED FROM RAZORPAY. Built locally by tasks 7.1 and 19.8. Every record ' +
        'carries _financeos_synthetic: true and _financeos_synthetic_note. Task 6.5 must ' +
        'confirm these shapes against live test mode.',
      anchor_date: anchorDate,
      anchor_note:
        'Part B is deterministic given this date, and this date is read back from the ' +
        'previous fixture, so a second run writes a byte-identical file. Delete the file to ' +
        're-anchor it to 30 days before today.',
      tenant_id: DEMO_TENANT_ID,
      confirm_in_task_6_5: [
        'settlement_recon_report line fields: entity_id, type, debit, credit, amount, fee, ' +
          'tax, settled, settled_at, settlement_id, settlement_utr, credit_type',
        'whether a chargeback arrives as type "dispute" or as an adjustment line',
        'whether the settlement object reports its fee as "fee" or "fees"',
        'that live payloads send monetary fields as JSON numbers, so ingestion exercises ' +
          'toIngestedPaise\'s number branch rather than its digit-string branch',
        'linked_account fields: id, entity, status, profile, legal_business_name, created_at',
        'transfer fields: source, recipient, amount_reversed, on_hold, on_hold_until, ' +
          'recipient_settlement_id and settlement_status',
        'transfer reversal fields: entity, transfer_id, amount, fees, tax and created_at',
      ],
      settlements: settlementBlocks,
      route: routeBlock,
      /** Every synthetic object flat, ready to insert or to feed a fake transport. */
      objects_flat: syntheticObjects,
      known_findings: [
        {
          id: 'recon-line-identifier-collision',
          severity: 'blocks a naive task 16.1 assertion',
          finding:
            'A combined recon report line keys on entity_id, and entity_id is the ' +
            'identifier of the settled entity itself — the Payment or Refund the line ' +
            'describes. So a recon line and its Payment contend for the same ' +
            '(tenant_id, razorpay_id) row under razorpay_objects_tenant_rzp_uniq. This is ' +
            'the finding already recorded in src/ingestion/ingestion-service.ts under ' +
            'IDENTIFIER_COLLIDES_WITH_OTHER_TYPE. The fixture reproduces it deliberately ' +
            'rather than fabricating collision-free entity_ids, which would hide a real ' +
            'defect from the test meant to catch it.',
          colliding_identifiers: collisions,
          consequence:
            'Ingesting objects_flat as-is stores the first of each colliding pair and ' +
            'records the second as an IDENTIFIER_COLLIDES_WITH_OTHER_TYPE error, so the run ' +
            'is partially_completed rather than completed.',
          workaround:
            'Every recon line payload also carries _financeos_composite_id, ' +
            '"<settlement_id>:<entity_id>", which is the identifier a ' +
            '(tenant_id, object_type, razorpay_id) key or a settlement-scoped composite ' +
            'would use. Choosing between those needs a migration, which task 7.1 does not own.',
        },
        {
          id: 'gst-is-not-exactly-18-percent-of-fee',
          severity: 'informational',
          finding:
            'design.md\'s SET-9281 totals are fee 1966100 and GST 353900, and 1966100 x 18% ' +
            'is 353898. The 2-paise gap is design.md\'s. The fixture carries design.md\'s ' +
            'totals unchanged and concentrates the gap on one GST line rather than adjusting ' +
            'a total to make the per-line rate come out even.',
        },
        {
          id: 'no-razorpay-write-transport',
          severity: 'reported, not worked around',
          finding:
            'RazorpayClient exposes fetchPages only. The two POSTs Part A needs are made by ' +
            'a narrow helper inside the seeding script. A RazorpayClient.post sharing the ' +
            '30 s timeout, the 1/2/4/8/16 s retry schedule and the four-way classification ' +
            'belongs in src/ingestion/razorpay-client.ts, and task 9.x\'s ' +
            'initiate_payment_retry will need it as well.',
        },
      ],
    },
  };

  await mkdir(dirname(FIXTURE_PATH), { recursive: true });
  await writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');

  say('');
  if (collisions.length > 0) {
    say(
      `${collisions.length} identifier collision(s) between recon lines and their entities ` +
        `(expected; see known_findings): ${collisions.join(', ')}`,
    );
  }
  say(`wrote test/fixtures/razorpay-seed.json`);
}

await main();
