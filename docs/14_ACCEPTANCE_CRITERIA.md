# 14 — Acceptance Criteria

Objective done-tests per requirement. Each row is verifiable by running something, not by reading code and forming an opinion.

The full acceptance criteria are in `requirements.md` — approximately 180 EARS clauses. This document gives the observable test per requirement, the property that proves it where one exists, and the CI stage that runs it.

## How to read this

**Done** means the stated test passes, not that the code exists. A requirement whose property test is failing is not done regardless of how complete the implementation looks.

**Property-gated** requirements cannot be signed off by inspection. P1 through P14 either pass over generated input or they do not.

## Requirement 1 — Razorpay Data Ingestion

| Done when | Verified by |
|---|---|
| An ingestion run retrieves all nine object types in pages of 100, stopping when a page returns fewer than 100 | Integration test, stage 8 |
| Every stored row carries the Razorpay id, type, tenant, run id, retrieval timestamp and **unmodified** payload | Unit + E2E, stages 2, 7 |
| Re-ingesting the same object set yields exactly one row per `(tenant_id, razorpay_id)` with the latest payload | **P10**, stage 5 |
| A rate limit retries at 1/2/4/8/16 s, max 5, then records an error for that object type | Integration test, stage 8 |
| A non-credential error on one type leaves other types stored and the run `partially_completed` | Integration test, stage 8 |
| A rejected credential aborts the run, stores **zero** objects, and leaves prior objects byte-identical | Integration test, stage 8 |
| The credential value appears in no response body, log line or error message | Integration test, stage 8 |
| Monetary values store as integer paise in range with no rounding, truncation or scaling | **P12** + schema type audit, stages 5, 3 |
| First run uses a 365-day window; a later run uses the last completed run's start timestamp | Unit test, stage 2 |

## Requirement 2 — Semantic Ledger

| Done when | Verified by |
|---|---|
| Every persisted set balances to exactly 0 paise, has 2–20 entries, every amount > 0, ≥ 1 source link per entry | **P1**, stage 5 |
| A Payment set posts `settlement_pending = amount − fee − gst` with a difference of 0 paise | **P1**, stage 5 |
| An imbalanced set persists **exactly 0** entries and changes no account balance | **P1** + database test, stages 5, 3 |
| Deriving twice from one source record creates one set and leaves balances unchanged | **P2**, stage 5 |
| Trial balance debit total equals credit total for any valid range | **P13**, stage 5 |
| A reversal leaves originals byte-identical and nets to 0 per account | **P14**, stage 5 |
| `UPDATE` and `DELETE` on `ledger_entries` both fail, target unchanged, attempt audited | Database test, stage 3 |

## Requirement 3 — Control Tower Dashboard

| Done when | Verified by |
|---|---|
| Four metrics render within 3 s with metric computation complete | Performance test, stage 9 |
| Values render in 2,2,3 grouping with 2 decimals; lakh at ≥ ₹1,00,000; crore at ≥ ₹1,00,00,000 | **P11** + unit, stages 5, 2 |
| Attention panel orders by descending impact, ties by ascending category name, rows only for categories with ≥ 1 open exception | Component test, stage 2 |
| Drill-down pages at 50, ordered by descending impact then ascending id, keyboard-selectable | Component test, stage 2 |
| Zero-ingestion and zero-open-exception empty states are **distinct** and both keep controls operable | Component test, stage 2 |
| A metric error or 30 s timeout shows a failure state for that metric only, naming the cause, with retry, while others render | Component test, stage 2 |
| Runway shows a non-numeric state distinguishing "> 120 months" from "not applicable" | Component test, stage 2 |
| Each metric shows its contributing ingestion timestamp in IST to whole seconds | Unit + component, stage 2 |

## Requirement 4 — Reconciliation Agent

