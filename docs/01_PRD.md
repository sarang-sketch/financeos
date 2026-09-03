# 01 — Product Requirements Document

## Vision

Indian finance teams reconcile by hand. A payment comes in through Razorpay, a fee is deducted, GST is charged on that fee, a settlement lands in the bank days later batching hundreds of payments and dozens of refunds, and someone opens a spreadsheet to work out why the bank credit does not match what they expected. When it does not reconcile, they cannot tell whether the gap is a normal fee, a duplicate refund, a chargeback, or money that genuinely went missing.

FinanceOS closes that loop continuously and shows its working. Not "your settlement is short ₹23,200" but "₹23,200 is ₹19,661 Razorpay fee plus ₹3,539 GST on that fee, residual zero, difference explained" — with every figure clickable down to the source record it came from.

## Users

### Primary: the finance operator

Works in a 10–200 person Indian business. Reconciles Razorpay settlements against the bank and the books. Currently exports CSVs and matches by hand or by lookup formula.

What they need: to know which settlements do not reconcile and why, without building the explanation themselves. They will not trust a number they cannot verify, and they are right not to. Every figure in the product therefore carries an evidence chain.

What they fear: an AI that confidently states a wrong number. This is why models never compute money here.

### Secondary: the business owner or founder

Does not reconcile. Wants to know cash position, revenue, how much is stuck in pending settlement, and how long the runway is. Occasionally asks whether payroll clears on a specific date.

What they need: four numbers on one screen, and a plain-language answer when something looks off. They will approve or reject a proposed correction but will not investigate one.

### Tertiary: the marketplace operator

Runs a platform splitting each customer payment across sellers and a platform commission via Razorpay Route. Fields seller complaints about short payouts.

What they need: to answer "why is Seller 183's settlement ₹17,400 short?" with the actual chain — every contributing payment, transfer, reversal, fee, GST component and commission — rather than a guess.

### Platform operator (internal)

Configures tenants, credentials, policy thresholds. Needs tenant isolation to be provably airtight and needs to know what the AI spent.

## The problems, stated concretely

**Problem 1: the money journey is invisible.** A ₹10,000 customer payment becomes a bank credit through payment capture → Razorpay fee → GST on fee → settlement batching → bank transfer → ledger posting. No single system shows that whole chain. The finance person reassembles it from Razorpay's dashboard, the bank statement, and their books.

**Problem 2: differences are unexplained by default.** Razorpay provides settlement reconciliation reports. Turning one into "this ₹23,200 gap is entirely fee and GST, and this ₹661 gap is not" is manual arithmetic across hundreds of line items.

**Problem 3: exceptions are found late or never.** Duplicate refunds, unmatched credit notes, payments with no corresponding ledger entry, invoices missing a GSTIN — all detectable from data already sitting in Razorpay and the books. Nobody is looking continuously.

**Problem 4: India-specific tax exposure accumulates quietly.** GST on Razorpay fees is input tax credit that has to be recorded. Invoices missing HSN/SAC codes or a customer GSTIN create problems that surface at filing time. TDS applicability on vendor payments needs review before payment, not after.

**Problem 5: marketplace splits multiply the problem by the seller count.** Every Route transfer, partial reversal and on-hold transfer is another place a seller payout can diverge from what the seller expects.

**Problem 6: AI finance tools stop at explanation.** They tell you what happened. They do not propose a correction, and if they did, there would be no policy gate, no approval trail and no proof of what executed.

## Core workflows

### Workflow 1 — Ingest and derive

The operator connects a Razorpay test-mode credential and starts an ingestion run. The system retrieves payments, orders, refunds, settlements, settlement recon reports, transfers, transfer reversals, invoices and linked accounts in pages of 100, storing each payload verbatim, one row per Razorpay object per tenant. Monetary values are stored as integer paise with no rounding or scaling.

A downstream derivation posts double-entry ledger entry sets from those records. The derivation is idempotent: running it twice creates nothing the second time.

The run reports per-object-type stored and error counts and a status of completed, partially completed, or failed. A rejected credential aborts the run, stores nothing, and leaves prior data untouched.

### Workflow 2 — Open the control tower

Four metrics: cash, revenue over the trailing 30 days, pending settlement, runway. Each is an independent cell with its own loading, processing and failure state, so one failing metric does not blank the screen. Values render in Indian format with a lakh or crore secondary line once the thresholds are crossed, and each carries the timestamp of the ingestion that fed it.

Below, the attention panel: one row per exception category with an open count and an aggregate rupee impact, ordered by impact descending. Selecting a row drills into the individual exceptions, each showing its impact, its source record identifiers, and a control that opens its evidence chain.

### Workflow 3 — Investigate a settlement shortfall (the centerpiece)

The operator asks why settlements are short. The reconciliation agent resolves the scope, calls typed tools over the stored records, and returns:

- the total shortfall, with the count of payments, settlements, refunds, ledger entries and invoices examined
- a per-settlement breakdown ordered by absolute difference, capped at 50 rows plus an aggregate remainder row
- for each row: expected amount, received amount, difference, and the difference decomposed into Razorpay fee, GST on fee, and unexplained residual

