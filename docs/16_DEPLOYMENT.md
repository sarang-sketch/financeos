# 16 — Deployment

## Environments

| Environment | Database | Razorpay | Model providers | Purpose |
|---|---|---|---|---|
| Local | Supabase local via CLI | Test mode | Real keys, low cost cap | Development, database and property tests |
| CI | Supabase local in the runner | Test mode | Stubbed by default | Stages 1–7; real providers only in stage 8 |
| Staging | Supabase hosted project | Test mode | Real keys, moderate cap | Demo, integration verification |
| Production | Supabase hosted project | **Test mode for the MVP** | Real keys, tenant-configured cap | — |

Razorpay live mode is not reachable in any environment in the MVP. Promotion requires a separate credential kind, a per-tenant flag settable only with `manage_credentials`, an audit event, and a re-review of the auto-execute threshold. See [09_SECURITY.md](09_SECURITY.md).

## Local setup

```bash
npm install
supabase start                    # Postgres, Auth, Realtime, Storage on localhost
supabase db reset                 # applies every migration in order
cp .env.example .env.local        # then fill in the values below
npm run typecheck
npm run test:unit
npm run test:db                   # requires supabase start
```

Seeding the demo data requires real Razorpay test-mode credentials:

```bash
npm run seed:razorpay            # creates the non-zero-residual and SET-9281 settlements
npm run test:e2e
```

`supabase start` is not optional for the database and property suites. RLS, the append-only privileges and the deferred ledger balance trigger cannot be exercised against a mock — they are the thing being tested.

## Environment variables

Loaded through a Zod schema that fails fast on a missing or malformed value. The application does not start with a partial configuration.

```
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Razorpay test mode
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=

# Model providers
OPENROUTER_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=

# Encryption for per-tenant credentials at rest
CREDENTIAL_ENCRYPTION_KEY=

# Operational
LOG_LEVEL=info
NODE_ENV=development
```

Two distinctions worth being clear about:

**Platform keys vs tenant credentials.** The variables above are the platform's own keys, used for the reference tenant and for tests. Per-tenant Razorpay and provider credentials are stored encrypted in `tenant_configuration` as `BYTEA` and are read through `ConfigurationService.readCredentialForServerUse`, a server-only path with no HTTP surface. A tenant's credential never appears in an environment variable.

**`SUPABASE_SERVICE_ROLE_KEY` is not a bypass.** `FORCE ROW LEVEL SECURITY` means even a service-role connection is filtered by the tenant predicate. A privileged path issuing a query with no explicit tenant scope is rejected and audited.

Never commit `.env.local`. `.env.example` carries key names with empty values only.

## Database roles

Three connection roles, and the distinction is load-bearing rather than cosmetic:

| Role | Grants | Used by |
|---|---|---|
| `authenticated` | Select, insert; update/delete except on the append-only tables | Normal request paths |
| Read-only role | **Select only, no write grants anywhere** | `read_only` financial tools |
| Service role | Server-only, still tenant-scoped explicitly | Ingestion, scheduled sweeps |

The read-only role exists so a tool's `mode: 'read_only'` declaration is backed by privilege rather than convention. A read-only tool that attempted a write would fail at the database, not pass a code review.

## Migrations

Ordered SQL files in `supabase/migrations/`, applied in filename order. The migration set follows the DDL in `design.md` → Data Models. Groups, matching the task numbering:

| Group | Tasks | Contents |
|---|---|---|
| Money domains, session functions, tenancy, config | 4.1 | `paise` domains, `app.current_tenant_id()`, tenants, users, memberships, permissions, `tenant_configuration` |
| Ingestion | 4.2 | Enums, `ingestion_runs`, `ingestion_errors`, `razorpay_objects` + indexes |
| Ledger | 4.3 | Chart of accounts, entry sets, entries, sources, **the deferred balance trigger** |
| Audit storage | 4.4 | `audit_events`, `audit_sequence_counters`, `app.append_audit_event`, **REVOKE + append-only triggers** |
| Exceptions | 4.5 | Category enum (14 values), `exceptions`, source records, panel indexes |
| Evidence chains | 4.6 | Chains, steps, sources |
| Settlement reconciliation | 4.7 | `settlement_reconciliations` with the three decomposition CHECKs |
| Proposals | 21.1 | Proposals, authorizations |
| RLS policies | 27.1 | `ENABLE` + `FORCE` + four policies on every tenant-scoped table |
| Model usage | 30.4 | `model_requests` + month index |
| Cash forecasts | 33.1 | Forecasts, days, components |
| TDS review | 32.6 | `tds_review_items` |

