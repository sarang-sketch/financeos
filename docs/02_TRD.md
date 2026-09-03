# 02 — Technical Requirements Document

## Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript, `strict: true`, target ES2020+ | ES2020 minimum so `bigint` literals compile |
| Runtime | Node.js LTS (server), modern browser (client) | |
| Database | Supabase Postgres | Also the RLS enforcement boundary |
| Auth | Supabase Auth | Session JWT carries the `tenant_id` claim |
| Realtime | Supabase Realtime | Pushes `exceptions` and `ingestion_runs` changes to the control tower |
| Storage | Supabase Storage | One use case only — evidence bundle exports. See below. |
| Payment data source | Razorpay Test-mode APIs | Live mode is a separately gated change |
| Model providers | OpenRouter, Gemini, Groq | Behind the AI gateway; task-class routed |
| Validation | Zod | Every financial tool declares `.strict()` input and output schemas |
| Test runner | Vitest | |
| Property testing | fast-check | 14 correctness properties, P1–P14 |

## The money type constraint

This is the single most important technical constraint in the system.

**Application layer.** `type Paise = bigint`. Every monetary value, operand, intermediate and result is a `bigint`. No `number` ever holds money. A lint rule fails on `number`-typed identifiers matching `/paise|amount|impact|balance|cash|fee|gst|shortfall|headroom/i` inside `src/calc/`, `src/ledger/`, `src/tools/`, `src/agents/`.

**Database layer.** Three domains over `BIGINT` with range checks:

```sql
CREATE DOMAIN paise           AS BIGINT CHECK (VALUE BETWEEN -99999999999999 AND 99999999999999);
CREATE DOMAIN paise_ingested  AS BIGINT CHECK (VALUE BETWEEN 0 AND 999999999999);
CREATE DOMAIN paise_positive  AS BIGINT CHECK (VALUE > 0 AND VALUE <= 99999999999999);
```

No `NUMERIC`, `DECIMAL`, `REAL`, `DOUBLE PRECISION`, `FLOAT` or `MONEY` column holds a monetary value anywhere in the schema. The only non-integer numerics are non-monetary: `tds_rate_percent`, `unusual_multiple`, `runway_months`. Rates convert to `bigint` basis points before any monetary multiplication.

**Why this is a hard constraint rather than a preference.** Several correctness properties assert exact equality in integer paise — the settlement decomposition (`difference = fee + gst + residual`), the Route conservation law (net transfers + commission + fee + GST = payment amount, difference exactly 0 paise), and evidence chain replay. A single float in the path makes those properties untestable, and two of them are enforced as database CHECK constraints, so a float would make rows unwritable rather than merely imprecise.

Typecheck is the first CI gate specifically because this is the cheapest place to catch the most expensive class of bug here.

## Infrastructure

### Database as the enforcement boundary

Three things live in Postgres rather than application code, deliberately:

**Tenant isolation.** Every tenant-scoped table has `tenant_id UUID NOT NULL`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and four policies bound to `app.current_tenant_id()`, which reads the JWT claim. `FORCE` means even a table-owner connection is filtered — there is no privileged read path. When no session claim exists the function returns `NULL`, and `tenant_id = NULL` is never true, so an unscoped query returns zero rows rather than all rows. The failure mode is closed.

Application-level `WHERE tenant_id = $1` filters stay in every query as defence in depth. They are never the control. Property P7 asserts isolation with the application filter deliberately removed.

**Append-only tables.** `ledger_entries` and `audit_events` have `UPDATE`, `DELETE` and `TRUNCATE` revoked from every application role. A rejecting trigger is the second barrier and audits the attempt before raising. Correction of a ledger entry is only ever a reversal set.

**Ledger balance.** An immediate CHECK on the declared totals plus a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that fires at commit and proves the persisted rows sum to those declared totals. An imbalanced set therefore aborts the transaction and persists zero entries.

### Connection roles

Three client factories:

| Client | Role | Used by |
|---|---|---|
| Tenant-scoped | `authenticated`, session JWT | All normal request paths |
| Read-only | No write grants | `read_only` financial tools — the mode declaration is backed by privilege |
| Service | Server-only, still tenant-scoped explicitly | Ingestion, scheduled sweeps |

