# 08 — UI / UX Specification

## Design principle

Every number is a claim, and every claim is clickable down to its evidence. That single idea drives the whole interface. A figure the user cannot verify is worse than no figure, so nothing renders without a path to its source records.

The second principle: **one failing thing fails alone.** A metric that errors shows a failure state in its own cell while the other three render. The screen never blanks.

## Screens

### Control Tower (the home screen)

```
┌──────────────────────────────────────────────────────────┐
│  FinanceOS                              [tenant] [user]  │
├──────────────────────────────────────────────────────────┤
│  Cash            Revenue (30d)   Pending Settl.  Runway  │
│  ₹42,80,000.00   ₹86,40,000.00   ₹11,20,000.00   8.7 mo  │
│  42.80 L         86.40 L         11.20 L                 │
│  as of 14:32:07 IST                                      │
├──────────────────────────────────────────────────────────┤
│  ⚠ ATTENTION                                             │
│  Settlement mismatch          7    ₹3,82,000.00          │
│  Missing accrual              6    ₹4,70,000.00          │
│  Possible duplicate refund    4    ₹1,14,000.00          │
│  GST anomaly                  9      ₹82,400.00          │
├──────────────────────────────────────────────────────────┤
│  Ask the reconciliation agent…                           │
└──────────────────────────────────────────────────────────┘
```

**Metric strip.** Four independent async cells. Each owns its own loading, processing, failure and retry state.

| Cell state | Renders |
|---|---|
| Ready | Value in Indian format, secondary lakh/crore line, ingestion timestamp |
| Processing (≤ 30 s) | Processing indicator; navigation and controls stay operable |
| Failed — error | Metric name, "computation error", retry control |
| Failed — timeout | Metric name, "timed out", retry control |
| Runway not applicable | Non-numeric state naming the reason (net outflow not positive, or exceeds 120 months) |

**Number formatting.** 2,2,3 grouping from the right, always 2 decimal places, `₹` prefix. A secondary line appears in lakh at ₹1,00,000 and above, in crore at ₹1,00,00,000 and above, to 2 decimal places. Timestamps in IST to whole-second precision.

**Attention panel.** One row per exception category holding one or more open exceptions. Ordered by descending aggregate impact, ties broken by ascending alphabetical category name. Rows are selectable by pointer **and by keyboard**.

Two empty states, distinct on purpose:

| Condition | State |
|---|---|
| Zero ingested Razorpay objects | "Ingestion has not completed" — no monetary values shown, controls operable |
| Ingested data, zero open exceptions | "No open exceptions" — no panel rows |

The first says *we do not know yet*. The second says *we looked and found nothing*. Collapsing them into one blank panel would be a lie.

### Exception drill-down

Selecting a category row opens the individual exceptions in pages of at most 50, ordered by descending impact then ascending exception identifier. Each row shows impact, source record identifiers, and a control that opens the evidence chain.

### Evidence panel

Opens from any displayed figure.

```
┌─────────────────────────────────────────────────┐
│  ₹23,200.00  — Settlement SET-9281 difference   │
│  as of 2026-08-26 14:32:07 UTC                  │
├─────────────────────────────────────────────────┤
│  1  sum(payments)                 ₹8,45,000.00  │
│  2  sum(refunds)                     ₹2,400.00  │
│  3  subtract (1 − 2)              ₹8,42,600.00  │
│  …                                              │
│  8  subtract(received)               ₹23,200.00 │
│  9  sum(fees)                        ₹19,661.00 │
│ 10  sum(gst_on_fees)                  ₹3,539.00 │
│ 11  subtract (8 − 9)                  ₹3,539.00 │
│ 12  subtract (11 − 10)                    ₹0.00 │
├─────────────────────────────────────────────────┤
│  Source records (47)          [1] 2 3 4 5 ›     │
│  payment  pay_QxR9m2… settlement setl_9281…     │
└─────────────────────────────────────────────────┘
```

Ordered steps with operation and operand references. Source identifiers in pages of at most 100 with navigation to every remaining page. A **stale indicator** when any referenced record was updated after the chain's as-of timestamp — a chain older than 15 minutes is re-fetched before presentation.

### Agent conversation

The user asks; the agent streams. First displayable content within 15 seconds.

What renders:

