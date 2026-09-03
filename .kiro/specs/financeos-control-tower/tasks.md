# Implementation Plan: FinanceOS Control Tower

## Overview

The task order follows the **MVP Build Order** section of design.md exactly, not requirement number order. Five slices, each ending in a property-gate checkpoint that blocks the next slice:

- **Slice 1 — the centerpiece.** Requirement 1 (ingestion), Requirement 2 (Semantic Ledger), Requirement 4 (Reconciliation_Agent settlement lifecycle), Requirement 12 (Financial_Tool_Layer and Evidence_Chains), Requirement 3 (Control_Tower), Requirement 15 (accuracy invariants). **No AI or Model dependency anywhere in this slice.** Gate: P1, P2, P3, P5, P6, P10, P11, P12, P13.
- **Slice 2 — the differentiator.** Requirement 7 (Razorpay_Route seller payout reconciliation, owned by the Reconciliation_Agent identity), Requirement 16.5–16.6. Gate: P4 passes, P1 and P5 still pass over Route-bearing datasets.
- **Slice 3 — the safety spine.** Requirement 5 (Policy_Engine, approval, verification), Requirement 13 (audit chain), Requirement 14 (multi-tenancy). Gate: P7, P8, P9, P14.
- **Slice 4 — breadth.** The Python runtime lands at the head of this slice — project and test stack, the money wire helpers, the transport schemas, P15, the three internal endpoints — then the Agent Engine, then Requirement 11 (AI_Gateway) because it unblocks the rest, then Requirement 6 (India_Compliance_Agent), Requirement 8 (Cash_Agent), Requirement 9 (Finance_Analyst recovery capability), Requirement 10 (Finance_Analyst period explanation capability). Gate: P15 passes in both directions, the validator adversarial suite passes in full under pytest, and all fifteen properties P1 through P15 still pass.
- **Slice 5 — closure.** Requirement 16 (the closed four-identity Agent_Catalogue enforced at three points), Requirement 17 (Secret_Safety_Gate and Provider_Runtime_Verifier), Requirement 18 (Winning_Demo continuity through verified cash impact). Gate: the full CI ordering, stages 0 through 15, with stage 0 secret scanning ahead of the compiler.

**Why Slice 5 exists as a slice rather than as edits inside Slices 1 through 4.** design.md places catalogue closure and the Secret_Safety_Gate in Slice 1 as cross-cutting work and the Provider_Runtime_Verifier in Slice 4, and it places the demo's propose-authorize-execute-verify half in Slice 3. Slices 1 through 4 have already shipped, so folding this work back into them would mean reopening completed tasks and renumbering everything after them. Appending it as Slice 5 keeps the completed numbering stable and keeps each new task traceable to the design section that specifies it. The ordering rationale design.md gives still holds inside the slice: catalogue closure and secret scanning come first because both are cheap now and expensive later — a fifth identity that has already reached a run row, an Audit_Event and a UI label is a data migration, and a secret scanner added after a key has reached a published artifact starts with a rotation rather than a scan.

Stack: two runtimes, split on one line — money arithmetic and database writes in TypeScript, Model interaction and agent reasoning in Python. **Next.js with TypeScript** owns the dashboard, the API, ingestion, the Semantic_Ledger, the Calculation_Service, the Financial_Tool_Layer, the Policy_Engine, the Action_Service, the Audit_Service, the Configuration_Service, the Authorization_Service, the Secret_Safety_Gate, and the credential-resolution and result-persistence halves of the Provider_Runtime_Verifier, tested with Vitest, fast-check, ESLint and `tsc --noEmit`, with Zod for tool and transport schemas. **Python** owns the Agent Engine, the four Agents' production homes, the AI_Gateway with its OpenRouter, Gemini and Groq adapters, FinanceOS_Response_Validator, and the probe-execution half of the Provider_Runtime_Verifier, tested with pytest, Hypothesis, `ruff` and `mypy`. Supabase (Postgres, Auth, RLS, Realtime, Storage) is the data layer and only TypeScript connects to it. Razorpay test-mode APIs supply the integration fixture. OpenRouter, Gemini and Groq sit behind a pluggable adapter protocol so a provider is swappable without touching routing.

**The Agent_Catalogue is closed at exactly four identities** — Finance_Analyst, Reconciliation_Agent, India_Compliance_Agent, Cash_Agent. Razorpay_Route seller payout reconciliation is a Reconciliation_Agent capability and Failed_Payment recovery is a Finance_Analyst capability, so tasks 19.x and 35.x add capability to an existing identity rather than adding an identity. Directory names under `src/agents/` are a code-organisation decision and are left as they are: design.md states capability ownership is an identity decision, not a code-organisation one.

**Slice 1 is entirely TypeScript.** It has no Model dependency, so it has no Python dependency either: the Reconciliation_Agent's Slice 1 work is DETECT and INVESTIGATE only and ships as a TypeScript-side driver over the Financial_Tool_Layer, called in-process. The Python runtime does not exist until the head of Slice 4.

Within each slice, items design.md marks **thin-sliceable** are placed as later sub-tasks so they never block the slice.

## Tasks

---

## Slice 1 — the centerpiece (Requirements 1, 2, 3, 4, 12, 15)

- [x] 1. Project scaffolding and the money type discipline
  - [x] 1.1 Initialize the Next.js TypeScript project and test toolchain
    - Create the Next.js app with `package.json` and `tsconfig.json` set to `strict: true` and `target: ES2020` or later so `bigint` literals compile
    - Install and configure Vitest (`vitest.config.ts`), fast-check, ESLint, Zod, `@supabase/supabase-js`
    - Create the source tree: `src/calc/`, `src/format/`, `src/wire/`, `src/db/`, `src/ingestion/`, `src/ledger/`, `src/evidence/`, `src/tools/`, `src/agents/` (the Slice 1 TypeScript agent drivers), `src/policy/`, `src/action/`, `src/audit/`, `src/authz/`, `src/config/`, `src/app/` (Next.js routes and UI), `test/fixtures/`, `test/property/`, `test/transport/`, `supabase/migrations/`
    - There is no `src/ai/` in the TypeScript tree: the AI_Gateway and FinanceOS_Response_Validator are Python and arrive with the Python runtime in Slice 4
    - Add npm scripts named for the CI stages in design.md: `typecheck` (`tsc --noEmit`), `lint` (ESLint), `test:unit`, `test:db`, `test:contract`, `test:transport`, `test:property`, `test:e2e`
    - _Requirements: 15.1, 15.8_

  - [x] 1.2 Create the money type module and the no-`number`-money guard
    - Create `src/calc/paise.ts` exporting `type Paise = bigint`, the range constants `-99999999999999n .. 99999999999999n`, the ingested range `0n .. 999999999999n`, and `isPaise`/`assertPaise` type guards
    - Add an ESLint rule configuration that fails on `number`-typed identifiers or parameters whose name matches `/paise|amount|impact|balance|cash|fee|gst|shortfall|headroom/i` in `src/calc/`, `src/ledger/`, `src/tools/`, `src/agents/`, `src/wire/`
    - Add a compile-time guard test asserting a `number` passed to a `Paise` parameter is a type error
    - Create `src/wire/paise-wire.ts` with `type PaiseWire = string`, `toWire(v: Paise): PaiseWire` which calls `calc.assertInRange(v)` then `v.toString()`, and `fromWire(s: PaiseWire): Paise` which validates `/^-?[0-9]+$/` and throws a `WireError` naming the field on failure, then `BigInt(s)`, then `calc.assertInRange`; plus the range-free `encodePaise` / `decodePaise` pair that performs the same integer-string encoding and decoding with no range check, which is the pair P15's above-2^53 case exercises
    - The module exists from Slice 1 even though nothing crosses the runtime boundary until Slice 4, because the transport schemas and P15 build on it and because `toWire` must be the only sanctioned way a `Paise` leaves the TypeScript process from the first boundary onward
    - _Requirements: 15.1, 15.8_

  - [x] 1.3 Environment and secret loading, Supabase client factories
    - Create `src/config/env.ts` loading Supabase URL/keys, Razorpay test-mode key id and secret, and the Groq, Gemini and OpenRouter keys from environment/secret configuration, with a Zod schema that fails fast on a missing or malformed value
    - Create `src/db/clients.ts` with three factories: an authenticated tenant-scoped client carrying the session JWT, a service client for server-only paths, and a **read-only client whose role holds no write grants** for `read_only` tools
    - Never log, echo, or serialize a credential value; expose only masked references
    - _Requirements: 12.7, 14.5_

- [x] 2. FinanceOS_Calculation_Service — built and property-tested before any other code that computes money
  - [x] 2.1 Implement the calculation service
    - Create `src/calc/calculation-service.ts` with `add`, `subtract`, `sum`, `applyRate(value, rateBasisPoints)`, `roundHalfUpToPaisa(numerator, denominator)`, `assertInRange`
    - Pure, synchronous, `bigint` only; every operand, intermediate, and result checked against the paise range, raising rather than wrapping or saturating
    - `applyRate` and `roundHalfUpToPaisa` return `{ result, rounding_adjustment_paise }` so the adjustment is reported with the result
    - _Requirements: 15.1, 15.8, 15.9_

  - [x] 2.2 Write property test for integer-only monetary arithmetic
    - **Property 12: Integer-only monetary arithmetic**
    - `numRuns: 1000`; generators per design.md: paise operand arrays, `arbitraryOperationSequence`, rate basis points `0n..300000n`, deliberately overflowing operand pairs, and value/rate pairs whose exact product is a half paisa
    - Assert `typeof result === 'bigint'`, in-range, overflow raises, and `applyRate(v, r).result * 10000n + adjustmentNumerator === v * r`
    - **Validates: Requirements 1.7, 8.2, 10.6, 11.8, 15.1, 15.8, 15.9**
    - _Properties: P12_

  - [x]* 2.3 Write unit tests for calculation boundaries
    - `0n`, `±1n`, both range extremes, one paisa beyond each extreme, and rate products that are exactly a half paisa
    - _Requirements: 15.1, 15.9_

- [x] 3. Indian number formatting and IST timestamps
  - [x] 3.1 Implement the formatters
    - Create `src/format/inr.ts` with `formatInr(p)` (2,2,3 grouping from the right, `₹` prefix, always 2 decimal places), `parseInr(text)`, `secondaryUnit(p)` returning the lakh band at `>= 1,00,000` and `< 1,00,00,000` and the crore band at `>= 1,00,00,000`, and `twoDecimalsFromRatio` with half-up rounding on `bigint`
    - Create `src/format/ist.ts` rendering a timestamp in Indian Standard Time to whole-second precision
    - Integer `bigint` division only; no float anywhere in the path
    - _Requirements: 3.2, 3.3, 3.10, 3.11, 15.2_

  - [x] 3.2 Write property test for Indian number format round-trip
    - **Property 11: Indian number format round-trip**
    - `numRuns: 1000`; `fc.bigInt({ min: -99999999999999n, max: 99999999999999n })` biased with the boundary constants from design.md
    - Assert `parseInr(formatInr(p)) === p`, the grouping regex, the independently computed secondary unit band, and exactly 2 decimal places on lakh/crore text
    - **Validates: Requirements 3.2, 3.3, 3.11, 15.2**
    - _Properties: P11_

  - [x]* 3.3 Write unit tests for formatter boundaries
    - `₹0.00`, `₹1.00`, `₹99,999.99` (no secondary unit), `₹1,00,000.00` (lakh opens), `₹99,99,999.99`, `₹1,00,00,000.00` (crore opens), negatives, both extremes, and IST whole-second rendering
    - _Requirements: 3.2, 3.3, 3.10, 3.11_

- [x] 4. Supabase migrations, one per schema group, implementing the DDL in design.md's Data Models section
  - [x] 4.1 Migration: money domains, session functions, tenancy, configuration
    - `CREATE DOMAIN paise`, `paise_ingested`, `paise_positive` with their range CHECKs
    - `CREATE SCHEMA app` with `app.current_tenant_id()` and `app.current_user_id()` reading the Supabase Auth JWT claims and returning `NULL` when absent
    - Tables `tenants`, `users`, `tenant_memberships`, the `permission` enum, `user_permissions`, and `tenant_configuration` with every configuration column nullable plus the encrypted credential columns
    - _Requirements: 14.1, 14.5, 14.6, 15.1, 15.8_

  - [x] 4.2 Migration: ingestion schema group
    - Enums `ingestion_status`, `razorpay_object_type`; tables `ingestion_runs` (with `window_from`, `window_basis`, `per_type_stored`, the two CHECKs), `ingestion_errors`, `razorpay_objects` with `payload JSONB NOT NULL`, the projected `*_paise` columns on `paise_ingested`, the `currency = 'INR'` CHECK, and `razorpay_objects_tenant_rzp_uniq`
    - Indexes `razorpay_objects_tenant_type_created_idx`, `razorpay_payment_settlement_link_idx`, `razorpay_recon_report_settlement_idx`, `razorpay_refund_payment_idx`
    - _Requirements: 1.2, 1.3, 1.6, 1.7_

  - [x] 4.3 Migration: Semantic Ledger schema group with the deferred balance trigger
    - `account_kind` and `source_record_type` enums, `chart_of_accounts`, `ledger_entry_sets` (with `ledger_set_balanced`, `ledger_set_totals_positive`, `ledger_set_derivation_uniq`, `entry_count BETWEEN 2 AND 20`), `entry_side`, `ledger_entries` on `paise_positive`, `ledger_entry_sources`
    - `assert_ledger_set_balanced()` plus the `DEFERRABLE INITIALLY DEFERRED` constraint trigger `ledger_entries_balance_check`
    - Indexes `ledger_entry_sources_lookup_idx`, `ledger_entries_account_date_idx`, `ledger_entry_sets_derivation_idx`
    - _Requirements: 2.1, 2.2, 2.5, 2.6, 2.7, 2.8_

  - [x] 4.4 Migration: audit log storage and the append-only barriers
    - `audit_events`, `audit_sequence_counters`, and `app.append_audit_event(...)` exactly as written in design.md, including the 65536-byte payload reduction and the SHA-256 `chain_value` over the canonical field join with `prev_chain_value`
    - `REVOKE UPDATE, DELETE, TRUNCATE` on `ledger_entries` and `audit_events` from every application role, `GRANT SELECT, INSERT`, plus `reject_mutation_and_audit()` and the two `BEFORE UPDATE OR DELETE` triggers
    - Indexes `audit_events_sequence_idx`, `audit_events_source_refs_idx` (GIN), `audit_events_proposal_idx`
    - This is the storage layer only; AuditService history, the verification walk, and P9 land in Slice 3. It ships in Slice 1 because the ledger append-only barrier depends on it
    - _Requirements: 2.7, 13.1, 13.3, 13.4, 13.5_

  - [x] 4.5 Migration: exceptions schema group
    - `exception_category` enum with all 14 categories, `exception_state`, `exceptions` with `impact_paise >= 0`, `direction`, the two lifecycle CHECKs and `exceptions_fingerprint_uniq`, plus `exception_source_records`
    - Indexes `exceptions_attention_panel_idx` (partial on open, `INCLUDE (impact_paise)`), `exceptions_drilldown_idx`, `exception_source_records_lookup_idx`
    - _Requirements: 3.5, 3.6, 4.12, 4.15_

  - [x] 4.6 Migration: evidence chain schema group
    - `evidence_chains` (`figure_paise`, `source_count >= 1`, `as_of`, `produced_by`), `evidence_operation` enum, `evidence_chain_steps` (1-based `step_index`, `operands JSONB`, nullable `result_paise`), `evidence_chain_sources` with `record_updated_at`
    - Index `evidence_chain_sources_idx`
    - _Requirements: 12.2, 12.5, 12.8_

  - [x] 4.7 Migration: settlement reconciliation results
    - `recon_status` enum and `settlement_reconciliations` with `settlement_recon_uniq`, `unreconciled_has_no_figures`, `difference_decomposes_exactly`, and `explained_iff_zero_residual`
    - Indexes `settlement_recon_tenant_date_idx` and the partial `settlement_recon_open_residual_idx`
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.13_

  - [x] 4.8 Write database tests against Supabase local with migrations applied
    - Run as the application role, not the owner
    - Domain range enforcement at `±99999999999999` accepted and one paisa beyond rejected, on a representative column of each domain
    - Ledger balance: declared totals mismatched rejected immediately; declared totals agreeing but entries disagreeing rejected at commit by the deferred trigger, with zero entries persisted in both cases
    - Append-only: `UPDATE` and `DELETE` on `ledger_entries` and `audit_events` both fail, the targeted row is unchanged field by field, and a `mutation_rejected` Audit_Event was appended
    - Idempotency constraints: `razorpay_objects_tenant_rzp_uniq`, `ledger_set_derivation_uniq`, `exceptions_fingerprint_uniq`, `audit_events_sequence_uniq` each reject a duplicate
    - Schema type audit: query `information_schema.columns` and assert no `_paise` column has a type other than `bigint` and no `numeric`, `real`, `double precision`, or `money` column holds a monetary value
    - _Requirements: 1.3, 2.1, 2.6, 2.7, 2.8, 4.15, 13.1, 13.5, 15.8_
    - _Properties: P12_

