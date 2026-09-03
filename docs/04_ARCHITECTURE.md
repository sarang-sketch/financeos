# 04 — Architecture

> **Pointer document.** The authoritative architecture lives in the spec, including four Mermaid diagrams and a component-by-component interface breakdown. This file gives the shape and points at the detail.

## Where the architecture is

**`.kiro/specs/financeos-control-tower/design.md`**

| Section | Contains |
|---|---|
| Overview | The five structural decisions that shape everything |
| Architecture → Layered view | Full system Mermaid diagram |
| Architecture → Razorpay ingestion path | Ingestion flow diagram |
| Architecture → Action_Pipeline sequence | Seven-stage sequence diagram with stage ownership |
| Architecture → Reconciliation centerpiece sequence | The demo path, end to end |
| Components and Interfaces | TypeScript interfaces for all 15 components plus the 6 agents |

## The shape in one table

| Plane | Components | Reaches |
|---|---|---|
| Client | FinanceOS_UI / Control_Tower | The API only |
| Server | FinanceOS_API, Agent Engine, 6 Agents, Financial_Tool_Layer, Calculation_Service, Semantic_Ledger | |
| Control plane | Policy_Engine, Action_Service, Audit_Service, Response_Validator, Authorization_Service, Configuration_Service | |
| AI plane | AI_Gateway → OpenRouter, Gemini, Groq | Nothing else |
| Data | Supabase Postgres + RLS | |

## The boundaries that matter

Three containment rules define the architecture more than the component list does.

**Agents reach data only through the Financial Tool Layer.** No agent holds a database client. Every read is a named tool invocation with Zod-validated typed arguments. There is no argument that expresses a query, which is why a misbehaving model cannot exfiltrate data through a crafted parameter.

**The AI Gateway reaches neither the data layer nor the tool layer.** It receives an already-bounded value set — at most 200 tool-returned values, at most 100,000 input characters — from the calling agent, and returns text. It cannot look anything up.

**The Response Validator sits between every agent response and every user.** It is the last gate. A monetary figure in model narrative that is not an exact paise match against the tool output supplied for that request withholds the entire response.

## Stage ownership in the action pipeline

| Stage | Owner |
|---|---|
| DETECT, INVESTIGATE, EXPLAIN, PROPOSE | The Agent |
| AUTHORIZE | Policy_Engine |
| EXECUTE, VERIFY | Action_Service |

Exactly one audit event per completed stage, appended within 5 seconds of stage completion.

## The five structural decisions

Quoted in full in `design.md`'s Overview. In brief:

1. **Money is always integer paise.** `bigint` in TypeScript, `BIGINT` domains in Postgres. No float anywhere.
2. **Models never compute.** Every figure comes from a tool and carries an evidence chain.
3. **Tenant isolation lives in the database.** RLS is the boundary; application filters are defence in depth.
4. **Two tables are append-only at the privilege level.** `ledger_entries` and `audit_events`.
5. **Determinism over cleverness in reconciliation.** Identifier-link matching only, total orderings with explicit tie-breakers.

## Related docs

- Data model → [05_DATA_MODEL.md](05_DATA_MODEL.md)
- API surface and tool catalogue → [06_API_CONTRACTS.md](06_API_CONTRACTS.md)
- Agent behaviour and guardrails → [07_AI_AGENT_SPEC.md](07_AI_AGENT_SPEC.md)
- Security enforcement → [09_SECURITY.md](09_SECURITY.md)
- Failure behaviour per layer → [10_ERROR_HANDLING.md](10_ERROR_HANDLING.md)
