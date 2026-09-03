'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import styles from './AiBuyerMerchantLabView.module.css';
import { LiveTransactionTimeline } from './LiveTransactionTimeline';
import { StepCard } from '../commerce/StepCard';
import { MoneyFirewallCard } from '../commerce/MoneyFirewallCard';
import { TimeoutRecoveryBanner } from '../commerce/TimeoutRecoveryBanner';
import { ExplainableMoneyTrail } from '../commerce/ExplainableMoneyTrail';
import { ToastProvider, useToast } from '../commerce/ToastProvider';
import { LiveRevenueDashboard } from '../commerce/LiveRevenueDashboard';
import { AgentConversationFeed } from '../commerce/AgentConversationFeed';
import { RevenueComparison } from '../commerce/RevenueComparison';
import { GuidedDemoTour } from '../commerce/GuidedDemoTour';
import { ThemeToggle } from '../commerce/ThemeToggle';
import { AuditExportButton } from '../commerce/AuditExportButton';

declare global {
  interface Window {
    Razorpay?: new (opts: Record<string, unknown>) => { open: () => void };
  }
}

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

interface BuyerIntent {
  category: string;
  budgetMaxPaise: number;
  requirements: string[];
  deliveryDeadline: string;
  occasion: string | null;
  giftableRequired: boolean;
}

interface Product {
  id: string;
  name: string;
  pricePaise: number;
  costPaise: number;
  marginPercent: number;
  inventory: number;
  category: string;
  aiMetadata: { useCases: string[]; features: string[]; giftable: boolean; deliveryDays: number };
}

interface CandidateProduct {
  product: Product;
  score: number;
  breakdown: { featureMatch: number; priceFit: number; delivery: number; inventory: number };
}

interface FirewallResult {
  allowed: boolean;
  governance_level: string;
  reason: string;
  requested_discount_percent: number;
  max_discount_allowed: number;
  projected_margin_percent?: number;
  counter_offer_discount_percent?: number;
  audit_sha256?: string;
  audit_event_id: string;
}

interface TransactionResult {
  orderId: string;
  transactionId: string;
  razorpayOrderId: string;
  amountPaise: number;
  razorpayKeyId: string;
  isLiveRazorpay: boolean;
}

interface OfferData {
  basePricePaise: number;
  discountedPricePaise: number;
  discountPercent: number;
  totalPaise: number;
  upsell: { name?: string; productId?: string; pricePaise?: number } | null;
  reasons: string[];
}

type DemoStep = 'IDLE' | 'DISCOVERING' | 'DISCOVERED' | 'OFFER_GENERATED' | 'FIREWALL_CHECKED' | 'PAYMENT_INITIATED' | 'PAYMENT_COMPLETED' | 'ORDER_CONFIRMED';

/* -------------------------------------------------------------------------- */
/* Inner component — needs toast context                                      */
/* -------------------------------------------------------------------------- */