- [x] 5. FinanceOS_Configuration_Service
  - [x] 5.1 Implement configuration and encrypted credential storage
    - Create `src/config/configuration-service.ts` with `get`, `put`, `putCredential`, `readCredentialForServerUse`
    - Apply every documented default and range from design.md when a column is unset, so an unconfigured Tenant behaves as specified without a migration writing defaults
    - Encrypt credential values at rest, return only masked references, exclude values from API responses, logs, and error messages, and append an Audit_Event on store or replace without the value
    - _Requirements: 5.15, 6.11, 8.14, 9.5, 9.6, 9.11, 10.4, 11.5, 11.13, 13.9, 14.5_

  - [x]* 5.2 Write unit tests for defaults, ranges, and credential masking
    - One test per configured value asserting the default when unset and rejection outside range; assert a stored credential never appears in a returned object or thrown error
    - _Requirements: 6.11, 14.5_

- [x] 6. FinanceOS_Ingestion_Service (Requirement 1)
  - [x] 6.1 Implement the Razorpay test-mode HTTP client
    - Create `src/ingestion/razorpay-client.ts`: paged retrieval of 100 records per object type, stopping when a page returns fewer than 100; 30-second per-request timeout
    - Retry rate-limit and timeout responses at 1 s, 2 s, 4 s, 8 s, 16 s to a maximum of 5 retries, then record the request as an error for its object type
    - Classify responses into `rate_limit`, `timeout`, `provider_error`, `credential_rejected` (401/403)
    - _Requirements: 1.1, 1.4, 1.5, 1.10_

  - [x] 6.2 Implement the ingestion run
    - Create `src/ingestion/ingestion-service.ts` with `startRun`, `fetchPages`, `upsertObject`
    - Retrieve all nine object types; store the Razorpay id, object type, tenant id, run id, retrieval timestamp, and **unmodified payload**; upsert on `(tenant_id, razorpay_id)` replacing payload and refreshing `retrieved_at`
    - Store every monetary value as integer paise in `0..999999999999` with no rounding, truncation, or unit scaling, currency `INR`
    - Non-credential errors recorded and ingestion continues with the remaining types; credential rejection aborts the run, stores zero objects, and leaves prior objects untouched
    - Run completion records end timestamp, per-type stored counts, per-type error counts, and the status mapping `completed` / `partially_completed` / `failed`
    - First-run window: the 365 days preceding the run start
    - Publish run state changes over Supabase Realtime for the Control_Tower
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.10_

  - [x] 6.3 Write property test for ingestion idempotency
    - **Property 10: Ingestion idempotency**
    - `arbitraryRazorpayObjectSet` across all ten object types with identifiers drawn from a small pool so duplicates are common, payloads including nested objects, unicode strings, and empty arrays; second pass mutates a random payload subset
    - Assert one row per `(tenant_id, razorpay_id)`, stored payload deep-equal to the most recently retrieved payload, and `retrieved_at` non-decreasing
    - **Validates: Requirements 1.2, 1.3**
    - _Properties: P10_

  - [x]* 6.4 Write unit tests for the ingestion status mapping
    - The full `(records stored, errors)` table including 0 stored with 0 errors
    - _Requirements: 1.6_

  - [x]* 6.5 Write Razorpay test-mode integration tests
    - Paging past 100 objects of one type; forced rate limit asserting the 1/2/4/8/16 s sequence and the 5-retry ceiling; deliberately invalid key asserting `failed` with `credential_rejected`, zero objects stored for the run, and prior objects unchanged; forced single-type error asserting other types still store and the run is `partially_completed`
    - Assert the credential value appears in no response body, log line, or error message
    - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.10, 14.5_

  - [x] 6.6 Add incremental window selection (design.md marks this thin-sliceable)
    - Restrict retrieval to objects created at or after the start timestamp of the most recent `completed` run, recording `window_basis = 'incremental'`
    - _Requirements: 1.9_

- [x] 7. Razorpay test-mode fixture data for the demo path
  - [x] 7.1 Write the Razorpay test-mode seeding script
    - Create `scripts/seed-razorpay-testmode.ts` that creates orders, payments, refunds and settlement-bearing data in Razorpay test mode, producing **at least one Settlement whose recon report leaves a non-zero unexplained residual** and **one Settlement in the SET-9281 shape whose residual is exactly zero**
    - Idempotent and re-runnable; writes the created identifiers to `test/fixtures/razorpay-seed.json` for the e2e test to consume
    - _Requirements: 1.1, 4.4, 4.5_

  - [x] 7.2 Create the SET-9281 worked-example fixture module
    - Create `test/fixtures/set-9281.ts` holding the exact paise values from design.md: expected `84260000n`, received `81940000n`, difference `2320000n`, fee `1966100n`, GST `353900n`, residual `0n`, plus the ₹19,000 fee variant whose residual is `66100n`
    - Include the expected twelve-step Evidence_Chain step sequence (`sum(payments)`, `sum(refunds)`, `subtract`, `sum(chargebacks)`, `subtract`, `sum(adjustments)`, `add`, `subtract(received)`, `sum(fees)`, `sum(gst_on_fees)`, `subtract`, `subtract`) as replay input
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 12.8_

- [x] 8. Semantic_Ledger (Requirement 2)
  - [x] 8.1 Implement the double-entry posting rules
    - Create `src/ledger/posting-rules.ts` with the Payment table (debit `settlement_pending` `N`, debit `razorpay_fee_expense` `F`, debit `gst_input_credit` `G`, credit `revenue` `A`, where `N = A − F − G`), the Refund table (designations opposite to the Payment set), and the Settlement table (debit `bank`, credit `settlement_pending`)
    - Omit zero-amount entries rather than posting them, since `paise_positive` requires `> 0`
    - Seed the default chart of accounts for a Tenant
    - _Requirements: 2.1, 2.2, 2.3, 2.9, 2.10_

  - [x]* 8.2 Write unit tests for the posting rules
    - Assert Σdebit = Σcredit per table, that the `settlement_pending` amount equals `A − F − G` with a difference of 0 paise, and that a no-fee Payment produces a valid 2-entry set
    - _Requirements: 2.1, 2.3_

  - [x] 8.3 Implement `postSet` with atomic imbalance rejection
    - Create `src/ledger/semantic-ledger.ts`; validate `Σdebit − Σcredit = 0` before any insert, enforce 2..20 entries and every amount `> 0`, write at least one Source_Record link per entry
    - On imbalance, reject the whole set with `{ ok: false, kind: 'unbalanced', imbalance_paise, source_refs }`, persist zero entries, and append the `ledger_set_rejected` Audit_Event on a separate connection so it survives the rollback
    - _Requirements: 2.1, 2.2, 2.6, 2.7_

  - [x] 8.4 Implement `postFromSource` idempotency and `trialBalance`
    - `postFromSource` returns `{ ok: true, created: false }` on a `ledger_set_derivation_uniq` violation, writing nothing and leaving every account balance unchanged
    - `trialBalance(from, to)` returns per-account debit total, credit total, and closing balance in integer paise for accounts holding at least one entry in the inclusive range, with summed debit equal to summed credit
    - _Requirements: 2.5, 2.8_

  - [x] 8.5 Write property test for ledger set balance
    - **Property 1: Ledger set balance**
    - `numRuns: 1000`, against Supabase local with a per-iteration transaction rollback; generators `arbitraryPayment`, `arbitraryRefund`, `arbitrarySettlement`, plus `arbitraryImbalancedDraft`
    - Assert balance, 2..20 entries, every amount `> 0n`, at least one source link per entry, the Payment `settlement_pending` identity, and that an imbalanced draft persists zero entries with deep-equal pre/post balance maps
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.6, 2.7, 2.9, 2.10, 4.12**
    - _Properties: P1_

  - [x] 8.6 Write property test for ledger derivation idempotency
    - **Property 2: Ledger derivation idempotency**
    - Generators: 1..50 source records, then a shuffled repetition so the second derivation arrives in a different order
    - Assert one set per distinct source ref, `created: false` on the second pass, and an unchanged `Map<string, bigint>` balance map
    - **Validates: Requirements 2.8**
    - _Properties: P2_

  - [x] 8.7 Write property test for trial balance self-balance
    - **Property 13: Trial balance self-balance**
    - Generators: arrays of `arbitraryBalancedLedgerSet` crossed with `arbitraryDateRange` including empty, single-day, fully-outside, and boundary-coincident ranges
    - Assert debit total equals credit total, each in-range account appears exactly once, the closing sign rule per account kind, and that an empty range returns zero accounts with `0n` totals
    - **Validates: Requirements 2.5**
    - _Properties: P13_

- [x] 9. Evidence chains (Requirement 12.2, 12.3, 12.8)
  - [x] 9.1 Implement the Evidence_Chain builder and persistence
    - Create `src/evidence/chain-builder.ts` emitting `EvidenceStep` records (1-based `step_index`, one arithmetic operation each, operands as source refs, prior step indexes, or literals), persisting `evidence_chains`, `evidence_chain_steps`, `evidence_chain_sources` with `as_of` set to the newest contributing record and `source_count` recorded
    - Retrieval returns source identifiers in pages of at most 500 without omission; expose `record_updated_at` versus `as_of` for the UI stale indicator
    - Return `incomplete_evidence` with per-type unavailable counts and **omit the figure** when a contributing record cannot be read
    - _Requirements: 12.2, 12.3, 12.5_

  - [x] 9.2 Implement the independent replay interpreter
    - Create `test/evidence/replay-interpreter.ts` written against the `EvidenceStep` schema only, **sharing no code with the tools**, evaluating ordered steps over referenced Source_Records and returning a `bigint`
    - _Requirements: 12.8_

  - [x] 9.3 Write property test for evidence chain replay
    - **Property 6: Evidence chain replay**
    - Generators: `arbitraryTenantDataset` then every read-only tool invoked over it, including chains with more than 500 sources so pagination is exercised
    - Assert `replayed === chain.figure_paise`, `source_count === concatenatedPages(chain).length`, and that concatenated pages yield each identifier exactly once
    - **Validates: Requirements 10.1, 12.2, 12.8**
    - _Properties: P6_

- [x] 10. Financial_Tool_Layer framework (Requirement 12)
  - [x] 10.1 Implement the tool contract and enforcement
    - Create `src/tools/tool.ts` with `FinancialTool<In, Out>`, `ToolContext`, and `ToolResult<T>`; Zod input schemas use `.strict()` and reject any free-form text or SQL argument
    - `tenant_id` comes from the session and never from a tool argument; `read_only` tools execute on the no-write-grant client
    - Schema violation returns `schema_violation` **without reading Tenant data or opening a connection** and appends `tool_invocation_rejected`
    - A 10-second overrun or thrown error terminates the invocation, rolls back any open transaction, and returns `tool_failure` with cause `timeout` or `execution_error`, appending `tool_failure`
    - Create `src/tools/registry.ts` so every tool declares `name`, `mode`, `inputSchema`, `outputSchema`
    - _Requirements: 12.1, 12.7, 12.9, 12.11_

  - [x] 10.2 Build the contract test harness driven by the registry
    - Create `test/contract/tool-contract.ts` running, for every registered tool: valid input accepted; unknown keys, wrong types, and free-form text/SQL rejected as `schema_violation` with no query issued; output validates against the declared output schema; declared `mode` matches behaviour; every monetary field carries a resolvable `evidence_chain_id`; a hidden contributing record yields `incomplete_evidence` rather than a figure; and holding past 10 s yields `tool_failure` with cause `timeout`
    - _Requirements: 12.1, 12.2, 12.3, 12.7, 12.9, 12.11_

- [x] 11. Reconciliation algorithms (Requirement 4.2–4.5, 4.15)
  - [x] 11.1 Implement Expected Amount and the three-way decomposition
    - Create `src/agents/reconciliation/reconcile-settlement.ts` with `expectedAmount(report)` as `Σpayments − Σrefunds − Σchargebacks + signed Σadjustments` and `reconcileSettlement` computing `difference = expected − received`, `fee = Σfee lines`, `gst = Σgst lines`, `residual = difference − fee − gst`
    - Status `difference_explained` if and only if `residual === 0n`, otherwise `mismatch`; direction `unexplained_shortfall` when `residual > 0n`, `unexplained_excess` when `< 0n`
    - Absent or empty report yields `unreconciled` with all five figures `null` and exclusion from the reported total shortfall
    - Persist to `settlement_reconciliations` with the Evidence_Chain identifier, examined counts, and the run id
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.13_

  - [x] 11.2 Write property test for settlement difference decomposition exactness
    - **Property 3: Settlement difference decomposition exactness**
    - `numRuns: 1000`; `arbitrarySettlementWithReconReport` with `residualShape` in zero/positive/negative and `reportShape` in present/absent/empty, shape discriminators placed after the data arrays so shrinking reduces data first
    - Assert `difference === fee + gst + residual`, `(status === 'difference_explained') === (residual === 0n)`, `expected === naiveExpected(report)`, and that absent/empty reports produce five `null` figures, `unreconciled` status, and absence from the shortfall aggregation
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.13**
    - _Properties: P3_

  - [x] 11.3 Write the SET-9281 worked-example test
    - Drive `reconcileSettlement` from `test/fixtures/set-9281.ts` and assert `1966100n + 353900n === 2320000n`, residual exactly `0n`, status `difference_explained`, **no Exception created**, and that expected, received, difference, fee and GST components are all recorded against the Settlement identifier
    - Assert the ₹19,000 fee variant produces residual `66100n`, a `settlement_mismatch` Exception with impact `66100n`, and direction `unexplained_shortfall`
    - Assert the persisted twelve-step Evidence_Chain replays to `2320000n` for the Difference and `0n` for the residual
    - _Requirements: 4.3, 4.4, 4.5, 12.8_
    - _Properties: P3, P6_

  - [x] 11.4 Implement the Exception fingerprint and upsert
    - Create `src/agents/exception-fingerprint.ts`: canonicalise source refs by sorting on type then id, join as `type:id`, append scope only for the range-scoped categories, and SHA-256 the `tenant|category|refs|scope` string; exclude `impact_paise`, `detail`, and every timestamp
    - Implement the `INSERT ... ON CONFLICT (tenant_id, fingerprint) DO UPDATE ... WHERE lifecycle_state = 'open'` upsert, writing `first_detected_at` once and advancing `last_detected_at`
    - _Requirements: 4.12, 4.15_

  - [x]* 11.5 Write unit tests for fingerprinting
    - Source ref order does not change the fingerprint; impact and timestamps do not enter it; scope enters it only for the range-scoped categories; a resolved Exception is not silently reopened
    - _Requirements: 4.15_