A privileged path issuing a read or write with no explicit tenant scope is rejected and audited.

### Supabase Storage

One use case: **evidence bundle exports.** A user with `view_financial_data` can export a reconciliation report for an exception — the settlement figures, the decomposition, the ordered evidence chain steps and the source record identifiers — as a downloadable file. Bucket is private, per-tenant path prefix, signed URLs with a short expiry, RLS-equivalent path policy.

No other feature uses Storage. Ingested Razorpay payloads live in `razorpay_objects.payload` as `JSONB`, not as files.

### Audit sequence allocation

A Postgres sequence leaves gaps on rollback, which would break the gapless requirement. Allocation instead uses a per-tenant counter row locked with `SELECT ... FOR UPDATE` inside `app.append_audit_event`, so sequence numbers are gapless and strictly increasing, and the SHA-256 chain value over the canonical field join plus the previous chain value is computed in the same serialized transaction.

## Performance budgets

All bounds hold while no more than **5 concurrent agent runs per tenant** are executing. That concurrency cap is the stated precondition, not an incidental detail.

| Operation | Bound | Requirement |
|---|---|---|
| Control tower — all 4 metrics rendered | 3 s | 15.5 |
| Agent first displayable content | 15 s | 15.4 |
| Agent complete answer | 120 s | 15.4 |
| Reconciliation run, up to 5000 payments | 60 s | 15.3 |
| Policy engine evaluation | 10 s | 5.3 |
| Financial tool invocation | 10 s, then `tool_failure` | 12.11 |
| Verification after execution | 60 s | 5.11 |
| Audit event append after stage completion | 5 s | 5.2 |
| Metric computation before failure state | 30 s | 3.9 |
| Razorpay API request | 30 s | 1.1 |
| Model request | 1000–60000 ms, default 30000 | 11.5 |

**Past the bounds.** An agent run reaching 120 s stops, returns partial results, flags itself incomplete, and names the source record types not fully processed. A dataset above 5000 payments still processes every payment, reports the count, and states that the 60-second bound does not apply.

Performance is CI stage 9 and is advisory rather than merge-gating, because it depends on machine speed. A failure opens an issue; two consecutive failures escalate to blocking.

## Retry and failover policy

### Razorpay ingestion

Pages of 100 per object type, stopping when a page returns fewer than 100. Rate-limit responses and timeouts retry the same request at 1 s, 2 s, 4 s, 8 s, 16 s for a maximum of 5 retries, then record an error for that object type. Non-credential errors are recorded and ingestion continues with remaining types. A credential rejection aborts the run, stores zero objects, and leaves prior objects byte-identical.

Window selection: 365 days back on the first run, otherwise since the start timestamp of the most recent completed run.

### Model providers

| Task class | 1st | 2nd | 3rd |
|---|---|---|---|
| complex reasoning | OpenRouter | Gemini | Groq |
| document analysis | Gemini | OpenRouter | Groq |
| fast classification | Groq | Gemini | OpenRouter |

Rate limit or timeout retries the **same** provider at 1000 ms then 2000 ms for a maximum of 2 retries, then fails over. Any other error fails over immediately with no retry. Maximum 3 providers per request.

OpenRouter holds the complex-reasoning head position because it proxies frontier reasoning models behind a single key, keeping the chain three wide without a fourth vendor relationship. Because it is itself a gateway, the adapter records the resolved underlying model name so cost attribution stays accurate.

## Constraints and bounds

### Payload and page bounds

| Thing | Bound |
|---|---|
| Razorpay page size | 100 records per object type |
| Evidence chain source identifiers per page | 500 (tool), 100 (UI) |
| Exception drill-down page | 50 |
| Audit history page | 100 |
| Settlement breakdown rows | 50 + aggregate remainder row |
| Seller payout chain rows | 200 + total count + truncation flag |
| Unusual transactions returned | 20 + total count |
| Recommended cash actions | 5 |
| Top contributors per change | 3 |
| Ledger entries per set | 2–20 |
| Model tool values per request | 200 |
| Model input characters | 100,000 |
| Model output characters | 8,000 |
| Audit event payload | 65,536 bytes, then reduced with an indicator |