function AiBuyerMerchantLabInner() {
  const toast = useToast();

  // --- Buyer state ---
  const [buyerPrompt, setBuyerPrompt] = useState('Find me a birthday gift toy for a 10-year-old under ₹5,000. He loves remote control cars and outdoor speed toys.');
  const [step, setStep] = useState<DemoStep>('IDLE');
  const [isProcessing, setIsProcessing] = useState(false);

  // --- AI Buyer results ---
  const [intent, setIntent] = useState<BuyerIntent | null>(null);
  const [candidates, setCandidates] = useState<CandidateProduct[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [explanation, setExplanation] = useState('');

  // --- Offer & Firewall ---
  const [offerData, setOfferData] = useState<OfferData | null>(null);
  const [firewallResult, setFirewallResult] = useState<FirewallResult | null>(null);

  // --- Transaction ---
  const [txResult, setTxResult] = useState<TransactionResult | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);

  // --- Firewall sliders ---
  const [maxDiscountSlider, setMaxDiscountSlider] = useState(10);
  const [minMarginSlider, setMinMarginSlider] = useState(25);

  // --- Demo controls ---
  const [injectTimeout, setInjectTimeout] = useState(false);
  const [timeoutState, setTimeoutState] = useState<'IDLE' | 'TIMEOUT' | 'RECOVERED'>('IDLE');
  const [firewallViolation, setFirewallViolation] = useState(false);

  // --- Loading per-step ---
  const [loadingStep, setLoadingStep] = useState<DemoStep | null>(null);

  // --- Agent conversation feed ---
  type AgentActor = 'AI_BUYER' | 'MERCHANT_AGENT' | 'MONEY_FIREWALL' | 'RAZORPAY_GATEWAY' | 'SYSTEM';
  interface AgentMsg { id: string; actor: AgentActor; message: string; timestamp: string; meta?: Record<string, string> }
  const [agentMessages, setAgentMessages] = useState<AgentMsg[]>([]);
  const [agentTyping, setAgentTyping] = useState(false);

  // --- Comparison data ---
  const [comparisonData, setComparisonData] = useState<{
    aiRevenuePaise: number; manualRevenuePaise: number; aiAovPaise: number; manualAovPaise: number;
    aiUpsellRate: number; manualUpsellRate: number; aiCartAbandon: number; manualCartAbandon: number; upliftMultiple: number;
  } | null>(null);

  // --- Tour ---
  const [showTour, setShowTour] = useState(false);

  const addMsg = useCallback((actor: AgentActor, message: string, meta?: Record<string, string>) => {
    setAgentMessages((prev) => [...prev, { id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, actor, message, timestamp: new Date().toISOString(), meta }]);
  }, []);

  // Load Razorpay SDK
  useEffect(() => {
    if (typeof window !== 'undefined' && !window.Razorpay) {
      const s = document.createElement('script');
      s.src = 'https://checkout.razorpay.com/v1/checkout.js';
      s.async = true;
      document.body.appendChild(s);
    }
  }, []);

  const fmtInr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

  const stepDone = (s: DemoStep) => {
    const order: DemoStep[] = ['IDLE', 'DISCOVERING', 'DISCOVERED', 'OFFER_GENERATED', 'FIREWALL_CHECKED', 'PAYMENT_INITIATED', 'PAYMENT_COMPLETED', 'ORDER_CONFIRMED'];
    return order.indexOf(step) >= order.indexOf(s);
  };

  /* ========== STEP 1: Full Transaction Flow ========== */

  const handleRunDiscovery = async () => {
    setIsProcessing(true);
    setStep('DISCOVERING');
    setLoadingStep('DISCOVERING');
    setIntent(null); setCandidates([]); setSelectedProduct(null); setExplanation('');
    setOfferData(null); setFirewallResult(null); setTxResult(null); setPaymentId(null);
    setTimeoutState('IDLE'); setFirewallViolation(false);
    setAgentMessages([]); setAgentTyping(true);

    try {
      // Step 1: AI Buyer discovery
      addMsg('AI_BUYER', `Searching for: "${buyerPrompt}"`, { mode: 'Gemini LLM' });

      const buyerRes = await fetch('/api/commerce/buyer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: buyerPrompt }),
      });
      const buyerData = await buyerRes.json();
      setIntent(buyerData.intent);
      setCandidates(buyerData.candidates || []);
      setSelectedProduct(buyerData.selected);
      setExplanation(buyerData.explanation || '');
      setStep('DISCOVERED');
      setLoadingStep('OFFER_GENERATED');

      if (buyerData.intent) {
        addMsg('AI_BUYER', `Intent extracted: ${buyerData.intent.category} | Budget: ₹${(buyerData.intent.budgetMaxPaise / 100).toLocaleString('en-IN')} | Requirements: ${buyerData.intent.requirements.join(', ')}`, { deadline: buyerData.intent.deliveryDeadline, occasion: buyerData.intent.occasion || 'none' });
      }

      if (!buyerData.selected) {
        addMsg('AI_BUYER', '❌ No matching products found in catalog.'); setAgentTyping(false);
        toast('No matching products found. Try a different query.', 'warning');
        setIsProcessing(false); setLoadingStep(null);
        return;
      }

      const matchScore = ((buyerData.candidates?.[0]?.score ?? 0) * 100).toFixed(0);
      addMsg('MERCHANT_AGENT', `Matched: ${buyerData.selected.name} (₹${(buyerData.selected.pricePaise / 100).toLocaleString('en-IN')}, ${buyerData.selected.marginPercent}% margin) — ${matchScore}% match score`, { inventory: `${buyerData.selected.inventory} units` });

      // Step 2: Merchant offer
      const offerRes = await fetch('/api/commerce/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          product_id: buyerData.selected.id,
          buyer: { intent: buyerData.intent.category, budget: buyerData.intent.budgetMaxPaise / 100, requirements: buyerData.intent.requirements },
          requested_discount_percent: 5,
        }),
      });
      const offer = await offerRes.json();
      setOfferData(offer);
      setStep('OFFER_GENERATED');
      setLoadingStep('FIREWALL_CHECKED');

      const offerPrice = offer.discountedPricePaise || offer.basePricePaise || 0;
      addMsg('MERCHANT_AGENT', `Offering ${offer.discountPercent || 0}% discount → ₹${(offerPrice / 100).toLocaleString('en-IN')}${offer.upsell ? ` | Upsell: ${offer.upsell.name || offer.upsell.productId}` : ''}`, { strategy: 'deterministic scoring' });

      // Step 3: Money Firewall
      addMsg('MONEY_FIREWALL', `Validating: ${offer.discountPercent || 5}% discount against ${maxDiscountSlider}% cap, margin floor ${minMarginSlider}%...`);

      const fwRes = await fetch('/api/commerce/firewall/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'CHECKOUT',
          merchant_id: 'merchant_001',
          requested_discount_percent: offer.discountPercent || 5,
          base_price_paise: buyerData.selected.pricePaise,
          product_margin_percent: buyerData.selected.marginPercent,
          override_policy: { maxDiscountPercent: maxDiscountSlider, minimumMarginPercent: minMarginSlider },
        }),
      });
      const fw = await fwRes.json();
      setFirewallResult(fw);
      setStep('FIREWALL_CHECKED');
      setLoadingStep('PAYMENT_INITIATED');

      if (!fw.allowed) {
        addMsg('MONEY_FIREWALL', `🚨 BLOCKED — ${fw.reason}. Counter-offer: ${fw.counter_offer_discount_percent}%`, { governance: fw.governance_level, sha: fw.audit_sha256?.substring(0, 16) || '' });
        setAgentTyping(false);
        toast(`Money Firewall BLOCKED: ${fw.reason}`, 'danger');
        setIsProcessing(false); setLoadingStep(null);
        return;
      }

      addMsg('MONEY_FIREWALL', `✅ APPROVED — ${fw.governance_level?.replace(/_/g, ' ')}. Margin: ${fw.projected_margin_percent?.toFixed(1)}%`, { sha: fw.audit_sha256?.substring(0, 16) || '' });

      // Step 4: Timeout injection
      if (injectTimeout) {
        addMsg('RAZORPAY_GATEWAY', '⚠️ Payment verification TIMEOUT — fulfillment paused, zero duplicate charges');
        setStep('PAYMENT_INITIATED'); setTimeoutState('TIMEOUT'); setLoadingStep(null); setAgentTyping(false);
        toast('Payment verification timeout simulated. Fulfillment paused.', 'warning');
        setIsProcessing(false);
        return;
      }

      // Step 4: Initiate transaction
      addMsg('RAZORPAY_GATEWAY', 'Creating Razorpay order...');
      const checkoutRes = await fetch('/api/agentic/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'INITIATE',
          buyerAgentId: 'ai_buyer_demo',
          merchantId: 'merchant_001',
          productId: buyerData.selected.id,
          quantity: 1,
          discountPaise: offer.discountedPricePaise ? buyerData.selected.pricePaise - offer.discountedPricePaise : 0,
          upsellProductId: offer.upsell?.productId,
        }),
      });
      const checkout = await checkoutRes.json();
      setTxResult(checkout);
      setStep('PAYMENT_INITIATED');
      setLoadingStep(null);
      setAgentTyping(false);
      addMsg('RAZORPAY_GATEWAY', `Order created: ${checkout.razorpayOrderId} | Amount: ₹${(checkout.amountPaise / 100).toLocaleString('en-IN')}`, { orderId: checkout.orderId });
      toast(`Razorpay order created: ${checkout.razorpayOrderId}`, 'success');

      // Fetch comparison data
      try {
        const dashRes = await fetch('/api/dashboard/commerce');
        if (dashRes.ok) { const d = await dashRes.json(); setComparisonData(d.comparison); }
      } catch { /* silent */ }

    } catch (err) {
      addMsg('SYSTEM', `❌ Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      setAgentTyping(false);
      toast(`Error: ${err instanceof Error ? err.message : 'Unknown'}`, 'danger');
      setLoadingStep(null);
    }
    setIsProcessing(false);
  };

  /* ========== Razorpay Checkout ========== */

  const handleOpenRazorpay = () => {
    if (!window.Razorpay || !txResult) {
      toast('Razorpay SDK loading... try again.', 'warning');
      return;
    }
    const rzp = new window.Razorpay({
      key: txResult.razorpayKeyId || 'rzp_test_TWEduRM7dLIhhc',
      amount: txResult.amountPaise,
      currency: 'INR',
      name: 'Acme Travel & Gear',
      description: selectedProduct?.name || 'CommerceOS Purchase',
      order_id: txResult.razorpayOrderId,
      prefill: { name: 'Autonomous AI Buyer', email: 'agent@commerceos.ai', contact: '+919820144812' },
      notes: { platform: 'CommerceOS', buyer_mode: 'Agentic' },
      theme: { color: '#4f46e5' },
      handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        setPaymentId(response.razorpay_payment_id);
        try {
          await fetch('/api/webhooks/razorpay', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response),
          });
          setStep('ORDER_CONFIRMED');
          toast(`Payment verified: ${response.razorpay_payment_id} — Order confirmed!`, 'success');
        } catch {
          setStep('PAYMENT_COMPLETED');
          toast(`Payment captured: ${response.razorpay_payment_id}`, 'success');
        }
      },
    });
    rzp.open();
  };

  const handleAutoVerify = async () => {
    if (!txResult) return;
    try {
      const res = await fetch('/api/agentic/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'VERIFY', razorpayOrderId: txResult.razorpayOrderId, razorpayPaymentId: `pay_demo_${Date.now().toString(36)}`, razorpaySignature: '' }),
      });
      const data = await res.json();
      setPaymentId(data.razorpayPaymentId || 'verified');
      setStep('ORDER_CONFIRMED');
      toast('Payment verified and order confirmed!', 'success');
    } catch {
      toast('Verification failed', 'danger');
    }
  };

  /* ========== Demo actions ========== */

  const handleRecoverTimeout = async () => {
    if (!txResult) {
      setTimeoutState('RECOVERED'); setStep('ORDER_CONFIRMED');
      toast('Transaction recovered without duplicate charge!', 'success');
      return;
    }
    try {
      const res = await fetch('/api/agentic/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'RETRY', transactionId: txResult.transactionId }),
      });
      const data = await res.json();
      setTimeoutState('RECOVERED');
      if (data.recovered) { setStep('ORDER_CONFIRMED'); toast('Recovered — order confirmed!', 'success'); }
      else { toast('Payment still pending. Webhook will complete verification.', 'warning'); }
    } catch { toast('Recovery failed', 'danger'); }
  };

  const handleFirewallViolation = async () => {
    setFirewallViolation(true);
    try {
      const res = await fetch('/api/commerce/firewall/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'DISCOUNT', merchant_id: 'merchant_001', requested_discount_percent: 30,
          base_price_paise: 449900, product_margin_percent: 44,
          override_policy: { maxDiscountPercent: maxDiscountSlider, minimumMarginPercent: minMarginSlider },
        }),
      });
      const fw = await res.json();
      setFirewallResult(fw);
      toast(`30% discount BLOCKED by ${maxDiscountSlider}% policy. Counter: ${fw.counter_offer_discount_percent}%.`, 'danger');
    } catch { toast('Firewall violation simulated.', 'danger'); }
  };

  /* ========== RENDER ========== */

  return (
    <div className={styles.wrapper}>
      {/* --- GUIDED TOUR --- */}
      {showTour && <GuidedDemoTour onComplete={() => setShowTour(false)} />}

      {/* --- HEADER BANNER --- */}
      <div className={styles.headerBanner}>
        <div className={styles.headerRow}>
          <div>
            <div className={styles.badgeRow}>
              <span className="badge badge-brand">LIVE TRANSACTION DEMO</span>
              <span className="badge badge-success">Real Razorpay Test Mode</span>
              <span className="badge badge-info">Gemini AI + Money Firewall</span>
              <span className="badge badge-neutral">Every Action Gated</span>
            </div>
            <h1 className={styles.headerTitle}>Razorpay CommerceOS: AI Merchant That Sells to AI</h1>
            <p className={styles.headerSubtitle}>
              Real end-to-end: Gemini extracts intent → deterministic catalog match → Money Firewall gates → Razorpay payment → SHA-256 audit trail.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
            <button onClick={() => setShowTour(true)} className="btn btn-secondary" style={{ fontSize: '11px', padding: '5px 12px' }} aria-label="Start guided demo tour">
              🎯 Guided Tour
            </button>
            <ThemeToggle />
          </div>
        </div>
      </div>

      {/* --- LIVE REVENUE DASHBOARD --- */}
      <LiveRevenueDashboard />

      {/* --- DUAL-SCREEN SPLIT --- */}
      <div className={styles.dualScreen}>

        {/* === LEFT: AI BUYER === */}
        <div className={styles.panelBuyer}>
          <div className={styles.panelHeader}>
            <div className={styles.panelHeaderLeft}>
              <span className={styles.panelIcon}>🤖</span>
              <div>
                <h3 className={`${styles.panelTitle} ${styles.panelTitleBuyer}`}>LEFT: Autonomous AI Buyer</h3>
                <span className={styles.panelSubtitle}>Gemini LLM Intent Extraction → Deterministic Match</span>
              </div>
            </div>
            <span className="badge badge-brand">AI Buyer</span>
          </div>

          {/* Prompt Input */}
          <div>
            <label className={styles.promptLabel} htmlFor="buyer-prompt">USER DELEGATION PROMPT</label>
            <textarea
              id="buyer-prompt"
              rows={2}
              value={buyerPrompt}
              onChange={(e) => setBuyerPrompt(e.target.value)}
              className={`input-control ${styles.promptTextarea}`}
              aria-label="Enter your purchase request for the AI buyer"
            />
            <div className={styles.chaosRow}>
              <input type="checkbox" id="chaosToggle" checked={injectTimeout} onChange={(e) => setInjectTimeout(e.target.checked)} />
              <label htmlFor="chaosToggle" className={styles.chaosLabel}>⚡ Inject Verification Timeout</label>
            </div>
            <div className={styles.promptActions}>
              <button disabled={isProcessing} onClick={handleRunDiscovery} className={`btn btn-primary ${styles.runButton}`} aria-label="Run full AI commerce transaction">
                {isProcessing ? '⏳ AI Processing...' : '⚡ Run Full Transaction'}
              </button>
            </div>
          </div>

          {/* Step 1 */}
          <StepCard title="STEP 1: GEMINI INTENT EXTRACTION" active={stepDone('DISCOVERED')} loading={loadingStep === 'DISCOVERING'} badge={intent ? `${intent.category} / ${fmtInr(intent.budgetMaxPaise)}` : undefined}>
            {intent && (
              <div>
                <div className={styles.stepMeta}>
                  <span>Category: <strong>{intent.category}</strong></span>
                  <span>Budget: <strong>{fmtInr(intent.budgetMaxPaise)}</strong></span>
                  <span>Occasion: <strong>{intent.occasion || 'none'}</strong></span>
                  <span>Delivery: <strong>{intent.deliveryDeadline}</strong></span>
                </div>
                {intent.requirements.length > 0 && (
                  <div style={{ marginTop: '4px' }}>
                    {intent.requirements.map((r, i) => <span key={i} className="badge badge-info" style={{ marginRight: '4px', fontSize: '10px' }}>{r}</span>)}
                  </div>
                )}
              </div>
            )}
          </StepCard>

          {/* Step 2 */}
          <StepCard title="STEP 2: CATALOG DISCOVERY & MATCH" active={stepDone('DISCOVERED')} loading={loadingStep === 'DISCOVERING'} badge={selectedProduct ? `${((candidates[0]?.score ?? 0) * 100).toFixed(0)}% match` : undefined}>
            {selectedProduct && (
              <div>
                <div style={{ fontWeight: 700 }}>{selectedProduct.name}</div>
                <div className={styles.stepMeta}>
                  <span>Price: <strong>{fmtInr(selectedProduct.pricePaise)}</strong></span>
                  <span>Margin: <strong>{selectedProduct.marginPercent}%</strong></span>
                  <span>Stock: <strong>{selectedProduct.inventory} units</strong></span>
                </div>
                {explanation && <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>💡 {explanation.substring(0, 200)}</div>}
              </div>
            )}
          </StepCard>

          {/* Step 3 */}
          <StepCard title="STEP 3: MERCHANT OFFER & UPSELL" active={stepDone('OFFER_GENERATED')} loading={loadingStep === 'OFFER_GENERATED'} badge={offerData?.upsell ? `+${fmtInr(offerData.upsell.pricePaise || 0)} upsell` : undefined}>
            {offerData && (
              <div>
                <div>Offer: <strong>{fmtInr(offerData.discountedPricePaise || offerData.basePricePaise)}</strong> ({offerData.discountPercent}% off)</div>
                {offerData.upsell && (
                  <div style={{ marginTop: '2px', fontSize: '11px', color: 'var(--success-text)', fontWeight: 600 }}>
                    ✓ Upsell: {offerData.upsell.name || offerData.upsell.productId} ({fmtInr(offerData.upsell.pricePaise || 0)})
                  </div>
                )}
                {offerData.reasons?.[0] && <div style={{ marginTop: '3px', fontSize: '10px', color: 'var(--text-muted)' }}>{offerData.reasons[0]}</div>}
              </div>
            )}
          </StepCard>

          {/* Step 4 */}
          <StepCard
            title="STEP 4: RAZORPAY PAYMENT & SETTLEMENT"
            active={stepDone('PAYMENT_INITIATED')}
            loading={loadingStep === 'PAYMENT_INITIATED'}
            highlight={step === 'ORDER_CONFIRMED'}
            badge={step === 'ORDER_CONFIRMED' ? '✓ Confirmed' : txResult?.isLiveRazorpay ? 'Live Order' : undefined}
          >
            {txResult ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div className={styles.paymentRow}>
                  <span className={styles.paymentLabel}>Razorpay Order:</span>
                  <span className={`mono ${styles.paymentValue}`}>{txResult.razorpayOrderId}</span>
                </div>
                <div className={styles.paymentRow}>
                  <span className={styles.paymentLabel}>Total:</span>
                  <span className={`mono ${styles.paymentTotal}`}>{fmtInr(txResult.amountPaise)}</span>
                </div>
                {paymentId && (
                  <div className={styles.paymentRow}>
                    <span className={styles.paymentLabel}>Payment ID:</span>
                    <span className={`mono ${styles.paymentId}`}>{paymentId}</span>
                  </div>
                )}
                <div className={styles.paymentButtons}>
                  <button onClick={handleOpenRazorpay} className={`btn btn-secondary ${styles.razorpayBtn}`} aria-label="Open Razorpay checkout modal">
                    📱 Razorpay Checkout
                  </button>
                  <button onClick={handleAutoVerify} className="btn btn-secondary" style={{ fontSize: '11px', padding: '6px 12px' }} aria-label="Auto-verify payment for demo">
                    ✓ Auto-Verify
                  </button>
                </div>
              </div>
            ) : timeoutState === 'TIMEOUT' ? (
              <div style={{ fontSize: '11px', color: 'var(--warning-text)' }}>⚠️ Payment verification timed out.</div>
            ) : null}
          </StepCard>
        </div>

        {/* === RIGHT: MERCHANT CONTROL ROOM === */}
        <div className={styles.panelMerchant}>
          <div className={styles.panelHeader}>
            <div className={styles.panelHeaderLeft}>
              <span className={styles.panelIcon}>🏢</span>
              <div>
                <h3 className={`${styles.panelTitle} ${styles.panelTitleMerchant}`}>RIGHT: Merchant Control Room</h3>
                <span className={styles.panelSubtitle}>Real-time Policy Gate, Money Firewall & Audit</span>
              </div>
            </div>
            <span className="badge badge-success">Merchant</span>
          </div>

          {/* Telemetry */}
          <div className={styles.telemetryBox}>
            <div className={styles.telemetryHeader}>
              <span className={styles.telemetryLabel}>INCOMING BUYER TELEMETRY</span>
              {intent && <span className="badge badge-info">Intent: {intent.category}</span>}
            </div>
            {selectedProduct ? (
              <div className={styles.telemetryGrid}>
                <div className={styles.telemetryItem}><label>Target</label><strong>{selectedProduct.name}</strong></div>
                <div className={styles.telemetryItem}><label>Inventory</label><strong>{selectedProduct.inventory} Units</strong></div>
                <div className={styles.telemetryItem}><label>Gross Margin</label><strong style={{ color: 'var(--success-text)' }}>{selectedProduct.marginPercent}%</strong></div>
                <div className={styles.telemetryItem}><label>Price</label><strong>{fmtInr(selectedProduct.pricePaise)}</strong></div>
              </div>
            ) : (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Awaiting buyer signal...</div>
            )}
          </div>

          {/* Money Firewall */}
          <MoneyFirewallCard
            maxDiscount={maxDiscountSlider}
            minMargin={minMarginSlider}
            onMaxDiscountChange={setMaxDiscountSlider}
            onMinMarginChange={setMinMarginSlider}
            firewallResult={firewallResult}
            violation={firewallViolation}
            onTriggerViolation={handleFirewallViolation}
            onTriggerTimeout={() => { setTimeoutState('TIMEOUT'); toast('Verification timeout simulated.', 'warning'); }}
          />

          {/* Timeout Recovery */}
          <TimeoutRecoveryBanner state={timeoutState} onRecover={handleRecoverTimeout} />

          {/* Explainable Money Trail */}
          <ExplainableMoneyTrail
            intent={intent}
            selectedProduct={selectedProduct}
            offerUpsell={offerData?.upsell ?? null}
            maxDiscount={maxDiscountSlider}
            minMargin={minMarginSlider}
            txResult={txResult}
          />
        </div>
      </div>

      {/* --- AGENT CONVERSATION FEED --- */}
      <div className={styles.panelAudit}>
        <div className={styles.auditHeader}>
          <div className={styles.auditHeaderLeft}>
            <span style={{ fontSize: '16px' }}>💬</span>
            <h3 className={styles.auditTitle}>Agent Negotiation Feed — Real-Time AI-to-AI</h3>
          </div>
          <span className="badge badge-brand">{agentMessages.length} Messages</span>
        </div>
        <AgentConversationFeed messages={agentMessages} isTyping={agentTyping} />
      </div>

      {/* --- AUDIT TRAIL + EXPORT --- */}
      <div className={styles.panelAudit}>
        <div className={styles.auditHeader}>
          <div className={styles.auditHeaderLeft}>
            <span style={{ fontSize: '16px' }}>📜</span>
            <h3 className={styles.auditTitle}>Live Audit Trail — Tamper-Evident SHA-256 Chain</h3>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <AuditExportButton />
            <span className="badge badge-neutral">Auto-Refresh 2s</span>
          </div>
        </div>
        <LiveTransactionTimeline orderId={txResult?.orderId} autoRefresh refreshIntervalMs={2000} />
      </div>

      {/* --- REVENUE COMPARISON: AI vs MANUAL --- */}
      <div className={styles.panelAudit}>
        <div className={styles.auditHeader}>
          <div className={styles.auditHeaderLeft}>
            <span style={{ fontSize: '16px' }}>📊</span>
            <h3 className={styles.auditTitle}>Revenue Intelligence — AI vs Manual Comparison</h3>
          </div>
          <span className="badge badge-success">Live Metrics</span>
        </div>
        <RevenueComparison data={comparisonData} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Exported component — wraps with ToastProvider                              */
/* -------------------------------------------------------------------------- */

export function AiBuyerMerchantLabView() {
  return (
    <ToastProvider>
      <AiBuyerMerchantLabInner />
    </ToastProvider>
  );
}
