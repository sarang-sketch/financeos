'use client';

import React, { useState } from 'react';
import { RecoveryPassport } from '@/components/RecoveryPassport';
import { DigitalTwinService, type RecoveryDigitalTwin } from '@/services/digital-twin-service';
import { SEED_PAYMENT_FAILURES } from '@/services/seed-data-service';

interface DecisionLabViewProps {
  onInspectEvidence: (id: string) => void;
  onExecuteAction: (paymentId: string, actionLabel: string) => void;
}

export function DecisionLabView({ onInspectEvidence, onExecuteAction }: DecisionLabViewProps) {
  const [selectedPaymentId, setSelectedPaymentId] = useState<string>('pay_fail_901');
  const [activeGraphNodeId, setActiveGraphNodeId] = useState<string | null>('n6');

  const digitalTwin: RecoveryDigitalTwin = DigitalTwinService.createDigitalTwin(selectedPaymentId);
  const activeNode = digitalTwin.decisionGraph.find((n) => n.id === activeGraphNodeId) || digitalTwin.decisionGraph[5]!;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* 1. Header Banner & Payment Selector */}
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
            <span className="badge badge-brand">Recovery Decision Lab</span>
            <span className="badge badge-success">Digital Twin Active</span>
            <span
              className={`badge ${
                digitalTwin.failureClassification === 'SYSTEMIC_DEGRADATION' ? 'badge-warning' : 'badge-info'
              }`}
            >
              {digitalTwin.failureClassification}
            </span>
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: 'var(--text-primary)', letterSpacing: '-0.02em' }}>
            Counterfactual Simulation & Net-EV Optimizer
          </h1>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
            Simulates possible recovery futures before spending capital. Optimizes for Maximum Expected Net Recovered Value.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>Select Failed Payment:</span>
          <select
            value={selectedPaymentId}
            onChange={(e) => setSelectedPaymentId(e.target.value)}
            className="input-control"
            style={{ fontWeight: 600, width: '220px' }}
          >
            {SEED_PAYMENT_FAILURES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} (₹{(p.amount_paise / 100).toLocaleString('en-IN')})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 2. Digital Twin Context Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
        <div className="panel" style={{ padding: '14px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>FAILED AMOUNT</div>
          <div className="mono tabular-nums" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text-primary)', margin: '4px 0' }}>
            {digitalTwin.amountInrFormatted}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>Customer: <strong>{digitalTwin.customerName}</strong></div>
        </div>

        <div className="panel" style={{ padding: '14px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>ROOT CAUSE CODE</div>
          <div className="mono" style={{ fontSize: '13px', fontWeight: 700, color: 'var(--danger-text)', margin: '4px 0' }}>
            {digitalTwin.errorCode}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>{digitalTwin.failureReason}</div>
        </div>

        <div className="panel" style={{ padding: '14px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>GATEWAY HEALTH</div>
          <div style={{ fontSize: '13px', fontWeight: 700, color: digitalTwin.gatewayNodeHealth === 'OPTIMAL' ? 'var(--success-text)' : 'var(--warning-text)', margin: '4px 0' }}>
            ● {digitalTwin.gatewayNodeHealth}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>HDFC Node (+340% latency spike)</div>
        </div>

        <div className="panel" style={{ padding: '14px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>OPTIMAL ACTION</div>
          <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--brand-text)', margin: '4px 0' }}>
            {digitalTwin.optimalAction.label}
          </div>
          <div className="mono" style={{ fontSize: '11px', color: 'var(--success-text)', fontWeight: 700 }}>
            Net EV: ₹{(digitalTwin.optimalAction.netExpectedPaise / 100).toLocaleString('en-IN')}.00
          </div>
        </div>
      </div>

      {/* 3. Optimal Recommendation Banner */}
      <div
        className="panel-raised"
        style={{
          padding: '18px 22px',
          borderLeft: '5px solid var(--brand)',
          background: 'var(--brand-surface)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '14px',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="badge badge-brand">AI Recommendation</span>
            <span className="badge badge-success">{digitalTwin.optimalAction.probabilityPercent}% Probability</span>
            <span className="badge badge-info">ETA: {digitalTwin.optimalAction.timeToRecoveryEta}</span>
            <span className="badge badge-neutral">Action Passport Enforced</span>
          </div>
          <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--brand-text)', marginTop: '6px' }}>
            {digitalTwin.optimalAction.label}
          </h2>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '3px', maxWidth: '780px' }}>
            {digitalTwin.optimalAction.policyReason}
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Expected Net Recovery</div>
            <div className="mono tabular-nums" style={{ fontSize: '20px', fontWeight: 800, color: 'var(--success-text)' }}>
              ₹{(digitalTwin.optimalAction.netExpectedPaise / 100).toLocaleString('en-IN')}.00
            </div>
          </div>
          <button
            onClick={() => onExecuteAction(digitalTwin.paymentId, digitalTwin.optimalAction.label)}
            className="btn btn-primary"
            style={{ padding: '8px 16px', fontSize: '13px' }}
          >
            Authorize & Schedule →
          </button>
        </div>
      </div>

      <RecoveryPassport digitalTwin={digitalTwin} onInspectEvidence={onInspectEvidence} />

      {/* 4. Counterfactual 7-Futures Simulation Grid */}
      <div className="panel" style={{ padding: '20px' }}>
        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
            Simulated Counterfactual Futures (7 Candidate Actions Evaluated)
          </h3>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Calculates Gross Expected Value minus Gateway Fees, Customer Friction, and Risk Penalties
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '14px' }}>
          {digitalTwin.simulatedActions.map((act) => (
            <div
              key={act.actionType}
              className="card-interactive"
              style={{
                padding: '16px',
                border: act.isOptimal ? '2px solid var(--brand)' : '1px solid var(--border-default)',
                background: act.isOptimal ? 'var(--brand-surface)' : '#ffffff',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                  <span
                    className={`badge ${
                      act.isOptimal
                        ? 'badge-brand'
                        : act.policyStatus === 'DELAYED'
                        ? 'badge-warning'
                        : act.policyStatus === 'BLOCKED'
                        ? 'badge-danger'
                        : 'badge-neutral'
                    }`}
                  >
                    {act.isOptimal ? '★ BEST ACTION' : act.channel}
                  </span>
                  <span className="mono font-bold" style={{ fontSize: '13px', color: 'var(--text-primary)' }}>
                    {act.probabilityPercent}% Prob
                  </span>
                </div>

                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>
                  {act.label}
                </div>

                <div style={{ background: '#ffffff', padding: '10px', borderRadius: '6px', border: '1px solid var(--border-subtle)', marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
                    <span>Gross Recovery:</span>
                    <span className="mono">₹{(act.grossExpectedPaise / 100).toFixed(0)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--danger-text)' }}>
                    <span>- Gateway Cost:</span>
                    <span className="mono">₹{(act.gatewayCostPaise / 100).toFixed(0)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--warning-text)' }}>
                    <span>- Friction Penalty:</span>
                    <span className="mono">₹{(act.frictionCostPaise / 100).toFixed(0)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
                    <span>- Risk Penalty:</span>
                    <span className="mono">₹{(act.riskPenaltyPaise / 100).toFixed(0)}</span>
                  </div>
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '8px', borderTop: '1px solid var(--border-subtle)' }}>
                  <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>EXPECTED NET:</span>
                  <span className="mono tabular-nums" style={{ fontSize: '15px', fontWeight: 800, color: act.isOptimal ? 'var(--brand-text)' : 'var(--text-primary)' }}>
                    ₹{(act.netExpectedPaise / 100).toLocaleString('en-IN')}.00
                  </span>
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  ETA: {act.timeToRecoveryEta} • Friction: {act.frictionLevel}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 5. "Why This Action & Why Not the Alternatives?" */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        <div className="panel" style={{ padding: '20px', borderLeft: '4px solid var(--success)' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 800, color: 'var(--success-text)', marginBottom: '8px' }}>
            ✓ Why {digitalTwin.optimalAction.label}?
          </h3>
          <ul style={{ paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            {digitalTwin.comparativeReasoning.whySelectedAction.map((reason, idx) => (
              <li key={idx}>{reason}</li>
            ))}
          </ul>
        </div>

        <div className="panel" style={{ padding: '20px', borderLeft: '4px solid var(--warning)' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 800, color: 'var(--warning-text)', marginBottom: '8px' }}>
            ✕ Why Not the Alternatives?
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {digitalTwin.comparativeReasoning.whyNotAlternatives.map((alt, idx) => (
              <div key={idx} style={{ background: 'var(--bg-surface-subtle)', padding: '10px', borderRadius: '6px' }}>
                <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>{alt.actionLabel}</strong>
                <ul style={{ paddingLeft: '16px', marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                  {alt.reasons.map((r, rIdx) => (
                    <li key={rIdx}>{r}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 6. Recovery Timing Intelligence & Recovery Value Clock */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Timing Curve */}
        <div className="panel" style={{ padding: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)' }}>
                Recovery Timing Intelligence
              </h3>
              <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                Probability & Net Expected Value over wait duration
              </p>
            </div>
            <span className="badge badge-brand">Optimal: +10 Mins</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {digitalTwin.temporalCurve.map((point) => (
              <div
                key={point.timeOffsetLabel}
                style={{
                  padding: '8px 12px',
                  background: point.isOptimalTiming ? 'var(--brand-surface)' : 'var(--bg-surface-subtle)',
                  border: `1px solid ${point.isOptimalTiming ? 'var(--brand-border)' : 'var(--border-default)'}`,
                  borderRadius: '6px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="mono font-bold" style={{ fontSize: '12px', color: point.isOptimalTiming ? 'var(--brand-text)' : 'var(--text-primary)' }}>
                    {point.timeOffsetLabel}
                  </span>
                  {point.isOptimalTiming && <span className="badge badge-success" style={{ fontSize: '9px' }}>PEAK CONVERSION</span>}
                </div>
                <div style={{ display: 'flex', gap: '16px', fontSize: '11px' }}>
                  <span className="mono" style={{ color: 'var(--text-muted)' }}>
                    Prob: <strong>{point.probabilityPercent}%</strong>
                  </span>
                  <span className="mono font-bold" style={{ color: point.isOptimalTiming ? 'var(--success-text)' : 'var(--text-primary)' }}>
                    Net: ₹{point.expectedNetInr.toFixed(0)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Value Clock Decay */}
        <div className="panel" style={{ padding: '20px' }}>
          <h3 style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
            Recovery Value Clock (Revenue Time Decay)
          </h3>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px' }}>
            Demonstrating time-dependent recoverable value erosion
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {digitalTwin.valueDecayTimeline.map((item, idx) => (
              <div key={idx} style={{ padding: '10px 12px', background: 'var(--bg-surface-subtle)', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
                  <strong style={{ color: 'var(--text-primary)' }}>{item.timeLabel}</strong>
                  <span className="mono tabular-nums font-bold" style={{ color: item.decayPercent > 30 ? 'var(--danger-text)' : 'var(--success-text)' }}>
                    ₹{item.expectedRecoverableInr.toLocaleString('en-IN')}.00
                  </span>
                </div>
                <div style={{ height: '6px', background: 'var(--border-default)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${Math.max(10, 100 - item.decayPercent)}%`,
                      height: '100%',
                      background: item.decayPercent > 30 ? 'var(--danger)' : 'var(--brand)',
                      borderRadius: '3px',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 7. Interactive Decision Graph */}
      <div className="panel" style={{ padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <div>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
              Autonomous Decision Graph Pipeline
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Click any lifecycle node to inspect mathematical derivation, policy gate checks, and audit hashes
            </p>
          </div>
          <button onClick={() => onInspectEvidence('chain_901')} className="btn btn-secondary" style={{ fontSize: '11px' }}>
            Full Cryptographic Replay ↗
          </button>
        </div>

        {/* Node strip */}
        <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '10px' }}>
          {digitalTwin.decisionGraph.map((node, i) => {
            const isSelected = activeGraphNodeId === node.id;
            return (
              <div
                key={node.id}
                onClick={() => setActiveGraphNodeId(node.id)}
                style={{
                  minWidth: '150px',
                  padding: '10px 12px',
                  borderRadius: '6px',
                  background: isSelected ? 'var(--brand-surface)' : 'var(--bg-surface-subtle)',
                  border: `1px solid ${isSelected ? 'var(--brand)' : 'var(--border-default)'}`,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>
                  <span>Node 0{i + 1}</span>
                  <span style={{ color: node.status === 'COMPLETED' ? 'var(--success)' : 'var(--brand)' }}>●</span>
                </div>
                <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                  {node.title}
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>{node.category}</div>
              </div>
            );
          })}
        </div>

        {/* Active Node Detail Inspector */}
        <div style={{ marginTop: '12px', padding: '14px', background: 'var(--bg-surface-subtle)', borderRadius: '6px', border: '1px solid var(--border-default)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <strong style={{ fontSize: '13px', color: 'var(--text-primary)' }}>{activeNode.title} ({activeNode.category})</strong>
            <span className="badge badge-brand">{activeNode.status}</span>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{activeNode.details}</p>
        </div>
      </div>
    </div>
  );
}
