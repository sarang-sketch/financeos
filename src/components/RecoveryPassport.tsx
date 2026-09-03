'use client';

import React, { useMemo, useState } from 'react';
import {
  compileRecoveryPassport,
  evaluateRecoveryPassport,
  type RecoveryPassportObservation,
} from '@/services/recovery-passport';
import type { RecoveryDigitalTwin } from '@/services/digital-twin-service';

interface RecoveryPassportProps {
  digitalTwin: RecoveryDigitalTwin;
  onInspectEvidence: (id: string) => void;
}

function inr(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

const simulations: ReadonlyArray<{ label: string; observation: RecoveryPassportObservation }> = [
  {
    label: 'T+3m · gateway degraded',
    observation: { minutesSinceFailure: 3, paymentRecovered: false, attemptsUsed: 2, routeHealth: 'DEGRADED' },
  },
  {
    label: 'T+10m · route healthy',
    observation: { minutesSinceFailure: 10, paymentRecovered: false, attemptsUsed: 2, routeHealth: 'HEALTHY' },
  },
  {
    label: 'Late success webhook',
    observation: { minutesSinceFailure: 10, paymentRecovered: true, attemptsUsed: 2, routeHealth: 'HEALTHY' },
  },
  {
    label: 'T+31m · stale evidence',
    observation: { minutesSinceFailure: 31, paymentRecovered: false, attemptsUsed: 2, routeHealth: 'HEALTHY' },
  },
];

export function RecoveryPassport({ digitalTwin, onInspectEvidence }: RecoveryPassportProps) {
  const passport = useMemo(() => compileRecoveryPassport(digitalTwin), [digitalTwin]);
  const [simulationIndex, setSimulationIndex] = useState(0);
  const simulation = simulations[simulationIndex]!;
  const result = evaluateRecoveryPassport(passport, simulation.observation);
  const tone = result.decision === 'EXECUTE' ? 'var(--success)' : result.decision === 'WAIT' ? 'var(--warning)' : 'var(--danger)';

  return (
    <section className="panel" style={{ padding: 20, borderTop: '4px solid #8b5cf6' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', gap: 7, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="badge badge-brand">ACTION PASSPORT</span>
            <span className="badge badge-neutral">EXECUTION SAFEGUARDS</span>
          </div>
          <h2 style={{ color: 'var(--text-primary)', fontSize: 16, fontWeight: 850, marginTop: 8 }}>
            The action must obey this contract—even when the AI is confident.
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: 1.5, marginTop: 4, maxWidth: 750 }}>
            Before FinanceOS creates a recovery schedule, it compiles the selected payment's counterfactual into an inspectable action contract. It records what may happen, when it must wait, and every condition that permanently cancels the action.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{passport.id}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 10, maxWidth: 245, marginTop: 4 }}>{passport.dataDisclosure}</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, margin: '16px 0' }}>
        <PassportMetric label="Approved intervention" value={passport.action.label} detail={`${passport.action.probabilityPercent}% recovery probability`} tone="var(--success)" />
        <PassportMetric label="Counterfactual rejected" value="Immediate card retry" detail={`Costs ${inr(passport.expectedNetAdvantagePaise)} in expected net value`} tone="var(--danger)" />
        <PassportMetric label="Retry budget" value={`${passport.maxAttempts - passport.attemptsUsed} action left`} detail={`${passport.attemptsUsed}/${passport.maxAttempts} attempts already used`} tone="var(--warning)" />
        <PassportMetric label="Evidence validity" value={`T+${passport.expiresAfterMinutes}m`} detail="Must be re-evaluated after expiry" tone="#8b5cf6" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(290px, 0.78fr)', gap: 16 }}>
        <div style={{ border: '1px solid var(--border-default)', borderRadius: 9, padding: 14 }}>
          <div style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: 13, marginBottom: 8 }}>Non-negotiable stopping rules for this recovery</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
            {passport.rules.map((rule, index) => (
              <div key={rule.id} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr)', gap: 8 }}>
                <span style={{ color: '#8b5cf6', fontWeight: 850, fontSize: 11 }}>{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 750, color: 'var(--text-primary)' }}>{rule.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.35 }}>{rule.enforcement}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ borderRadius: 9, padding: 14, background: 'var(--bg-surface-subtle)', border: `1px solid ${tone}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
            <div style={{ color: 'var(--text-primary)', fontWeight: 800, fontSize: 13 }}>Action eligibility inspector</div>
            <span className="badge" style={{ background: `${tone}18`, color: tone, borderColor: `${tone}55` }}>{result.decision}</span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0' }}>
            {simulations.map((candidate, index) => (
              <button
                key={candidate.label}
                onClick={() => setSimulationIndex(index)}
                className="btn btn-secondary"
                style={{ padding: '4px 7px', fontSize: 10, borderColor: simulationIndex === index ? tone : undefined, fontWeight: simulationIndex === index ? 750 : 500 }}
              >
                {candidate.label}
              </button>
            ))}
          </div>
          <div style={{ background: '#ffffff', borderRadius: 7, padding: 10 }}>
            <div style={{ color: tone, fontSize: 12, fontWeight: 850 }}>{result.title}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 11, lineHeight: 1.4, marginTop: 4 }}>{result.detail}</div>
            <div className="mono" style={{ color: 'var(--text-muted)', fontSize: 10, marginTop: 8 }}>{result.auditEvent}</div>
          </div>
          <button className="btn btn-secondary" onClick={() => onInspectEvidence('chain_recovery_passport')} style={{ width: '100%', marginTop: 10, fontSize: 11 }}>
            Inspect action evidence →
          </button>
        </div>
      </div>
    </section>
  );
}

function PassportMetric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return (
    <div style={{ border: '1px solid var(--border-default)', borderTop: `3px solid ${tone}`, borderRadius: 8, padding: '10px 11px', background: '#ffffff' }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 800 }}>{label}</div>
      <div style={{ color: 'var(--text-primary)', fontSize: 12, fontWeight: 800, marginTop: 5 }}>{value}</div>
      <div style={{ color: 'var(--text-secondary)', fontSize: 10, marginTop: 3, lineHeight: 1.3 }}>{detail}</div>
    </div>
  );
}
