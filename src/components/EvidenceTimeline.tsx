'use client';

import React from 'react';

export interface TimelineNode {
  step: number;
  stage: string;
  source: 'CUSTOMER_LEVEL' | 'TENANT_LEVEL' | 'SYSTEM' | 'POLICY';
  operation: string;
  input: string;
  output: string;
  timestamp: string;
}

interface EvidenceTimelineProps {
  nodes?: TimelineNode[];
  onClose?: () => void;
  title?: string;
  figureInr?: string;
}

export function EvidenceTimeline({
  nodes,
  onClose,
  title = 'Settlement Difference Decomposition #SET-9281',
  figureInr = '₹23,200.00',
}: EvidenceTimelineProps) {
  const defaultNodes: TimelineNode[] = [
    {
      step: 1,
      stage: 'PAYMENT_INGESTION',
      source: 'SYSTEM',
      operation: 'fetch_razorpay_payments(setl_9281)',
      input: '4,821 captured payments across 73 settlement batches',
      output: 'Total Gross Captured: ₹8,42,600.00',
      timestamp: '2026-08-30 09:15:02 IST',
    },
    {
      step: 2,
      stage: 'BANK_CREDIT_COMPARISON',
      source: 'SYSTEM',
      operation: 'read_bank_credit_deposit()',
      input: 'HDFC Bank Account ending in 9012',
      output: 'Net Payout Received: ₹8,19,400.00',
      timestamp: '2026-08-30 09:15:04 IST',
    },
    {
      step: 3,
      stage: 'DIFFERENCE_CALCULATION',
      source: 'SYSTEM',
      operation: 'subtract(Expected ₹8,42,600, Received ₹8,19,400)',
      input: 'Operand 1: 84260000 paise, Operand 2: 81940000 paise',
      output: 'Difference: ₹23,200.00 (2320000 paise)',
      timestamp: '2026-08-30 09:15:05 IST',
    },
    {
      step: 4,
      stage: 'MDR_FEE_EXTRACTION',
      source: 'TENANT_LEVEL',
      operation: 'sum_fee_breakdown_lines()',
      input: 'Razorpay payment gateway MDR tier (2.0% standard + international)',
      output: 'Gateway Fee: ₹19,661.00',
      timestamp: '2026-08-30 09:15:05 IST',
    },
    {
      step: 5,
      stage: 'GST_ON_MDR_VERIFICATION',
      source: 'TENANT_LEVEL',
      operation: 'apply_gst_rate(18% on ₹19,661.00)',
      input: 'SAC 997159 (Payment Gateway Services)',
      output: 'GST on Fee: ₹3,539.00 (1800 basis points)',
      timestamp: '2026-08-30 09:15:06 IST',
    },
    {
      step: 6,
      stage: 'THREE_WAY_DECOMPOSITION',
      source: 'POLICY',
      operation: 'subtract(Difference ₹23,200, Fee ₹19,661 + GST ₹3,539)',
      input: '2320000n - (1966100n + 353900n)',
      output: 'Unexplained Residual: ₹0.00 (EXACT ZERO PAISA PROOF)',
      timestamp: '2026-08-30 09:15:07 IST',
    },
    {
      step: 7,
      stage: 'POLICY_GATE_EVALUATION',
      source: 'POLICY',
      operation: 'evaluate_dual_authorization_policy()',
      input: 'Reconciliation adjustment proposal #prop_9281',
      output: 'Decision: SAFE_AUTO (Risk Score: 4/100, Balanced Double-Entry)',
      timestamp: '2026-08-30 09:15:08 IST',
    },
  ];

  const displayNodes = nodes || defaultNodes;

  return (
    <div className="panel-raised" style={{ padding: '24px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', paddingBottom: '14px', borderBottom: '1px solid var(--border-default)' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span className="badge badge-brand">Audit Proof</span>
            <h3 style={{ fontSize: '16px', fontWeight: 700, color: 'var(--text-primary)' }}>{title}</h3>
          </div>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Cryptographically replayed through independent interpreter • Strict 0-float integer paise arithmetic
          </p>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div className="mono tabular-nums" style={{ fontSize: '18px', fontWeight: 800, color: 'var(--brand)' }}>
            {figureInr}
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="btn btn-secondary"
              style={{ fontSize: '11px', padding: '3px 8px', marginTop: '4px' }}
            >
              Close Inspector ✕
            </button>
          )}
        </div>
      </div>

      {/* 10-Node Timeline List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', position: 'relative' }}>
        {displayNodes.map((node) => (
          <div
            key={node.step}
            className="card-interactive"
            style={{
              padding: '12px 16px',
              display: 'grid',
              gridTemplateColumns: '36px 180px 1fr 1fr',
              gap: '14px',
              alignItems: 'center',
              fontSize: '12px',
            }}
          >
            {/* Step Number */}
            <div
              style={{
                width: '26px',
                height: '26px',
                borderRadius: '50%',
                background: 'var(--brand-surface)',
                border: '1px solid var(--brand-border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 700,
                color: 'var(--brand-text)',
                fontSize: '11px',
              }}
            >
              {node.step}
            </div>

            {/* Stage & Source Badge */}
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px' }}>{node.stage}</div>
              <span
                className={`badge ${
                  node.source === 'CUSTOMER_LEVEL'
                    ? 'badge-brand'
                    : node.source === 'TENANT_LEVEL'
                    ? 'badge-warning'
                    : 'badge-info'
                }`}
                style={{ fontSize: '9px', padding: '1px 5px' }}
              >
                {node.source}
              </span>
            </div>

            {/* Operation & Inputs */}
            <div>
              <div className="mono" style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '11px' }}>
                {node.operation}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {node.input}
              </div>
            </div>

            {/* Output & Verified Time */}
            <div style={{ textAlign: 'right' }}>
              <div className="mono" style={{ color: 'var(--success-text)', fontWeight: 700, fontSize: '12px' }}>
                {node.output}
              </div>
              <div className="mono" style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {node.timestamp}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
