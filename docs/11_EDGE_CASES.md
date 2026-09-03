# 11 — Edge Cases

Failures are covered in [10_ERROR_HANDLING.md](10_ERROR_HANDLING.md). This document covers the harder class: data that is *valid* but ambiguous, absent, contradictory or unusual, where the wrong choice produces a confidently wrong number rather than an error.

The governing rule: **when the data does not support a conclusion, say so rather than inferring one.**

## Reconciliation

| Situation | Behaviour | Why |
|---|---|---|
| Settlement recon report absent | Status `unreconciled`. No expected amount, no difference, all five figures `null`. **Excluded from the reported total shortfall.** | Including it as zero would understate the shortfall; estimating it would fabricate a figure |
| Recon report present but enumerates 0 payments | Same as absent | An empty report carries no more information than a missing one |
| Payment matches 2+ candidate settlements | Classified **ambiguous**, exception raised naming every candidate, and **excluded from the unsettled classification** | Picking one would be a guess; calling it unsettled would be wrong since candidates exist |
| Payment matches no settlement | Classified **unsettled** with the payment age in days. Excluded from every settlement computation in that run | It is not a discrepancy, it is money not yet paid out |
| Residual is 1 paisa | A mismatch exception with impact ₹0.01 | "Difference explained" means residual exactly `0n`. There is no tolerance band, because a tolerance is where systematic errors hide |
| Residual is negative | Classified **unexplained excess**, not shortfall, with the absolute value as impact | Receiving more than expected is also unreconciled and also needs explaining |
| Combined refunds exactly equal the payment | **No exception.** The threshold is exceeding by 1 paisa or more | A full refund is normal |
| Combined refunds exceed by 1 paisa | Duplicate-refund exception with the excess as impact | Exact arithmetic, not similarity heuristics — a near-duplicate flagged as duplicate is a false accusation about someone's money |
| Refund with no matching payment | Missing-accrual exception referencing the refund | |
| Payment with a fee but no GST on fee | Valid. Ledger set has fewer entries; `paise_positive` forbids zero-amount entries | Some payment methods carry no GST on fee |
| Payment where fee + GST ≥ amount | Cannot occur in Razorpay data. Generators repair rather than filter this invariant | |
| Same condition detected on a re-run | Existing **open** exception updated in place by fingerprint; `first_detected_at` preserved, `last_detected_at` advanced | Duplicating would inflate the attention panel |
| Same condition after a user resolved it | **Not reopened.** The upsert is guarded by `WHERE lifecycle_state = 'open'` | Silently reopening resolved work is an argument with the user |
| Dataset exceeds 5000 payments | Every payment still processed; count reported; the 60-second bound stated as not applying | Correctness does not degrade with volume; the promise about speed does |

## Marketplace / Razorpay Route

| Situation | Behaviour | Why |
|---|---|---|
| Linked account has 0 settlements in range | Classified **pending**, not mismatched. Pending amount and oldest transfer age reported | Reporting a shortfall against a seller who has not been paid yet is wrong |
| Transfer partially reversed | Counted at its **own reversed amount**, not the full transfer amount | |
| Transfer reversed twice | Each reversal counted at its own amount | |
| Transfer on hold | **Excluded** from expected payout, reported separately with identifier and amount | It is not lost, it is withheld |
| Transfers sum above the payment amount | `over_allocated_split` exception with the excess as impact | Data error worth surfacing |
| Chain exceeds 200 rows | First 200 in the defined order, total count reported, chain flagged truncated | A silent cut would misrepresent the total |
| Seller received more than expected | Direction **excess**, absolute difference as impact | |

## Ledger

| Situation | Behaviour | Why |
|---|---|---|
| Derivation produces a zero-amount entry | Entry omitted. Set may be 2 entries instead of 4 | `paise_positive` requires > 0 |
| Set would have 1 entry | Rejected. Minimum is 2 | Single-entry sets cannot balance |
| Set would exceed 20 entries | Rejected | Bound exists so pathological sets are caught |
| Reversal set posts to the same account on both sides | Valid. Pair nets to 0 per account | |
| Reversing an already-reversed set | Two independent reversal sets; original untouched both times | Reversal is not a toggle |
| Trial balance range fully outside the data window | Zero accounts, both totals `0n` | Empty is a valid answer |
| Trial balance range where start = end | Single day, inclusive | |
| Trial balance start after end | Rejected | |

## Cash forecasting

| Situation | Behaviour | Why |
|---|---|---|
| Average net monthly outflow is zero or negative | Runway reported **not applicable** with the reason stated. Control Tower shows a non-numeric state | Dividing by zero, or showing "infinite runway", would both be misleading |
| Runway exceeds 120 months | Non-numeric state distinguishing this from not-applicable | A four-digit runway is a data artefact, not a fact |
| Fewer than 30 days of ingested data | Forecast still produced, flagged **partial history**, with earliest date, latest date and day count | Useful with a caveat beats refusing |
| Obligation date in the past | No answer. Error naming the supported range | |
| Obligation date beyond the horizon | No answer. Error naming the supported range | Extrapolating past the horizon invents data |
| Razorpay settlement cycle data absent | Date assigned as capture + 3 days, basis recorded `default_delay` | The basis is always visible, so the user knows which dates are scheduled and which estimated |
| Projected cash exactly equals obligation + buffer | Risk **low**, shortfall `0n` | Bands are defined on `>=`, exhaustive and mutually exclusive |
| Headroom exactly zero | Risk **medium** | Meeting the obligation with no buffer is not low risk |
| Two forecast components tie as primary cause | Tie-break: earliest date, then source id, then component name | Determinism |
| No outflow components at all | No primary cause reported | |

