# 07 — AI Agent Specification

Six agents. The Reconciliation Agent is the primary spec because it is the product centerpiece; the other five follow the same contract.

## The contract every agent obeys

Five rules, without exception.

**1. No database access.** An agent holds no database client. Every read goes through a named financial tool with a Zod `.strict()` typed input schema. There is no argument that expresses a query.

**2. Every figure comes from a tool.** An agent never computes a monetary value itself and never asks a model to. Arithmetic happens in the Calculation Service on `bigint` paise.

**3. Every figure carries an evidence chain.** Ordered computation steps with operations and operand references, the contributing source record identifiers, and the as-of timestamp of the newest contributing record. Replaying the steps reproduces the figure exactly in integer paise — this is correctness property P6.

**4. The model produces narrative only.** Explanation, classification and narrative text, capped at 8,000 characters. The Response Validator withholds any response containing a monetary figure that is not an exact paise match against the tool output supplied for that request.

**5. Every stage is audited.** Exactly one audit event per completed pipeline stage, appended within 5 seconds.

## The action pipeline

```
DETECT → INVESTIGATE → EXPLAIN → PROPOSE → AUTHORIZE → EXECUTE → VERIFY
```

Stages run strictly in order, each completing before the next begins, none omitted.

| Stage | Owner | What happens |
|---|---|---|
| DETECT | Agent | Read via tools, upsert exceptions by fingerprint |
| INVESTIGATE | Agent | Drill-down tool calls, build evidence chains |
| EXPLAIN | Agent → Gateway → Validator | Narrative generated, then gated |
| PROPOSE | Agent | Build proposal: action type, targets, impact, evidence chain, expected outcome |
| AUTHORIZE | Policy Engine | Six checks, risk score, one decision |
| EXECUTE | Action Service | Write-capable tool with proposal and authorization ids |
| VERIFY | Action Service | Observed vs expected within 1 paisa |

**Wall-clock bounds.** First displayable content within 15 seconds. A run reaching 120 seconds stops, returns partial results, flags itself incomplete, and names the source record types not fully processed. Concurrency is capped at 5 agent runs per tenant.

Agents in slices 1 and 2 only detect and explain. They write no proposal that could execute, because the policy engine does not exist until slice 3.

---

## Reconciliation Agent (primary)

**Question it answers:** where is the money?

**Task class:** complex reasoning → OpenRouter → Gemini → Groq.

### Matching

Matches each in-scope payment to its order, invoice, settlement and ledger entries **using only stored Razorpay identifier links**. No amount-based matching. No date-based matching. No fuzzy inference. Records a matched identifier per record type, or a not-matched marker.

This is a deliberate constraint. Inferred matching would produce different results on different runs and would make correctness property P5 — run determinism — untestable.

### The core computation

```
Expected  = Σpayments − Σrefunds − Σchargebacks + signed Σadjustments
Difference = Expected − Received
Residual   = Difference − Σfees − Σgst_on_fees
```

Status is `difference_explained` **if and only if** the residual is exactly `0n`. Not close to zero. Not within a tolerance. Exactly zero.

Because the residual is *defined* by subtraction, `Difference = fee + gst + residual` holds by construction for every input, with no rounding anywhere. That is why it can be a database CHECK constraint.

### Reasoning boundaries

| The agent may | The agent may not |
|---|---|
| Read any tenant record through a tool | Query the database directly |
| Report a computed difference and its decomposition | Compute a figure itself |
| Classify a residual as shortfall or excess | Decide a residual is "close enough" |
| Mark a settlement explained when residual is `0n` | Mark it explained on a non-zero residual |
| Exclude an unreconciled settlement from totals | Estimate a missing recon report |
| Report examined counts and the applied date range | Report a total without its scope |

### Detectors

Settlement mismatch, possible duplicate refund, unmatched credit note, missing accrual, ambiguous match, unreconciled settlement, unsettled payment.

**Duplicate refund is exact, not heuristic.** Two or more refunds against one payment whose combined amount exceeds the payment by 1 paisa or more. Similarity-based detection is explicitly excluded, because a near-duplicate flagged as a duplicate is a false accusation about someone's money.

### Determinism

Exception identity is a fingerprint: SHA-256 over tenant, category, canonically sorted source record identifiers, and scope where the category is range-scoped. It excludes impact, detail and every timestamp — so a re-run that recomputes a different impact lands on the same fingerprint and updates in place.

The upsert is guarded by `WHERE lifecycle_state = 'open'`, so a re-run does not silently reopen an exception a user resolved. `first_detected_at` is written once.

Every result ordering is a total order terminating in a unique identifier comparison, so ordering is reproducible.

---

## Marketplace Agent

**Question:** why is this seller's payout short?

**Task class:** complex reasoning.

Maps each payment to its transfers, transfer reversals and retained platform commission in integer paise. Expected seller payout is Σtransfers − Σreversals, with **each partial reversal counted at its own reversed amount** rather than the full transfer amount.

**Boundaries:** on-hold transfers are excluded from the expected payout but reported separately with identifier and amount. A linked account with zero settlements in range is classified **pending**, not mismatched — reporting a shortfall against a seller who simply has not been paid yet would be wrong.

**Conservation law (property P4):** for every payment, net transfers + commission + fee + GST on fee equals the payment amount with a difference of exactly 0 paise.

