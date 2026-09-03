# 03 — Requirements

> **Pointer document.** The authoritative functional requirements live in the spec. This file exists so the numbered doc set is complete; it deliberately does not restate the requirements, because two copies would disagree the first time either changed.

## Where the requirements are

**`.kiro/specs/financeos-control-tower/requirements.md`**

15 requirements in EARS format (WHEN / IF / WHILE / WHERE / THE … SHALL), approximately 180 acceptance criteria, a glossary of Indian finance terms, Razorpay object terms, FinanceOS system terms and component names, and a binding non-goals section.

## Requirement index

| # | Requirement | User story focus | Slice |
|---|---|---|---|
| 1 | Razorpay Data Ingestion | Source records rather than estimates | 1 |
| 2 | Semantic Ledger | Accounting state vs payment state | 1 |
| 3 | Control Tower Dashboard | Cash reality and open exceptions in one place | 1 |
| 4 | Reconciliation Agent | Find and explain every rupee of difference | 1 |
| 5 | Action Pipeline and Policy Engine | AI acts without the owner losing control | 3 |
| 6 | India Compliance Detection and Review | Flag tax issues before the accountant sees them | 4 |
| 7 | Marketplace and Razorpay Route Intelligence | Explain any seller payout shortfall | 2 |
| 8 | Cash Forecasting and Affordability | Act before a shortfall happens | 4 |
| 9 | Revenue Recovery for Failed Payments | Retry through the channel most likely to succeed | 4 |
| 10 | Finance Analyst Explanations | Understand movements without reading reports | 4 |
| 11 | Multi-Model AI Gateway | Capability not tied to one vendor's availability | 4 |
| 12 | Financial Tool Layer and Tool Grounding | Every number traceable to a source record | 1 |
| 13 | Audit Log Immutability | Prove what happened and why | 3 |
| 14 | Multi-Tenancy and Security | No tenant reads another tenant's data | 3 |
| 15 | Accuracy and Performance Bounds | Arithmetically exact, workably fast | 1 |

## How to cite a requirement

Format is `Requirement N.M` — requirement number, then acceptance criterion number. For example `Requirement 4.3` is the settlement difference decomposition criterion.

Every task in `tasks.md` cites the requirements it implements as `_Requirements: N.M, N.M_`. Every component in `design.md` states which requirements it satisfies. [14_ACCEPTANCE_CRITERIA.md](14_ACCEPTANCE_CRITERIA.md) gives the objective done-test per requirement.

## Non-goals are binding

`requirements.md` opens with a non-goals section stating that no requirement in the document may be interpreted as requiring: an ERP, a tax filing authority, a Razorpay replacement, statutory books of account, or autonomous money movement. That section is normative, not commentary. See [15_OUT_OF_SCOPE.md](15_OUT_OF_SCOPE.md).

## Changing a requirement

Requirements changes propagate. Amending one means checking:

1. `requirements.md` — the criterion itself, and the glossary if a term changed
2. `design.md` — any component, algorithm, DDL or correctness property that cites it
3. `tasks.md` — any task citing it, and the property gates
4. This doc set — [14_ACCEPTANCE_CRITERIA.md](14_ACCEPTANCE_CRITERIA.md) at minimum

The provider-chain change from OpenAI to OpenRouter is the worked example: it touched the glossary, three acceptance criteria in Requirement 11, a Mermaid node, a routing table, a TypeScript constant, a `CHECK` constraint, a credential kind list, and two task descriptions.