- **Investigation progress** — which record types are being examined and their counts, so a long-running query does not look frozen
- **The figures**, each clickable to its evidence chain
- **The narrative**, only after the Response Validator releases it

When the validator withholds, the user sees a validation-failure notice and **no figures at all** — not a partial answer with the bad number removed. When every model provider fails, the user sees a narrative-unavailable notice while the tool-grounded figures and evidence chains **still render**, because they never depended on the model.

That asymmetry is the point: the figures are the product, the narrative is presentation.

### Approval queue

```
┌──────────────────────────────────────────────────────────┐
│  Reconciliation adjustment · SET-9281                    │
│  Impact ₹661.00                    Risk 40 / threshold 0 │
│  Expires in 21h 14m                                      │
├──────────────────────────────────────────────────────────┤
│  ✓ user permission      ✓ accounting rule                │
│  ✓ transaction evidence ✓ duplicate action               │
│  ✗ risk threshold       ✓ approval requirement           │
├──────────────────────────────────────────────────────────┤
│  [View evidence]          [Reject]  [Approve]            │
└──────────────────────────────────────────────────────────┘
```

**All six policy check results always render**, including on a blocked proposal — a user seeing only the one that failed cannot tell whether the rest were evaluated. Risk score and the threshold used are both shown, so the decision is legible rather than opaque.

Approve and reject are gated on `approve_sensitive_actions`. An expired proposal **removes both controls** rather than leaving them to fail on click.

### Compliance views

Every finding, TDS review item and ITC discrepancy renders the review-only, not-authoritative-tax-advice statement **in the same view as the item**. Not in a footer, not behind a tooltip, not on a separate page. The disclaimer travels with the claim.

### Ingestion status

Run status, per-object-type stored and error counts, and the window basis. A credential rejection shows the run as failed with the cause named — never the credential value.

## Interaction states

| State | Behaviour |
|---|---|
| Loading | Per-cell, never full-screen |
| Processing (≤ 30 s) | Indicator with controls operable |
| Timed out (> 30 s) | Failure state distinguishing timeout from error, with retry |
| Partial (agent hit 120 s) | Results shown, flagged incomplete, unprocessed record types named |
| Stale evidence | Explicit indicator; re-fetched past 15 minutes |
| Withheld response | Validation notice, zero figures |
| Provider unavailable | Narrative notice, figures still render |
| Cost cap reached | Cap notice with month-to-date and cap, figures still render |
| Permission denied | Error naming the required permission |
| Cross-tenant target | Nothing — zero rows, existence not confirmed |

## Accessibility

- Attention panel rows and exception rows are keyboard-selectable, not pointer-only
- Every displayed figure is a focusable control opening its evidence chain
- Metric failure states are conveyed by text naming the metric and the cause, not by colour alone
- Evidence chain step tables use proper table semantics with header association
- Pagination controls are reachable and labelled with the page range
- Currency values include the symbol in text rather than relying on formatting
- Loading and processing states are announced, so a screen reader user is not left in silence during a 15-second agent response

Full WCAG conformance requires manual testing with assistive technologies and expert accessibility review; this section sets the implementation baseline.

## Copy principles

Say what is true and how precisely it is known.

| Instead of | Write |
|---|---|
| "Approximately ₹3.8 lakh missing" | "₹3,82,000.00 unexplained across 7 settlements" |
| "Reconciliation complete" | "7 discrepancies across 4,821 payments, 73 settlements" |
| "Something went wrong" | "Cash metric timed out after 30 seconds. Retry." |
| "AI suggests reconciling this" | "Proposed: reconciliation adjustment, ₹661.00, 6 checks evaluated" |
| "Tax issue found" | "Invoice inv_4A9 has no customer GSTIN. For review — not tax advice." |

Never round a monetary figure in copy. The formatter renders it; prose does not restate it approximately. This is the same rule the Response Validator enforces on model output, applied to human-written text.

## Related docs

- Component structure → `design.md` → Components → FinanceOS_UI / Control_Tower
- What each state means → [10_ERROR_HANDLING.md](10_ERROR_HANDLING.md)
- Unusual situations the UI must handle → [11_EDGE_CASES.md](11_EDGE_CASES.md)
- UI task breakdown → `tasks.md` tasks 14.1–14.6, 28.1–28.2, 32.7
