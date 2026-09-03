'use client';

import React from 'react';
import type { WeatherRadarSummary } from '@/services/weather-radar-service';

interface RevenueDefenseActionCenterProps {
  telemetry: WeatherRadarSummary;
  onApplyIntervention: (actionId: string) => void;
  onInspectEvidence: (id: string) => void;
  onNavigateToDecisionLab: () => void;
}

export function RevenueDefenseActionCenter({
  telemetry,
  onApplyIntervention,
  onInspectEvidence,
  onNavigateToDecisionLab,
}: RevenueDefenseActionCenterProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Revenue Decay Forecast Panel */}
      <div className="panel" style={{ padding: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
          <div>
            <span className="badge badge-danger" style={{ marginBottom: '4px' }}>PREDICTIVE DECAY MODEL</span>
            <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
              What Happens If We Do Nothing? (Revenue Decay Timeline)
            </h3>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Demonstrating deterministic revenue loss erosion across time intervals if mitigation is delayed
            </p>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>EXPECTED LOSS BY WAITING 24H:</div>
            <div className="mono tabular-nums" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--danger-text)' }}>
              ₹6,56,000.00 Lost
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '10px' }}>
          {telemetry.activeLeaks[0]?.decayTimeline.map((item, idx) => (
            <div key={idx} style={{ padding: '12px', background: 'var(--bg-surface-subtle)', borderRadius: '6px', border: '1px solid var(--border-default)', textAlign: 'center' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700 }}>{item.timeLabel}</div>
              <div className="mono tabular-nums" style={{ fontSize: '15px', fontWeight: 800, color: item.decayLossInr > 200000 ? 'var(--danger-text)' : 'var(--text-primary)', margin: '4px 0' }}>
                ₹{(item.projectedRecoverableInr / 1000).toFixed(0)}k
              </div>
              <div style={{ fontSize: '10px', color: item.decayLossInr > 0 ? 'var(--danger-text)' : 'var(--success-text)' }}>
                {item.decayLossInr > 0 ? `-₹${(item.decayLossInr / 1000).toFixed(0)}k loss` : '100% Intact'}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Action Center Ranked List */}
      <div className="panel" style={{ padding: '20px' }}>
        <div style={{ marginBottom: '16px' }}>
          <h3 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
            What FinanceOS Wants To Do Now (Ranked Revenue Defense Actions)
          </h3>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            Ranked by Expected Net Gain × Urgency × Confidence ÷ Risk
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {telemetry.defenseActions.map((act) => (
            <div
              key={act.id}
              className="panel-raised"
              style={{
                padding: '18px 20px',
                borderLeft: `4px solid ${act.urgency === 'CRITICAL' ? 'var(--danger)' : 'var(--brand)'}`,
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span className="badge badge-brand">#{act.rank} DEFENSE ACTION</span>
                    <span className={`badge ${act.urgency === 'CRITICAL' ? 'badge-danger' : 'badge-warning'}`}>
                      {act.urgency}
                    </span>
                    <span className="badge badge-success">{act.confidencePercent}% Confidence</span>
                  </div>
                  <h4 style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>
                    {act.actionTitle}
                  </h4>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div className="mono tabular-nums" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--success-text)' }}>
                    Protect {act.protectedRevenueInr}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    Net EV: <strong className="mono">{act.expectedNetValueInr}</strong>
                  </div>
                </div>
              </div>

              <p style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                {act.actionSummary}
              </p>

              <div style={{ background: 'var(--bg-surface-subtle)', padding: '10px 12px', borderRadius: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
                <strong style={{ color: 'var(--text-primary)' }}>Why FinanceOS Chose This: </strong>{act.whyRationale}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '8px', borderTop: '1px solid var(--border-subtle)' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Risk: <strong style={{ color: 'var(--text-primary)' }}>{act.riskAssessment}</strong>
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={onNavigateToDecisionLab}
                    className="btn btn-secondary"
                    style={{ fontSize: '11px' }}
                  >
                    Simulate
                  </button>
                  <button
                    onClick={() => onInspectEvidence(act.evidenceChainId)}
                    className="btn btn-secondary"
                    style={{ fontSize: '11px' }}
                  >
                    View Proof ↗
                  </button>
                  <button
                    onClick={() => onApplyIntervention(act.id)}
                    className="btn btn-primary"
                    style={{ fontSize: '11px' }}
                  >
                    Execute Autonomous Defense
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* "Why Not?" Restraint Engine */}
      <div className="panel" style={{ padding: '20px', borderLeft: '4px solid var(--warning)' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 800, color: 'var(--warning-text)', marginBottom: '10px' }}>
          Why Not? (AI Restraint & Negative Selection Engine)
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
          <div style={{ padding: '12px', background: 'var(--bg-surface-subtle)', borderRadius: '6px' }}>
            <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>Why NOT retry immediately?</strong>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Gateway correlation is too high (+369% timeout spike). Immediate retries produce 85% duplicate failures.
            </p>
          </div>
          <div style={{ padding: '12px', background: 'var(--bg-surface-subtle)', borderRadius: '6px' }}>
            <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>Why NOT broadcast payment links?</strong>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Customer friction penalty is higher than waiting 10 minutes for silent background card retry.
            </p>
          </div>
          <div style={{ padding: '12px', background: 'var(--bg-surface-subtle)', borderRadius: '6px' }}>
            <strong style={{ fontSize: '12px', color: 'var(--text-primary)' }}>Why NOT contact customer directly?</strong>
            <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Customer value is below manual touch threshold; automated concierge sequence is 3.4x more cost effective.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