- [x] 12. Read-only Financial_Tools for the reconciliation and Control_Tower path (read-only before write-capable)
  - [x] 12.1 Implement `get_settlement_reconciliation`
    - Rows, `total_shortfall_paise`, resolved scope, examined counts per record type, and `residual_nonzero_count`, each monetary figure carrying its Evidence_Chain
    - _Requirements: 4.2, 4.4, 4.7, 4.13, 12.2_

  - [x] 12.2 Implement `get_settlement_difference_breakdown`
    - One row per in-scope Settlement with non-zero Difference ordered by descending absolute Difference, limit 1..50, plus the aggregate remainder row stating count and total absolute Difference
    - _Requirements: 4.3, 4.6, 12.2_

  - [x] 12.3 Implement `get_trial_balance`
    - Per-account totals and closing balances plus the two grand totals, over `SemanticLedger.trialBalance`
    - _Requirements: 2.5, 12.2_

  - [x] 12.4 Implement `get_unsettled_payments`, `get_duplicate_refund_candidates`, `get_missing_accruals`
    - Paged at 100 with totals reported; each monetary figure carrying an Evidence_Chain
    - _Requirements: 4.8, 4.10, 4.11, 12.2_

  - [x] 12.5 Implement `list_exceptions_by_category` and `get_exception_evidence`
    - Category rows with open count and aggregate impact; drill-down pages of at most 50 ordered by descending impact then ascending Exception identifier; evidence retrieval paged at 500 source identifiers
    - _Requirements: 3.5, 3.6, 12.2, 12.5_

  - [x] 12.6 Implement `get_control_tower_metrics`
    - Four independent cells (Cash, Revenue trailing 30 days, Pending Settlement, Runway) each with `state`, optional `value_paise`, `failure_kind`, `last_ingested_at`, `evidence_chain_id`; Runway returns a not-yet-available state until the Cash_Agent lands in Slice 4
    - _Requirements: 3.1, 3.8, 3.9, 3.10, 3.12, 12.2_

  - [x] 12.7 Run the contract test harness over every Slice 1 tool
    - Add each tool to the registry-driven suite from task 10.2 and fix every schema, mode, evidence, and timeout finding
    - _Requirements: 12.1, 12.2, 12.3, 12.7, 12.9, 12.11_

- [x] 13. Reconciliation_Agent (Requirement 4)
  - [x] 13.1 Implement identifier-only lifecycle matching
    - Create `src/agents/reconciliation/match.ts` mapping each in-scope Payment to its Order, Razorpay_Invoice, Settlement and Ledger_Entries using **only stored Razorpay identifier links**, with no amount-based or date-based inference and a not-matched marker per record type
    - _Requirements: 4.1_

  - [x] 13.2 Implement the agent run over the settlement path
    - Create `src/agents/reconciliation/agent.ts`: resolve scope (trailing 90 days when the request states no range), reconcile every in-scope Settlement, upsert `settlement_mismatch` Exceptions where the residual is non-zero with `|residual|` as impact and the correct direction, and report scope plus examined counts
    - All result ordering is total with explicit tie-breakers so a re-run over an unchanged dataset reproduces the identical Exception set in identical order
    - Enforce the 120-second wall-clock bound: stop, return partial results, flag incomplete, and name the Source_Record types not fully processed
    - _Requirements: 4.1, 4.5, 4.7, 4.12, 4.15, 15.6, 15.7, 15.10_

  - [x] 13.3 Write property test for reconciliation run determinism
    - **Property 5: Reconciliation run determinism**
    - `arbitraryTenantDataset` including deliberate impact ties; the second run receives the same dataset with row insertion order shuffled
    - Assert deep equality of ordered `[category, impact_paise, sortedSourceRefs]` tuples, unchanged Exception count, unchanged `first_detected_at`, advanced `last_detected_at`
    - **Validates: Requirements 4.15, 6.12, 7.10, 15.7**
    - _Properties: P5_

  - [x] 13.4 Implement the shortfall answer
    - Return the 50 Settlements with the largest absolute Difference plus a single aggregate row stating the count and total absolute Difference of the remainder, each row carrying settlement id, expected, received, difference, fee, GST and residual
    - Report the applied settlement date range and the examined counts of Payments, Settlements, Refunds, Ledger_Entries and Razorpay_Invoices
    - _Requirements: 4.6, 4.7_

  - [x] 13.5 Add the remaining detectors (design.md marks these thin-sliceable, land one at a time)
    - Possible duplicate Refunds where combined refunds exceed the Payment by 1 paisa or more; Unmatched_Credit_Notes; missing accruals for Payments and Refunds with no referencing Ledger_Entry; ambiguous matches with candidate exclusion from the unsettled classification
    - _Requirements: 4.8, 4.9, 4.10, 4.14_

- [x] 14. Control_Tower UI (Requirement 3) — component code plus tests
  - [x] 14.1 Implement the metric strip with per-cell states
    - Create `src/app/control-tower/MetricStrip.tsx` and `MetricCell.tsx`: four independent async cells (Cash, Revenue trailing 30 days, Pending Settlement, Runway), each owning its loading, processing, failure and retry state so one cell never blocks the others
    - Render values through `formatInr`, add the lakh secondary line at `>= ₹1,00,000` and `< ₹1,00,00,000` and the crore line at `>= ₹1,00,00,000`, both to 2 decimal places, and show the contributing ingestion timestamp in IST to whole-second precision
    - Render Runway to 1 decimal place when available, and the non-numeric state distinguishing "exceeds 120.0 months" from "not applicable"
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.10, 3.11, 3.12_

  - [x] 14.2 Implement the Attention_Panel with ordering and drill-down paging
    - Create `src/app/control-tower/AttentionPanel.tsx`: one row per Exception_Category holding 1 or more open Exceptions with category name, open count and aggregate INR impact, ordered by descending aggregate impact then ascending alphabetical category name
    - Pointer and keyboard selection drills into pages of at most 50 Exceptions ordered by descending impact then ascending Exception identifier, each showing impact, Source_Record identifiers, and a control that opens the Evidence_Chain
    - Subscribe to Supabase Realtime on `exceptions` and `ingestion_runs` so the panel stays current without polling
    - _Requirements: 3.5, 3.6_

  - [x] 14.3 Implement the Evidence panel
    - Create `src/app/evidence/EvidencePanel.tsx`: ordered steps with operation and operand references, the as-of timestamp, the total source identifier count, source identifiers in pages of at most 100 with navigation to every remaining page, and a stale indicator when any referenced record changed after `as_of`
    - Every displayed figure is a control that opens its chain
    - _Requirements: 12.4, 12.5_

  - [x] 14.4 Implement the empty states
    - Zero ingested Razorpay objects: an empty-state message identifying that ingestion has not completed, no monetary metric values, navigation and controls still operable
    - Metric computation incomplete for 30 seconds or less: a processing state per incomplete metric with controls operable
    - Zero open Exceptions across all categories: a no-open-exceptions state with no Attention_Panel rows
    - _Requirements: 3.7, 3.8, 3.13_

  - [x] 14.5 Add per-metric failure isolation and retry (design.md marks this thin-sliceable)
    - On a metric computation error or a 30-second timeout, render a failure state for that metric naming it and distinguishing computation error from timeout, with a retry control, while the remaining metrics render their values
    - _Requirements: 3.9_

  - [x]* 14.6 Write component tests for the Control_Tower
    - Attention_Panel ordering including the equal-impact alphabetical tie-break; drill-down page size of 50 and its ordering; keyboard selection; Indian_Number_Format and lakh/crore rendering at the band boundaries; every empty, processing and failure state; Evidence panel step ordering, 100-per-page navigation and the stale indicator
    - _Requirements: 3.2, 3.3, 3.5, 3.6, 3.7, 3.8, 3.9, 3.11, 3.13, 12.5_

- [x] 15. FinanceOS_API surface for Slice 1
  - [x] 15.1 Implement the Slice 1 routes
    - `POST /ingestion/runs`, `GET /control-tower/metrics`, `GET /exceptions?category=&page=`, `GET /evidence-chains/{id}?page=`, `POST /agents/{agent}/runs` where `{agent}` names an Agent_Catalogue identity and Slice 1 exercises `Reconciliation_Agent`
    - Every route resolves a session, binds exactly one Tenant for the session lifetime, and delegates; an absent, expired or invalid session credential returns an authentication-required error carrying no Tenant financial data and no Tenant identifier
    - Route-level rejection of an identifier outside the closed catalogue lands in task 39.2, which replaces the Slice 1 path segment with the `z.enum(AGENT_CATALOGUE)` parse
    - _Requirements: 3.1, 3.5, 3.6, 12.5, 14.4, 14.8, 16.3_

  - [x]* 15.2 Write API route tests
    - Assert the authentication-required path leaks no Tenant identifier, that pagination parameters are enforced, and that metric cells surface independently
    - _Requirements: 3.9, 14.4_

- [x] 16. End-to-end demo path, steps 1 through 5 (no Model dependency)
  - [x] 16.1 Write the ordered demo path test
    - Create `test/e2e/demo-path.test.ts`: seed Razorpay test-mode data from task 7.1; run ingestion and assert one `razorpay_objects` row per object identifier with run status `completed`; derive the Semantic_Ledger and assert every set balances and a second derivation pass creates nothing; run the Reconciliation_Agent and assert the zero-residual Settlement is `difference_explained` with no Exception while the non-zero-residual Settlement produced a `settlement_mismatch` Exception with `impact = |residual|` and the correct direction; fetch that Exception's Evidence_Chain and assert the ordered steps replay to the presented figure exactly and every referenced Source_Record identifier resolves to an ingested row
    - Steps 6 and 7 (the validator-gated ask) are added in task 37.1 once the Python runtime, the AI_Gateway and the validator exist
    - _Requirements: 1.1, 1.6, 2.1, 2.8, 4.4, 4.5, 12.8_
    - _Properties: P1, P2, P3, P6, P10_

- [x] 17. **PROPERTY GATE — Slice 1. Blocks Slice 2.**
  - Run P1, P2, P3, P5, P6, P10, P11, P12, P13 with explicit seeds. All nine must pass. Also run the typecheck, unit, database and contract suites.
  - These nine are not waivable: every later slice computes on top of them, and a decomposition or rounding bug found in Slice 4 would invalidate everything built in between.
  - Commit any fast-check counterexample as an example-based regression test alongside its property. Ensure all tests pass, ask the user if questions arise.

---

## Slice 2 — the differentiator (Requirement 7, Requirement 16.5–16.6)

- [x] 18. Route ledger posting
  - [x] 18.1 Implement Transfer and Transfer_Reversal posting rules
    - Extend `src/ledger/posting-rules.ts`: Transfer debits `seller_payout_clearing` and credits `settlement_pending` by `T`; Transfer_Reversal debits `settlement_pending` and credits `seller_payout_clearing` by the reversed amount `V`, counted at its own amount
    - Add both account codes to the seeded chart of accounts
    - _Requirements: 2.1, 2.2, 7.1, 7.2_

- [x] 19. Reconciliation_Agent Route capability — Razorpay_Route seller payout reconciliation
  - Route reconciliation is a **second capability on the existing Reconciliation_Agent identity, not a new Agent**: a Route split is a decomposition of the same Payment the settlement path already reconciles, and the Requirement 7.11 conservation law is checked against the same Payment amount the Requirement 4.2 Expected Amount is built from. The Action_Pipeline driver, the Exception upsert path, the fingerprint function and the audit actor value all already exist from Slice 1, so this slice adds tools and arithmetic rather than a component. Directory names under `src/agents/marketplace/` are retained as code organisation; the owning identity is `Reconciliation_Agent`.
  - [x] 19.1 Implement Route split mapping and expected Seller payout
    - Create `src/agents/marketplace/route-split.ts`: map each Payment in a reconciliation range of at most 366 days to its Transfers, Transfer_Reversals and retained platform commission in integer paise
    - Expected Seller payout is `Σtransfers − Σreversals` for the Linked_Account within the range, each partial reversal counted at its own reversed amount
    - _Requirements: 7.1, 7.2, 7.11, 16.5_

  - [x] 19.2 Write property test for Route split conservation
    - **Property 4: Route split conservation**
    - `arbitraryRouteSplit` allocating split weights, reversal ratios and on-hold flags so the conservation law is satisfiable by construction rather than by filtering
    - Assert `sum(netTransfers) + commission + fee + gst === payment.amount_paise` with difference exactly `0n`; separately assert `expectedPayout === sum(nonHeldTransfers) − sum(theirReversals)` so removing on-hold Transfers does not change the expected payout; assert deliberately over-allocated cases produce an `over_allocated_split` Exception with impact `Σtransfers − payment.amount_paise`
    - **Validates: Requirements 7.1, 7.2, 7.7, 7.9, 7.11**
    - _Properties: P4_

  - [x] 19.3 Implement the Route Exceptions with scope-included fingerprints
    - `seller_settlement_mismatch` where the expected payout differs from Settlements received by the Linked_Account by 1 or more paise, with `|difference|` as impact and direction shortfall or excess
    - `over_allocated_split` where Σtransfers for a Payment exceeds the Payment amount
    - Include the reconciliation date range in the fingerprint for both categories so a re-run over the same range updates the open Exception rather than duplicating it. These two are the only fingerprint categories the requirements scope by reconciliation date range, and they belong to the Reconciliation_Agent's Route capability
    - _Requirements: 7.3, 7.7, 7.10, 16.5_

  - [x] 19.4 Implement `get_seller_payout_chain` and `get_linked_account_balance`
    - Payout chain returns the shortfall, the ordered rows, the total row count, a truncation flag and the on-hold list; balance returns integer paise, the as-of timestamp of the most recent contributing record, and the contributing Source_Record identifiers
    - Add both to the contract test suite
    - _Requirements: 7.2, 7.3, 7.4, 7.5, 7.6, 7.9, 12.1, 12.2_

  - [x] 19.5 Implement the Route run and chain ordering under the Reconciliation_Agent identity
    - Create `src/agents/marketplace/agent.ts`: ordered chain rows by ascending Payment creation timestamp, then Payment id, then Transfer id, then Transfer_Reversal id, each row listing Payment, Transfer, Transfer_Reversal where one exists, Razorpay_Fee, GST_On_Fee and platform commission
    - Truncate at 200 rows, return the total contributing row count, and identify the chain as truncated
    - The Route capability runs through the same Action_Pipeline under the same identity, so a Route Proposal passes the same Policy_Engine gate, records the same Authorization shape, and appends the same stage Audit_Events with `actor_id = 'Reconciliation_Agent'`; the tools differ — `get_seller_payout_chain` and `get_linked_account_balance` rather than the settlement pair — but the Evidence_Chain envelope and the write-capable authorization requirement are identical
    - _Requirements: 7.4, 7.5, 16.5, 16.6_

  - [x] 19.6 Add on-hold Transfer handling (design.md marks this thin-sliceable)
    - Exclude on-hold Transfer amounts from the expected Seller payout and report the on-hold Transfer identifier and amount alongside it
    - _Requirements: 7.9_

  - [x] 19.7 Add the pending classification for zero-settlement Linked_Accounts (design.md marks this thin-sliceable)
    - Classify the expected payout as pending, create no `seller_settlement_mismatch` Exception, and report the pending amount and the age in days of the oldest contributing Transfer
    - _Requirements: 7.8_

  - [x] 19.8 Extend the Razorpay test-mode seed with Route fixtures
    - Add Linked_Accounts, Transfers, partial and full Transfer_Reversals, an on-hold Transfer, a zero-settlement Linked_Account, and one deliberately over-allocated split to `scripts/seed-razorpay-testmode.ts`
    - _Requirements: 7.1, 7.7, 7.8, 7.9_

- [x] 20. **PROPERTY GATE — Slice 2. Blocks Slice 3.**
  - Run P4 and assert it passes. Re-run P1 and P5 over datasets that now include Route objects and assert both still pass.
  - Ensure all tests pass, ask the user if questions arise.

---

## Slice 3 — the safety spine (Requirements 5, 13, 14)

- [x] 21. Proposal and authorization storage
  - [x] 21.1 Migration: proposals and authorizations
    - `proposal_state` enum, `proposals` (target refs, `target_fingerprint`, `impact_paise`, `evidence_chain_id NOT NULL`, `expected_outcome`, `risk_score`, `threshold_used`, `policy_checks`, `approval_deadline`, observed and difference columns), `authorizations` with the `actor_kind`/`actor_user_id` CHECK
    - _Requirements: 5.4, 5.15, 5.16_

