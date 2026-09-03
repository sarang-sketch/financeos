# 17 — Roadmap

> **Pointer document.** The authoritative MVP sequencing is the MVP Build Order section of the spec's design document, with per-component "fully required vs thin-sliceable" breakdowns and the property gates between slices. This file summarises it and separates MVP from post-MVP so future features stay out of the current build.

## Where the MVP sequencing is

**`.kiro/specs/financeos-control-tower/design.md` → `## MVP Build Order`**
**`.kiro/specs/financeos-control-tower/tasks.md`** — 37 tasks implementing it, with gate tasks at 17, 20, 29 and 37.

## MVP: four slices

| Slice | Requirements | Ships | Gate |
|---|---|---|---|
| **1 — the centerpiece** | 1, 2, 3, 4, 12, 15 | Ingestion, semantic ledger, reconciliation agent, tool layer, evidence chains, control tower, accuracy invariants. **No AI at all.** | P1, P2, P3, P5, P6, P10, P11, P12, P13 |
| **2 — the differentiator** | 7 | Razorpay Route / marketplace reconciliation | P4; P1 and P5 re-run over Route data |
| **3 — the safety spine** | 5, 13, 14 | Policy engine, approval, verification, hash-chained audit, multi-tenancy | P7, P8, P9, P14 |
| **4 — breadth** | 11, then 6, 8, 9, 10 | AI gateway first, then compliance, cash, recovery, analyst | Adversarial suite in full; all 14 properties |

The gates are hard. A slice is done when its properties pass, not when its tasks are checked off.

## Why this order

Three reasons, from `design.md`:

**Exact arithmetic first, because everything downstream is built on it.** A cash forecast computed on a ledger that does not balance is not a partially useful forecast; it is a confidently wrong one.

**The model last, because it is decorative.** Slice 1 answers the demo question with figures and evidence chains and no narrative at all. Adding narrative in slice 4 improves how the answer reads; it does not change whether the answer is right. Building it in that order keeps the team honest about which is which.

**Safety before breadth.** The agents added in slice 4 are the ones that would benefit from acting, and none should be able to act before the policy engine, the authorization record and the audit chain exist. Slice 1 and 2 agents only detect and explain — they write no proposal that could execute.

## Post-MVP

Nothing below is in the current build. Listing it here is what keeps it out of `requirements.md`.

### v1.1 — close the loop with the accountant

| Item | Why next | Attaches to |
|---|---|---|
| Semantic ledger export (Tally XML, Zoho Books, QuickBooks) | The most-requested thing after "why is this short" is "put it in my books" | New export tools in the registry |
| Evidence bundle as a formatted PDF | Auditors want a document, not a screen | Existing Supabase Storage bucket |
| Scheduled agent runs | Continuous detection instead of on-demand | Cron trigger on the existing run path |
| Email digest of new exceptions | Attention panel only works if someone opens it | New notification component |
| Bulk exception resolution with one authorization | Resolving 40 exceptions one at a time is unusable | Proposal with a multi-target record set |

### v1.2 — Razorpay live mode

Gated deliberately, not incidentally. Requires: a distinct `razorpay_live` credential kind stored separately from `razorpay_test`; a per-tenant live-mode flag settable only with `manage_credentials`; an audit event recording the promotion; a re-review of the auto-execute threshold, because a threshold acceptable when no money moves is not necessarily acceptable when it does; and a live-mode-specific rate limit review.

**Not a configuration toggle.** Nothing in the current design treats live mode as reachable by accident.

### v1.3 — bank-side reconciliation

Currently settlements are read from Razorpay and trusted as received. The next layer is matching Razorpay settlements against actual bank credits, which catches a class of problem the MVP cannot see: a settlement Razorpay says it sent that never arrived.

Needs bank statement ingestion (upload, then feed), a bank account ledger with its own posting rules, a settlement-to-bank-credit matcher, and a new exception category for unmatched settlements. This is a genuine scope expansion, not an extension.

### v1.4 — deeper GST

| Item | Constraint |
|---|---|
| GSTR-2A / 2B reconciliation against ingested invoices | Needs filing data we do not ingest today |
| GSTIN registry lookup | Would upgrade structural validation to actual validation |
| HSN/SAC code validity checking against the official list | Reference data, not inference |
| ITC eligibility rules beyond the arithmetic discrepancy | Needs care — see below |

**The tax boundary does not move.** Even in v1.4, FinanceOS detects and reviews. It does not file, and it does not give authoritative tax advice. That is a permanent product stance, stated as a binding non-goal in `requirements.md`.

### v2 — multi-gateway

The whole current value proposition is depth on one gateway's object model. Supporting a second (Cashfree, PhonePe, PayU) means abstracting the ingestion layer and the reconciliation arithmetic behind a gateway-neutral model, which is a rewrite of the core rather than an addition to it.

Worth doing only once the Razorpay depth is unambiguously proven. Doing it early would trade the differentiator for breadth.

### Explored and rejected

| Idea | Why not |
|---|---|
| ML-based anomaly detection | Would break property P5. Detection rules are arithmetic and deterministic, which is exactly what makes runs reproducible and exceptions stable across re-runs. A learned score is neither. |
| Tolerance bands on settlement matching | A tolerance is where systematic errors hide. "Difference explained" means residual exactly `0n`. |
| Auto-reverting verification failures | Acting twice on state we have demonstrated we do not understand is worse than leaving it for review. |
| Letting the model call tools with free-form filters | Removes the guarantee that a compromised model cannot over-fetch. |
| An agent that writes the ledger directly | Every write goes through an authorized proposal. No exceptions. |

## Architecture extension points

Post-MVP items attach without redesign:

| Extension | Point |
|---|---|
| A model provider | `ModelProviderAdapter` interface |
| An agent | Agent Engine pipeline runner |
| An exception category | `exception_category` enum + a detector |
| A financial tool | Tool registry |
| A ledger posting rule | `src/ledger/posting-rules.ts` |
| A permission | `permission` enum |
| A scheduled job | Existing agent run path |
| A correctness property | fast-check suite + a gate |

## Thin-sliceable is in scope

`design.md` marks some MVP behaviour as thin-sliceable — required, but landing as a later sub-task within its slice rather than blocking it. Present as tasks 6.6, 13.5, 14.5, 19.6, 19.7, 23.5, 26.4, 30.7, 32.6, 33.5, 34.5, 35.3.

These are **not roadmap items.** Do not confuse "not built yet" with "not in scope." See [15_OUT_OF_SCOPE.md](15_OUT_OF_SCOPE.md).

## Adding something to the roadmap

Roadmap entries are prose and cost nothing. Turning one into work costs propagation:

1. Write the requirement in `requirements.md` in EARS format, with acceptance criteria
2. Extend `design.md` — component, algorithm, DDL, and a correctness property if it carries an invariant
3. Add tasks to `tasks.md` citing the requirement
4. Update [14_ACCEPTANCE_CRITERIA.md](14_ACCEPTANCE_CRITERIA.md)

In that order. A feature arriving as a task without a requirement has no acceptance criteria and no property, which means nobody can say when it is done.
