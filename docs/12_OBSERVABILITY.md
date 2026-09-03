# 12 — Observability

FinanceOS has two distinct record-keeping systems, and conflating them would be a mistake.

**The audit log** is a product feature. It is append-only, hash-chained, tenant-scoped, retained for at least seven years, and it exists so a business owner can prove what the AI detected, proposed, authorized, executed and verified. It is queryable through the API.

**Operational telemetry** is engineering infrastructure. Logs, metrics and traces for diagnosing why something is slow or broken. It is not a compliance artefact and must never become the place where financial history lives.

The dividing line: if a finance person might need it to explain a number to an auditor, it belongs in the audit log. If an engineer needs it to explain a latency spike, it belongs in telemetry.

## The audit log

Authoritative design: `design.md` → Components → FinanceOS_Audit_Service, `## Data Models` → Audit log, and `## Key Algorithms` → Audit chain_value and the verification walk.

### What every event carries

| Field | Notes |
|---|---|
| `tenant_id` | RLS-scoped |
| `sequence_number` | Tenant-scoped, **gapless**, strictly increasing |
| `event_type` | |
| `stage` | One of the seven pipeline stages, where applicable |
| `outcome` | `succeeded`, `failed` or `blocked` |
| `actor_kind` / `actor_id` | Exactly one of a user, an agent name, or the policy engine |
| `proposal_id` | Where the event relates to a proposal |
| `source_record_refs` | **Identifiers only** — never a copy of record content |
| `payload` | Reduced past 65,536 bytes with an indicator set |
| `occurred_at` | UTC, millisecond precision |
| `chain_value` / `prev_chain_value` | SHA-256 tamper evidence |

### Why gapless matters and how it is achieved

A Postgres sequence leaves gaps on rollback. A gap in an audit log is indistinguishable from a deleted record, so gaps would destroy the log's evidentiary value.

`app.append_audit_event` therefore locks a per-tenant counter row with `SELECT ... FOR UPDATE`, allocates the next number, computes the chain value, inserts, and advances the counter — all in one serialized transaction. The counter advances only on commit.

### Chain verification

`GET /audit/verify` walks the events in ascending sequence order, recomputes each chain value over stored fields, and reports **two independent findings**: the lowest mismatched sequence number and the lowest absent sequence number. Both, because a gap and a tamper can coexist.

The walk continues from the **stored** chain value rather than the recomputed one. Chaining from recomputed values would make every event after a single tampered row report as mismatched, which is technically correct but useless for locating the edit. Chaining from stored values means exactly the tampered rows report as mismatched.

The verification is read-only. It reports anomalies as actionable evidence; it does not repair them.

### What is audited

| Category | Events |
|---|---|
| Pipeline | One per completed stage, within 5 s of completion |
| Authorization | Approvals, rejections, policy-engine auto-authorizations, expiries |
| Execution | Execution success, execution failure, each reversing ledger set |
| Verification | Success, and failure with observed/expected/difference in paise |
| Rejections | `mutation_rejected`, `tool_invocation_rejected`, `unauthorized_write_rejected`, `ledger_set_rejected` |
| Validation | `response_withheld` with the unmatched figure |
| Security | `cross_tenant_access_rejected`, `unscoped_access_rejected`, `permission_denied` |
| Config | Credential store or replace — **without the value** |
| AI | `model_request_rejected_cost_cap` |
| Ingestion | Run start, run completion with counts, credential rejection |

Note that **rejections are audited as thoroughly as successes.** A blocked proposal, a withheld response and a cross-tenant attempt are all things someone may later need to prove happened.

### Retention

At least 2555 days (seven years), tenant-configurable upward only. Events are readable and unchanged for the whole period — this is correctness property P9.

### History queries

| Query | Returns |
|---|---|
| Source record history | Events referencing that record, ascending timestamp then sequence, pages of 100 |
| Proposal history | Exactly one event per completed stage, with absent stages identified as **not completed** |

Naming absent stages rather than omitting them is deliberate: a proposal that stopped at AUTHORIZE should visibly show four stages complete and three not, rather than looking like a four-stage pipeline.

## Operational telemetry

### Structured logs

JSON, one object per line. Every entry carries `tenant_id`, `request_id`, `route` or `component`, `level`, `duration_ms`.

**Never in a log line:** a credential value, a full Razorpay payload, personally identifiable customer data beyond an identifier, or a model prompt containing tenant figures.