Chain answers order by ascending payment creation timestamp, then payment id, then transfer id, then reversal id; truncated at 200 rows with the total count and a truncation flag.

---

## Compliance Agent

**Question:** what tax exceptions need review?

**Task class:** document analysis → Gemini → OpenRouter → Groq.

**The hardest boundary in the system.** This agent performs detection and review only. It produces **no statutory return, no filing submission, and no instruction directing a user to adopt a specific tax position**. Every finding renders a review-only, not-authoritative-tax-advice statement in the same view as the finding.

Detects: missing GST information, structurally invalid GSTIN, GST rate anomaly, input tax credit discrepancy, records needing review, unmatched credit notes. Creates TDS review items.

GSTIN validation is **structural only** — five rules checked in order, reporting the first that failed by name. It is not a checksum verification and not a registration lookup. Claiming otherwise would imply an authority the product does not have.

Examination window is at most 366 days, defaulting to the preceding 90, with per-record-type examined counts reported.

---

## Cash Agent

**Question:** what happens to my cash next?

**Task class:** complex reasoning.

Projects day-by-day closing cash over the forecast horizon: prior day's closing plus that day's inflows minus that day's outflows. Every component records its amount in integer paise and its source record identifiers.

Risk bands are defined arithmetically on headroom = projected closing − obligation:

| Condition | Risk |
|---|---|
| headroom ≥ safety buffer | low |
| 0 ≤ headroom < safety buffer | medium |
| headroom < 0 | high |

Exhaustive and mutually exclusive by construction.

**Boundaries:** simulate writes nothing at all — no proposal, no stored record change. Take action creates a policy-gated proposal. A date before today or beyond the horizon returns no answer and an error naming the supported range. Runway is reported as not applicable, with the reason, when average net monthly outflow is not positive — rather than dividing by zero or showing an absurd number.

Settlement dates derive from Razorpay settlement cycle data with the basis recorded as `settlement_cycle`, falling back to capture date plus 3 days recorded as `default_delay`. The basis is always stated, so a user knows which figures are scheduled and which are estimated.

---

## Recovery Agent

**Question:** which channel should I retry through?

**Task class:** fast classification → Groq → Gemini → OpenRouter.

Probability per channel is 70% of the customer's channel success rate plus 30% of the tenant's, over the lookback window, as an integer 0–100. Probabilities are percentages, not money, so `number` arithmetic is legitimate here — the one place in the system where it is.

**Boundaries:** with zero prior successful payments the basis is tenant-level only and customer rates are excluded, with the basis reported. Below the minimum sample size **no proposal is created** and the available count, the configured minimum and the below-minimum condition are reported. No proposal for payments already recovered, already retried, or past the maximum retry age.

Channel selection tie-break: highest probability, then more tenant successes, then the fixed order UPI, card, netbanking, wallet.

This agent is the only one whose proposal calls a Razorpay write API.

---

## Analyst Agent

**Question:** what's happening?

**Task class:** complex reasoning.

Compares a period against the immediately preceding equal-length period on revenue, expense, margin, cash movement and unusual transactions.

**Boundaries:** percentage change is reported as **not applicable** when the prior value is zero or the prior period had no transactions, rather than as infinity or a fabricated number. Unusual transactions use a configured multiple of the 180-day median with the median and the computed threshold both reported, so the classification is auditable rather than asserted. Capped at 20 rows with the total count; top contributors capped at 3 with tie-breaks and the count reported when fewer exist.

---

## Guardrails summary

| Guardrail | Mechanism | Enforced by |
|---|---|---|
| No direct data access | Named typed tools only | No DB client on agents |
| No free-form queries | Zod `.strict()`, no query-text argument | Schema rejection before any read |
| No model arithmetic | Figures supplied as tool output | Response Validator, zero tolerance |
| No ungrounded figures | Evidence chain required per figure | Whole-response withholding |
| No unauthorized writes | `proposal_id` + `authorization_id` required | Write-capable tool rejection |
| No cross-tenant reads | Tenant from session, RLS in the database | `FORCE ROW LEVEL SECURITY` |
| No silent auto-execution | Auto-execute threshold defaults to 0 | Policy engine |
| No unbounded runs | 120 s stop with partial results | Agent Engine |
| No unbounded model spend | Monthly cost cap, checked before first attempt | AI Gateway |
| No credential leakage into prompts | Value-matched stripping | AI Gateway |

## Why withholding the whole response is correct

A response with one fabricated figure among nine correct ones is not partially trustworthy, and a user cannot be expected to identify which one was invented. So the validator withholds everything and records the withholding.

The lakh and crore normalisation matters most here. A model that writes "about 3.8 lakh" when the tool returned `38200000n` (₹3,82,000.00) produces `38000000n` — not a member of the allowed set, response withheld. That rounding-to-plausibility is exactly where a confident-sounding wrong number would otherwise slip through.

## Related docs

- Tool catalogue → [06_API_CONTRACTS.md](06_API_CONTRACTS.md)
- Full component interfaces → `design.md` → Components and Interfaces
- Gateway routing and failover → `design.md` → AI Gateway Design
- Edge cases per agent → [11_EDGE_CASES.md](11_EDGE_CASES.md)