| Done when | Verified by |
|---|---|
| Matching uses stored identifier links only, with a not-matched marker per record type | Unit test, stage 2 |
| `difference = fee + gst + residual` exactly, for all generated recon reports | **P3**, stage 5 |
| Status is `difference_explained` **if and only if** residual is exactly `0n` | **P3** + DB CHECK, stages 5, 3 |
| The SET-9281 fixture yields residual `0n`, status explained, **no exception**, and all five figures recorded | E2E fixture test, stage 7 |
| The ₹19,000-fee variant yields residual `66100n`, a mismatch exception, direction shortfall | E2E fixture test, stage 7 |
| An absent or empty recon report yields `unreconciled`, five `null` figures, and exclusion from the total | **P3**, stage 5 |
| A second run over unchanged data produces the identical exception set, order, impacts and source refs | **P5**, stage 5 |
| Shortfall answers return ≤ 50 rows plus an aggregate remainder, with scope and examined counts | Contract + E2E, stages 4, 7 |
| Duplicate refunds flagged only when combined refunds exceed the payment by ≥ 1 paisa | Unit test, stage 2 |
| An ambiguous match is excluded from the unsettled classification | Unit test, stage 2 |

## Requirement 5 — Action Pipeline and Policy Engine

| Done when | Verified by |
|---|---|
| Stages run strictly in order with exactly one audit event per completed stage within 5 s | **P8**, stage 5 |
| All six policy checks are evaluated independently and all six results returned even when one fails | Unit test, stage 2 |
| Risk score is an integer 0–100, monotone non-decreasing in each of its three inputs | Unit test, stage 2 |
| Any failed check yields `block` with **no tenant state change** | Unit + property, stages 2, 5 |
| Every proposal reaching EXECUTE has an authorization in the audit log | **P8**, stage 5 |
| No blocked, awaiting, rejected or expired proposal has an EXECUTE-stage event | **P8**, stage 5 |
| Verification treats ≤ 1 paisa as matching; a larger difference raises an exception and makes **no further automatic change** | Unit test, stage 2 |
| Execution failure reverses applied changes and requires a new authorization before retry | Unit + **P14**, stages 2, 5 |
| With the default threshold of 0, no proposal auto-executes | Unit test, stage 2 |

## Requirement 6 — India Compliance Detection and Review

| Done when | Verified by |
|---|---|
| GSTIN validation checks the five rules in order and names the **first** that failed | Unit test, stage 2 |
| State codes `01` and `38` pass; `00` and `39` fail with `state_code_01_to_38` | Unit test, stage 2 |
| Missing GST info, invalid GSTIN, GST anomaly, ITC discrepancy, record needing review and unmatched credit note each produce an exception with impact and source refs | Contract test, stage 4 |
| ITC discrepancy below 1 paisa is reported but creates **no exception** | Unit test, stage 2 |
| Every finding, TDS review item and ITC discrepancy renders the review-only disclaimer **in the same view** | Component test, stage 2 |
| No statutory return, filing submission or directive tax position is produced anywhere | Code review + contract test, stage 4 |
| A re-run updates existing open items rather than duplicating | **P5**, stage 5 |

## Requirement 7 — Marketplace and Razorpay Route Intelligence

| Done when | Verified by |
|---|---|
| Net transfers + commission + fee + GST equals the payment amount with a difference of exactly 0 paise | **P4**, stage 5 |
| Partial reversals count at their own reversed amount, not the full transfer | **P4**, stage 5 |
| On-hold transfers are excluded from expected payout and reported separately | **P4**, stage 5 |
| A linked account with zero settlements is **pending**, not mismatched | Unit test, stage 2 |
| Over-allocated splits raise an exception with `Σtransfers − payment` as impact | **P4**, stage 5 |
| Payout chains order by payment timestamp, then payment id, transfer id, reversal id | Contract test, stage 4 |
| Chains over 200 rows return 200 with the total count and a truncation flag | Contract test, stage 4 |

## Requirement 8 — Cash Forecasting and Affordability

| Done when | Verified by |
|---|---|
| The forecast returns a closing cash value per day over the horizon, each component carrying amount and source refs | Contract test, stage 4 |
| Risk bands on headroom are exhaustive and mutually exclusive at the boundaries | Unit test, stage 2 |
| At or above obligation + buffer: affordable, shortfall `0n`, no primary cause, risk low | Unit test, stage 2 |
| Primary cause tie-breaks resolve deterministically through all four levels | Unit test, stage 2 |
| Simulate creates **no proposal** and writes **no stored record** | Contract test, stage 4 |
| A date before today or beyond the horizon returns no answer and names the supported range | Contract test, stage 4 |
| Runway is not applicable, with the reason, when net outflow is not positive | Unit test, stage 2 |
| Settlement date basis is recorded as `settlement_cycle` or `default_delay` on every component | Contract test, stage 4 |

