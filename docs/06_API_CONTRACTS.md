# 06 — API Contracts

> **Pointer document.** The authoritative route table and the full financial tool catalogue with typed signatures live in the spec. This file summarises the surface and the error envelope.

## Where the contracts are

**`.kiro/specs/financeos-control-tower/design.md`**

| Section | Contains |
|---|---|
| Components → FinanceOS_API | Route table with required permission per route |
| Financial Tool Catalogue | 17 read-only and 3 write-capable tools with typed input/output signatures |
| Components → shared types | `ToolResult<T>`, `EvidenceChain`, `EvidenceStep`, `SourceRef`, `ToolContext` |

## HTTP surface

| Route | Permission |
|---|---|
| `POST /ingestion/runs` | `manage_credentials` or `run_agents` |
| `GET /control-tower/metrics` | `view_financial_data` |
| `GET /exceptions?category=&page=` | `view_financial_data` |
| `POST /agents/{agent}/runs` | `run_agents` |
| `POST /agents/{agent}/ask` | `run_agents` |
| `GET /evidence-chains/{id}?page=` | `view_financial_data` |
| `POST /proposals/{id}/approve` \| `/reject` | `approve_sensitive_actions` |
| `GET /audit/verify` | `view_financial_data` |
| `PUT /configuration` | `configure_policy` |
| `PUT /credentials/{kind}` | `manage_credentials` |
| `GET /ai/usage?from=&to=` | `view_financial_data` |

**No route accepts a `tenant_id` parameter.** The tenant comes from the session claim and is immutable for the session lifetime. Acting in a different tenant requires a new session.

The only endpoints without a session requirement are the Supabase Auth callbacks and a static health check that returns a version string and touches no tenant table.

## The tool envelope

Every financial tool returns `ToolResult<Out>`, and every monetary figure inside `Out` is `Paise` accompanied by an `EvidenceChain`:

```ts
type ToolResult<T> =
  | { ok: true; value: T; evidence: EvidenceChain }
  | { ok: false; kind: 'incomplete_evidence'; unavailable: Array<{ type: SourceRecordType; count: number }> }
  | { ok: false; kind: 'schema_violation'; violations: Array<{ argument: string; reason: string }> }
  | { ok: false; kind: 'tool_failure'; tool: string; cause: 'timeout' | 'execution_error' }
  | { ok: false; kind: 'unauthorized_write'; reason: 'missing_authorized_proposal' };

interface EvidenceChain {
  evidence_chain_id: string;
  figure_paise: Paise;          // integer paise, always
  sources: SourceRef[];         // paged at 500 identifiers
  source_count: number;
  steps: EvidenceStep[];        // ordered, 1-based, one operation each
  as_of: string;                // ISO-8601 UTC, ms precision
}
```

Three envelope rules hold for every tool:

1. **A figure is never returned without its chain.** If a contributing source record cannot be read, the tool returns `incomplete_evidence` and omits the figure entirely rather than returning a partial number.
2. **Reads and writes are scoped to `ctx.tenant_id`**, taken from the session, never from a tool argument.
3. **Write-capable tools require `proposal_id` and `authorization_id`** in `ToolContext`, both resolving to a proposal with a recorded authorization. Read-only tools additionally execute on a connection whose role holds no write grants, so the mode declaration is backed by privilege rather than convention.

## Tool inventory

**Read-only (17):** `get_settlement_reconciliation`, `get_settlement_difference_breakdown`, `get_unsettled_payments`, `get_duplicate_refund_candidates`, `get_missing_accruals`, `get_trial_balance`, `list_exceptions_by_category`, `get_exception_evidence`, `get_compliance_findings`, `get_itc_discrepancy`, `get_seller_payout_chain`, `get_linked_account_balance`, `get_cash_forecast`, `simulate_cash_action`, `get_failed_payment_recovery_profile`, `get_period_comparison`, `get_control_tower_metrics`.

**Write-capable (3):** `post_reconciliation_adjustment`, `mark_exception_resolved`, `initiate_payment_retry`.

`initiate_payment_retry` is the only tool that calls a Razorpay write API. It records the Razorpay request and response identifiers on the proposal so verification has something observable to compare against.

## Input schema discipline

Every tool declares a Zod schema with `.strict()`. Unknown keys are rejected. **No tool accepts a free-form query string, filter expression or SQL text in any argument.** A schema violation is rejected before any tenant data is read — no connection is opened, no query is planned — and the rejection is audited.

This is the reason agents hold no database client. An agent cannot construct a query; it can only invoke a named tool with typed arguments.

## Events

Realtime subscriptions rather than a webhook surface:

| Channel | Table | Consumer |
|---|---|---|
| Exception changes | `exceptions` | Attention panel |
| Ingestion progress | `ingestion_runs` | Ingestion status, metric freshness |

## Error responses

Full per-layer behaviour is tabulated in `design.md` → `## Error Handling`, six tables covering ingestion, ledger, tool layer, AI and validation, policy and action, and tenancy and permissions. Each row states the condition, the detection mechanism, the user-visible result, the audit record, and — the load-bearing column — the state guarantee that holds afterwards.

Two rules apply across every row:

- **An error never leaves a half-written monetary record.** Every write path touching money is a single transaction, and the deferred balance trigger means a partially built ledger entry set cannot commit.
- **An error never emits a figure.** Failure modes return no number rather than an approximate one, because a number with an incomplete evidence chain is indistinguishable to a user from a number with a complete one.

Two notable response shapes:

- A **cross-tenant request returns zero rows**, not a permission error. A "forbidden" response would confirm the record exists, leaking information across a tenant boundary.
- A **permission denial names the required permission**, so the user knows what to request.

## Related docs

- Architecture and boundaries → [04_ARCHITECTURE.md](04_ARCHITECTURE.md)
- Agent tool usage and guardrails → [07_AI_AGENT_SPEC.md](07_AI_AGENT_SPEC.md)
- Failure behaviour → [10_ERROR_HANDLING.md](10_ERROR_HANDLING.md)
- Permission model → [09_SECURITY.md](09_SECURITY.md)
