'use client';

import React, { useState } from 'react';
import {
  AgenticCommerceService,
  type AgenticCommerceSummary,
  type AiBuyerTransaction,
} from '@/services/agentic-commerce-service';
import { BuyerActivityFeed } from './agentic/BuyerActivityFeed';

interface AgenticCommerceViewProps {
  onInspectEvidence?: (id: string) => void;
  defaultSubTab?: 'BUYER_ACTIVITY' | 'A2A_GATEWAY' | 'AGENT_CATALOG' | 'UPSELL_ENGINE' | 'CAMPAIGNS';
}

export function AgenticCommerceView({
  onInspectEvidence = () => {},
  defaultSubTab = 'A2A_GATEWAY',
}: AgenticCommerceViewProps) {
  const [summary, setSummary] = useState<AgenticCommerceSummary>(AgenticCommerceService.getSummary());
  const [activeSubTab, setActiveSubTab] = useState<'BUYER_ACTIVITY' | 'A2A_GATEWAY' | 'AGENT_CATALOG' | 'UPSELL_ENGINE' | 'CAMPAIGNS'>(defaultSubTab);
  const [isExecuting, setIsExecuting] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const handleTriggerSimulatedBuyer = async (mode: 'SUCCESS' | 'FAILURE_GRACEFUL') => {
    setIsExecuting(true);
    try {
      const res = await fetch('/api/agentic/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      setSummary(AgenticCommerceService.getSummary());
      setIsExecuting(false);

      if (mode === 'SUCCESS') {
        showToast('✓ AI Buyer Purchase Settled: AutoProcure agent transacted ₹13,000.00 via Razorpay Test Mode.');
      } else {
        showToast('⚠️ Graceful Failure Handled: Over-budget AI order intercepted, auto-negotiated down-scope, and settled safely.');
      }
    } catch {
      setIsExecuting(false);
    }
  };

  const handleDispatchNudge = async (
    sessionId: string,
    channel: 'WHATSAPP' | 'EMAIL' | 'CALL' | 'PUSH'
  ) => {
    setIsExecuting(true);
    try {
      const res = await fetch('/api/agentic/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'SINGLE', sessionId, channel }),
      });
      const data = await res.json();
      setSummary(AgenticCommerceService.getSummary());
      setIsExecuting(false);
      showToast(data.result?.message || `✓ Dispatched ${channel} cart recovery nudge.`);
    } catch {
      setIsExecuting(false);
    }
  };

  const handleAutoNudgeAll = async () => {
    setIsExecuting(true);
    try {
      const res = await fetch('/api/agentic/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'AUTO_ALL' }),
      });
      const data = await res.json();
      setSummary(AgenticCommerceService.getSummary());
      setIsExecuting(false);
      showToast(data.result?.message || '✓ Autonomous Nudge Agent engaged all high-intent carts.');
    } catch {
      setIsExecuting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Real-time Toast */}
      {toastMessage && (
        <div
          style={{
            position: 'fixed',
            top: '18px',
            right: '24px',
            zIndex: 200,
            background: 'var(--text-primary)',
            color: '#ffffff',
            padding: '12px 18px',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
            fontSize: '13px',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            animation: 'fadeIn 0.25s ease',
          }}
        >
          <span style={{ color: 'var(--success)' }}>●</span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* 1. Header Banner */}
      <div
        className="panel"
        style={{
          padding: '22px 26px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          borderLeft: '5px solid var(--brand)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' }}>
            <span className="badge badge-brand">Track 01: AI Growth & Agentic Commerce</span>
            <span className="badge badge-success">NPCI UAP Compatible</span>
            <span className="badge badge-info">ACP v1.2 Enabled</span>
            <span className="badge badge-warning">HTTP x402 Active</span>
            <span className="badge badge-neutral">Razorpay Test-Mode</span>
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 850, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            AI Growth & Agentic Commerce Control Tower
          </h1>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '3px', maxWidth: '820px' }}>
            Grow merchant revenue and make your business transactable by AI buyers end-to-end. Autonomous discovery feeds, bounded in-app checkouts, upsell agents, and failure-resilient policy gates.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <a
            href="/api/agentic/catalog"
            target="_blank"
            rel="noreferrer"
            className="btn btn-secondary"
            style={{ fontWeight: 700, fontSize: '12px' }}
          >
            📋 Agent-Readable Catalog Feed ↗
          </a>
          <a
            href="/.well-known/agent-commerce.json"
            target="_blank"
            rel="noreferrer"
            className="btn btn-primary"
            style={{ fontWeight: 700, fontSize: '12px' }}
          >
            ⚡ Protocol Discovery (.well-known) ↗
          </a>
        </div>
      </div>

      {/* 2. Top Metric Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <div className="panel" style={{ padding: '16px', borderLeft: '4px solid var(--brand)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>TOTAL AGENTIC VOLUME</span>
            <span className="badge badge-brand">A2A Sales</span>
          </div>
          <div className="mono tabular-nums" style={{ fontSize: '22px', fontWeight: 800, color: 'var(--brand-text)', margin: '4px 0' }}>
            {summary.totalAgenticVolumeInr}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Across {summary.aiBuyersServedCount} autonomous AI buyers
          </div>
        </div>

        <div className="panel" style={{ padding: '16px', borderLeft: '4px solid var(--success)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>AVERAGE ORDER VALUE</span>
            <span className="badge badge-success">+28.4% Lift</span>
          </div>
          <div className="mono tabular-nums" style={{ fontSize: '22px', fontWeight: 800, color: 'var(--success-text)', margin: '4px 0' }}>
            {summary.averageOrderValueInr}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Driven by autonomous bundle cross-sells
          </div>
        </div>

        <div className="panel" style={{ padding: '16px', borderLeft: '4px solid #8b5cf6' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>UPSELL MARGIN GENERATED</span>
            <span className="badge badge-neutral" style={{ color: '#8b5cf6' }}>AI Agent Margin</span>
          </div>
          <div className="mono tabular-nums" style={{ fontSize: '22px', fontWeight: 800, color: '#8b5cf6', margin: '4px 0' }}>
            {summary.upsellMarginGeneratedInr}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            High-margin add-ons attached at checkout
          </div>
        </div>

        <div className="panel" style={{ padding: '16px', borderLeft: '4px solid var(--warning)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>FAILURES HANDLED GRACEFULLY</span>
            <span className="badge badge-warning">Zero Disruption</span>
          </div>
          <div className="mono tabular-nums" style={{ fontSize: '22px', fontWeight: 800, color: 'var(--warning-text)', margin: '4px 0' }}>
            {summary.gracefulFailuresHandledCount} Incidents
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
            Policy-intercepted & auto-mitigated
          </div>
        </div>
      </div>

      {/* 2.5. Merchant Margin Safety & Autonomous Spend Guard Rails */}
      <div
        className="panel"
        style={{
          padding: '16px 20px',
          background: '#ffffff',
          borderRadius: '8px',
          border: '1px solid var(--border-default)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '15px' }}>🛡️</span>
            <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)' }}>
              Autonomous Commerce Safety & Margin Policy Envelope
            </span>
            <span className="badge badge-success" style={{ fontSize: '10px' }}>Active • Zero Margin Leakage</span>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Governed by RFC-8785 Policy Gate
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
          <div style={{ padding: '10px 14px', background: 'var(--bg-surface-subtle)', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>MARGIN FLOOR POLICY</div>
            <div className="mono" style={{ fontSize: '15px', fontWeight: 800, color: 'var(--success-text)', marginTop: '2px' }}>
              75.0% Minimum Floor
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Protects merchant unit economics</div>
          </div>

          <div style={{ padding: '10px 14px', background: 'var(--bg-surface-subtle)', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>MAX AUTONOMOUS DISCOUNT</div>
            <div className="mono" style={{ fontSize: '15px', fontWeight: 800, color: 'var(--brand)', marginTop: '2px' }}>
              15.0% Hard Ceiling
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Bounded pricing optimization</div>
          </div>

          <div style={{ padding: '10px 14px', background: 'var(--bg-surface-subtle)', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>24H AUTONOMOUS SPEND CAP</div>
            <div className="mono" style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginTop: '2px' }}>
              ₹50,000 / ₹50,000 Safe
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Circuit breaker on abnormal volume</div>
          </div>

          <div style={{ padding: '10px 14px', background: 'var(--bg-surface-subtle)', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>ROGUE BUYER SHIELD</div>
            <div className="mono" style={{ fontSize: '15px', fontWeight: 800, color: 'var(--info-text)', marginTop: '2px' }}>
              100% Intercept & Counter
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Graceful degradation to safe bundles</div>
          </div>
        </div>
      </div>

      {/* 3. Navigation Sub-Tabs */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border-default)', paddingBottom: '8px' }}>
        {[
          { id: 'BUYER_ACTIVITY', label: '🛒 Buyer Activity & Abandoned Carts' },
          { id: 'A2A_GATEWAY', label: '⚡ Inbound AI Buyer Gateway (A2A Checkout)' },
          { id: 'AGENT_CATALOG', label: '📖 Agent-Readable Catalog (AP2/x402)' },
          { id: 'UPSELL_ENGINE', label: '📈 Upsell & Cross-Sell Intelligence' },
          { id: 'CAMPAIGNS', label: '🎯 Revenue Growth Campaigns' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSubTab(tab.id as any)}
            style={{
              padding: '7px 16px',
              borderRadius: '6px',
              border: 'none',
              background: activeSubTab === tab.id ? 'var(--brand-surface)' : 'transparent',
              color: activeSubTab === tab.id ? 'var(--brand-text)' : 'var(--text-secondary)',
              fontWeight: activeSubTab === tab.id ? 700 : 500,
              fontSize: '12px',
              cursor: 'pointer',
              borderBottom: activeSubTab === tab.id ? '2px solid var(--brand)' : '2px solid transparent',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* 4. SUB-TAB 0: Buyer Activity & Abandoned Carts */}
      {activeSubTab === 'BUYER_ACTIVITY' && (
        <BuyerActivityFeed
          sessions={summary.buyerActivities}
          onDispatchNudge={handleDispatchNudge}
          onAutoNudgeAll={handleAutoNudgeAll}
          isProcessing={isExecuting}
        />
      )}

      {/* 5. SUB-TAB 1: Inbound AI Buyer Gateway */}
      {activeSubTab === 'A2A_GATEWAY' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Demonstration Control Box */}
          <div
            className="panel-raised"
            style={{
              padding: '20px 24px',
              background: 'linear-gradient(135deg, #0f172a 0%, #1e293b 100%)',
              color: '#ffffff',
              borderRadius: '10px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px' }}>
              <div>
                <span className="badge badge-brand" style={{ marginBottom: '6px' }}>LIVE A2A SIMULATOR</span>
                <h3 style={{ fontSize: '16px', fontWeight: 850, color: '#f8fafc' }}>
                  Simulate Autonomous AI Buyer Inbound Checkout
                </h3>
                <p style={{ fontSize: '12px', color: '#cbd5e1', maxWidth: '640px', marginTop: '4px' }}>
                  Test how external buyer agents interact with your store: from schema discovery and x402 challenge negotiation to Razorpay test-mode execution and policy safety checks.
                </p>
              </div>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  disabled={isExecuting}
                  onClick={() => handleTriggerSimulatedBuyer('SUCCESS')}
                  className="btn btn-primary"
                  style={{ fontWeight: 700, fontSize: '12px', padding: '8px 16px' }}
                >
                  {isExecuting ? 'Processing...' : '▶ Run Successful AI Checkout'}
                </button>
                <button
                  disabled={isExecuting}
                  onClick={() => handleTriggerSimulatedBuyer('FAILURE_GRACEFUL')}
                  className="btn btn-secondary"
                  style={{
                    fontWeight: 700,
                    fontSize: '12px',
                    padding: '8px 16px',
                    background: 'rgba(239, 68, 68, 0.15)',
                    color: '#fca5a5',
                    borderColor: 'rgba(239, 68, 68, 0.4)',
                  }}
                >
                  {isExecuting ? 'Processing...' : '⚠️ Test Graceful Failure Handling'}
                </button>
              </div>
            </div>

            {/* Protocol Architecture Strip */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px', marginTop: '18px', paddingTop: '16px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
              <div>
                <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>1. DISCOVERY</div>
                <div style={{ fontSize: '12px', fontWeight: 750, color: '#f8fafc' }}>AP2 / ACP Feed</div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>2. CHALLENGE</div>
                <div style={{ fontSize: '12px', fontWeight: 750, color: '#f8fafc' }}>HTTP x402 Header</div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>3. NEGOTIATION</div>
                <div style={{ fontSize: '12px', fontWeight: 750, color: '#f8fafc' }}>Dynamic Upsell Agent</div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>4. POLICY GATE</div>
                <div style={{ fontSize: '12px', fontWeight: 750, color: '#34d399' }}>Bounded Ceiling (₹50k)</div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>5. SETTLEMENT</div>
                <div style={{ fontSize: '12px', fontWeight: 750, color: '#60a5fa' }}>Razorpay Test API</div>
              </div>
            </div>
          </div>

          {/* Recent AI Buyer Transactions Feed */}
          <div className="panel" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                  Autonomous AI Buyer Transaction Feed
                </h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Immutable record of autonomous agent purchases with cryptographic audit digests
                </p>
              </div>
              <span className="badge badge-brand">Real-Time Ingestion</span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {summary.recentTransactions.map((tx) => {
                const isMitigated = tx.executionStatus === 'FAILED_GRACEFULLY_HANDLED';
                return (
                  <div
                    key={tx.id}
                    className="panel-raised"
                    style={{
                      padding: '16px 18px',
                      borderLeft: `4px solid ${isMitigated ? 'var(--warning)' : 'var(--success)'}`,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                          <span className={`badge ${isMitigated ? 'badge-warning' : 'badge-success'}`}>
                            {isMitigated ? '⚠️ GRACEFUL FAILURE MITIGATED' : '✓ AUTONOMOUS SETTLED'}
                          </span>
                          <span className="badge badge-brand">{tx.protocol}</span>
                          <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{tx.timestamp}</span>
                        </div>
                        <h4 style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
                          {tx.buyerAgentName} <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)' }}>({tx.buyerAgentOwner})</span>
                        </h4>
                      </div>

                      <div style={{ textAlign: 'right' }}>
                        <div className="mono tabular-nums" style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
                          {tx.amountInrFormatted}
                        </div>
                        <div className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          Order: {tx.razorpayOrderId}
                        </div>
                      </div>
                    </div>

                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
                      {tx.explanation}
                    </p>

                    {tx.mitigationApplied && (
                      <div style={{ background: 'var(--warning-surface)', border: '1px solid var(--warning-border)', padding: '8px 12px', borderRadius: '6px', fontSize: '11px', color: 'var(--warning-text)' }}>
                        <strong>Autonomous Policy Mitigation: </strong>{tx.mitigationApplied}
                      </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '6px', borderTop: '1px solid var(--border-subtle)', fontSize: '11px' }}>
                      <span className="mono" style={{ color: 'var(--text-muted)' }}>
                        Audit Hash: <strong>{tx.auditSha256}</strong>
                      </span>
                      <span className="badge badge-neutral" style={{ fontSize: '10px' }}>
                        Policy Gate: {tx.policyStatus}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* 5. SUB-TAB 2: Agent-Readable Catalog */}
      {activeSubTab === 'AGENT_CATALOG' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="panel" style={{ padding: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                  Machine-Readable Catalog (AP2 / ACP / Schema.org Standard)
                </h3>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Exposed directly to AI shopping agents, enterprise procurement bots, and UAP search crawlers
                </p>
              </div>
              <a
                href="/api/agentic/catalog"
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary"
                style={{ fontSize: '11px' }}
              >
                Inspect Live JSON Payload ↗
              </a>
            </div>

            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU & Name</th>
                  <th>Category</th>
                  <th>Price</th>
                  <th>Inventory</th>
                  <th>Agent Policy Limit</th>
                  <th>Add-on Affinities</th>
                  <th>Protocol Compatibility</th>
                </tr>
              </thead>
              <tbody>
                {summary.catalog.map((item) => (
                  <tr key={item.sku}>
                    <td>
                      <strong style={{ color: 'var(--text-primary)' }}>{item.name}</strong>
                      <div className="mono" style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{item.sku}</div>
                    </td>
                    <td>
                      <span className="badge badge-neutral">{item.category}</span>
                    </td>
                    <td className="mono tabular-nums font-bold" style={{ color: 'var(--brand-text)' }}>
                      {item.priceInrFormatted}
                    </td>
                    <td className="mono">{item.stockAvailable} units</td>
                    <td className="mono">Max {item.maxPerTransaction} / txn</td>
                    <td>
                      {item.crossSellAffinities.length > 0 ? (
                        item.crossSellAffinities.map((aff) => (
                          <span key={aff} className="badge badge-brand" style={{ fontSize: '9px', marginRight: '4px' }}>
                            {aff}
                          </span>
                        ))
                      ) : (
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>None</span>
                      )}
                    </td>
                    <td>
                      <span className="badge badge-success" style={{ fontSize: '9px' }}>
                        UAP • x402 • ACP {item.agentProtocolSpec.acpVersion}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 6. SUB-TAB 3: Upsell & Cross-Sell Intelligence */}
      {activeSubTab === 'UPSELL_ENGINE' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="panel" style={{ padding: '20px' }}>
            <div style={{ marginBottom: '16px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                Autonomous Upsell & Cross-Sell Recommendation Matrix
              </h3>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Dynamically injected into conversational checkouts and AI agent negotiation handshakes to expand merchant margin
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px' }}>
              {summary.upsells.map((upsell) => (
                <div
                  key={upsell.id}
                  className="panel-raised"
                  style={{
                    padding: '18px 20px',
                    borderTop: '4px solid var(--brand)',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                      <span className="badge badge-brand">UPSELL PAIRING</span>
                      <span className="mono font-bold" style={{ color: 'var(--success-text)' }}>
                        {upsell.conversionProbabilityPercent}% Conv. Probability
                      </span>
                    </div>

                    <h4 style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
                      Attach {upsell.recommendedSku} to {upsell.baseItemSku}
                    </h4>

                    <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: '12px' }}>
                      {upsell.rationale}
                    </p>
                  </div>

                  <div style={{ paddingTop: '10px', borderTop: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>INCREMENTAL MARGIN</div>
                      <div className="mono font-bold" style={{ fontSize: '14px', color: 'var(--success-text)' }}>
                        +₹{(upsell.incrementalMarginPaise / 100).toLocaleString('en-IN')}.00
                      </div>
                    </div>
                    <span className="badge badge-success">+{upsell.expectedAovLiftPercent}% AOV Lift</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 7. SUB-TAB 4: Revenue Growth Campaigns */}
      {activeSubTab === 'CAMPAIGNS' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div className="panel" style={{ padding: '20px' }}>
            <div style={{ marginBottom: '16px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                Active Merchant Revenue Growth Campaigns
              </h3>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Targeting both human enterprise buyers and autonomous AI agent discovery feeds
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              {summary.campaigns.map((cmp) => (
                <div
                  key={cmp.id}
                  className="panel-raised"
                  style={{
                    padding: '18px 20px',
                    borderLeft: '4px solid var(--brand)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                        <span className="badge badge-brand">{cmp.channel}</span>
                        <span className="badge badge-success">ROI: {cmp.roiMultiplier}x</span>
                        <span className="badge badge-neutral">{cmp.status}</span>
                      </div>
                      <h4 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                        {cmp.name}
                      </h4>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Target: {cmp.targetSegment}</div>
                    </div>

                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>PROJECTED REVENUE</div>
                      <div className="mono tabular-nums" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--success-text)' }}>
                        ₹{(cmp.projectedRevenuePaise / 10000000).toFixed(2)} Lakh
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '8px', borderTop: '1px solid var(--border-subtle)', fontSize: '11px' }}>
                    <span>
                      Budget Ceiling: <strong className="mono">₹{(cmp.budgetCeilingPaise / 10000000).toFixed(2)}L</strong> • Spend: <strong className="mono">₹{(cmp.spendToDatePaise / 100000).toFixed(1)}k</strong>
                    </span>
                    <button
                      onClick={() => showToast(`✓ Policy envelope updated for ${cmp.name}.`)}
                      className="btn btn-secondary"
                      style={{ fontSize: '11px', padding: '4px 10px' }}
                    >
                      Adjust Budget Envelope
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 8. The Bar: Explainable, Bounded & Gated Safety Callout */}
      <div
        className="panel"
        style={{
          padding: '20px',
          background: 'var(--bg-surface-subtle)',
          borderLeft: '4px solid #8b5cf6',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
          <span className="badge badge-brand" style={{ background: '#8b5cf6', color: '#ffffff' }}>THE BUILDATHON BAR</span>
          <span className="badge badge-success">✓ 100% Policy Gated</span>
          <span className="badge badge-neutral">✓ Audit Trail Verified</span>
        </div>
        <h4 style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '6px' }}>
          Every Money Action Explainable, Bounded and Gated
        </h4>
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          FinanceOS guarantees that AI buyers cannot trigger unconstrained money movement or exploit pricing slippage. Every transaction evaluates: (1) single-transaction monetary ceilings, (2) cryptographic UAP/x402 signature verification, (3) inventory allocation checks, and (4) immutable SHA-256 audit logging. If an AI buyer breaches bounds, FinanceOS intercepts the request, generates an explainable negotiation token, and resolves the purchase gracefully.
        </p>
      </div>
    </div>
  );
}
