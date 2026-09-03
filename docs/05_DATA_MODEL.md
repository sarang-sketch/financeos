# 05 — Data Model

> **Pointer document.** The authoritative schema is written as executable DDL in the spec. This file gives the table inventory and the three invariants the schema enforces, then points at the detail.

## Where the schema is

**`.kiro/specs/financeos-control-tower/design.md` → `## Data Models`**

Full `CREATE DOMAIN`, `CREATE TYPE`, `CREATE TABLE`, `CREATE FUNCTION`, `CREATE TRIGGER`, `CREATE POLICY` and `CREATE INDEX` statements, plus a Mermaid `erDiagram` of the core entities. The migration tasks in `tasks.md` (4.1 through 4.7, plus 21.1, 27.1, 30.4, 33.1) implement it as written.

## Table inventory

| Group | Tables |
|---|---|
| Tenancy | `tenants`, `users`, `tenant_memberships`, `user_permissions` |
| Ingestion | `ingestion_runs`, `ingestion_errors`, `razorpay_objects` |
| Ledger | `chart_of_accounts`, `ledger_entry_sets`, `ledger_entries`, `ledger_entry_sources` |
| Reconciliation | `settlement_reconciliations` |
| Exceptions | `exceptions`, `exception_source_records` |
| Evidence | `evidence_chains`, `evidence_chain_steps`, `evidence_chain_sources` |
| Actions | `proposals`, `authorizations` |
| Audit | `audit_events`, `audit_sequence_counters` |
| Compliance | `tds_review_items` |
| Cash | `cash_forecasts`, `cash_forecast_days`, `cash_forecast_components` |
| AI usage | `model_requests` |
| Config | `tenant_configuration` |

## Money representation

Three `BIGINT` domains with range checks, so the constraint is enforced by the database on every insert and update in every table:

| Domain | Range | Used for |
|---|---|---|
| `paise` | −99,999,999,999,999 … 99,999,999,999,999 | Signed monetary values |
| `paise_ingested` | 0 … 999,999,999,999 | Values as retrieved from Razorpay |
| `paise_positive` | 1 … 99,999,999,999,999 | A single ledger entry amount |

**No `NUMERIC`, `DECIMAL`, `REAL`, `DOUBLE PRECISION`, `FLOAT` or `MONEY` column holds money.** The only non-integer numerics in the schema are non-monetary: `tds_rate_percent`, `unusual_multiple`, `runway_months`.

A database test queries `information_schema.columns` and asserts no `_paise` column has a type other than `bigint`.

## Three invariants the schema enforces

These are constraints, not conventions. A violating row cannot exist.

**Ledger balance.** `ledger_set_balanced` CHECKs the declared totals immediately. A `DEFERRABLE INITIALLY DEFERRED` constraint trigger fires at commit and proves the persisted entries sum to those declared totals, so a set cannot be balanced on paper and unbalanced in its rows. An imbalanced set aborts the transaction and persists zero entries.

**Settlement decomposition exactness.** `settlement_reconciliations` carries `CHECK (difference_paise = fee_component_paise + gst_component_paise + residual_paise)` and `CHECK ((status = 'difference_explained') = (residual_paise = 0))`. Correctness property P3 is therefore a database invariant as well as a test assertion.

**Append-only.** `ledger_entries` and `audit_events` have `UPDATE`, `DELETE`, `TRUNCATE` revoked from every application role, with a rejecting trigger as second barrier that audits the attempt before raising.

## Idempotency keys

Four unique constraints carry the system's determinism guarantees:

| Constraint | Guarantees | Property |
|---|---|---|
| `razorpay_objects_tenant_rzp_uniq` | One row per Razorpay object per tenant | P10 |
| `ledger_set_derivation_uniq` | Deriving twice from one source record creates one set | P2 |
| `exceptions_fingerprint_uniq` | A re-run updates rather than duplicates | P5 |
| `audit_events_sequence_uniq` | Gapless tenant-scoped sequence | P9 |

## Row-level security

Every tenant-scoped table gets `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and four policies bound to `app.current_tenant_id()`. `design.md` shows the full policy set on `exceptions` as the representative case and lists every table the pattern repeats on.

Child tables carry a redundant `tenant_id` specifically so their policy is a direct column comparison rather than a join through the parent — a join-based policy would be correct but would put the isolation guarantee behind query planning.

## Audit sequence allocation

A Postgres sequence leaves gaps on rollback, which breaks gaplessness. `app.append_audit_event` instead locks a per-tenant counter row with `SELECT ... FOR UPDATE`, allocates the next number, computes the SHA-256 chain value over the canonical field join plus the previous chain value, inserts, and advances the counter — all in one serialized transaction.

## Indexes

Two hot paths drive the index set:

- **Reconciliation** — settlement lookups by tenant and date, a partial index on mismatched settlements ordered by absolute difference, expression indexes on the JSONB identifier links (payment→settlement, recon report→settlement, refund→payment, transfer→payment and →recipient), and ledger entry source lookups.
- **Attention panel** — a partial index on open exceptions with `INCLUDE (impact_paise)` so the category aggregation is index-only, plus a drill-down index matching the descending-impact then ascending-id ordering.

## Related docs

- Architecture → [04_ARCHITECTURE.md](04_ARCHITECTURE.md)
- State transitions in the action pipeline → [07_AI_AGENT_SPEC.md](07_AI_AGENT_SPEC.md)
- RLS reasoning → [09_SECURITY.md](09_SECURITY.md)
