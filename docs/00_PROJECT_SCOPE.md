# 00 — Project Scope

## The one-sentence version

FinanceOS is an AI layer that continuously reconciles the Razorpay payment-to-settlement-to-ledger lifecycle for Indian businesses, detects India-specific financial exceptions, explains each one with traceable evidence, forecasts cash impact, and safely proposes corrective actions under policy, approval and audit control.

## What we are building

**A financial control tower, not a chatbot.** The product surface is a dashboard showing four metrics and an attention panel of open exceptions, plus an agent conversation that investigates those exceptions on demand. The agent does not answer from memory; it calls typed tools over stored records and every figure it states carries an evidence chain back to source records.

**The reconciliation centerpiece.** One workflow built exceptionally well: match each Razorpay payment to its order, invoice, settlement and ledger entries; compute what each settlement should have paid; decompose any difference into Razorpay's fee, the GST on that fee, and an unexplained residual; and mark the settlement explained only when that residual is exactly zero paise. Everything else in the product either feeds this or extends it.

**A semantic ledger.** A double-entry-aware internal ledger derived from ingested Razorpay objects, representing the accounting state so it can be compared against the payment state. Append-only. Corrections happen by reversal, never by edit.

**India-native financial intelligence.** GST on Razorpay fees, GSTIN structural validation, input tax credit discrepancy detection, TDS review flags, HSN/SAC presence checks, credit note matching, and Indian number formatting throughout — lakh and crore, 2,2,3 digit grouping.

**Razorpay Route reconciliation.** For marketplaces: one customer payment split across linked accounts and platform commission, with transfers, partial reversals, on-hold transfers, and per-seller settlement shortfall investigation across the full chain.

**A safety spine.** Every AI-initiated action passes a seven-stage pipeline — detect, investigate, explain, propose, authorize, execute, verify — gated by six policy checks. Safe actions auto-execute only when a tenant has deliberately raised the threshold from its default of zero. Everything else waits for a human. Every stage writes an immutable, hash-chained audit event.

**A model-agnostic AI gateway.** Groq, Gemini and OpenRouter behind one interface with task-class routing and failover. Models produce narrative and classification text only. They never compute a monetary figure, and a response validator withholds any answer containing a rupee amount that is not an exact paise match against the tool output supplied to the model.

## What we are NOT building

These are hard boundaries. The requirements document states them as binding non-goals, meaning no requirement in the spec may be read as requiring them.

**Not an ERP.** No procurement, no inventory, no manufacturing, no HR, no general business process management. FinanceOS reads and reconciles financial state. It does not become the system of record for business operations.

**Not a tax filing or compliance authority.** The compliance agent performs detection and review only. It does not file GST returns, does not file TDS returns, does not generate statutory filings, and does not provide authoritative tax advice. Every finding it surfaces carries a review-only disclaimer in the same view. This is a deliberate positioning choice, not a limitation we intend to remove later.

**Not a Razorpay replacement.** FinanceOS does not process payments, hold funds, or move money on its own rails. Money movement stays with Razorpay. We read Razorpay data and, where explicitly authorized, invoke Razorpay APIs.

**Not a bookkeeping replacement for statutory books.** The semantic ledger exists for reconciliation and explanation. It is not certified statutory books of account.

**Not an autonomous money mover.** No sensitive action executes without a recorded human authorization. The default auto-execute threshold is zero, which means nothing auto-executes until a tenant with the policy configuration permission deliberately raises it.

## Why this scope and not a wider one

Razorpay already shipped agentic banking. RazorpayX announced agents for payouts, collections and cash flow in June 2026. A generic "AI finance assistant" competes directly with the platform vendor on their own turf, with less data access and no payment rails.

The defensible position is the layer above: understanding the *whole* money journey well enough to find the rupees that went missing between a captured payment and a bank credit, explain them with evidence a finance person can verify, and act on them under control. That is a different product from "an AI agent that does payouts."

## What "done" means for the MVP

The demo is one question, answered correctly.

A user asks *"Why am I missing ₹3.82 lakh in settlements?"* The system reports how many payments, settlements, refunds, ledger entries and invoices it examined, returns a per-settlement breakdown ordered by the size of the difference, decomposes each difference into fee, GST on fee, and unexplained residual, and lets the user click any figure to see the ordered computation steps and the source record identifiers behind it.

Notably, that demo works with the AI gateway entirely absent. The figures and evidence chains are the product; the narrative is presentation. This is why the build order puts the model last.

## Scope boundaries by slice

The build is sliced so the centerpiece is demoable before anything else starts. See [17_ROADMAP.md](17_ROADMAP.md) and the MVP Build Order section of `design.md` for the full breakdown.

| Slice | Scope | Gate before proceeding |
|---|---|---|
| 1 | Ingestion, semantic ledger, reconciliation agent, tool layer, control tower, accuracy invariants. No AI. | 9 correctness properties pass |
| 2 | Razorpay Route / marketplace reconciliation | Route conservation property passes |
| 3 | Policy engine, approval, verification, audit chain, multi-tenancy | 4 safety properties pass |
| 4 | AI gateway, then compliance, cash, recovery, analyst | Adversarial validator suite passes, all 14 properties pass |

## Authoritative sources

This document describes scope. It does not define behaviour. For that:

- Functional requirements → `.kiro/specs/financeos-control-tower/requirements.md`
- Technical design → `.kiro/specs/financeos-control-tower/design.md`
- Work queue → `.kiro/specs/financeos-control-tower/tasks.md`
- Explicit exclusions → [15_OUT_OF_SCOPE.md](15_OUT_OF_SCOPE.md)