- [x] 22. Policy_Engine (Requirement 5.3–5.7, 5.13, 5.15)
  - [x] 22.1 Implement the six independent Policy_Checks
    - Create `src/policy/checks.ts`: user permission, accounting rule, transaction evidence, duplicate action, risk threshold, approval requirement
    - Evaluate all six independently even after one fails so the User sees the complete gate picture; duplicate action looks back 30 days over executed and awaiting-approval Proposals with the same action type and target Source_Record set, recording the matching Proposal id
    - Return within 10 seconds of submission
    - _Requirements: 5.3, 5.4, 5.13_

  - [x] 22.2 Implement the risk score and the decision
    - Create `src/policy/risk.ts` with the impact bands, action type points and absent-evidence points capped at 15, clamped to 0..100
    - Create `src/policy/decide.ts`: throw when fewer than six checks are present, `block` when any check fails, `auto_execute` when all pass and `risk <= threshold`, otherwise `require_approval`; on `auto_execute` record an Authorization naming the Policy_Engine as actor before execution begins
    - Persist the six check results, the risk score and the threshold used on the Proposal so the approval queue can render the complete gate picture
    - _Requirements: 5.4, 5.5, 5.6, 5.7, 5.15_

  - [x]* 22.3 Write unit tests for the risk score and decision
    - Band boundaries at ₹1,000, ₹10,000, ₹1,00,000, ₹10,00,000 and ₹1,00,00,000; each action type; absent-evidence counts of 0, 1, 3 and 4; the `decide` mapping across all three outcomes at thresholds 0 and 100
    - _Requirements: 5.6, 5.7, 5.15_

- [x] 23. FinanceOS_Action_Service (Requirement 5.8–5.12, 5.16, 5.17)
  - [x] 23.1 Implement approval and rejection
    - Create `src/action/action-service.ts`: withhold execution while `require_approval` stands; on approval record the Authorization with user id, proposal id and decision timestamp, resubmit to the Policy_Engine, and execute only when the resubmitted decision is not `block`; on rejection record the rejection and discard the Proposal with no state change
    - _Requirements: 5.8, 5.9, 5.10_

  - [x] 23.2 Implement authorized execution
    - `executeAuthorized(proposalId, authorizationId)` invokes a write-capable tool carrying both identifiers; refuse to execute without a resolvable Authorization
    - _Requirements: 5.9, 5.14, 12.10_

  - [x] 23.3 Implement verification with the 1-paisa tolerance
    - `verify` runs within 60 seconds of execution completion comparing observed state against `expected_outcome`, treating `|difference| <= 1` paisa as matching
    - On a monetary difference above 1 paisa or any non-monetary difference, mark the Proposal verification-failed, create a `verification_failure` Exception with the absolute INR difference as impact and the Proposal and target identifiers attached, and make no further automatic change
    - _Requirements: 5.11, 5.12_

  - [x] 23.4 Implement the execution failure reversal path
    - On EXECUTE failure, mark the Proposal execution-failed, reverse each applied change through `SemanticLedger.reverseSet`, create an `execution_failure` Exception naming the Proposal and failure reason, and require a new Authorization before any retry
    - _Requirements: 5.17_

  - [x] 23.5 Implement Approval_Window expiry (design.md marks this thin-sliceable: query-time check first, then the sweep)
    - `expireOverdue` marks overdue Proposals expired, withholds execution permanently, and appends an Audit_Event recording the elapsed wait
    - _Requirements: 5.16_

  - [x] 23.6 Write property test for authorization completeness over a TypeScript pipeline harness
    - **Property 8: Authorization completeness**
    - The Agent Engine is Python and does not exist until Slice 4, so Slice 3 exercises the Action_Pipeline through a TypeScript test harness in `test/property/pipeline-harness.ts` that drives the Policy_Engine and the Action_Service directly in stage order and appends the same stage Audit_Events an engine run would, keeping the Slice 3 gate satisfiable without the Python runtime
    - `arbitraryProposal` crossed with `arbitraryPolicyEnvironment` (which checks fail, threshold 0..100, duplicate within 30 days) and `arbitraryApprovalBehaviour` (approve, reject, expire, approve after the window)
    - Assert every Proposal with an EXECUTE Audit_Event has at least one Authorization; no blocked, awaiting-approval, rejected or expired Proposal has an EXECUTE-stage event; and the recorded stage sequence is an in-order prefix of the seven stages with exactly one event per completed stage
    - The Python Agent Engine in Slice 4 is asserted against the same property, so a divergence between the harness and the engine surfaces as a P8 failure rather than as an untested gap
    - **Validates: Requirements 5.1, 5.6, 5.7, 5.14, 12.10, 13.7**
    - _Properties: P8_

- [x] 24. Ledger reversal and the write-capable tool path
  - [x] 24.1 Implement `reverseSet`
    - Build a new set with per-account amounts equal and sides exchanged, linked by `reverses_set_id`, never mutating the original
    - _Requirements: 2.4, 5.17_

  - [x] 24.2 Write property test for reversal preservation
    - **Property 14: Reversal preservation**
    - `arbitraryBalancedLedgerSet` with 2..20 entries, including sets posting several entries to one account on the same side and sets posting to one account on both sides
    - Snapshot originals, reverse, then assert field-by-field deep equality including source links, `reversal.reverses_set_id === original.id`, and `netOf(original, account) + netOf(reversal, account) === 0n` per account; reversing twice yields two independent reversal sets with the original still untouched
    - **Validates: Requirements 2.4, 5.17**
    - _Properties: P14_

  - [x] 24.3 Implement the write-capable tools
    - `post_reconciliation_adjustment` delegating to `SemanticLedger.postSet` so an unbalanced adjustment is rejected atomically with zero entries persisted, and `mark_exception_resolved`
    - Both reject any invocation whose `ToolContext` lacks `proposal_id` and `authorization_id` resolving to a Proposal with a recorded Authorization, leaving Tenant state unchanged and appending `unauthorized_write_rejected`
    - Extend the contract suite with the write-capable mode assertions
    - _Requirements: 2.1, 2.6, 5.17, 12.10_

- [x] 25. FinanceOS_Audit_Service (Requirement 13)
  - [x] 25.1 Implement the append path
    - Create `src/audit/audit-service.ts` wrapping `app.append_audit_event`: serialized per-Tenant sequence allocation, credential values excluded from payloads, Source_Records referenced by identifier only, payloads over 65536 bytes reduced with the indicator set while Source_Record identifiers stay unreduced
    - _Requirements: 13.1, 13.2, 13.3_

  - [x] 25.2 Implement `chainValue` and the verification walk
    - Create `src/audit/chain.ts` with `canonicalJson` (sorted keys, preserved array order), the `occurred_at` normalisation to `YYYY-MM-DDTHH:MM:SS.sssZ`, the fixed initial Chain_Value, and `verifyChain` reporting the lowest mismatched sequence number and the lowest absent sequence number independently, continuing from the **stored** chain value rather than the recomputed one
    - _Requirements: 13.4, 13.8_

  - [x] 25.3 Write property test for audit chain integrity
    - **Property 9: Audit chain integrity**
    - `arbitraryAuditEventSequence` with varied event types, actor kinds, stages, outcomes, source ref arrays and payloads including oversized ones, interleaved aborted transactions so gaplessness is tested under rollback, plus an optional injected tamper index and gap index
    - Assert recomputed equals stored for every event, sequence numbers form `1..n`, and `verifyChain` reports `intact: true`; on injected anomalies assert the reported positions match the injected ones
    - **Validates: Requirements 13.1, 13.4, 13.8, 13.10**
    - _Properties: P9_

  - [x] 25.4 Implement history retrieval (design.md marks pagination thin-sliceable)
    - `sourceHistory` ordered by ascending timestamp then ascending sequence number in pages of at most 100 with a further-events indicator; `proposalHistory` returning exactly one event per completed stage with the absent stages identified as not completed
    - _Requirements: 13.6, 13.7_

  - [x] 25.5 Write the mutation-rejection audit test
    - Assert an `UPDATE` or `DELETE` attempt on `audit_events` is rejected, leaves the targeted event's sequence number, timestamp, actor, payload and Chain_Value unchanged, and appends an Audit_Event recording the attempt with the requesting actor and the targeted sequence number
    - _Requirements: 13.5, 13.10_

- [x] 26. Multi-tenancy and security (Requirement 14)
  - [x] 26.1 Migration: RLS policies on every tenant-scoped table
    - `ENABLE` and `FORCE ROW LEVEL SECURITY` plus the four-policy pattern bound to `app.current_tenant_id()` repeated verbatim across every table named in design.md's Row-level security section, omitting only the `UPDATE` and `DELETE` policies on `ledger_entries` and `audit_events` where those privileges are revoked
    - _Requirements: 14.1, 14.2, 14.3, 14.7, 14.10_

  - [x] 26.2 Implement session Tenant binding and the Authorization_Service
    - Bind the session to exactly one Tenant from the User's memberships at authentication, keep it immutable for the session lifetime, and require a new session to act in another Tenant
    - Create `src/authz/authorization-service.ts` with `require(session, permission)` over the six Permissions, evaluated before any read or change of Tenant financial data
    - Keep application-level `WHERE tenant_id = $1` filters in every query as defence in depth, never as the control
    - _Requirements: 14.6, 14.8, 14.9_

  - [x] 26.3 Write property test for tenant isolation
    - **Property 7: Tenant isolation**
    - `arbitraryMultiTenantDataset` of 2..5 Tenants with deliberately colliding amounts, dates and similar identifiers; queries generated across every read path crossed with generated arguments including foreign Tenant record identifiers; `numRuns: 100` with truncate-and-reseed since committed data is required
    - Assert zero foreign rows on every path and session, including queries with the application-level tenant filter deliberately omitted; foreign-record targets return zero rows rather than a permission error and the targeted row is unchanged
    - **Validates: Requirements 12.7, 14.2, 14.3, 14.7, 14.10**
    - _Properties: P7_

  - [x] 26.4 Write RLS database tests per table
    - For each tenant-scoped table: seed two Tenants, set the claim to Tenant A, assert `SELECT` returns only A's rows, `UPDATE` and `DELETE` against B's rows affect 0 rows, and `INSERT` with B's `tenant_id` is rejected by the `WITH CHECK` clause; repeat with no session claim asserting zero rows everywhere
    - _Requirements: 14.2, 14.3, 14.4, 14.10_

  - [x] 26.5 Implement the rejection audit events
    - Append `cross_tenant_access_rejected`, `unscoped_access_rejected` and `permission_denied` events with the fields named in design.md's Error Handling tables; permission denial returns an error naming the required Permission and changes no state
    - _Requirements: 14.3, 14.9, 14.10_

- [x] 27. Approval queue UI
  - [x] 27.1 Implement the approval queue
    - Create `src/app/approvals/ApprovalQueue.tsx` listing Sensitive_Actions with all six Policy_Check results, the risk score, the threshold used, the Evidence_Chain control and the remaining Approval_Window, with approve and reject actions gated on `approve_sensitive_actions`
    - _Requirements: 5.4, 5.9, 5.10, 5.16, 14.6_

  - [x]* 27.2 Write component tests for the approval queue
    - All six check results render on a blocked Proposal; expired Proposals remove the approve and reject controls; the remaining window counts down from `approval_deadline`
    - _Requirements: 5.4, 5.16_

- [x] 28. **PROPERTY GATE — Slice 3. Blocks Slice 4.**
  - Run P7, P8, P9 and P14 and assert all four pass. P8 runs against the TypeScript pipeline harness from task 23.6, since the Python Agent Engine does not exist until Slice 4; the proposals, the Policy_Engine, the Action_Service and the Audit_Service are all TypeScript and complete without it.
  - Re-run the Slice 1 and Slice 2 gates.
  - Ensure all tests pass, ask the user if questions arise.

---

## Slice 4 — breadth (the Python runtime and the money wire contract first, then Requirement 11, then 6, 8, 9, 10)

- [x] 29. The Python runtime and the money wire contract — first in this slice because everything after it depends on the boundary being correct
  - [x] 29.1 Initialize the Python project and test stack
    - Create `pyproject.toml` declaring the project and its dependencies, with pytest as the runner, Hypothesis for the property-based suite, `ruff` for lint and `mypy` for type checking, each configured in `pyproject.toml` rather than in scattered dotfiles
    - Configure `mypy` strictly enough to reject a `float` annotation on a paise field and a `_paise` field annotated `int` in a transport model where the wire type must be `str`
    - Create the package tree `financeos/` with `wire/`, `agents/`, `ai/` and `validator/`, and the test tree `tests/` with `property/` and `transport/`
    - Add the two Python CI commands matching design.md's stage names: `ruff` plus `mypy` for stage 2, pytest for stage 4
    - _Requirements: 15.1, 15.8_

  - [x] 29.2 Implement the Python money wire helpers
    - Create `financeos/wire/paise.py` with `PaiseWire = str`, `PAISE_MIN = -99_999_999_999_999`, `PAISE_MAX = 99_999_999_999_999`, `to_wire(v: int) -> PaiseWire` calling `assert_in_range` then `str(v)`, `from_wire(s: PaiseWire) -> int` rejecting a non-`str` or a value failing the compiled `/^-?[0-9]+$/` full match with a `WireError`, then `int(s)`, then `assert_in_range`
    - `assert_in_range(v: int) -> None` raises a `WireError` when `not isinstance(v, int) or isinstance(v, bool)` — the `bool` guard matters because `bool` is a subclass of `int` in Python and `True` would otherwise pass as `1` — and raises when `v` is outside `PAISE_MIN..PAISE_MAX`
    - Add the range-free encode and decode pair mirroring the TypeScript `encodePaise` / `decodePaise`, since `assert_in_range` rejects the above-2^53 magnitudes P15 needs to exercise
    - Every paise value inside the Python process is `int`, never `float`, which is the Python half of P12's assertion
    - _Requirements: 15.1, 15.8_

  - [x] 29.3 Implement the transport schemas on both sides
    - TypeScript: create the Zod transport schemas under `src/wire/` declaring every monetary field with a `_paise` suffix as `z.string().regex(/^-?[0-9]+$/)` with **no coercion** — not `z.coerce.string()`, which would turn a JSON number into a confident-looking string and hide a value that had already lost precision in `JSON.parse`
    - Python: mirror the same shapes as Pydantic models under `financeos/wire/`, with `str` for every `_paise` field on the wire and `int` for every paise value in memory, parsed through `from_wire` at the boundary
    - The two sides are hand-written and test-verified rather than generated, so a `_paise` field typed as a number stays visible in review
    - Add the field-typing audit that enumerates every field in every transport schema whose name ends in `_paise` and asserts its declared type is `string` on the TypeScript side and `str` on the Python side, so a new monetary field typed as a number fails at this audit rather than at runtime
    - Cover the three places money crosses: the tool input and `ToolResult<Out>` envelope including `figure_paise` and every `EvidenceStep.result_paise`, the `allowed_values_paise` set passed to the validator, and the two metering payloads
    - _Requirements: 15.1, 15.8_

  - [x] 29.4 Write property test for money wire round-trip
    - **Property 15: Money wire round-trip**
    - Owned by **both** runtimes: `test/property/money-wire.property.test.ts` under fast-check and `tests/property/test_money_wire.py` under Hypothesis, both reading the **same committed fixture vectors** so a boundary value drawn on one side is asserted on the other rather than producing a green suite by omission
    - Generators: `fc.bigInt({ min: -99999999999999n, max: 99999999999999n })` biased with `fc.constantFrom` over `0n`, `1n`, `-1n`, `99n`, `100n` and both range extremes, and `st.integers(min_value=-99999999999999, max_value=99999999999999)` with the same constants through `st.sampled_from`
    - Assert `pyParse(tsSerialize(p)) == p` and `BigInt(pySerialize(p)) === p` for every in-range value, and that `toWire` raises rather than emitting a string for any out-of-range value, so the range guard and the encoding guarantee are asserted as separate facts
    - Malformed-payload rejection per `_paise` field, one case each: a JSON number, a JSON float, a numeric string carrying a decimal point, a numeric string with leading whitespace, a numeric string with a leading plus sign, a non-numeric string, `null`, and a nested object — asserting the parse result is a schema violation naming the offending field and that no coerced value is produced
    - The above-2^53 case is its own named test, not left to the generator: `fc.bigInt({ min: 9007199254740992n, max: 10n ** 20n })` and the Hypothesis equivalent through the range-free encode and decode pair, because that is the magnitude at which a JSON-number implementation passes every other case in this suite and silently fails, and it is the magnitude an unrounded `applyRate` product actually reaches
    - **Validates: Requirements 15.1, 15.8**
    - _Properties: P15_
    - _Requirements: 15.1, 15.8_

  - [x] 29.5 Implement the internal tool endpoint
    - TypeScript: create `POST /internal/tools/{tool_name}` as a server-to-server route, not routed through the public API surface, not reachable from a browser, and not documented as a Tenant-facing route
    - Authentication is a **service credential distinct from any user session**, so a leaked user session cannot reach the endpoint and a leaked service credential cannot impersonate a user; it establishes only that the caller is the Agent runtime
    - Authorization is separate and additive: the forwarded originating user context must hold the Permission the invoked tool requires, so a service credential alone authorizes nothing. The endpoint resolves `ToolContext` — `tenant_id`, `user_id`, `permissions` and the RLS-bound `db` client — from that forwarded context alone
    - A `tenant_id` appearing anywhere in the request body is **rejected as a schema violation, not ignored**, so a caller cannot believe it scoped a request when it had not; this preserves Requirement 12.7 and 14.8 across the process boundary
    - An unknown `tool_name` returns a schema violation rather than a 404, so a typo in an Agent is audited the same way a bad argument is
    - Both auth checks run **before** the tool's input schema is parsed, and a failure of either is audited
    - Python: create the client in `financeos/agents/tool_client.py` with a deliberately longer **13-second deadline** against the 10-second server-side tool timeout, so a tool overrun surfaces as the TypeScript `tool_failure` result with cause `timeout` rather than as a client-side transport error — the Agent must keep the distinction between "the tool timed out and Tenant state is unchanged" and "the request never arrived"
    - _Requirements: 12.7, 12.9, 12.11, 14.8_

  - [x] 29.6 Implement the internal metering endpoints
    - TypeScript: create `GET /internal/model-cost-cap` under the same service-credential plus forwarded-user-context model, rejecting a body-supplied `tenant_id` as a schema violation. It returns `cap_paise` and `month_to_date_paise` as decimal strings through `toWire`, plus an `exceeded` boolean computed on the TypeScript side with `>=` so reaching the cap exactly rejects, and appends `model_request_rejected_cost_cap` when `exceeded` is true
    - TypeScript: create `POST /internal/model-requests` under the same model, accepting provider, resolved model name, declared Task_Class, provider attempt count, input token count, output token count, latency in milliseconds, outcome, and the per-attempt failure records
    - A body carrying a `cost_paise` field is **rejected as a schema violation**, since cost is computed server-side; the endpoint prices the measurements through `CalculationService.applyRate`, writes the `model_requests` row, and returns `{ model_request_id, cost_paise }` with `cost_paise` as a decimal string
    - The comparison and the pricing are therefore never duplicated in Python: the Gateway measures, TypeScript prices and persists
    - _Requirements: 11.8, 11.13_

  - [x] 29.7 Write the transport contract test suite
    - Create `test/transport/` on the TypeScript side and `tests/transport/` on the Python side, running the suite design.md's Testing Strategy names, against the shared fixture files
    - **Field typing audit** — every `_paise` field declared `string` on the TypeScript side and `str` on the Python side
    - **JSON-number rejection** — for every `_paise` field, a JSON number, a JSON float, `null` and a non-numeric string each produce a schema violation naming the field with no coerced value
    - **Cross-runtime round-trip** — the P15 assertions in both directions over the shared vectors, including the above-2^53 case against the range-free encode and decode pair as an explicit named test
    - **Internal endpoint contract** — a body `tenant_id` is rejected; the service credential alone authorizes nothing without the forwarded user Permission; a tool held past 10 s surfaces the TypeScript `tool_failure` result rather than a client-side transport timeout
    - **Cost cap endpoint contract** — `cap_paise` and `month_to_date_paise` returned as decimal strings with an `exceeded` flag, and a Tenant whose month-to-date spend sits **exactly at the cap** returns `exceeded: true`
    - **Metering endpoint contract** — a payload carrying `cost_paise` is rejected with a schema violation, and the returned `cost_paise` round-trips as a decimal string through `from_wire` on the Python side
    - _Requirements: 11.8, 11.13, 12.7, 12.9, 15.1, 15.8_