Settlements whose residual is exactly zero are marked *difference explained* and produce no exception. Settlements with a non-zero residual produce a settlement mismatch exception with the residual as impact, classified as an unexplained shortfall or excess.

The narrative wrapper around these figures comes from a model. Every figure in it must exactly match a value the tools returned, to the paisa. If it does not, the whole response is withheld.

### Workflow 4 — Investigate a seller payout

The marketplace operator asks why a seller's payout is short. The marketplace agent maps each payment to its transfers, reversals and retained commission, computes the expected payout as transfers minus reversals with partial reversals counted at their own amount, compares it against what the linked account actually received, and returns the ordered contributing chain with fees, GST and commission per row.

### Workflow 5 — Propose and authorize a correction

An agent produces a proposal: action type, target records, rupee impact, evidence chain, expected outcome. The policy engine evaluates all six checks independently — user permission, accounting rule, transaction evidence, duplicate action, risk threshold, approval requirement — computes a risk score from 0 to 100, and returns exactly one decision.

Below the tenant's auto-execute threshold, the proposal executes with the policy engine recorded as the authorizing actor. Above it, the proposal waits for a human within the approval window. The default threshold is zero, so nothing auto-executes until a tenant deliberately raises it.

After execution, verification compares observed state against the expected outcome within a 1-paisa tolerance. A mismatch raises a verification failure exception rather than silently reverting. An execution failure reverses what was applied and requires a new authorization before any retry.

Every stage appends an immutable audit event.

### Workflow 6 — Ask whether an obligation clears

The owner asks whether payroll clears on a date. The cash agent projects day-by-day closing cash over the forecast horizon from current cash, expected settlements, outstanding invoices, expected refunds, vendor payments, recurring expenses and payroll obligations, then reports projected cash, the obligation, the safety buffer, headroom, and a low/medium/high risk level. When short, it names the forecast component causing the largest reduction and ranks up to five corrective actions by rupee improvement. Simulate changes nothing; take action creates a policy-gated proposal.

### Workflow 7 — Review India tax exposure

The compliance agent examines invoices, GSTINs, HSN/SAC codes, tax amounts, credit notes and payments over a bounded window and flags missing GST information, structurally invalid GSTINs, GST rate anomalies, input tax credit discrepancies, records needing review, unmatched credit notes and TDS review items. Every finding renders a review-only, not-authoritative-tax-advice statement in the same view.

### Workflow 8 — Recover failed revenue

The recovery agent profiles a failed payment with the Razorpay failure reason, the customer's prior payment count, their last successful method, and their lifetime value, then reports a recovery probability per retry channel blending customer-level and tenant-level success rates. It proposes a retry on the single best channel only when the historical sample meets the configured minimum, and suppresses proposals for payments already recovered, already retried, or past the maximum retry age.

## Feature set

| Feature | Requirement | Slice |
|---|---|---|
| Razorpay ingestion with idempotent upsert | 1 | 1 |
| Double-entry semantic ledger | 2 | 1 |
| Control tower dashboard and attention panel | 3 | 1 |
| Reconciliation agent and settlement decomposition | 4 | 1 |
| Financial tool layer and evidence chains | 12 | 1 |
| Integer-paise accuracy invariants | 15 | 1 |
| Marketplace / Razorpay Route reconciliation | 7 | 2 |
| Action pipeline and policy engine | 5 | 3 |
| Hash-chained immutable audit log | 13 | 3 |
| Multi-tenancy and permission model | 14 | 3 |
| Multi-model AI gateway | 11 | 4 |
| India compliance detection and review | 6 | 4 |
| Cash forecasting and affordability | 8 | 4 |
| Revenue recovery for failed payments | 9 | 4 |
| Finance analyst period comparison | 10 | 4 |

## What makes this defensible

| Typical AI finance tool | FinanceOS |
|---|---|
| Reads data, answers from context | Investigates data through typed tools |
| Gives an answer | Gives an answer plus the evidence chain |
| Suggests an action | Proposes an executable action behind a policy gate |
| One model vendor | Three providers behind a task-class router |
| Generic finance | India-native: GST on fee, GSTIN, ITC, TDS, lakh/crore |
| A dashboard | A control tower with an attention queue |
| No accounting state | A double-entry semantic ledger |
| Model can hallucinate a figure | Ungrounded figures are mechanically withheld |
| No authorization model | Six policy checks, approval window, risk score |
| No auditability | Append-only hash-chained audit log |

## Success criteria

The MVP succeeds if a finance operator can, in one session: connect a Razorpay test credential, ingest, open the control tower, see a real settlement mismatch in the attention panel, ask why settlements are short, receive a per-settlement decomposition, click any figure, and see the ordered computation steps and source records that produced it.

Objective per-requirement criteria are in [14_ACCEPTANCE_CRITERIA.md](14_ACCEPTANCE_CRITERIA.md).

## Authoritative source

This document describes intent. Behaviour is defined in `.kiro/specs/financeos-control-tower/requirements.md` — 15 requirements in EARS format. Where this document and the spec disagree, the spec wins.