The redaction filter matches on credential **value**, not key name, so a credential that ends up in an unexpected field is still redacted. Key-based redaction only catches what you predicted.

| Level | Used for |
|---|---|
| `error` | Unhandled failures, provider chain exhaustion, ledger rejection |
| `warn` | Retries, partial ingestion, agent run hitting 120 s, cost cap reached |
| `info` | Run start and completion, agent run boundaries, migrations |
| `debug` | Tool invocation names and durations, provider attempt outcomes |

### Metrics

| Metric | Type | Why |
|---|---|---|
| `ingestion_run_duration_seconds` | histogram, by status | |
| `ingestion_records_stored_total` | counter, by object type | |
| `ingestion_errors_total` | counter, by object type and category | Rising rate limits mean the backoff needs tuning |
| `ledger_set_rejected_total` | counter | **Should be zero.** Non-zero means a posting rule bug |
| `reconciliation_run_duration_seconds` | histogram | Against the 60 s bound |
| `exceptions_open` | gauge, by category | |
| `settlement_residual_nonzero_total` | counter | The business signal — how much is genuinely unexplained |
| `tool_invocation_duration_seconds` | histogram, by tool | Against the 10 s timeout |
| `tool_failures_total` | counter, by tool and cause | |
| `tool_schema_violations_total` | counter, by tool | Non-zero means an agent is constructing bad calls |
| `evidence_incomplete_total` | counter | Rising means source data is going missing |
| `model_request_duration_seconds` | histogram, by provider and task class | |
| `model_cost_paise_total` | counter, by provider | |
| `model_provider_failures_total` | counter, by provider and category | Drives chain reordering decisions |
| `response_withheld_total` | counter, by kind | **The most important AI metric here** |
| `policy_decisions_total` | counter, by decision | |
| `proposals_expired_total` | counter | Rising means the approval window is too short for the team |
| `verification_failures_total` | counter | Should be near zero |
| `cross_tenant_rejections_total` | counter | **Any non-zero value warrants investigation** |
| `control_tower_metric_duration_seconds` | histogram, by metric | Against the 3 s bound |
| `agent_runs_incomplete_total` | counter, by agent | |

Two metrics deserve alerting rather than dashboards: `ledger_set_rejected_total` and `cross_tenant_rejections_total`. Both should be flat at zero in normal operation, so any movement is signal.

`response_withheld_total` is the honest measure of whether the grounding rule is doing work. A permanent zero could mean the models behave — or that the validator is not actually running.

### Traces

Span the full request. The reconciliation ask is the trace worth getting right:

```
POST /agents/reconciliation/ask
├── auth.resolve_session
├── authz.require(run_agents)
├── agent.reconciliation.run
│   ├── stage.DETECT
│   │   ├── tool.get_settlement_reconciliation
│   │   │   ├── db.query.settlements
│   │   │   ├── calc.expected_amount
│   │   │   └── evidence.persist_chain
│   │   └── exception.upsert (×7)
│   ├── stage.INVESTIGATE
│   │   └── tool.get_settlement_difference_breakdown
│   └── stage.EXPLAIN
│       ├── ai.gateway.route
│       │   └── provider.openrouter.complete
│       └── validator.validate
└── response.stream
```

Span attributes carry `tenant_id`, tool name, provider name, row counts and durations. **Span attributes never carry monetary values** — those belong in the audit log and the evidence chain, not in telemetry that may ship to a third-party backend.

## Health

`GET /health` returns a version string and touches no tenant table. It is the only unauthenticated non-auth endpoint.

Readiness additionally checks database connectivity and that migrations are at the expected version.

## Dashboards

| Dashboard | Panels |
|---|---|
| Reconciliation health | Run duration vs 60 s bound, open exceptions by category, non-zero residual total, ledger rejections |
| AI spend and grounding | Cost by provider, requests by task class, provider failure rate, **withheld responses** |
| Action pipeline | Decisions by outcome, approval latency, expiries, verification failures |
| Tenant isolation | Cross-tenant rejections, unscoped rejections, permission denials |
| Ingestion | Run status over time, records by type, errors by category, retry depth |

## Related docs

- Audit table DDL and the append function → `design.md` → Data Models → Audit log
- Chain algorithm → `design.md` → Key Algorithms
- What is audited per failure → [10_ERROR_HANDLING.md](10_ERROR_HANDLING.md)
- Credential exclusion channels → [09_SECURITY.md](09_SECURITY.md)
