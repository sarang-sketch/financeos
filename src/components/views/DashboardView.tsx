'use client';

import React from 'react';
import { MetricCard } from '@/components/MetricCard';
import { RecoveryChart } from '@/components/RecoveryChart';
import { StoreEventTicker } from '@/components/StoreEventTicker';
import type { SeedCustomer, SeedRecoveryProposal, SeedChannelStat } from '@/services/seed-data-service';

interface DashboardViewProps {
  proposals: SeedRecoveryProposal[];
  customers: SeedCustomer[];
  channelStats: SeedChannelStat[];
  pendingProposalsCount: number;
  executingProposalId: string | null;
  onViewFailedPayments: () => void;
  onViewProposals: () => void;
  onOpenChat?: () => void;
  onInspectEvidence: (id: string) => void;
  onInspectPayment: (failureId: string) => void;
  onApproveProposal: (id: string) => void;
  onNavigateToDecisionLab: () => void;
  onNavigateToWeatherRadar: () => void;
}

export function DashboardView({
  proposals,
  customers,
  channelStats,
  pendingProposalsCount,
  executingProposalId,
  onViewFailedPayments,
  onViewProposals,
  onOpenChat: _onOpenChat,
  onInspectEvidence,
  onInspectPayment,
  onApproveProposal,
  onNavigateToDecisionLab,
  onNavigateToWeatherRadar,
}: DashboardViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Executive Header Banner */}
      <div
        className="panel"
        style={{
          padding: '20px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '16px',
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span className="badge badge-brand">AI Growth & Agentic Commerce</span>
            <span className="badge badge-success">Razorpay Test-Mode Live</span>
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Merchant Revenue Growth & Agentic Commerce Overview
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Grow merchant revenue and make your business sellable to AI buyers end-to-end on Razorpay test-mode APIs.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={onNavigateToDecisionLab} className="btn btn-primary" style={{ fontWeight: 700 }}>
            🔬 Open Decision Lab →
          </button>
        </div>
      </div>

      {/* Top 4 Primary Financial KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
        <MetricCard
          label="Total Ingested Volume"
          value="₹86.4 Lakh"
          secondaryValue="4,821 Captured Payments"
          trend="14.2% MoM"
          trendDirection="up"
          status="info"
          evidenceChainId="chain_rev_30d"
          onViewEvidence={onInspectEvidence}
        />
        <MetricCard
          label="Revenue at Risk"
          value="₹14.65 Lakh"
          secondaryValue="3 Active Leak Patterns"
          trend="3.1% this week"
          trendDirection="down"
          status="danger"
          evidenceChainId="chain_weather"
          onViewEvidence={onInspectEvidence}
        />
        <MetricCard
          label="AI Recovery Rate"
          value="78.4%"
          secondaryValue="392 Recovered / 500 Attempts"
          trend="+25.7% vs baseline"
          trendDirection="up"
          status="success"
          evidenceChainId="chain_recovery_rate"
          onViewEvidence={onInspectEvidence}
        />
        <MetricCard
          label="Net Recovered Revenue"
          value="₹33.5 Lakh"
          secondaryValue="₹33,54,200.00 Net Inflow"
          trend="₹5.2L this month"
          trendDirection="up"
          status="success"
          evidenceChainId="chain_recovered_inr"
          onViewEvidence={onInspectEvidence}
        />
      </div>

      {/* Executive Decision Impact & Weather Strip */}
      <div
        className="panel"
        style={{
          padding: '16px 20px',
          background: 'var(--bg-surface-subtle)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '14px',
          borderLeft: '4px solid var(--brand)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>AI DECISION IMPACT:</div>
            <strong style={{ fontSize: '13px', color: 'var(--brand-text)' }}>342 Unnecessary Retries Prevented</strong>
          </div>
          <div style={{ height: '24px', width: '1px', background: 'var(--border-default)' }} />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>GATEWAY FEES SAVED:</div>
            <strong className="mono" style={{ fontSize: '13px', color: 'var(--success-text)' }}>₹14,364.00 Saved</strong>
          </div>
          <div style={{ height: '24px', width: '1px', background: 'var(--border-default)' }} />
          <div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>SYSTEMIC WEATHER:</div>
            <span className="badge badge-warning">HDFC Latency Spike (+340%)</span>
          </div>
        </div>

        <button onClick={onNavigateToWeatherRadar} className="btn btn-secondary" style={{ fontSize: '11px' }}>
          View Failure Weather Radar ↗
        </button>
      </div>

      {/* Visualizations: SVG Chart + Channel Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '20px' }}>
        <RecoveryChart />

        <div className="panel" style={{ padding: '20px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
            Recovery by Channel
          </h3>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px' }}>
            Success rates across 70/30 blended models
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {channelStats.map((ch) => (
              <div
                key={ch.id}
                style={{
                  padding: '10px 12px',
                  background: 'var(--bg-surface-subtle)',
                  borderRadius: '6px',
                  border: '1px solid var(--border-default)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontSize: '12px' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{ch.channel}</strong>
                  <span className="mono tabular-nums" style={{ color: 'var(--success-text)', fontWeight: 700 }}>
                    {ch.success_rate}% success
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
                  <span>{ch.total_attempts} attempts</span>
                  <span className="mono font-semibold">₹{(ch.recovered_paise / 10000000).toFixed(1)}L recovered</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Real-Time Storefront & AI Buyer Webhook Ticker */}
      <StoreEventTicker />

      {/* High-Confidence Recovery Opportunities */}
      <div className="panel" style={{ padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="badge badge-brand">Recovery Proposals</span>
              <h2 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                Net-EV Optimized Recovery Opportunities
              </h2>
            </div>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              Simulated across 7 futures • Maximizing Net Recovered Cash after fees & friction
            </p>
          </div>
          <button onClick={onViewProposals} className="btn btn-secondary" style={{ fontSize: '11px' }}>
            View All Proposals ({pendingProposalsCount} Pending) →
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px' }}>
          {proposals.slice(0, 3).map((opp) => {
            const isApproved = opp.status === 'RECOVERED';
            const isExecuting = executingProposalId === opp.id;
            const cust = customers.find((c) => c.id === opp.customer_id);

            return (
              <div
                key={opp.id}
                className="card-interactive"
                style={{
                  padding: '16px',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                  borderLeft: `4px solid ${isApproved ? 'var(--success)' : 'var(--brand)'}`,
                }}
              >
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '6px' }}>
                    <div>
                      <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                        {opp.failure_id}
                      </span>
                      <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                        {cust?.name || opp.customer_id}
                      </div>
                    </div>
                    <div className="mono tabular-nums" style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
                      ₹{(opp.amount_paise / 100).toLocaleString('en-IN')}.00
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', margin: '8px 0' }}>
                    <span className="badge badge-brand">{opp.recommended_channel}</span>
                    <span className="badge badge-success">{opp.recovery_probability}% Probability</span>
                    <span
                      className={`badge ${
                        opp.evidence_source === 'CUSTOMER_LEVEL' ? 'badge-info' : 'badge-warning'
                      }`}
                      style={{ fontSize: '9px' }}
                    >
                      {opp.evidence_source}
                    </span>
                  </div>

                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.45, margin: '8px 0' }}>
                    {opp.reasoning}
                  </p>
                </div>

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: '12px',
                    paddingTop: '10px',
                    borderTop: '1px solid var(--border-subtle)',
                  }}
                >
                  <div className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    Net EV:{' '}
                    <strong style={{ color: 'var(--success-text)' }}>
                      ₹{(opp.expected_recovery_paise / 100).toLocaleString('en-IN')}.00
                    </strong>
                  </div>

                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      onClick={() => onInspectPayment(opp.failure_id)}
                      className="btn btn-secondary"
                      style={{ fontSize: '11px', padding: '4px 8px' }}
                    >
                      Simulate ↗
                    </button>
                    <button
                      disabled={isApproved || isExecuting}
                      onClick={() => onApproveProposal(opp.id)}
                      className="btn btn-primary"
                      style={{
                        fontSize: '11px',
                        padding: '4px 10px',
                        background: isApproved ? 'var(--success)' : undefined,
                      }}
                    >
                      {isExecuting ? 'Executing...' : isApproved ? '✓ Recovered' : 'Authorize Retry'}
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