- [x] 30. Agent Engine and the Action_Pipeline (Python, moved here with the Python runtime)
  - [x] 30.1 Implement the stage runner
    - Create `financeos/agents/engine.py` executing DETECT, INVESTIGATE, EXPLAIN, PROPOSE, AUTHORIZE, EXECUTE, VERIFY strictly in order, each completing before the next begins, none omitted, with the Agent owning DETECT through PROPOSE, the Policy_Engine owning AUTHORIZE, and the Action_Service owning EXECUTE and VERIFY
    - The engine reaches data only through the internal tool endpoint from task 29.5; it opens no database connection and holds no money arithmetic of its own
    - Append exactly one Audit_Event per completed stage within 5 seconds of stage completion recording stage name, agent identifier, tenant, proposal, timestamp and outcome
    - Cap concurrency at 5 Agent runs per Tenant; stream first displayable content within 15 seconds; stop at 120 seconds with partial results and the unprocessed Source_Record types named
    - _Requirements: 5.1, 5.2, 13.7, 15.4, 15.6_

  - [x] 30.2 Write property test for authorization completeness against the Python engine
    - **Property 8: Authorization completeness**
    - Asserted against the same property Slice 3 asserted through the TypeScript pipeline harness in task 23.6, so the Python engine and the harness are held to one statement rather than two
    - Hypothesis strategies mirroring `arbitraryProposal` crossed with `arbitraryPolicyEnvironment` (which checks fail, threshold 0..100, duplicate within 30 days) and `arbitraryApprovalBehaviour` (approve, reject, expire, approve after the window)
    - Assert every Proposal with an EXECUTE Audit_Event has at least one Authorization; no blocked, awaiting-approval, rejected or expired Proposal has an EXECUTE-stage event; and the recorded stage sequence is an in-order prefix of the seven stages with exactly one event per completed stage
    - **Validates: Requirements 5.1, 5.6, 5.7, 5.14, 12.10, 13.7**
    - _Properties: P8_

- [x] 31. AI_Gateway (Requirement 11) — Python, first after the runtime head because every remaining Agent's narrative depends on it
  - [x] 31.1 Implement the pluggable Model_Provider adapter layer
    - Create `financeos/ai/providers/provider.py` with a `ModelProviderAdapter` **Protocol** (`name`, `complete(payload, timeout_ms)`, token accounting, failure classification into `rate_limit` / `timeout` / `provider_error`) so providers are swappable without touching routing and `mypy` checks conformance structurally
    - Implement `financeos/ai/providers/openrouter.py`, `financeos/ai/providers/gemini.py` and `financeos/ai/providers/groq.py`, each reading its credential from the process environment provisioned from `ConfigurationService.readCredentialForServerUse` on the TypeScript side
    - The Gateway has no database access, no Postgres connection, and no access to the Financial_Tool_Layer
    - _Requirements: 11.1, 14.5_

  - [x] 31.2 Wire the per-Task_Class provider chains
    - Define `PROVIDER_CHAINS` in `financeos/ai/chains.py` exactly as design.md's routing table specifies: complex reasoning **OpenRouter → Gemini → Groq**, document analysis **Gemini → OpenRouter → Groq**, fast classification **Groq → Gemini → OpenRouter**
    - One fixed ordered chain of exactly three providers per Task_Class, with the first-provider-first rule intact so a request always begins at the head of its chain
    - Because OpenRouter is itself a gateway, the adapter reports the **resolved underlying model name** in the metering payload so the TypeScript side records it in `model_requests.model_name` and cost attribution against the per-model rate table stays accurate
    - _Requirements: 11.1, 11.2, 11.3, 11.4_

  - [x] 31.3 Implement routing, retry and failover
    - Create `financeos/ai/gateway.py` with `route`: retry the **same** provider on rate limit or timeout after 1000 ms then 2000 ms for a maximum of 2 retries then fail over; fail over immediately on any other error with no retry; attempt a maximum of 3 providers per request
    - On chain exhaustion return `provider_unavailable` naming each attempted provider, its failure category and its elapsed milliseconds
    - Timeout is the Tenant-configured 1000..60000 ms defaulting to 30000 ms, supplied to the Gateway rather than read from the database
    - _Requirements: 11.1, 11.5, 11.6, 11.7_

  - [x] 31.4 Implement the `model_requests` storage and server-side cost computation (TypeScript)
    - Add the `model_requests` migration per design.md with index `model_requests_month_idx`
    - Add the per-provider, per-model rate table in paise per thousand tokens and compute `cost_paise` through `CalculationService.applyRate` so the rounding adjustment is explicit and the result is an exact integer paise value
    - `POST /internal/model-requests` from task 29.6 writes the row: provider, model, declared Task_Class, attempt count, input and output token counts, the computed cost, latency in milliseconds, outcome, and the per-attempt records; failed requests are recorded too with `outcome = 'provider_unavailable'` so a Tenant's usage view reflects spend on failed attempts rather than hiding it
    - The rate table lives next to the Calculation_Service that consumes it, so a price change is a TypeScript change and needs no Python deploy
    - _Requirements: 11.7, 11.8_

  - [x] 31.5 Implement gateway-side measurement and metering (Python)
    - The Gateway measures what only it can observe — input and output token counts and elapsed latency in milliseconds — and posts them to `POST /internal/model-requests` together with the provider, the resolved model name, the declared Task_Class, the attempt count, the outcome and the per-attempt failure records
    - It posts **no cost**: it computes no cost, holds no rate table, and opens no database connection. It receives `cost_paise` back as a decimal string, parses it through `from_wire`, and includes it in the `GatewayResult` handed to the Agent
    - _Requirements: 11.7, 11.8_

  - [x] 31.6 Implement the monthly cost cap check (Python)
    - `enforce_monthly_cap` calls `GET /internal/model-cost-cap` **before the first provider attempt** and branches on the returned `exceeded` flag, performing no comparison of its own — the `>=` comparison and the `model_request_rejected_cost_cap` append both happen on the TypeScript side
    - On `exceeded` return `cost_cap_exceeded` carrying `month_to_date_paise` and `cap_paise` parsed through `from_wire`, and stop narrative generation only; tool-grounded figures remain available
    - _Requirements: 11.13_

  - [x] 31.7 Implement payload bounds and credential stripping
    - Enforce a maximum of 200 tool values and 100000 input characters, **rejecting rather than silently truncating** so no legitimate figure is dropped from the validator's allowed set; bound model output at 8000 characters
    - `strip_credentials` walks the assembled payload matching on **value** rather than key name and applies the same stripping to the recorded request and response records
    - _Requirements: 11.9, 11.10, 11.12_

  - [x] 31.8 Implement the usage breakdown endpoint (design.md marks this thin-sliceable)
    - `GET /ai/usage?from=&to=` on the TypeScript side over a 1..366 day range, aggregating `model_requests` and returning total cost in INR and total request count broken down by Model_Provider
    - _Requirements: 11.14_

  - [x]* 31.9 Write unit tests for gateway routing
    - Under pytest: chain order per Task_Class; two retries then failover on rate limit and timeout; immediate failover with no retry on other errors; the 3-provider ceiling; branching on the `exceeded` flag without recomputing the comparison; bound rejection rather than truncation; a credential value planted in a free-text field is stripped
    - _Requirements: 11.1, 11.5, 11.6, 11.9, 11.12, 11.13_

- [x] 32. FinanceOS_Response_Validator (Requirement 11.11, 12.6) — Python, next to the Model interaction it validates
  - [x] 32.1 Implement the validator
    - Create `financeos/ai/response_validator.py`: extract every monetary token from the narrative (`₹`-prefixed amounts, bare Indian-grouped digit groups, decimal rupee amounts, and lakh and crore phrasings), normalise each to integer paise through the Python `parse_inr` and the lakh/crore multipliers, and require exact `int` membership in `allowed_values_paise` with **zero tolerance**
    - `allowed_values_paise` arrives as a list of decimal strings and is parsed through `from_wire` before any set-membership comparison, because a coerced double in that set would silently widen or narrow what counts as grounded
    - Any unmatched token, any figure with no Evidence_Chain identifier, or any identifier that does not resolve withholds the **entire** response and returns a validation-failure indication naming the offending figure; the `response_withheld` Audit_Event recording the withheld response and the offending figure is appended on the TypeScript side, since Python opens no database connection
    - _Requirements: 11.10, 11.11, 12.6_

  - [x] 32.2 Write the validator adversarial test suite
    - Create `tests/validator/test_adversarial.py` under pytest implementing every row of design.md's adversarial table against a fixed small allowed value set: exact repetition released; "about 8.4 lakh" withheld; off by 1 paisa withheld; a sum of two allowed values withheld; a percentage-derived invention withheld; a figure with no chain identifier withheld; an unresolvable chain identifier withheld; "3.82 Cr" released; "3.8 Cr" withheld; nine correct figures and one fabricated withholds the entire response
    - These are Python tests because the token-extraction and lakh/crore normalisation logic is Python; testing it from the TypeScript side would only test the transport
    - Each withholding case additionally asserts the `response_withheld` Audit_Event was appended
    - _Requirements: 11.11, 12.6_

- [x] 33. India_Compliance_Agent (Requirement 6)
  - Detection and review only, under the `India_Compliance_Agent` catalogue identity: no statutory output and no directive tax position anywhere in the surface. Directory names under `src/agents/compliance/` are retained as code organisation.
  - [x] 33.1 Implement GSTIN structural validation
    - Create `src/compliance/gstin.ts` with the five rules checked in order returning the first failing rule by name: length 15, state code 01..38, chars 3..12 as five letters four digits one letter, char 14 is `Z`, char 15 alphanumeric; structural only, no checksum and no registration lookup
    - _Requirements: 6.3, 6.9_

  - [x]* 33.2 Write unit tests for the GSTIN validator
    - Valid GSTINs at state codes `01` and `38`, rejections at `00` and `39`, and one input per failing rule so each of the five rule values is produced at least once
    - _Requirements: 6.3_

  - [x] 33.3 Implement the compliance Exception categories
    - Create `src/agents/compliance/agent.ts` as the India_Compliance_Agent run, examining Razorpay_Invoices, GSTIN values, HSN_SAC values, tax amounts, Credit_Notes and Payments over a range of at most 366 days defaulting to the preceding 90, reporting per-type examined counts
    - Every Exception and Audit_Event this run writes carries `actor_id = 'India_Compliance_Agent'`; the declared Task_Class for invoice-field and GSTIN reasoning is `document_analysis`
    - Produce `missing_gst_information`, `invalid_gstin`, `gst_anomaly` against the configured valid GST rate set, `record_needing_review` against the configured review threshold, and `unmatched_credit_note`, each with the impact and Source_Records specified in the requirements
    - Upsert on re-run through the existing fingerprint path
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.10, 6.12_

  - [x] 33.4 Implement the ITC discrepancy computation and tool
    - Expected ITC as Σ invoice GST plus Σ `GST_On_Fee` on examined Payments, recorded ITC as Σ ITC Ledger_Entry amounts over the same range, discrepancy as expected minus recorded with the contributing Source_Record identifiers for each sum; create an `itc_discrepancy` Exception when the absolute discrepancy is at or above 1 paisa
    - Implement `get_itc_discrepancy` and add it to the contract suite
    - _Requirements: 6.4, 12.1, 12.2_

  - [x] 33.5 Implement `get_compliance_findings`
    - Findings, TDS review items, per-type examined counts and the review-only disclaimer string; add to the contract suite
    - _Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 6.7, 6.8, 6.10, 12.1, 12.2_

  - [x] 33.6 Implement TDS_Review_Items (design.md marks this thin-sliceable)
    - Add the `tds_review_items` migration with `tds_review_uniq`; for a vendor Payment matching a configured TDS-applicable category, record the Payment id and amount, the matched category, the configured rate, and the TDS amount computed through `applyRate` rounded half up with the rounding adjustment stored; upsert on re-run
    - _Requirements: 6.7, 6.11, 6.12, 15.9_

  - [x] 33.7 Implement the compliance views with the disclaimer
    - Create `src/app/compliance/ComplianceFindings.tsx` rendering every finding, TDS_Review_Item and ITC_Discrepancy with the review-only, not-authoritative-tax-advice statement in the same view; produce no statutory output and no directive tax position anywhere in the surface
    - _Requirements: 6.8, 6.9_

