# 10 — Error Handling

> **Pointer document.** The authoritative failure behaviour is tabulated in the spec across six per-layer tables. This file states the two governing rules and points at the detail.

## Where the error handling is

**`.kiro/specs/financeos-control-tower/design.md` → `## Error Handling`**

Six tables — ingestion, semantic ledger, financial tool layer, AI and validation, policy/action/verification, and tenancy/permission/metric. Each row states five things:

| Column | Why it is there |
|---|---|
| Condition | What went wrong |
| Detection | How the system knows |
| User-visible result | What the person sees |
| Audit record | What is provable afterwards |
| **State guarantee** | What is true about stored data afterwards |

The state guarantee is the load-bearing column. In a financial system, *what is true after the failure* matters more than the error message.

## The two governing rules

**An error never leaves a half-written monetary record.** Every write path touching money is a single transaction, and the deferred ledger balance trigger means a partially built entry set cannot commit. There is no state in which a settlement is half-reconciled or a ledger set is half-posted.

**An error never emits a figure.** Failure modes return no number rather than an approximate one. A number carrying an incomplete evidence chain is indistinguishable to a user from a number carrying a complete one, so returning it would be worse than returning nothing.

## Failure inventory

| Condition | Result | State afterwards |
|---|---|---|
| Razorpay non-credential error on one object type | Run continues; that type shows an error count | Other types stored; status `partially_completed` or `failed` |
| Razorpay rate limit or 30 s timeout | Transparent while retrying 1/2/4/8/16 s, max 5 | A page is fully stored or not stored, never half-parsed |
| Razorpay credential rejected | Run `failed`, cause named, value never echoed | **Zero** objects stored this run; prior objects byte-identical |
| Ledger set would not balance | Error with imbalance in paise and source ids | **Exactly 0** entries persist; no balance changes |
| Second derivation from same source record | `{ ok: true, created: false }` — not an error | Existing set retained; 0 entries added; balances unchanged |
| Update or delete on `ledger_entries` | Error: append-only, correct by reversal | Target row unchanged in every field; attempt audited |
| Tool argument violates its schema | `schema_violation` naming each argument | **No tenant data read at all**; no connection opened |
| Tool exceeds 10 s or throws | `tool_failure` with cause | Invocation terminated, transaction rolled back |
| A contributing source record unreadable | `incomplete_evidence` with per-type counts; **figure omitted** | No partial figure returned or persisted |
| Write-capable tool without authorization | `unauthorized_write` | Nothing written |
| All 3 model providers fail | Narrative unavailable; **figures still render** | Exceptions from DETECT remain |
| Monthly model cost cap reached | Cap notice with month-to-date and cap | No provider called, no cost incurred |
| Model states an ungrounded figure | **Entire response withheld**, no figures shown | No state change; user can re-ask |
| Figure with no resolvable evidence chain | Entire response withheld | No state change |
| One or more policy checks fail | `block` showing **all 6** results, risk, threshold | Proposal retained `blocked`; **no state change** |
| Approval window expires | Proposal expired; approve/reject controls removed | Execution withheld **permanently**; new proposal required |
| Execution fails mid-way | Marked execution-failed; `execution_failure` exception | Applied changes reversed; **no retry without new authorization** |
| Verification differs by > 1 paisa | Marked verification-failed; exception with the difference | **No further automatic change**; left for human review |
| Audit chain mismatch or gap | Lowest mismatched and lowest absent sequence numbers | Read-only; nothing repaired |
| Cross-tenant request | **Zero rows** — not a permission error | Target row unchanged |
| Unscoped privileged path | Rejected, no data returned | Records unchanged |
| Missing permission | Error **naming the required permission** | **No state change**; nothing read |
| No/expired/invalid session | Auth-required error, no tenant id leaked | Nothing read or written |
| Metric errors or exceeds 30 s | Failure state **for that metric only**, with retry | Read-only; other metrics render |
| Agent run reaches 120 s | Partial results, flagged incomplete, types named | Upserted exceptions valid; no partial set or proposal |

## Three decisions that read as surprising

**Verification failure does not auto-revert.** When observed state differs from the expected outcome by more than 1 paisa, the proposal is marked verification-failed and an exception is raised, but the executed change is **left in place** for human review. Auto-reverting on a verification mismatch would mean acting twice on state we have already demonstrated we do not understand.

**Execution failure does revert.** The difference is that an execution failure means the action did not complete, so reversing restores a known state. A verification failure means the action completed and the *outcome* was unexpected — a different situation.

**Model payload bounds reject rather than truncate.** Silently dropping a tool value would remove a legitimate figure from the validator's allowed set and cause a false withholding downstream — a confusing failure that looks like a hallucination but is not.

## Retry policy at a glance

| Path | Retry | Then |
|---|---|---|
| Razorpay rate limit / timeout | Same request, 1/2/4/8/16 s, max 5 | Record error for that object type |
| Razorpay other error | None | Record, continue other types |
| Razorpay credential rejected | None | Abort run, store nothing |
| Model rate limit / timeout | Same provider, 1000/2000 ms, max 2 | Fail over to next provider |
| Model other error | None | Fail over immediately |
| Model chain exhausted (3 providers) | None | `provider_unavailable` with per-attempt detail |
| Tool timeout | None | `tool_failure` |
| Metric computation | User-initiated retry control | — |
| Failed proposal execution | None automatically | New authorization required |

## Related docs

- Response shapes → [06_API_CONTRACTS.md](06_API_CONTRACTS.md)
- What the user sees per state → [08_UI_UX_SPEC.md](08_UI_UX_SPEC.md)
- Ambiguous and contradictory data → [11_EDGE_CASES.md](11_EDGE_CASES.md)
- What gets logged and audited → [12_OBSERVABILITY.md](12_OBSERVABILITY.md)
