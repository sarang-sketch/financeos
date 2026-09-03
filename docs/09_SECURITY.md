# 09 — Security

> **Pointer document.** The authoritative security design lives in the spec. This file summarises the controls and the reasoning behind the two least obvious ones.

## Where the security design is

**`.kiro/specs/financeos-control-tower/design.md` → `## Security Considerations`**

Covers RLS as the enforcement boundary, session tenant binding, the permission model mapped to API operations, credential handling across four exclusion channels, typed-argument-only tools, the network surface, and Razorpay mode.

Related: `## Data Models` → `### Row-level security` for the policy DDL, and `## Error Handling` → the tenancy and permission table for rejection behaviour.

## Control summary

| Control | Mechanism | Requirement |
|---|---|---|
| Tenant isolation | RLS bound to the session JWT claim, `FORCE ROW LEVEL SECURITY` | 14.1, 14.2, 14.7 |
| Session tenant binding | One tenant per session, immutable for its lifetime | 14.8 |
| Authorization | Six enumerated permissions checked before any read or write | 14.6, 14.9 |
| Credential protection | Encrypted at rest, masked reads, four exclusion channels | 14.5 |
| Injection prevention | Zod `.strict()` typed arguments, no query-text argument | 12.9 |
| Unauthorized writes | `proposal_id` + `authorization_id` required | 12.10 |
| Audit integrity | Append-only privileges, SHA-256 hash chain, gapless sequence | 13.1, 13.4, 13.5 |
| Authentication | Supabase Auth; no unauthenticated route touches tenant data | 14.4 |
| Budget protection | `run_agents` on every agent-triggering route, monthly cost cap | 11.13 |

## Two controls worth explaining

### A cross-tenant request returns zero rows, not a permission error

This looks like worse UX and is actually the correct choice. A "403 Forbidden" response confirms the record exists, which leaks information across a tenant boundary — an attacker enumerating identifiers learns which ones are real. Zero rows leaks nothing.

The mechanism makes this the natural behaviour rather than something the application has to remember: RLS policies evaluate `tenant_id = app.current_tenant_id()`, and when that function returns `NULL` — no session claim — the predicate is never true. An unauthenticated or unscoped query returns zero rows rather than all rows. **The failure mode is closed, not open.**

`FORCE ROW LEVEL SECURITY` extends this to table-owner connections, so there is no privileged read path that bypasses the tenant predicate.

Property P7 asserts the invariant with the application-level tenant filter **deliberately removed**, over generated multi-tenant datasets with colliding non-key values. A test that passed only because the application filter was present would not satisfy P7.

### Agents cannot construct queries, so a compromised model cannot exfiltrate

Every financial tool declares a Zod schema with `.strict()`. No tool accepts a query string, a filter expression, or SQL text in any argument. A schema violation is rejected **before any tenant data is read** — no connection opened, no query planned — and the rejection is audited.

This is why agents hold no database client. The threat model is not "the model tries to be malicious"; it is "the model is influenced by content in the data it reads, or by a crafted user message, and emits a tool call intended to over-fetch." There is no argument that expresses over-fetching, so the attack has no surface.

## Permission model

| Permission | Grants |
|---|---|
| `view_financial_data` | Metrics, exceptions, evidence chains, trial balance, audit history and verification, AI usage |
| `run_agents` | Starting an ingestion run, starting an agent run, asking an agent a question |
| `approve_sensitive_actions` | Approving or rejecting a proposal |
| `configure_policy` | Auto-execute threshold, approval window, safety buffer, compliance thresholds, TDS rates, every tenant setting |
| `manage_credentials` | Storing or replacing Razorpay and model provider credentials; starting an ingestion run |
| `manage_users` | Tenant membership and permission grants |

`run_agents` gates budget as well as data: an agent run consumes model spend against the tenant's monthly cap, so an under-privileged trigger would be a denial-of-budget vector.

Denial names the required permission, changes no state, and appends an audit event.

## Credential handling

Stored encrypted at rest as `BYTEA` in `tenant_configuration`. Kinds: `razorpay_test`, `openrouter`, `gemini`, `groq`. `razorpay_live` is deliberately absent from the MVP set.

Four exclusion channels:

1. **API responses** — `putCredential` returns a masked reference. No route returns a credential value.
2. **Logs** — the redaction filter matches on **value**, not key name, so a credential that leaked into an unexpected field is still redacted.
3. **Errors** — Razorpay client errors are re-wrapped; the wrapper carries status code and object type, not request headers.
4. **Model prompts** — `stripCredentials` walks the assembled gateway payload matching on value, and applies the same stripping to the recorded request and response rows.

Value-matching rather than key-matching in channels 2 and 4 is the deliberate part. Key-based redaction only catches credentials in fields you predicted.

## Network surface

Every route resolves a Supabase Auth session, binds the tenant, and checks the required permission before delegating. A missing, expired or invalid session credential returns an authentication-required error carrying **no tenant financial data and no tenant identifier**.

The only session-free endpoints are the Supabase Auth callbacks and a static health check returning a version string, touching no tenant table.

## Razorpay mode

**Test mode for the MVP.** Every integration test, the demo path and every ingestion run use Razorpay test mode. `initiate_payment_retry`, the one tool calling a Razorpay write API, calls test mode.

Promoting a tenant to live mode is an explicit, separately gated change, not a config toggle. It requires a distinct `razorpay_live` credential kind stored separately, a per-tenant live-mode flag settable only by a `manage_credentials` holder, an audit event recording the promotion, and a re-review of the auto-execute threshold — because a threshold acceptable when no real money moves is not necessarily acceptable when it does.

Nothing in the design treats live mode as reachable by accident.

## Security testing

| Suite | Asserts | CI stage |
|---|---|---|
| RLS database tests | Per table: only own rows on select, 0 rows affected on cross-tenant update/delete, `WITH CHECK` rejects foreign insert, zero rows with no claim | 3 |
| Append-only tests | Update and delete rejected, target unchanged field by field, attempt audited | 3 |
| Property P7 | Zero foreign rows on every read path, application filter removed | 5 |
| Property P8 | Every executed proposal has an authorization | 5 |
| Property P9 | Audit chain verifies, sequence gapless | 5 |
| Tool contract tests | Schema violation before any read; write-capable rejected without authorization | 4 |
| Credential exclusion tests | Plaintext absent from responses, logs, errors and prompts | 2, 8 |

## Related docs

- Permission-to-route mapping → [06_API_CONTRACTS.md](06_API_CONTRACTS.md)
- Rejection behaviour and state guarantees → [10_ERROR_HANDLING.md](10_ERROR_HANDLING.md)
- Audit trail detail → [12_OBSERVABILITY.md](12_OBSERVABILITY.md)
- Agent guardrails → [07_AI_AGENT_SPEC.md](07_AI_AGENT_SPEC.md)