Note that audit storage lands in slice 1 rather than slice 3, because the ledger's append-only trigger writes an audit event when it rejects a mutation. The AuditService history API and chain verification come later, in slice 3.

RLS policies land in slice 3. `tenant_id NOT NULL` is present on every table from slice 1, so adding the policies is additive rather than a data migration. **No tenant data reaches a shared environment before the policies are in place** — this is a scheduling decision about when the policies are written, not a period during which isolation is absent.

### Migration rules

- Forward-only. Fixing a bad migration means a new migration, not editing a shipped one.
- Never `DROP` a column holding financial history. Add a new one and stop writing the old.
- Never relax a monetary domain range or a decomposition CHECK. Those constraints are the reason correctness properties hold at the database layer.
- Never grant `UPDATE` or `DELETE` on `ledger_entries` or `audit_events`.
- A migration touching a monetary column requires the schema type audit test to pass.

## Deploy pipeline

```
push → CI stages 1-7 (all gate) → build → apply migrations → deploy → smoke → done
                                                    │
                                        stages 8-9 advisory, in parallel
```

Order matters: **migrations apply before the new code deploys.** Every migration must be backward-compatible with the currently running version, because there is a window where the old code runs against the new schema. Additive changes only.

### Smoke checks after deploy

1. `GET /health` returns the expected version
2. Readiness confirms database connectivity and the migration version
3. `GET /control-tower/metrics` on the reference tenant returns four cells
4. `GET /audit/verify` on the reference tenant reports `intact: true`
5. A cross-tenant probe returns zero rows

Check 4 is the one worth watching. If the audit chain does not verify after a deploy, something touched history, and that is a stop-everything condition rather than a bug to triage.

## Rollback

| Situation | Action |
|---|---|
| Code fault, schema unchanged | Redeploy the previous build |
| Code fault after an additive migration | Redeploy previous build; the migration is compatible, leave it |
| Bad migration | **Forward fix.** A new corrective migration, never a down-migration on financial tables |
| Audit chain fails to verify | Stop deploys. Investigate. The chain reports the lowest mismatched and lowest absent sequence number — do not attempt repair |

There is no down-migration path for `ledger_entries` or `audit_events`, by design. They are append-only, so "undoing" them is not a supported operation.

## Configuration at deploy time

Nothing about tenant behaviour is deployed. Every tunable is a nullable column in `tenant_configuration` with a documented default applied at read time, changeable through `PUT /configuration` with the `configure_policy` permission.

That includes the auto-execute threshold. **It defaults to 0 and no deployment changes it**, so a fresh tenant auto-executes nothing until someone deliberately raises it.

## Storage

One private bucket for evidence bundle exports, per-tenant path prefix, signed URLs with a short expiry, and a path policy equivalent to the RLS predicate. No other feature uses Storage; ingested Razorpay payloads live in `razorpay_objects.payload` as `JSONB`.

## Cost controls in production

| Control | Default | Configurable |
|---|---|---|
| Model monthly cost cap per tenant | ₹10,000 | yes, ₹1 – ₹10,00,000 |
| Concurrent agent runs per tenant | 5 | no |
| Agent run wall clock | 120 s | no |
| Model tool values per request | 200 | no |
| Model input / output characters | 100,000 / 8,000 | no |

The cap is checked before the first provider attempt, so an exhausted cap costs nothing. Tool-grounded figures stay available when it trips; only narrative generation stops.

## Monitoring after deploy

Two metrics should be flat at zero. Any movement is signal, not noise:

- `ledger_set_rejected_total` — non-zero means a posting rule bug
- `cross_tenant_rejections_total` — non-zero warrants investigation

See [12_OBSERVABILITY.md](12_OBSERVABILITY.md).

## Related docs

- Stack and infrastructure constraints → [02_TRD.md](02_TRD.md)
- Schema and migration content → [05_DATA_MODEL.md](05_DATA_MODEL.md)
- Security controls → [09_SECURITY.md](09_SECURITY.md)
- CI stages → [13_TESTING_STRATEGY.md](13_TESTING_STRATEGY.md)