- [x] 34. Cash_Agent (Requirement 8)
  - [x] 34.1 Migration: cash forecast schema group
    - `cash_forecasts` (horizon 30..180, `partial_history`, `runway_months`, `runway_basis`, `is_simulation`), `cash_forecast_days`, `cash_forecast_components` with the `date_basis` CHECK and the composite foreign key
    - _Requirements: 8.1, 8.2, 8.7, 8.9, 8.11, 8.12_

  - [x] 34.2 Implement the day-by-day projection
    - Create `src/agents/cash/forecast.ts` with `projectForecast`: each day's closing cash is the prior day's closing plus that day's inflows minus that day's outflows over the configured Forecast_Horizon, with `assertInRange` on every closing value
    - Record per component per day the amount in integer paise and the Source_Record identifiers; assign expected Settlement dates from Razorpay settlement cycle data with `date_basis = 'settlement_cycle'`, falling back to capture date plus 3 calendar days with `date_basis = 'default_delay'`, recording the basis and the contributing identifier
    - Report the available data window and flag partial history when the Tenant has fewer than 30 days of ingested objects
    - _Requirements: 8.1, 8.2, 8.9, 8.12_

  - [x] 34.3 Implement affordability, Headroom and the risk bands
    - `affordability` returns closing cash, obligation, Safety_Buffer, Headroom and the risk level `low` / `medium` / `high`, plus shortfall and buffer shortfall floored at `0n`, and the primary cause with the four-step tie-break chain
    - At or above obligation plus buffer, report affordable with both shortfalls `0n`, no primary cause and risk `low`
    - Reject dates earlier than the current date or later than the last day of the Forecast_Horizon with no answer, an error naming the supported range, and no write
    - Resolve the Safety_Buffer as the configured integer paise value or 10 percent of the obligation rounded half up, recording the basis
    - _Requirements: 8.3, 8.4, 8.5, 8.13, 8.14_

  - [x] 34.4 Implement Runway and wire the Control_Tower Runway cell
    - Runway as current cash divided by average net monthly outflow rounded half up to 1 decimal place while that outflow is above `0n`; not applicable with the non-positive-outflow reason otherwise
    - Replace the not-yet-available placeholder in `MetricCell` with the live value, rendering the non-numeric state when Runway exceeds 120.0 months or is reported not applicable
    - _Requirements: 3.4, 3.12, 8.10, 8.11_

  - [x] 34.5 Implement ranked actions and Simulation (design.md marks both thin-sliceable)
    - At most 5 recommended actions ordered by improvement descending with the earliest-effective-date, action-type-name and target-identifier tie-breaks; Simulation returns per-day closing values, Headroom, shortfall and risk level while creating no Proposal and writing no change; an execution request creates a policy-gated Proposal with action type, targets, impact and Evidence_Chain
    - _Requirements: 8.6, 8.7, 8.8_

  - [x] 34.6 Implement `get_cash_forecast` and `simulate_cash_action`
    - Both read-only, both returning Evidence_Chains for every monetary figure; add both to the contract suite
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.9, 8.10, 8.11, 8.12, 12.1, 12.2_

- [x] 35. Finance_Analyst recovery capability (Requirement 9)
  - Failed_Payment recovery is a **second capability on the Finance_Analyst identity, not a new Agent**: recoverable value is a revenue figure and a Failed_Payment cohort is one of the contributors a period explanation would name, so the recoverable aggregate and the revenue change it belongs to are computed by one Agent over one resolved period scope. Directory names under `src/agents/recovery/` are retained as code organisation. Task_Class is declared per request, so this capability declares `fast_classification` for failure-reason categorisation while task 36's explanation capability declares `complex_reasoning` under the same identity.
  - [x] 35.1 Implement the failure profile and the 70/30 blend
    - Create `src/agents/recovery/probability.ts`: report the Razorpay failure reason, prior Payment count, most recent successful method (or `none`), and lifetime value in integer paise
    - Per-channel probability as 70 percent of the customer rate plus 30 percent of the Tenant rate over the Lookback_Window, rounded half up to an integer 0..100; fall back to Tenant-level rates only when the customer has zero successful history, identifying the basis; report the sample count and the Lookback_Window used
    - Channel selection by highest probability, then more Tenant successes, then the fixed order UPI, card, netbanking, wallet
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7, 9.9_

  - [x]* 35.2 Write unit tests for the recovery blend
    - Zero-attempt denominators, the Tenant-level fallback branch, and the channel tie-break down to the fixed order
    - _Requirements: 9.4, 9.7, 9.9_

  - [x] 35.3 Implement Proposal creation and suppression
    - Create a single-channel retry Proposal only when the available historical Payment count is at or above Minimum_Sample_Size; below it create no Proposal and report the available count, the configured minimum and the below-minimum condition
    - Suppress Proposals for already-recovered and already-retried Failed_Payments and for those older than Maximum_Retry_Age, reporting the exclusion reason and the age in days
    - Every retry Proposal carries `agent_name = 'Finance_Analyst'` and every stage Audit_Event carries `actor_id = 'Finance_Analyst'`; this is the one Finance_Analyst path that can write, so it passes the same Policy_Engine gate and records the same Authorization shape as any other write
    - _Requirements: 9.6, 9.8, 9.10, 9.11, 16.7, 16.8_

  - [x] 35.4 Implement `get_failed_payment_recovery_profile`
    - Read-only tool returning the profile, the four channel probabilities with sample counts and basis, the Lookback_Window and any exclusion reason; add to the contract suite
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.9, 9.10, 9.11, 12.1, 12.2_

  - [x] 35.5 Implement the recoverable aggregate (design.md marks this thin-sliceable)
    - Total recoverable value as the integer paise sum of in-window, non-excluded, within-age Failed_Payments with the included count reported
    - _Requirements: 9.12_

  - [x] 35.6 Implement `initiate_payment_retry`
    - Write-capable tool requiring `proposal_id` and `authorization_id`; the only tool calling a Razorpay write API; record the Razorpay request and response identifiers on the Proposal so VERIFY has something observable to compare against; add to the contract suite
    - _Requirements: 9.6, 12.10, 5.11_

- [x] 36. Finance_Analyst period explanation capability (Requirement 10)
  - Period-over-period explanation is the **read-only capability on the Finance_Analyst identity**, the same identity task 35 gives the recovery capability to: both answer "what happened to revenue and what can be done about it" over the same Payment and Refund population, so the recoverable-value aggregate and the revenue change it belongs to are computed by one Agent over one resolved period scope rather than by two Agents with independently resolved windows. Directory names under `src/agents/analyst/` are retained as code organisation. This capability creates no Proposal and declares `complex_reasoning`, while task 35's recovery capability declares `fast_classification` under the same identity — Task_Class is a property of the request, not of the identity. Every Audit_Event this capability writes carries `actor_id = 'Finance_Analyst'`.
  - [x] 36.1 Implement period comparison
    - Create `src/agents/analyst/period.ts`: revenue as successful Payments minus Refunds, expense as Razorpay_Fee plus GST_On_Fee plus expense-account Ledger_Entries, margin as revenue minus expense, and cash movement as closing minus opening cash, all in integer paise, over the specified period compared against the immediately preceding equal-length period
    - Percentage change reported when the prior value is above 0, rounded half up to 1 decimal place, and as not applicable at 0 or when the prior period contains zero transactions
    - Default period is the trailing 30 days with the resolved start and end dates echoed; period lengths outside 1..366 days return an error naming the supported range with no figures and no state change
    - Every figure comes from a Financial_Tool; Model content is restricted to narrative
    - _Requirements: 10.1, 10.2, 10.3, 10.6, 10.7, 10.8, 10.9_

  - [x] 36.2 Implement `get_period_comparison`
    - Current and prior metrics, changes, unusual transactions with the total count, and contributors, each monetary figure carrying its Evidence_Chain; add to the contract suite
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.8, 10.9, 12.1, 12.2_

  - [x] 36.3 Implement unusual transactions and top contributors (design.md marks both thin-sliceable)
    - Unusual transactions at or above the configured Unusual_Multiple of the 180-day median, capped at 20 rows with the total count; up to 3 top contributors ordered by descending absolute contribution with the transaction-date and identifier tie-breaks and the count reported when fewer than 3 exist
    - _Requirements: 10.4, 10.5_

- [x] 37. Complete the end-to-end demo path
  - [x] 37.1 Add steps 6 and 7 to the demo path test
    - Extend `test/e2e/demo-path.test.ts`: ask "Why am I missing ₹3.82 lakh in settlements?" through `POST /agents/reconciliation/ask`, assert the released response contains only figures present in the tool output value set each carrying a resolvable Evidence_Chain identifier, then re-run the same step with the AI_Gateway stubbed to return a narrative containing one fabricated figure and assert the **entire** response is withheld with the `response_withheld` Audit_Event recorded
    - Implement the `POST /agents/reconciliation/ask` route on the TypeScript side wiring TypeScript API → Python Agent Engine → Financial_Tool_Layer over `POST /internal/tools/{tool_name}` → AI_Gateway → validator → response, with every monetary field crossing the boundary as a decimal string, streaming first displayable content within 15 seconds
    - _Requirements: 4.6, 4.7, 11.9, 11.11, 12.4, 12.6, 15.4_
    - _Properties: P6, P15_

- [x] 38. **PROPERTY GATE — Slice 4. Final gate.**
  - Assert P15 passes in both directions. Run the validator adversarial suite in full under pytest and assert every row behaves as tabled. Re-run all fifteen properties P1 through P15 over the complete dataset shape and assert all pass, across both suites — fast-check on the TypeScript side and Hypothesis on the Python side, per design.md's ownership table. P12 and P15 are owned by both runtimes: the Python half of P12 asserts every paise value is an `int` in range and never a `float`.
  - Run the full 12-stage CI ordering in order, stopping at the first failure: (1) TypeScript typecheck and lint `tsc --noEmit` + ESLint, (2) Python typecheck and lint `ruff` + `mypy`, (3) TypeScript unit tests under Vitest, (4) Python unit tests under pytest, (5) database tests against Supabase local with migrations applied, (6) contract tests for every Financial_Tool, (7) transport schema and wire round-trip tests across both runtimes, (8) property tests P1–P15 seeded across both suites, (9) validator adversarial tests under pytest, (10) end-to-end demo path.
  - Stages 1 through 10 gate the merge. Stage 11 (Razorpay test-mode integration: paging, retry/backoff, credential rejection) and stage 12 (performance bounds against a 5000-payment fixture) are advisory because they depend on an external service and on machine performance; a failure there opens an issue and a second consecutive failure escalates to blocking.
  - Stage 7 runs before stage 8 deliberately: a wire contract failure makes every cross-runtime property result untrustworthy, so it is cheaper to fail at the transport stage than to debug a P12 or P15 failure that turns out to be a serialization bug two stages later.
  - This gate closes the fifteen properties and the ten stages that existed when it was written. Slice 5 follows it and adds no sixteenth property — catalogue closure is a compile-time union plus two database CHECK constraints, and provider verification is non-deterministic against a live provider — so the final CI ordering, renumbered to stages 0 through 15 with stage 0 secret scanning ahead of the compiler, is asserted at task 43 rather than here.
  - Ensure all tests pass, ask the user if questions arise.

---

## Slice 5 — closure (Requirement 16, Requirement 17, Requirement 18)

Three bodies of work that Slices 1 through 4 predate. Ordered within the slice by the rationale design.md gives: catalogue closure and secret scanning first because both are cheap now and expensive later — a fifth identity that has already reached a run row, an Audit_Event and a UI label is a data migration, and a secret scanner added after a key has reached a published artifact starts with a rotation rather than a scan — then the Provider_Runtime_Verifier, then the demo's second half, then the full CI ordering.

- [ ] 39. Agent_Catalogue closure enforced at three points (Requirement 16)
  - The catalogue is closed at exactly four identities in the **type system, the route boundary and the database**, not merely in documentation. One declaration, three enforcement points. Nothing in this task changes what any capability computes: Route reconciliation and Failed_Payment recovery keep the algorithms tasks 19.x and 35.x already shipped, and the directory names under `src/agents/` stay as they are, because capability ownership is an identity decision rather than a code-organisation one.
  - [ ] 39.1 Implement the closed `AgentName` union and the display-name map
    - Create `src/agents/catalogue.ts` exporting `type AgentName` as the closed union of exactly `'Finance_Analyst' | 'Reconciliation_Agent' | 'India_Compliance_Agent' | 'Cash_Agent'`, `AGENT_CATALOGUE` as `[...] as const satisfies readonly AgentName[]`, and `AGENT_DISPLAY_NAME: Record<AgentName, string>` mapping to exactly `'Finance Analyst'`, `'Reconciliation Agent'`, `'India Compliance Agent'`, `'Cash Agent'`
    - Because the map is typed `Record<AgentName, string>` it is total by construction, so a fifth identity is a compile error at the map and at every `switch` over `AgentName` rather than a missing label discovered at runtime
    - Replace every free-text agent label in the UI with an `AGENT_DISPLAY_NAME` lookup across navigation, conversation headers, run history, Proposal ownership and run status, and present no capability sub-label as an identity: a Route payout conversation is headed "Reconciliation Agent" and a recovery conversation "Finance Analyst"
    - _Requirements: 16.1, 16.2_

  - [ ] 39.2 Enforce the catalogue at the route boundary before a run row exists
    - Replace the Slice 1 and Slice 4 agent path segments with `z.enum(AGENT_CATALOGUE)` on `POST /agents/{agent}/runs` (task 15.1) and `POST /agents/{agent}/ask` (task 37.1), so both routes accept only the four identities
    - A non-catalogue identifier returns a validation error and **creates no Agent run row**: the rejection happens before the Agent Engine is reached, before any Model budget is consumed, and before any Audit_Event with an agent actor could be appended. This is route-level rejection rather than a downstream lookup failure, because a downstream failure would already have created a run row naming an identity outside the catalogue
    - _Requirements: 16.3_

  - [ ] 39.3 Migration: catalogue CHECK constraints on the audit and proposal tables
    - Add `audit_events_agent_actor_in_catalogue` as `CHECK (actor_kind <> 'agent' OR actor_id IN ('Finance_Analyst', 'Reconciliation_Agent', 'India_Compliance_Agent', 'Cash_Agent'))`, so an Audit_Event with an agent actor names exactly one catalogue identity
    - Add the `proposals.agent_name` CHECK over the same four values, so Proposal ownership is attributable to exactly one identity
    - Same closed set as the TypeScript union in 39.1, which is what makes adding a fifth identity a schema change, an API change, a UI change and a constraint change rather than a string edit
    - _Requirements: 16.1, 16.2, 16.4_

  - [ ] 39.4 Write the catalogue closure enforcement tests
    - Route rejection: `z.enum(AGENT_CATALOGUE)` accepts each of the four identities, and rejects `Marketplace_Agent`, `Recovery_Agent`, `Analyst_Agent`, `Compliance_Agent`, an empty string and a case-variant of a valid name — asserting in **every rejection case that no Agent run row was created**, which is the load-bearing half of Requirement 16.3
    - `AGENT_DISPLAY_NAME` asserted total over `AgentName` and to contain exactly the four Requirement 16.2 display strings, with no free-text agent label remaining in the UI surface
    - Database tests: an `audit_events` insert with `actor_kind = 'agent'` and `actor_id = 'Marketplace_Agent'`, and a `proposals` insert with `agent_name = 'Recovery_Agent'`, are each rejected by their CHECK constraint, and all four catalogue values are accepted
    - Ownership assertions over the two dual-capability identities: Route Exceptions and stage Audit_Events from task 19.5 carry `actor_id = 'Reconciliation_Agent'`, and retry Proposals from task 35.3 carry `agent_name = 'Finance_Analyst'`
    - _Requirements: 16.1, 16.2, 16.3, 16.4, 16.5, 16.7_