Model payload bounds **reject rather than truncate**, because a silently dropped tool value would remove a legitimate figure from the validator's allowed set and cause a false withholding downstream.

### Date range bounds

Compliance and marketplace runs accept at most 366 days. Analyst periods are 1–366 days, defaulting to the trailing 30. Reconciliation defaults to the trailing 90 days. AI usage queries accept 1–366 days.

### Tenant-configurable values

| Setting | Range | Default |
|---|---|---|
| Auto-execute threshold | 0–100 | **0** |
| Approval window | 1–168 hours | 24 |
| Forecast horizon | 30–180 days | 90 |
| Safety buffer | ₹0 – ₹10 Cr | 10% of obligation |
| Lookback window | 30–730 days | 180 |
| Minimum sample size | 10–1000 | 50 |
| Maximum retry age | 1–30 days | 7 |
| Unusual multiple | 1.5–20.0 | 5.0 |
| Compliance review threshold | ₹0 – ₹10,00,00,000 | ₹50,000 |
| TDS rate per category | 0.00–30.00% | 10.00% |
| Model timeout | 1000–60000 ms | 30000 |
| Model monthly cost cap | ₹1 – ₹10,00,000 | ₹10,000 |
| Audit retention | ≥ 2555 days | 2555 |

Every column is nullable; defaults are applied at read time, so an unconfigured tenant behaves as specified without a migration writing defaults into rows.

The auto-execute threshold defaulting to 0 matters: every action type scores at least 5 on the risk scale, so **nothing auto-executes until a tenant deliberately raises it**.

### Hard architectural constraints

1. **Agents have no database access.** They read only through the financial tool layer. An agent cannot construct a query; it can only invoke a named tool with typed arguments. There is no argument that expresses a query, so a compromised model cannot exfiltrate through a crafted argument.
2. **The AI gateway has no database access and no tool access.** It receives an already-bounded value set from the calling agent and returns text.
3. **Models never compute money.** Enforced mechanically by the response validator at zero tolerance, not by prompt instruction.
4. **Matching uses stored Razorpay identifier links only.** No amount-based or date-based inference. This is what makes reconciliation runs deterministic.
5. **Write-capable tools require an authorized proposal.** `proposal_id` and `authorization_id` must both resolve, or the invocation is rejected with tenant state unchanged.

## Environment and secrets

Loaded through a Zod schema that fails fast on a missing or malformed value:

- Supabase URL, anon key, service role key
- Razorpay test-mode key id and key secret
- OpenRouter, Gemini and Groq API keys

Credential kinds stored per tenant, encrypted at rest as `BYTEA`: `razorpay_test`, `openrouter`, `gemini`, `groq`. Never returned to a client; reads yield a masked reference only. Excluded from API responses, log output, error messages and model prompts — the log redaction filter and the gateway's `stripCredentials` both match on **value** rather than key name, so a credential that leaked into an unexpected field is still removed.

`razorpay_live` is deliberately absent from the MVP credential set.

## Testing infrastructure

Supabase local (`supabase start`) with migrations applied is required, not optional: RLS, the append-only privileges and the deferred balance trigger cannot be tested against a mock. Property tests P1, P2, P7, P13, P14 run against it. P3, P4, P6, P11, P12 run in-process against pure functions.

Database-backed properties reset with a per-iteration transaction rollback. P7 is the exception — it needs committed multi-tenant data to exercise RLS, so it truncates and reseeds with reduced iterations.

## CI stages

| Stage | Suite | Gates merge |
|---|---|---|
| 1 | Typecheck + lint | yes |
| 2 | Unit | yes |
| 3 | Database (Supabase local) | yes |
| 4 | Tool contract | yes |
| 5 | Properties P1–P14 (seeded) | yes |
| 6 | Validator adversarial | yes |
| 7 | E2E demo path | yes |
| 8 | Razorpay integration | advisory |
| 9 | Performance bounds | advisory |

## Authoritative source

Full DDL, component interfaces, algorithms and the correctness property specifications are in `.kiro/specs/financeos-control-tower/design.md`. Where this document and the design disagree, the design wins.