## Requirement 9 — Revenue Recovery for Failed Payments

| Done when | Verified by |
|---|---|
| Probability per channel is 70% customer + 30% tenant over the lookback window, integer 0–100 | Unit test, stage 2 |
| Zero customer successes uses tenant-level rates only, basis reported | Unit test, stage 2 |
| Below the minimum sample size **no proposal** is created and the counts are reported | Unit test, stage 2 |
| Channel tie-break resolves through probability, tenant successes, then the fixed order | Unit test, stage 2 |
| Already recovered, already retried, or over-age payments produce no proposal, with the reason | Unit test, stage 2 |
| The retry proposal passes through the policy engine | **P8**, stage 5 |

## Requirement 10 — Finance Analyst Explanations

| Done when | Verified by |
|---|---|
| Percentage change is **not applicable** when the prior value is 0 or the prior period had no transactions | Unit test, stage 2 |
| Unusual transactions report the median used and the computed threshold, capped at 20 with the total count | Contract test, stage 4 |
| Top contributors cap at 3 with tie-breaks, reporting the count when fewer exist | Contract test, stage 4 |
| No period specified resolves to trailing 30 days with dates echoed back | Contract test, stage 4 |
| A period outside 1–366 days returns an error, no figures, no state change | Contract test, stage 4 |
| Every figure comes from a tool; model content is narrative only | **P6** + adversarial, stages 5, 6 |

## Requirement 11 — Multi-Model AI Gateway

| Done when | Verified by |
|---|---|
| Each task class routes to its chain head first: OpenRouter, Gemini, Groq respectively | Unit test, stage 2 |
| Rate limit or timeout retries the same provider twice at 1000/2000 ms then fails over | Unit test, stage 2 |
| Any other error fails over immediately with no retry; max 3 providers per request | Unit test, stage 2 |
| Chain exhaustion returns `provider_unavailable` with per-attempt provider, category and elapsed ms | Unit test, stage 2 |
| Every request records provider, resolved model, task class, attempts, tokens, cost in paise, latency | Unit test, stage 2 |
| The cost cap is checked **before the first attempt** and rejects at exactly the cap | Unit test, stage 2 |
| Over 200 tool values or 100,000 characters is **rejected, not truncated** | Unit test, stage 2 |
| A credential value planted in a free-text field is stripped from the payload and the records | Unit test, stage 2 |
| An ungrounded monetary figure withholds the **entire** response and appends an audit event | **Adversarial suite**, stage 6 |

## Requirement 12 — Financial Tool Layer and Tool Grounding

| Done when | Verified by |
|---|---|
| Every tool declares `.strict()` input and output schemas and rejects unknown keys, wrong types and free-form text or SQL | Contract test, stage 4 |
| A schema violation reads **no tenant data** and opens no connection | Contract test, stage 4 |
| Every monetary figure carries a resolvable evidence chain identifier | Contract test, stage 4 |
| Replaying any chain's ordered steps reproduces the figure exactly in integer paise | **P6**, stage 5 |
| An unreadable contributing record returns `incomplete_evidence` and **omits the figure** | Contract test, stage 4 |
| Read-only tools execute on a connection with no write grants | Contract test, stage 4 |
| Write-capable tools reject a context missing `proposal_id` or `authorization_id`, state unchanged | Contract test, stage 4 |
| A tool held past 10 s returns `tool_failure` with cause `timeout` | Contract test, stage 4 |

## Requirement 13 — Audit Log Immutability