- [ ] 40. Secret_Safety_Gate — seven enforcement channels (Requirement 17.2)
  - Seven channels, one per artifact Requirement 17.2 names, each a distinct mechanism at a distinct moment because no single mechanism covers a build-time channel and a runtime channel. Four **refuse** and three **redact or exclude**, and the split is decided per channel rather than globally: redaction is right where the artifact keeps its value without the secret, refusal is right where the artifact would be a durable copy of it.
  - [ ] 40.1 Implement the credential value matcher and the key shape matcher
    - Create `src/security/secret-matchers.ts` with a value matcher initialised once at process start from the same `ConfigurationService` server-only read path, holding the resolved values in memory only and never serializing them, and a shape matcher over the entropy and prefix shapes of Gemini, Groq and OpenRouter keys
    - Match on **value, not key name**: a filter keyed on names like `GROQ_API_KEY` catches the expected case and misses the one that matters — a credential that leaked into a free-text field, an error message or a nested object under an innocuous key
    - Shape matching complements it at build time, where the runner may hold no production credential at all and so cannot match by value. Neither is sufficient alone: shape matching false-positives on high-entropy non-secrets, value matching cannot see a value it does not hold. A shape match is a hard failure requiring an explicit allowlist entry
    - _Requirements: 17.1, 17.2_

  - [ ] 40.2 Implement the four refusing channels — source, fixtures, bundle, Audit_Event payload
    - Channel 1, source files: a pre-commit hook and CI stage 0 scan of the working tree that exits non-zero naming the file and line **without printing the matched value**, blocking the commit and the CI run
    - Channel 6, test fixtures: the same scan over fixture files, plus an assertion that no fixture contains a value resolvable from the environment — a fixture is a source file for this purpose
    - Channel 2, client bundle: a post-build scan of every emitted client chunk before any artifact is published, plus an assertion that no `process.env` read of a provider key name survived into client output; a match blocks the build so no bundle is produced
    - Channel 7, Audit_Event payloads: a value-matching assertion inside `AuditService.append` before the row is written that **raises rather than redacting**, so no Audit_Event is appended carrying a credential and no append-only record is silently altered
    - These four refuse because each artifact would be a durable copy of the secret — a commit, a fixture, a published bundle or an append-only row
    - _Requirements: 13.2, 17.2_

  - [ ] 40.3 Implement the three redacting and excluding channels — logs, prompts, errors
    - Channel 3, log records: a redaction filter in the logger keyed on the resolved credential values, replacing a match with a fixed marker so the line is still written and still useful
    - Channel 4, Model prompts: `strip_credentials` from task 31.7 is the enforcement point; assert the same stripping is applied to the recorded request and response records, not only to the outbound payload
    - Channel 5, error messages: re-wrap every Model_Provider and Razorpay client error at its boundary into a typed error carrying a status code and a closed-set code, never the original message, the request headers or the response body. A provider error body is the single most likely carrier of a key fragment, because some providers echo a prefix of the rejected key, and never propagating the original object is cheaper than sanitising it and composes downstream
    - The two Requirement 14.5 channels that exclude by construction stay that way: no API response shape has a field for a credential, and no propagated error object holds one
    - _Requirements: 11.12, 14.5, 17.2_

  - [ ] 40.4 Write the seven-channel credential-absence test suite
    - One suite over all seven channels, generating credential-shaped strings, implementing every row of design.md's channel table: a planted credential in a fixture tree fails the scan naming file and line with the matched value absent from the output; a build referencing a provider key from client-reachable code fails with the emitted chunk set asserted empty; a credential written through the logger in a message, in a nested field and under an unexpected key emerges as the marker in all three; `stripCredentials` removes it from a free-text field, a nested object and an array element; a provider error whose body echoes a key prefix propagates with no substring of the credential and no header
    - Channel 7's assertion is the one to be explicit about: `AuditService.append` **raises and the `audit_events` row count is unchanged**, which is what distinguishes refusing from sanitising — a redact-and-append implementation would satisfy a naive "no credential in the Audit_Log" check while silently altering an append-only record
    - Wire the suite as CI stage 11, with the client-bundle channel running against the built output
    - _Requirements: 11.12, 13.2, 14.5, 17.2_

- [ ] 41. Provider_Runtime_Verifier (Requirement 17.1, 17.3–17.18)
  - Answers "is each Model_Provider reachable with the credential this deployment holds, and does routing actually behave as specified" with real provider calls and no Tenant data. The tension is that verifying a provider requires a credential and produces a provider response, which are exactly the two things that must never be echoed; every decision below resolves it in one direction — **the diagnostic surface is built from a closed set of values the system generates itself, never from provider or credential text.** A redaction filter can miss a case; a closed set has no path by which foreign text enters.
  - Split per the runtime rule with no exception carved: credential resolution and result persistence are TypeScript because they are credential handling and database writes; probe execution is Python because it is Model interaction.
  - [ ] 41.1 Implement credential resolution with the source recorded and a fixed mask
    - Extend the Configuration_Service with `resolveForServerUse(tenantId, kind)` returning `ResolvedCredential | null`, resolving **Server_Runtime_Environment first, then Encrypted_Secret_Storage**, and reporting which of the two supplied the value so a caller can record it without holding it
    - `maskedReference` returns `MaskedCredential` whose `masked` is the fixed constant `'••••••••'`, **not a last-four truncation**: a key suffix is still key material, it is enough to correlate a key across systems, and provider error bodies sometimes echo a prefix — so a masked reference showing real characters and an error showing real characters can between them reconstruct more than either alone
    - Returning `null` rather than throwing is what lets `missing_credential` be one of the six outcomes with zero requests sent, instead of an absent credential having to be distinguished from a failed lookup inside an exception handler
    - The `credential_source` field is a design addition beyond the Requirement 17.11 minimum and design.md marks it thin-sliceable, so it may follow the six outcomes; it is worth carrying because the most common misconfiguration is a credential present in one store and stale in the other, and an `invalid_credential` outcome with no indication of which store was read leaves an operator guessing
    - _Requirements: 17.1, 17.5, 17.11_

  - [ ] 41.2 Implement the `NON_FINANCIAL_PROBE` constant and `ProbeSpec`
    - Create `NON_FINANCIAL_PROBE` as a compile-time constant carrying a fixed `system`, a fixed `user` and `max_output_tokens: 4`, with **no interpolation point**: the constructor takes no Tenant-derived argument at all, so there is no parameter through which a Tenant identifier, a Source_Record field, a monetary figure or Tenant-derived text could enter
    - The probe content is identical for every Tenant and every check, which is what makes it incapable of being a covert channel — two probes differ only in which provider they target and which credential authenticates them
    - `ProbeSpec` carries `provider`, an optional `task_class` present for a Routing_Verification and absent for a readiness check, `timeout_ms` from the Requirement 11.5 configured 1000..60000 ms value, and an optional `controlled_outcome` of `rate_limit | timeout | provider_failure`
    - Fault injection is expressible **only** as an explicit field on an explicit verification request — no ambient mode flag and no environment switch — so it cannot reach the Tenant request path, where `ProbeSpec` is never constructed
    - _Requirements: 17.4_

  - [ ] 41.3 Implement `POST /internal/provider-probe` and the Python probe executor
    - TypeScript: server-to-server only under the same service-credential plus forwarded-user-context model as the other internal endpoints, additionally requiring `manage_credentials` on the forwarded context, both checks running before the body is parsed and either failure audited
    - Accept a `ProbeSpec` **only from the fixed constructor**, rejecting any body carrying an unexpected key as a schema violation, so the endpoint cannot be repurposed into a general provider proxy carrying arbitrary text
    - It is the one internal endpoint that carries a credential in its request body, so three consequences follow: the request is **never logged, not even at debug level**; the response contains **no request echo**; and the response type has no `response_body` and no credential field
    - Python: create the probe executor sending the probe through the **same `ModelProviderAdapter` protocol the AI_Gateway uses**, so the verified path is the production path rather than a parallel one, returning an outcome, a latency, a resolved model name or `null`, and a closed-set code. It is the one Python component with no Tenant data path at all — not even the internal tool endpoint
    - _Requirements: 17.1, 17.4, 17.6, 17.11_

  - [ ] 41.4 Implement the ordered six-outcome classification and the closed-set diagnostic code
    - Classify into exactly one of `ready`, `missing_credential`, `invalid_credential`, `timeout`, `rate_limit`, `provider_failure`, **in that order**, because HTTP responses satisfy more than one loose description: `missing_credential` is decided before dispatch; then a credential-rejection status is `invalid_credential`; a rate-limit status is `rate_limit`; an expired request timer is `timeout`; any remaining non-success is `provider_failure`; a complete success is `ready`
    - Draw the `invalid_credential` versus `provider_failure` distinction on the response **status, never the body** — reading the body to decide would hold provider text in the classification path, which is exactly what Requirement 17.6 excludes from the result
    - `provider_failure` is the residual bucket by construction, so the six values are exhaustive and a novel provider error cannot produce a seventh outcome or an absent one
    - `diagnosticCode(provider, outcome, httpStatus)` emits `{provider}.{outcome}.{status}` where status is a three-digit observed status or the literal `none`, with an out-of-range status discarded rather than passed through; nothing from a response body and no credential character can enter because no branch reads either
    - _Requirements: 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.11_

  - [ ] 41.5 Migration: provider verification tables with their CHECK constraints and RLS
    - `provider_diagnostic_outcome` enum with the six values; `provider_readiness_results` with the `diagnostic_code` regex CHECK over the closed-set pattern, the `credential_source` CHECK, `missing_credential_has_no_model` and `ready_has_model`; `routing_verifications` with `fallback_assessed_only_when_injected`
    - Both carry `tenant_id UUID NOT NULL`, get `ENABLE` plus `FORCE ROW LEVEL SECURITY` and the same four policies bound to `app.current_tenant_id()` as every other tenant-scoped table; add `provider_readiness_latest_idx` and `routing_verification_latest_idx`
    - **Neither table has a column that could hold a credential or a provider response body**, and that is the point of the shape: the guarantee is the absence of a column, not discipline at the insert site
    - Neither table is append-only. A readiness result is a point-in-time diagnostic, not a financial record, and the Audit_Event appended alongside each check is the immutable record; making the diagnostic table append-only would conflate the two and leave no way to age out stale diagnostics
    - `tenant_id` is on the stored row and not in the probe: the row is Tenant-scoped under RLS because the check was initiated inside a Tenant session, and the probe carries no Tenant identifier because it crosses to a third party
    - _Requirements: 14.1, 14.2, 17.4, 17.5, 17.10, 17.11, 17.15, 17.16_

  - [ ] 41.6 Implement the readiness check run and result persistence
    - `POST /providers/verify-readiness`, gated on `manage_credentials`, executes **exactly 1** Provider_Readiness_Check for Gemini, exactly 1 for Groq and exactly 1 for OpenRouter — a single attempt per provider with no retry, since retry behaviour is verified separately by 41.7
    - Persist one Provider_Readiness_Result per check carrying the provider name, the resolved model name or `null` for the unavailable marker, an integer latency at or above 0, exactly one outcome, the closed-set diagnostic code, the credential source and the check timestamp in UTC to millisecond precision; append an Audit_Event with the provider, outcome, code, latency and initiating User and **no credential value and no provider body**
    - Where no credential resolves, send **zero requests** to that provider and store `latency_ms = 0`, `resolved_model = NULL`, `credential_source = 'none'`, with the other two providers still checked
    - For OpenRouter record the **underlying resolved model name**, which is the same value `model_requests.model_name` holds, so the readiness panel and the cost breakdown name the same thing
    - _Requirements: 17.3, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.11_

  - [ ] 41.7 Implement Routing_Verification over the production `route` AttemptRecords
    - `POST /providers/verify-routing`, gated on `manage_credentials`, calls the **production `route` function** with a `ProbeSpec` and reads back the `AttemptRecord[]` `route` already produces, rather than re-implementing chain logic. A verifier holding its own copy would verify the copy, and a routing bug in `route` would pass verification — the same reasoning that keeps the Financial_Tool_Layer out of Python
    - Read `expected_first_provider` and `expected_next_provider` from `PROVIDER_CHAINS`, the same constant `route` reads, so the expectation and the behaviour cannot drift into separate maintenance
    - Three modes per Task_Class: all providers available marks `first_provider_routing` passed only where the actual first attempt is the chain head and sets `fallback_routing` to `not_applicable`; a controlled `rate_limit` or `timeout` requires the first provider receive **at most 2** retries and the next provider be chain position 2; a controlled `provider_failure` requires **exactly 0** retries and the next provider be chain position 2
    - The retry bounds are the only place the Requirement 11.5 versus 11.6 distinction becomes externally observable, and they are deliberately asymmetric: *at most* 2 on a transient outcome, because a retry that succeeds first time is correct behaviour and asserting exactly 2 would fail a working system, and *exactly* 0 on a non-transient one, because a single retry there doubles failover latency with no chance of a different result
    - Assert at most 3 providers attempted; record the declared Task_Class, the ordered attempts with per-provider retry counts, the expected and actual next provider, the two pass/fail results and the timestamp. A `failed` result is **recorded rather than thrown** — the verifier reports a routing defect, it does not repair one or crash on one
    - _Requirements: 11.5, 11.6, 17.12, 17.13, 17.14, 17.15, 17.16, 17.17_

  - [ ] 41.8 Implement the cost-cap exemption and the verification rate limit
    - Verification probes do not count against the Tenant monthly Model cost cap and are recorded in `provider_readiness_results` and `routing_verifications` rather than `model_requests`. A cap that disables the tool for diagnosing the cap is a self-locking failure mode, and "nothing is working" is precisely the state in which an operator most needs the readiness panel
    - Keeping probes out of `model_requests` also keeps `GET /ai/usage` honest: that view answers what the Agents spent, and diagnostic probes are not Agent spend
    - Bound the exemption so it cannot become an unmetered channel: at most 3 probes per readiness verification, at most 3 attempts per Task_Class routing verification, 4 output tokens and well under 100 input characters each, both routes gated on the narrowest Permission in the set, and **1 verification per Tenant per minute** — above that, reject with a rate-limited response naming the retry-after interval that **sends no probe** and append `provider_verification_rate_limited`
    - _Requirements: 11.13, 11.14, 17.3_

  - [ ] 41.9 Implement `GET /providers/readiness` and the readiness panel
    - Route gated on `manage_credentials` returning the latest Provider_Readiness_Result for each of Gemini, Groq and OpenRouter and the latest Routing_Verification for each Task_Class
    - Panel renders the provider name, the resolved model name or the unavailable marker, the latency in milliseconds, the outcome as one of the six values with a plain-language label, the diagnostic code, the credential source and the check timestamp
    - It renders **no credential value, no provider authorization header, no provider request body and no provider response body — in any state, at any privilege level, behind any expander.** This holds structurally rather than by omission: none of the four is in the API response shape, because none is in the stored row, because none is in the internal endpoint's return type
    - A User without `manage_credentials` gets the panel **absent from their navigation payload**, not locked or empty: a locked panel would confirm which providers are configured, which is exactly the information the Permission exists to withhold. Denial names the required Permission and changes no state
    - _Requirements: 14.6, 14.9, 17.18_

  - [ ] 41.10 Write the provider verification test suite
    - These are example-based contract tests, not property tests, and deliberately so: a live provider is non-deterministic in latency, resolved model and error kind, so there is no "for all provider responses" statement a test could establish — 100 iterations against a real provider would produce 100 differently-flaky results. What is deterministic is the classification, the code construction, the routing order and the retry counts, and each is finite and fully enumerated here, which is why Requirement 17 adds no sixteenth numbered property
    - **Readiness classification**, 18 cases against a stubbed `ModelProviderAdapter`, one per outcome per provider: `missing_credential` asserts **0 requests reached the adapter** with null model, zero latency and `credential_source = 'none'`; `invalid_credential` asserts the serialized row contains neither the stub's credential string nor its body string; `timeout` asserts latency at or above the configured timeout; `rate_limit` asserts **exactly 1** request reached the adapter; an unmapped 5xx asserts the residual bucket rather than an absent outcome; success asserts the OpenRouter stub reports the underlying model name rather than `openrouter`
    - **Probe content**, asserting Requirement 17.4 directly: scan the serialized probe for the seeded Tenant identifier, every seeded Source_Record identifier, every seeded monetary value in both paise and Indian_Number_Format rendering, and every resolvable credential value, asserting zero matches for each; then assert the probe is **byte-identical across two different Tenants**, which is the assertion that closes the covert-channel question
    - **Diagnostic code construction** over the generated space of 3 providers × 6 outcomes × statuses `99`, `100`, `599`, `600` and `null`, asserting every output matches the closed-set pattern and that out-of-range statuses collapse to `none` rather than passing through
    - **Routing**, the nine cases of design.md's table — three Task_Classes × three modes — asserting the first attempt, the retry bound (at most 2 on `rate_limit`/`timeout`, exactly 0 on `provider_failure`), the next provider, the 3-provider ceiling, and that expected values were read from `PROVIDER_CHAINS` rather than hard-coded in the test
    - **A negative case** injecting a deliberately wrong chain into `PROVIDER_CHAINS` and asserting `first_provider_routing: failed` is produced. Without it, all nine positive cases would also pass against a verifier that returned `passed` unconditionally
    - **Surface and permission**: the response shape carries no credential, authorization header, request body or response body field; a User without `manage_credentials` receives a permission-denied error naming the required Permission with the panel absent from the navigation payload; a second verification inside the rate-limit window is rejected with **zero probes sent**
    - **Cost-cap exemption**: a Tenant at or above its monthly cap can still run both verifications, and neither writes a `model_requests` row
    - **Database**: the CHECK constraints reject an out-of-pattern `diagnostic_code`, a `missing_credential` row carrying a resolved model or a non-zero latency, a `ready` row with a null model, and a `routing_verifications` row where `controlled_outcome` is null but `fallback_routing` is not `not_applicable` and the converse; plus an `information_schema.columns` audit asserting the column set of both tables matches the declared set exactly, so a later migration cannot quietly add a `response_body` or a credential column
    - Wire the suite as CI stage 10. Every case is stubbed, so no live provider is involved and the stage is deterministic enough to gate a merge
    - _Requirements: 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10, 17.11, 17.12, 17.13, 17.14, 17.15, 17.16, 17.17, 17.18_

  - [ ]* 41.11 Write the live provider readiness smoke test
    - Send 1 Non_Financial_Probe per provider against the real OpenRouter, Gemini and Groq endpoints, recording the outcome, the resolved model name and the latency
    - Wire as advisory CI stage 14, not a merge gate: stage 10 tests our classification, routing and retry logic against a stub and is deterministic, while this stage tests whether three third-party services happen to be up, which is not a property of the change under review — gating on it would mean a Groq outage blocks a ledger bug fix. A failure opens an issue and a second consecutive failure escalates to blocking
    - _Requirements: 17.3, 17.10_

