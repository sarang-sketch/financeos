# 13 — Testing Strategy

> **Pointer document.** The authoritative testing strategy and the 14 correctness property specifications live in the spec. This file summarises the suites and explains why property-based testing carries the weight here.

## Where the strategy is

**`.kiro/specs/financeos-control-tower/design.md`**

| Section | Contains |
|---|---|
| `## Correctness Properties` | P1–P14 with statement, requirement citations, generator inputs, assertion; plus the fast-check arbitraries and shrinking guidance |
| `## Testing Strategy` | Unit, property, Razorpay integration, database, contract, validator adversarial, E2E demo path, and the CI stage table |

## Suites

| Suite | Tool | Covers | CI stage | Gates merge |
|---|---|---|---|---|
| Typecheck + lint | `tsc --noEmit`, ESLint | The `Paise = bigint` discipline | 1 | yes |
| Unit | Vitest | Named boundaries in calc, formatters, GSTIN, risk score, fingerprint | 2 | yes |
| Database | Vitest + Supabase local | RLS, append-only, balance trigger, domains, idempotency constraints, schema type audit | 3 | yes |
| Tool contract | Vitest + Zod | Every tool's input/output schema, declared mode, evidence envelope, timeout | 4 | yes |
| Property | fast-check | P1–P14, seeded | 5 | yes |
| Validator adversarial | Vitest | 10 plausible hallucination shapes | 6 | yes |
| E2E demo path | Vitest + Razorpay test mode | Seed → ingest → derive → reconcile → evidence → ask → withhold | 7 | yes |
| Razorpay integration | Vitest + real HTTP | Paging, backoff, credential rejection, error isolation | 8 | advisory |
| Performance | Vitest | The bounds against a 5000-payment fixture | 9 | advisory |

Stages 8 and 9 are advisory because they depend on an external service and on machine speed — a Razorpay test-mode outage must not block unrelated work. A failure opens an issue automatically; two consecutive failures escalate to blocking.

**Typecheck gates first and hardest.** The `type Paise = bigint` rule is enforced by the compiler, so a `number` on a monetary path is a type error. That is the cheapest place in the pipeline to catch the most expensive class of bug in this system.

## The 14 correctness properties

| # | Property | Validates |
|---|---|---|
| P1 | Ledger set balance | 2.1, 2.2, 2.3, 2.6, 2.7, 2.9, 2.10, 4.12 |
| P2 | Ledger derivation idempotency | 2.8 |
| P3 | Settlement difference decomposition exactness | 4.2–4.5, 4.13 |
| P4 | Route split conservation | 7.1, 7.2, 7.7, 7.9, 7.11 |
| P5 | Reconciliation run determinism | 4.15, 6.12, 7.10, 15.7 |
| P6 | Evidence chain replay | 10.1, 12.2, 12.8 |
| P7 | Tenant isolation | 12.7, 14.2, 14.3, 14.7, 14.10 |
| P8 | Authorization completeness | 5.1, 5.6, 5.7, 5.14, 12.10, 13.7 |
| P9 | Audit chain integrity | 13.1, 13.4, 13.8, 13.10 |
| P10 | Ingestion idempotency | 1.2, 1.3 |
| P11 | Indian number format round-trip | 3.2, 3.3, 3.11, 15.2 |
| P12 | Integer-only monetary arithmetic | 1.7, 8.2, 10.6, 11.8, 15.1, 15.8, 15.9 |
| P13 | Trial balance self-balance | 2.5 |
| P14 | Reversal preservation | 2.4, 5.17 |

`numRuns` is at least 100, raised to 1000 for P1, P3, P11 and P12 — cheap and central.

## Why properties rather than more example tests

The invariants in this system are stated arithmetically in the requirements, over a very large input space. "The settlement difference equals fee plus GST plus residual, exactly, in integer paise" is either true for all recon reports or the reconciliation is unsound. An example test proves it for the examples you thought of.

Three of the properties are additionally enforced as database constraints, so they hold at two layers:

| Property | Also enforced by |
|---|---|
| P1 | `ledger_set_balanced` CHECK + deferred `ledger_entries_balance_check` trigger |
| P3 | `difference_decomposes_exactly` and `explained_iff_zero_residual` CHECKs |
| P10 | `razorpay_objects_tenant_rzp_uniq` |

## Property gates between slices

The gates are the point of the slicing. Each blocks the next slice.

| After slice | Gate |
|---|---|
| 1 | P1, P2, P3, P5, P6, P10, P11, P12, P13 |
| 2 | P4, plus P1 and P5 re-run over Route data |
| 3 | P7, P8, P9, P14 |
| 4 | Adversarial suite in full, plus all 14 properties |

The slice 1 gate is nine properties and is explicitly not waivable: every later slice computes on top of them, so a decomposition or rounding bug found in slice 4 would invalidate everything built in between.

## Generator discipline

Full arbitraries are in `design.md`. Three rules worth repeating:

**Repair, do not filter.** `arbitraryPayment` repairs the `amount > fee + gst` invariant in a `.map` rather than rejecting with `fc.pre`. Filtering on a low-probability predicate biases the distribution, slows generation, and shrinks poorly because the shrinker keeps landing on rejected candidates.

**Every monetary arbitrary is `bigint`.** There is no `number`-valued money arbitrary, so a `number` reaching a monetary path is a compile error rather than a rounding bug found in production.

**Shrink the shape discriminator last.** `residualShape` and `reportShape` are placed after the data arrays, so a failing case first shrinks the data down and only then simplifies the shape, keeping the counterexample in the shape that actually failed.

Every property runs with an explicit seed in CI, and any counterexample fast-check reports is committed as an example-based regression test alongside the property.

## The two tests that prove the AI claim

**Validator adversarial suite (stage 6).** Ten plausible hallucination shapes against a fixed allowed value set: exact repetition released; "about 8.4 lakh" withheld; off by 1 paisa withheld; a sum of two allowed values withheld; a percentage-derived invention withheld; a figure with no chain identifier withheld; an unresolvable chain identifier withheld; "3.82 Cr" released; "3.8 Cr" withheld; nine correct and one fabricated withholds the whole response. Each withholding case also asserts the audit event.

**E2E demo path step 7.** The same pipeline is run twice — once normally, once with the gateway stubbed to return a fabricated figure — asserting release in the first case and whole-response withholding in the second. That paired assertion is the point: the difference is mechanical, not a matter of prompt quality.

## What is deliberately not tested automatically

- **WCAG conformance** — the accessibility baseline in [08_UI_UX_SPEC.md](08_UI_UX_SPEC.md) is implementable and reviewable, but full validation needs manual assistive-technology testing and expert review
- **Razorpay live mode** — test mode only for the MVP by design
- **Model output quality** — narrative readability is not asserted; only that ungrounded figures are withheld

## Related docs

- Property specifications and generators → `design.md` → Correctness Properties
- Edge cases the generators produce → [11_EDGE_CASES.md](11_EDGE_CASES.md)
- Per-requirement done tests → [14_ACCEPTANCE_CRITERIA.md](14_ACCEPTANCE_CRITERIA.md)
- Test tasks → `tasks.md`, property gates at 17, 20, 29, 37