| Done when | Verified by |
|---|---|
| Recomputed chain value equals stored for every event; sequence numbers are gapless 1..n | **P9**, stage 5 |
| Gaplessness holds under interleaved aborted transactions | **P9**, stage 5 |
| An injected tamper and gap are reported at the correct sequence numbers, independently | **P9**, stage 5 |
| Update or delete is rejected, the target is unchanged field by field, and the attempt is audited | Database test, stage 3 |
| Payloads exclude credential values and reference source records by identifier only | Unit test, stage 2 |
| Payloads over 65,536 bytes are reduced with the indicator set, source refs unreduced | Unit test, stage 2 |
| Proposal history returns one event per completed stage and names absent stages as **not completed** | Unit test, stage 2 |

## Requirement 14 — Multi-Tenancy and Security

| Done when | Verified by |
|---|---|
| No query on any read path returns a foreign-tenant row, **with the application filter removed** | **P7**, stage 5 |
| Per table: select returns own rows only; cross-tenant update and delete affect 0 rows; foreign insert rejected by `WITH CHECK` | Database test, stage 3 |
| With no session claim, every table returns zero rows | Database test, stage 3 |
| A cross-tenant target returns **zero rows, not a permission error**, and is audited | Database + unit, stages 3, 2 |
| A session binds one tenant, immutable for its lifetime; no route accepts a `tenant_id` | Unit test, stage 2 |
| Permission denial names the required permission, changes no state, and is audited | Unit test, stage 2 |
| A stored credential is absent from API responses, logs, error messages and model prompts | Unit + integration, stages 2, 8 |
| A privileged path with no explicit tenant scope is rejected and audited | Database test, stage 3 |

## Requirement 15 — Accuracy and Performance Bounds

| Done when | Verified by |
|---|---|
| Every operand, intermediate and result is `bigint` in range; overflow **raises** rather than wraps | **P12**, stage 5 |
| No `_paise` column has a type other than `bigint`; no float column holds money | Schema type audit, stage 3 |
| `applyRate` returns the rounding adjustment, and result + adjustment reconstructs the exact product | **P12**, stage 5 |
| `parseInr(formatInr(p)) === p` for all paise in range | **P11**, stage 5 |
| A reconciliation run over ≤ 5000 payments completes within 60 s at ≤ 5 concurrent runs | Performance test, stage 9 |
| Agent first content within 15 s; complete answer within 120 s | Performance test, stage 9 |
| A run reaching 120 s returns partial results, flags incomplete, names unprocessed types | Unit test, stage 2 |
| Repeating a run over unchanged data produces the identical exception set in identical order | **P5**, stage 5 |
| Above 5000 payments every payment is still processed, the count reported, the bound stated as not applying | Unit test, stage 2 |

## The MVP acceptance test

One ordered test, and if it passes the MVP is demonstrable:

1. Seed Razorpay test mode with one non-zero-residual settlement and one SET-9281-shaped zero-residual settlement
2. Ingest — one row per object identifier, run status `completed`
3. Derive the ledger — every set balances, a second pass creates nothing
4. Run the reconciliation agent — the zero-residual settlement is `difference_explained` with no exception; the other produces a mismatch exception with `impact = |residual|` and the correct direction
5. Fetch that exception's evidence chain — ordered steps replay to the figure exactly, every source identifier resolves to an ingested row
6. Ask "Why am I missing ₹3.82 lakh in settlements?" — the released response contains only figures from the tool output, each with a resolvable chain
7. Re-run step 6 with the gateway stubbed to return one fabricated figure — the **entire** response is withheld and the audit event is recorded

Step 7's pairing with step 6 is the acceptance test for the whole AI claim: the same pipeline releases grounded figures and withholds ungrounded ones, mechanically.

## Slice sign-off

A slice is done when its property gate passes, not when its tasks are checked off.

| Slice | Gate |
|---|---|
| 1 | P1, P2, P3, P5, P6, P10, P11, P12, P13 |
| 2 | P4, plus P1 and P5 over Route data |
| 3 | P7, P8, P9, P14 |
| 4 | Adversarial suite in full, plus all 14 properties |

## Related docs

- Full EARS criteria → `requirements.md`
- Property specifications → `design.md` → Correctness Properties
- Suite-to-stage mapping → [13_TESTING_STRATEGY.md](13_TESTING_STRATEGY.md)
