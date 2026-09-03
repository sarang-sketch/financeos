# accmount / FinanceOS — Documentation Index

FinanceOS is an AI Financial Control Tower for Indian businesses: an intelligence and control layer over Razorpay payment data, Indian financial rules, and an internal double-entry Semantic Ledger.

> Razorpay moves the money. Supabase stores the financial state. The Semantic Ledger understands the accounting state. AI explains what is happening. Agents investigate problems. The Policy Engine controls what AI is allowed to do. The Audit Log proves what happened.

## How this documentation set is organised

There are two tiers, and it matters which one you are reading.

**The spec is authoritative.** `.kiro/specs/financeos-control-tower/` holds three documents that are the single source of truth for what gets built:

| Spec file | Holds |
|---|---|
| `requirements.md` | 15 requirements in EARS format, ~180 acceptance criteria, full glossary, non-goals |
| `design.md` | Architecture, component interfaces, Supabase DDL, key algorithms, 14 correctness properties, error handling, testing strategy, MVP build order |
| `tasks.md` | 37 implementation tasks across 4 slices with property gates between them |

**These docs are the reading layer.** Nine of the files below are full documents covering ground the spec does not. The other nine are deliberately thin pointers into the spec, because duplicating spec content would create two sources of truth that disagree the first time either changes.

## Index

| File | Type | Purpose |
|---|---|---|
| [00_PROJECT_SCOPE.md](00_PROJECT_SCOPE.md) | full | What we are building and what we are explicitly not |
| [01_PRD.md](01_PRD.md) | full | Product vision, users, problems, workflows, features |
| [02_TRD.md](02_TRD.md) | full | Technical stack, infrastructure, performance budgets, constraints |
| [03_REQUIREMENTS.md](03_REQUIREMENTS.md) | pointer | → `requirements.md` |
| [04_ARCHITECTURE.md](04_ARCHITECTURE.md) | pointer | → `design.md` Architecture + Components and Interfaces |
| [05_DATA_MODEL.md](05_DATA_MODEL.md) | pointer | → `design.md` Data Models |
| [06_API_CONTRACTS.md](06_API_CONTRACTS.md) | pointer | → `design.md` FinanceOS_API + Financial Tool Catalogue |
| [07_AI_AGENT_SPEC.md](07_AI_AGENT_SPEC.md) | full | Agent behaviour, tools, reasoning boundaries, guardrails |
| [08_UI_UX_SPEC.md](08_UI_UX_SPEC.md) | full | Control Tower screens, states, interactions |
| [09_SECURITY.md](09_SECURITY.md) | pointer | → `design.md` Security Considerations |
| [10_ERROR_HANDLING.md](10_ERROR_HANDLING.md) | pointer | → `design.md` Error Handling |
| [11_EDGE_CASES.md](11_EDGE_CASES.md) | full | Ambiguous, missing, contradictory and unusual situations |
| [12_OBSERVABILITY.md](12_OBSERVABILITY.md) | full | Logs, metrics, traces, audit trail, monitoring |
| [13_TESTING_STRATEGY.md](13_TESTING_STRATEGY.md) | pointer | → `design.md` Testing Strategy + Correctness Properties |
| [14_ACCEPTANCE_CRITERIA.md](14_ACCEPTANCE_CRITERIA.md) | full | Objective definition of done per requirement |
| [15_OUT_OF_SCOPE.md](15_OUT_OF_SCOPE.md) | pointer | → `requirements.md` Non-Goals |
| [16_DEPLOYMENT.md](16_DEPLOYMENT.md) | full | Local, staging, production configuration |
| [17_ROADMAP.md](17_ROADMAP.md) | pointer | → `design.md` MVP Build Order |

## Reading order

New to the project: 00 → 01 → 02 → 04 → 07.

Implementing: `tasks.md` is the work queue. Read `design.md` for the section your task touches. 14_ACCEPTANCE_CRITERIA tells you when a task is done.

Reviewing: 14 → 11 → 09.

## Non-negotiables

Four rules hold everywhere in this system. Every document below assumes them.

1. **Money is integer paise, always.** `type Paise = bigint` in TypeScript, `BIGINT` domains with range checks in Postgres. No float, no `NUMERIC`, no JavaScript `number` on a monetary path.
2. **Models never compute money.** Every figure a user sees came from a Financial Tool over stored records and carries an Evidence Chain. The Response Validator withholds any response containing a monetary figure that is not an exact paise match against the tool output supplied to the model.
3. **Tenant isolation lives in the database.** Row-level security bound to the session tenant claim is the boundary. Application filters are defence in depth, never the control.
4. **Nothing acts without a recorded authorization.** Every proposal that reaches execution has an authorization record in the append-only audit log.
