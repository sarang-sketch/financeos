# Razorpay AI Buildathon submission — FinanceOS

## Selected track

**03 — AI Revenue Recovery**

FinanceOS recovers failed payment revenue without treating every failure as a
retry. It detects correlated payment-route degradation, scores seven possible
recovery futures for net expected value, stops harmful retries, and only
executes an action inside a policy boundary with an auditable evidence trail.

## One-sentence pitch

**FinanceOS is a proof-carrying recovery agent that knows when the best money
action is to wait, not retry.**

## What is uniquely strong

Most recovery tools see a failed payment and retry it. FinanceOS first asks
whether the failure is customer-specific or systemic. During a correlated HDFC
3DS timeout, an immediate retry creates duplicate failures, gateway-fee burn,
and customer fatigue. The Recovery Digital Twin compares immediate retry,
delayed retry, UPI collect, payment link, WhatsApp link, human escalation, and
no action. It selects the highest **net expected** recovery after gateway,
friction, and risk costs, then exposes why every alternative lost.

### Recovery Passport

Before a recovery is eligible to run, FinanceOS compiles a **Recovery Passport**:
an action contract that records the chosen intervention, counterfactual it beat,
remaining retry budget, cooldown, route-health condition, duplicate-payment
cancellation, evidence expiry, and audit event for every gate. A judge can
simulate a late success webhook or stale evidence and watch the agent cancel
itself. This makes the stopping rules tangible rather than a slide-deck claim.

## Measured benchmark

The Buildathon Proof Run reports a deterministic synthetic cohort of 500 payment
failures. It deliberately identifies the data as synthetic and reproducible,
rather than claiming it is production recovery data.

| Same 500-case cohort | Blind retry control | FinanceOS Digital Twin | Difference |
| --- | ---: | ---: | ---: |
| Recovery rate | 71.4% | 86.8% | +15.4 points |
| Payments recovered | 357 | 434 | +77 |
| Net recovered revenue | ₹28.83 lakh | ₹36.24 lakh | **+₹7.41 lakh** |
| Unnecessary retries | 356 | 14 | **342 stopped** |

## Five-minute pitch script

**0:00–0:35 — Problem.** A payment failure is not one clean event. It may be a
customer decline, or it may be a payment-route incident. Blindly retrying during
an outage wastes fees and consumes customer trust just when revenue is most at
risk.

**0:35–1:10 — Product.** Open **Failed Payments**, select the HDFC timeout,
and move into **Recovery Decision Lab**. This is the product's normal operator
workflow, not a judge-only screen.

**1:10–2:15 — Detection and diagnosis.** FinanceOS detects a correlated HDFC
timeout, classifies it as systemic degradation, and does not confuse it with a
customer-specific failure.

**2:15–3:10 — The digital twin.** Open **Inspect all 7 futures**. Show that a
10-minute delayed card retry is selected over the obvious immediate retry:
the route gets time to recover, so probability rises and net expected recovery
is better after fees, friction, and risk penalties.

**3:10–4:05 — Bounded execution.** Open the **Action Passport** directly below
the recommendation. Cooldown, duplicate prevention, retry cap, route health,
and evidence expiry are evaluated before the recovery schedule can execute. The
graceful failure is visible: the agent waits instead of repeatedly charging into
a degraded route.

**4:05–4:40 — Evidence.** Click **Replay evidence chain** and then the audit
trail. The monetary route is explainable, actions are policy-gated, and the
audit log is hash-chained. The AI writes narrative; exact monetary work is
deterministic integer-paise computation.

**4:40–5:00 — Close.** “FinanceOS does not merely recover failed payments. It
proves that a recovery action is better than its alternatives before executing
it.”

## Architecture

```text
Razorpay failure / webhook
          ↓
Supabase: payment_failures + customer history + channel statistics
          ↓
Failure weather classification ──→ systemic vs customer-specific
          ↓
Recovery Digital Twin: seven bounded futures, net-EV calculation
          ↓
Policy gate: confidence, retry cap, duplicate check, ceiling, approval
          ↓
Razorpay recovery action / scheduled cooldown
          ↓
Verification + customer recovery memory + hash-chained audit evidence
```

## How to run the demo

```bash
npm run dev
```

Open the local app, select **Recovery Decision Lab**, and choose a failed
payment. The Action Passport is generated from the selected payment's Digital
Twin and is part of the normal recovery workflow.

## Responsible demo boundary

The current demo benchmark is deterministic synthetic data. Razorpay settlement
objects cannot be created through its test-mode API, and FinanceOS labels
synthetic fixtures rather than presenting them as provider-retrieved records.
Before production use, benchmark claims must be rerun on a held-out merchant
dataset and recovery actions must remain subject to the tenant's approval and
policy configuration.