## Compliance

| Situation | Behaviour | Why |
|---|---|---|
| GSTIN is 15 chars but state code is `00` or `39` | Invalid, failing rule named `state_code_01_to_38` | Naming the specific rule makes the finding actionable |
| GSTIN fails several rules | **First failing rule** in checking order is reported | One specific reason beats a list |
| GSTIN char 13 unusual | **Not validated.** Requirement 6.3 does not constrain it | Validating beyond the spec would produce false positives |
| GSTIN structurally valid but unregistered | **Not detected.** Structural validation only, not a registry lookup | Claiming otherwise implies authority the product lacks |
| Invoice tax matches no valid GST rate | `gst_anomaly` with the difference from the nearest valid-rate amount | |
| Invoice tax within 1 paisa of a valid rate | No anomaly | Rounding at the source is not an error |
| Invoice with zero tax and 0% in the valid set | No anomaly | Zero-rated supplies are legitimate |
| Credit note with no linked invoice | `unmatched_credit_note`, indicating no link exists | |
| Credit note whose linked invoice does not reconcile | Same category, indicating the adjusted value mismatch | Two distinct conditions, one category, distinguished in detail |
| ITC discrepancy below 1 paisa | Reported but **no exception created** | Sub-paisa noise is not an exception |
| Customer with no GSTIN below the review threshold | No exception | B2C customers legitimately have none |

## Recovery

| Situation | Behaviour | Why |
|---|---|---|
| Customer has zero successful payments | Probability from **tenant-level rates only**, basis reported `tenant_level` | A 70% weight on an empty history is meaningless |
| Channel has zero attempts | Rate is 0 | Avoids dividing by zero |
| Historical sample below minimum | **No proposal.** Available count, configured minimum, and the condition reported | A probability on 3 payments is not a probability |
| Two channels tie on probability | More tenant successes, then fixed order UPI → card → netbanking → wallet | |
| Failed payment later succeeded on the same order | **No proposal**, exclusion reason `already recovered` | |
| Retry proposal already executed | **No proposal**, exclusion reason `already retried` | Prevents retry loops |
| Failed payment older than max retry age | **No proposal**, age in days reported | Retrying a three-week-old failure annoys a customer |

## Analyst

| Situation | Behaviour | Why |
|---|---|---|
| Prior period value is zero | Percentage change **not applicable** | Not infinity, not 100%, not omitted |
| Prior period has zero transactions | Current values reported; every percentage not applicable; stated explicitly | |
| Period length outside 1–366 days | Error naming the supported range, no figures, no state change | |
| No period specified | Trailing 30 days, with resolved start and end dates **echoed back** | The user should know what was measured |
| Fewer than 3 contributors exist | Those that exist, with the count reported | |
| More than 20 unusual transactions | Top 20 by absolute amount, total count reported | |
| Median of same-type transactions is zero | Threshold becomes zero; classification degenerates. Median and computed threshold both reported so it is visible | Better to expose a degenerate input than hide it |

## Ingestion

| Situation | Behaviour | Why |
|---|---|---|
| First run, no prior completed run | 365-day window, basis `first_run_365d` | |
| Prior run `partially_completed` only | Treated as no completed run — full window again | Incrementing from a partial run would skip records |
| Re-ingesting the same object | One row per `(tenant_id, razorpay_id)`; payload replaced, `retrieved_at` refreshed | |
| Payload changes between runs | Latest payload stored; ledger derivation stays idempotent | Razorpay is the source of truth for payloads |
| Page returns exactly 100 records | Another page requested | Termination is on **fewer than** 100 |
| Zero records across every type | Run status `failed` — zero stored | |

## Multi-tenancy

| Situation | Behaviour | Why |
|---|---|---|
| User belongs to several tenants | Session binds exactly one, immutable. Another tenant needs a new session | Removes an entire class of mid-request confusion bug |
| Request targets a foreign record | **Zero rows.** Not a permission error | A forbidden response confirms existence, leaking across a boundary |
| Two tenants hold identical amounts and dates | Isolation still holds. P7 generates exactly this to make leaks detectable | A leak that looks like a coincidence is still a leak |
| Session claim absent | Every RLS predicate false, zero rows everywhere | Failure mode is closed |

## AI and validation

| Situation | Behaviour | Why |
|---|---|---|
| Model states an allowed value in crore, exactly | **Released** — normalises to an exact member | |
| Model rounds "3.82 Cr" to "3.8 Cr" | **Withheld** — normalises to a non-member | This is precisely where a plausible hallucination hides |
| Model states a figure off by 1 paisa | **Withheld.** Zero tolerance | A tolerance band is a hole |
| Model sums two allowed values into a third | **Withheld** — the sum was never returned by a tool | Models do not compute money, including addition |
| Nine correct figures, one fabricated | **Entire response withheld** | A user cannot be expected to spot which one was invented |
| Model returns no figures at all | Released if narrative-only | |
| Model output exceeds 8000 chars | Truncated at the bound | |
| Agent supplies over 200 tool values | **Rejected, not truncated** | Dropping a value would cause a false withholding later |
| Cost cap reached exactly | Rejected — comparison is `>=` | |

## Related docs

- Failure conditions and state guarantees → [10_ERROR_HANDLING.md](10_ERROR_HANDLING.md)
- How each state renders → [08_UI_UX_SPEC.md](08_UI_UX_SPEC.md)
- Generators that produce these shapes → `design.md` → Correctness Properties → Generators and arbitraries
