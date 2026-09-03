# 15 — Out of Scope

> **Pointer document.** The binding exclusions are stated in the spec's non-goals section, which is normative: no requirement in the document may be interpreted as requiring them. This file restates them and adds the softer exclusions that prevent feature creep.

## Where the binding exclusions are

**`.kiro/specs/financeos-control-tower/requirements.md` → `## Non-Goals`**

Five hard boundaries:

| Non-goal | Means |
|---|---|
| **Not an ERP** | No procurement, inventory, manufacturing, HR or business process management. FinanceOS reads and reconciles financial state; it is not the system of record for operations. |
| **Not a tax filing or compliance authority** | Detection and review only. No GST returns, no TDS returns, no statutory filings, no authoritative tax advice. |
| **Not a Razorpay replacement** | No payment processing, no holding funds, no money movement on our own rails. |
| **Not a bookkeeping replacement for statutory books** | The semantic ledger serves reconciliation and explanation, not certified books of account. |
| **Not an autonomous money mover** | No sensitive action executes without a recorded human authorization. |

These are positioning decisions, not temporary limitations. The tax boundary in particular is a permanent product stance — it is why every compliance finding carries a review-only disclaimer in the same view.

## Additionally out of scope for the MVP

### Not building at all

| Excluded | Why |
|---|---|
| Razorpay **live mode** | Test mode only. Promotion is a separately gated change requiring a distinct credential kind, a per-tenant flag, an audit event, and a re-review of the auto-execute threshold. |
| Accounting software integrations (Tally, Zoho Books, QuickBooks) | The semantic ledger is internal. Export is a roadmap item, not MVP. |
| Bank statement ingestion or bank feed reconciliation | Settlements are read from Razorpay. Bank-side matching is a separate problem. |
| Payment gateways other than Razorpay | The whole value proposition is depth on one gateway's object model. |
| GSTIN registry lookup or GSTIN checksum verification | Structural validation only. A registry lookup would imply authority we do not have. |
| GSTR-1 / GSTR-2A / GSTR-3B reconciliation | Requires filing data we do not ingest. |
| e-Invoice or e-Way Bill generation | Statutory output, excluded by the tax non-goal. |
| Invoice creation or editing | We read invoices, we do not author them. |
| Customer or vendor master data management | Records are read from Razorpay payloads. |
| Payroll processing | Payroll obligations are a forecast input, not something we run. |
| Vendor payment execution | Scheduled payments are a forecast input. |
| Multi-currency | INR only. Every monetary value is paise, every display is `₹`. |
| Mobile apps | Web only. |
| Email or SMS notification | Realtime in-app only. |
| SSO, SAML, SCIM | Supabase Auth only. |
| Custom report builder | Fixed screens plus evidence bundle export. |
| Anomaly detection by machine learning | Detection rules are arithmetic and deterministic, which is what makes runs reproducible. A learned model would break property P5. |

### Deliberately not automated

| Excluded | Why |
|---|---|
| Auto-execution by default | The auto-execute threshold defaults to 0. A tenant must deliberately raise it. |
| Auto-reverting a verification failure | The executed change is left in place for human review. Acting twice on state we have demonstrated we do not understand would be worse. |
| Auto-retrying a failed execution | Requires a new authorization. |
| Reopening a resolved exception | The upsert is guarded on `lifecycle_state = 'open'`. Silently reopening resolved work argues with the user. |
| Repairing a broken audit chain | Verification reports anomalies as evidence. A log that repairs itself is not evidence. |
| Tolerance bands on monetary comparison | "Difference explained" means residual exactly `0n`. A tolerance is where systematic errors hide. |

### Not in the MVP but architecturally anticipated

These have a place to go without redesign. See [17_ROADMAP.md](17_ROADMAP.md).

| Deferred | Where it would attach |
|---|---|
| Additional model providers | The `ModelProviderAdapter` interface |
| Additional agents | The Agent Engine's pipeline runner |
| Additional exception categories | The `exception_category` enum + a detector |
| Additional financial tools | The tool registry |
| Additional ledger posting rules | `src/ledger/posting-rules.ts` |
| Scheduled agent runs | A cron trigger on the existing run path |
| Additional permissions | The `permission` enum |

## Thin-sliceable, not out of scope

`design.md`'s MVP Build Order marks some behaviour as thin-sliceable — required but landing as a later sub-task within its slice. These are **in scope**, just sequenced:

incremental ingestion watermark, the secondary reconciliation detectors, per-metric failure isolation, on-hold and pending Route handling, the approval window sweep, audit history pagination, TDS review items, forecast simulation and ranked actions, the recovery aggregate, unusual transactions and top contributors, the AI usage breakdown.

Do not confuse "not built yet" with "not in scope."

## How to handle a scope request

1. Is it excluded by a **non-goal**? Then no, and the answer does not depend on effort.
2. Is it in the "not building at all" table? Then it needs an explicit scope change, not a task.
3. Is it thin-sliceable? Then it is already in the plan — check `tasks.md`.
4. Is it none of these? Then it is a genuine new requirement: add it to `requirements.md` in EARS format first, propagate to `design.md`, then to `tasks.md`. Not the other way round.

The propagation order matters. A feature that arrives as a task without a requirement has no acceptance criteria and no correctness property, which means nobody can say when it is done.