- [ ] 42. Winning_Demo continuity through verified cash impact (Requirement 18)
  - The investigation is the setup and the verified correction is the payoff. This extends the **one** existing `test/e2e/demo-path.test.ts` rather than adding scenario tests beside it, because Requirement 18.1 is a continuity claim: separate tests for investigation, approval and cash impact could all pass while the handoffs between them were broken. Every Razorpay read and write on the path, including the VERIFY confirmation read, uses test-mode credentials and endpoints.
  - [ ] 42.1 Extend the demo path test through PROPOSE and the policy decision
    - Seed the residual Settlement so the aggregate in-scope shortfall is exactly `38200000n` paise, and assert the reported figure is exactly `38200000n`, renders as `₹3,82,000.00` with a `3.82 L` secondary line, and carries a resolvable `evidence_chain_id`
    - Advance the Reconciliation_Agent to PROPOSE and assert at least 1 Proposal exists whose `evidence_chain_id` is the chain asserted in the existing step 5, whose `impact_paise` equals the residual computed in the existing step 4, and whose `agent_name = 'Reconciliation_Agent'`. The Proposal is **derived from the Exception, not authored for the demo**: a hand-written impact would fail the `transaction_evidence` Policy_Check for the right reason, because no chain would resolve to that figure
    - Submit to the Policy_Engine and assert exactly 6 Policy_Check results are returned, exactly one decision of `auto_execute`, `require_approval` or `block` is produced, and the decision is produced before any execution occurred
    - _Requirements: 16.1, 18.1, 18.2, 18.3, 18.4_
    - _Properties: P3, P6_

  - [ ] 42.2 Assert both authorization paths, execution, and verification including the perturbed variant
    - Run the step twice, once per authorization path, because both are real paths and which one runs depends on configuration rather than on the script. **Sensitive_Action run:** with the default Auto_Execute_Threshold of 0, assert the decision is `require_approval`, that no Tenant state changed while it stood, then approve as a User holding `approve_sensitive_actions` and assert an Authorization with `actor_kind = 'user'` was recorded **before** the EXECUTE Audit_Event. **Safe_Action run:** with the threshold raised above the Proposal's risk score, assert the decision is `auto_execute` and an Authorization with `actor_kind = 'policy_engine'` was recorded before EXECUTE — the path where the Policy_Engine authorizes itself, which is the one most worth a test
    - Assert EXECUTE posted a balanced Ledger_Entry set through `post_reconciliation_adjustment` with both `proposal_id` and `authorization_id` present in the `ToolContext`, and that Σdebit = Σcredit on the posted set
    - Assert VERIFY ran within 60 seconds of execution completion and compared observed state against `expected_outcome` with the 1-paisa tolerance; then run a **third variant** perturbing the expected outcome by 2 paise and assert a `verification_failure` Exception was created with the absolute difference as impact and that no further automatic change was made — a verify step that always succeeds is not a control
    - _Requirements: 5.9, 5.11, 5.12, 18.4, 18.5, 18.6_
    - _Properties: P8_

  - [ ] 42.3 Assert the post-correction cash impact and the complete stage audit trail
    - On the succeeding variant, assert the Cash_Agent reports the post-correction cash impact as integer paise with a resolvable Evidence_Chain and its as-of timestamp, and that the chain's ordered steps **replay to the reported figure exactly**. It is a fresh computation from `get_cash_forecast` over a ledger that now contains the adjustment set posted at EXECUTE, not a restatement of the Proposal impact and not a Model-generated summary, so a correction that did not actually change the ledger produces a figure that fails replay
    - Assert the Audit_Log for the Proposal holds exactly one Audit_Event per completed Action_Pipeline stage, in ascending Tenant-scoped sequence order, with every agent actor drawn from the four-identity catalogue
    - Assert every Razorpay interaction on the whole path used test-mode credentials and endpoints
    - _Requirements: 13.7, 16.4, 18.7, 18.8_
    - _Properties: P6_

- [ ] 43. **PROPERTY GATE — Slice 5. Final gate: the full CI ordering, stages 0 through 15.**
  - Run the 16 contiguous stages in order, stopping at the first failure: (0) Secret_Safety_Gate scan of the source tree and test fixtures, by value and by key shape, both runtimes; (1) TypeScript typecheck and lint `tsc --noEmit` + ESLint; (2) Python typecheck and lint `ruff` + `mypy`; (3) TypeScript unit tests under Vitest; (4) Python unit tests under pytest; (5) database tests against Supabase local with migrations applied; (6) contract tests for every Financial_Tool; (7) transport schema and wire round-trip tests across both runtimes; (8) property tests P1–P15 seeded across both suites; (9) validator adversarial tests under pytest; (10) provider verification tests — readiness classification, probe content, routing, surface, cost-cap exemption, all stubbed with no live provider; (11) the seven-channel credential-absence suite including the client-bundle scan on the built output; (12) the end-to-end demo path, both parts, both authorization paths, against Razorpay test mode.
  - **Stages 0 through 12 gate a merge.** Stage 13 (Razorpay test-mode integration: paging, retry/backoff, credential rejection), stage 14 (live provider readiness smoke, 1 probe per provider) and stage 15 (performance bounds against a 5000-payment fixture) are advisory because they depend on an external service or on machine performance; an advisory failure opens an issue automatically and a second consecutive failure escalates to blocking.
  - **Stage 0 runs ahead of the compiler** because a leaked credential is the only failure in this pipeline that a later commit cannot undo: once a key reaches a published artifact it must be rotated, and no amount of subsequent coverage recovers it. Everything else on the list catches a bug; stage 0 catches an irreversible disclosure.
  - Stage 7 still precedes stage 8 for the reason task 38 gives, and stage 10 gates while stage 14 does not over the same subject matter, for the reason task 41.11 gives.
  - Re-run all fifteen properties P1 through P15 across both suites and re-run the Slice 1, Slice 2, Slice 3 and Slice 4 gates. Assert the catalogue closure tests pass with no fifth identity present anywhere in the type system, the API surface, the UI labels or the database.
  - Commit any fast-check or Hypothesis counterexample as an example-based regression test alongside its property. Ensure all tests pass, ask the user if questions arise.

## Notes

- Task order follows design.md's MVP Build Order, not requirement number order. The three property-gate checkpoints between slices are hard gates.
- Two runtimes, one dividing line: **money arithmetic and database writes are TypeScript on Next.js; Model interaction and agent reasoning are Python.** TypeScript is tested with Vitest, fast-check, ESLint and `tsc --noEmit`; Python with pytest, Hypothesis, `ruff` and `mypy`. Supabase Postgres serves both but only TypeScript connects to it, and Python opens no database connection at all — its only data path is `POST /internal/tools/{tool_name}`.
- **Slice 1 is entirely TypeScript.** It contains no AI or Model dependency, so it contains no Python dependency either: the Reconciliation_Agent's Slice 1 work is DETECT and INVESTIGATE only — tool invocation, arithmetic and Exception upsert, no EXPLAIN stage and therefore no Model call — and ships as a TypeScript-side driver over the Financial_Tool_Layer called in-process. Tasks 13.x and 19.x are TypeScript for that reason. One language, one test stack and one deploy target for the slice that has to be exact; the Python runtime arrives at task 29, at the head of Slice 4.
- **Money crosses the runtime boundary as a decimal string, never a JSON number.** Every monetary field on the wire carries a `_paise` suffix and is typed `string`, and the transport schemas reject a number rather than coercing it. JSON has no bigint: `JSON.stringify` throws on one and `JSON.parse` produces an IEEE-754 double for every numeric literal, so an unrounded intermediate — an `applyRate` product reaches roughly 3 × 10^19 — round-trips to a neighbouring value with no error raised. The failure is undetectable downstream, since the range check, the type check and the Evidence_Chain replay all pass against the rounded value, which is why the rule is rejection rather than coercion and why P15 exists.
- Sub-tasks marked `*` are optional: unit tests, Razorpay test-mode integration tests, and UI component tests. The property tests P1–P15, the database tests, the contract tests, the transport and wire round-trip tests, the validator adversarial suite and the end-to-end demo path are **not** marked optional because design.md's CI table makes stages 1 through 10 merge gates and because the slice gates run the properties directly.
- The calculation service and its property test (task 2) and the formatters and theirs (task 3) come before any other code that computes money, so the paise discipline is established and proven first. `src/wire/paise-wire.ts` lands in the same first task group even though nothing crosses the boundary until Slice 4, because the transport schemas and P15 build on it.
- Within Slice 4 the Python runtime, the wire helpers, the transport schemas, P15 and the three internal endpoints all come before the Agent Engine and the AI_Gateway. Building the gateway first would mean writing its request and response handling against a wire contract that does not exist yet, and a `_paise` field that shipped as a JSON number is a silent precision loss no later test discovers unless it is looked for.
- Items design.md marks thin-sliceable appear as later sub-tasks: incremental ingestion watermark (6.6), remaining reconciliation detectors (13.5), per-metric failure isolation (14.5), on-hold and pending Route handling (19.6, 19.7), Approval_Window sweep (23.5), audit history pagination (25.4), TDS review items (33.6), forecast simulation and ranked actions (34.5), recovery aggregate (35.5), unusual transactions and contributors (36.3), AI usage breakdown (31.8).
- The Model_Provider set is OpenRouter, Gemini and Groq. Task 31.1 keeps the adapter layer a Python `Protocol` so a provider can be swapped without touching routing, and OpenRouter's resolved underlying model name is reported per request so cost attribution on the TypeScript side stays accurate.
- The metering split is measure-versus-price: the Gateway observes token counts and latency because it holds the provider connection, and TypeScript prices them through `applyRate` and writes the `model_requests` row because that is money arithmetic and a database write. A `cost_paise` in a metering request body is rejected.
- CI runs 12 contiguous stages in order, stopping at the first failure, with a Runtime column: TypeScript typecheck and lint, Python typecheck and lint, TypeScript unit, Python unit, database, contract, transport and wire round-trip, properties P1–P15 across both suites, validator adversarial under pytest, end-to-end demo path — stages 1 through 10 gating a merge — then Razorpay integration and performance bounds as advisory stages 11 and 12.
- Every fast-check or Hypothesis counterexample reported during a gate should be committed as an example-based regression test alongside its property, and every property test runs with an explicit seed in CI.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.2", "3.3"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 6, "tasks": ["4.5", "4.6", "4.7"] },
    { "id": 7, "tasks": ["4.8", "5.1"] },
    { "id": 8, "tasks": ["5.2", "6.1"] },
    { "id": 9, "tasks": ["6.2", "8.1"] },
    { "id": 10, "tasks": ["6.3", "6.4", "6.6", "7.1", "8.2"] },
    { "id": 11, "tasks": ["6.5", "7.2", "8.3"] },
    { "id": 12, "tasks": ["8.4", "8.5"] },
    { "id": 13, "tasks": ["8.6", "8.7", "9.1"] },
    { "id": 14, "tasks": ["9.2", "10.1"] },
    { "id": 15, "tasks": ["9.3", "10.2", "11.1"] },
    { "id": 16, "tasks": ["11.2", "11.3", "11.4"] },
    { "id": 17, "tasks": ["11.5", "12.1", "12.2"] },
    { "id": 18, "tasks": ["12.3", "12.4", "12.5", "12.6"] },
    { "id": 19, "tasks": ["12.7", "13.1"] },
    { "id": 20, "tasks": ["13.2", "14.1"] },
    { "id": 21, "tasks": ["13.3", "13.4", "13.5", "14.2", "14.3"] },
    { "id": 22, "tasks": ["14.4", "14.5", "14.6", "15.1"] },
    { "id": 23, "tasks": ["15.2", "16.1", "18.1"] },
    { "id": 24, "tasks": ["19.1", "19.8"] },
    { "id": 25, "tasks": ["19.2", "19.3"] },
    { "id": 26, "tasks": ["19.4", "19.5"] },
    { "id": 27, "tasks": ["19.6", "19.7", "21.1"] },
    { "id": 28, "tasks": ["22.1", "22.2", "24.1"] },
    { "id": 29, "tasks": ["22.3", "24.2"] },
    { "id": 30, "tasks": ["23.1", "24.3"] },
    { "id": 31, "tasks": ["23.2", "23.3"] },
    { "id": 32, "tasks": ["23.4", "23.5"] },
    { "id": 33, "tasks": ["25.1", "26.1"] },
    { "id": 34, "tasks": ["25.2", "26.2"] },
    { "id": 35, "tasks": ["23.6", "25.3", "25.4", "25.5", "26.3"] },
    { "id": 36, "tasks": ["26.4", "26.5", "27.1"] },
    { "id": 37, "tasks": ["27.2", "29.1"] },
    { "id": 38, "tasks": ["29.2"] },
    { "id": 39, "tasks": ["29.3"] },
    { "id": 40, "tasks": ["29.4"] },
    { "id": 41, "tasks": ["29.5", "31.4"] },
    { "id": 42, "tasks": ["29.6"] },
    { "id": 43, "tasks": ["29.7"] },
    { "id": 44, "tasks": ["30.1", "31.1"] },
    { "id": 45, "tasks": ["30.2", "31.2"] },
    { "id": 46, "tasks": ["31.3"] },
    { "id": 47, "tasks": ["31.5"] },
    { "id": 48, "tasks": ["31.6"] },
    { "id": 49, "tasks": ["31.7", "31.8"] },
    { "id": 50, "tasks": ["31.9", "32.1"] },
    { "id": 51, "tasks": ["32.2", "33.1", "34.1"] },
    { "id": 52, "tasks": ["33.2", "33.3", "34.2", "35.1"] },
    { "id": 53, "tasks": ["33.4", "34.3", "35.2", "35.3", "36.1"] },
    { "id": 54, "tasks": ["33.5", "34.4", "35.4", "36.2"] },
    { "id": 55, "tasks": ["33.6", "33.7", "34.5", "35.5", "36.3"] },
    { "id": 56, "tasks": ["34.6", "35.6"] },
    { "id": 57, "tasks": ["37.1"] }
  ]
}
```
