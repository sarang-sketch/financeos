'use client';

import React, { useState } from 'react';
import { COMPLIANCE_DISCLAIMER } from '@/agents/compliance/agent';

export interface FindingUI {
  readonly id: string;
  readonly category: string;
  readonly impact_inr: string;
  readonly direction: string;
  readonly detail: Record<string, unknown>;
  readonly source_records: readonly { type: string; id: string }[];
}

export interface TdsItemUI {
  readonly payment_id: string;
  readonly payment_amount_inr: string;
  readonly matched_category: string;
  readonly configured_rate_percent: string;
  readonly tds_amount_inr: string;
}

export interface ComplianceProps {
  readonly findings?: readonly FindingUI[];
  readonly tdsItems?: readonly TdsItemUI[];
  readonly itcExpectedInr?: string;
  readonly itcRecordedInr?: string;
  readonly itcDiscrepancyInr?: string;
}

export function ComplianceFindings({
  findings = [],
  tdsItems = [],
  itcExpectedInr = '₹0.00',
  itcRecordedInr = '₹0.00',
  itcDiscrepancyInr = '₹0.00',
}: ComplianceProps) {
  const [activeTab, setActiveTab] = useState<'findings' | 'tds' | 'itc'>('findings');

  const categoryLabels: Record<string, string> = {
    missing_gst_information: 'Missing GST Information',
    invalid_gstin: 'Invalid GSTIN',
    gst_anomaly: 'GST Rate Anomaly',
    record_needing_review: 'Record Needing Review',
    unmatched_credit_note: 'Unmatched Credit Note',
    itc_discrepancy: 'ITC Discrepancy',
  };

  return (
    <div className="space-y-6">
      {/* Mandatory Statutory Review-Only Disclaimer (Requirement 6.8, 6.9) */}
      <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
        <div className="p-2 rounded-lg bg-amber-500/20 text-amber-400">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <div>
          <div className="font-semibold text-amber-300 text-sm">Regulatory Notice</div>
          <div className="text-xs text-amber-200/90 mt-0.5">{COMPLIANCE_DISCLAIMER}</div>
        </div>
      </div>

      {/* Top summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-5 rounded-2xl bg-zinc-900/80 border border-zinc-800 backdrop-blur-sm">
          <div className="text-xs text-zinc-400 font-medium">Compliance Exceptions</div>
          <div className="text-2xl font-bold text-zinc-100 mt-2">{findings.length}</div>
          <div className="text-xs text-zinc-500 mt-1">Open tax discrepancies flagged</div>
        </div>

        <div className="p-5 rounded-2xl bg-zinc-900/80 border border-zinc-800 backdrop-blur-sm">
          <div className="text-xs text-zinc-400 font-medium">TDS Review Items</div>
          <div className="text-2xl font-bold text-indigo-400 mt-2">{tdsItems.length}</div>
          <div className="text-xs text-zinc-500 mt-1">Vendor withholdings pending review</div>
        </div>

        <div className="p-5 rounded-2xl bg-zinc-900/80 border border-zinc-800 backdrop-blur-sm">
          <div className="text-xs text-zinc-400 font-medium">ITC Discrepancy</div>
          <div className="text-2xl font-bold text-amber-400 mt-2">{itcDiscrepancyInr}</div>
          <div className="text-xs text-zinc-500 mt-1">Expected vs Recorded ITC</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-zinc-800 gap-6">
        <button
          onClick={() => setActiveTab('findings')}
          className={`pb-3 text-sm font-medium transition-colors relative ${
            activeTab === 'findings' ? 'text-indigo-400 border-b-2 border-indigo-500' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Detection Findings ({findings.length})
        </button>
        <button
          onClick={() => setActiveTab('tds')}
          className={`pb-3 text-sm font-medium transition-colors relative ${
            activeTab === 'tds' ? 'text-indigo-400 border-b-2 border-indigo-500' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          TDS Withholding Reviews ({tdsItems.length})
        </button>
        <button
          onClick={() => setActiveTab('itc')}
          className={`pb-3 text-sm font-medium transition-colors relative ${
            activeTab === 'itc' ? 'text-indigo-400 border-b-2 border-indigo-500' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          ITC Reconciliation
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'findings' && (
        <div className="space-y-3">
          {findings.length === 0 ? (
            <div className="p-8 text-center rounded-2xl bg-zinc-900/40 border border-zinc-800/80 text-zinc-400">
              No open compliance exceptions detected in this period.
            </div>
          ) : (
            findings.map((f) => (
              <div key={f.id} className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="px-2.5 py-1 rounded-md text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                      {categoryLabels[f.category] ?? f.category}
                    </span>
                    <span className="text-xs text-zinc-500">ID: {f.id.slice(0, 8)}</span>
                  </div>
                  <div className="text-xs text-zinc-400 mt-2">
                    Sources: {f.source_records.map((s) => `${s.type}:${s.id}`).join(', ')}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-zinc-400">Impact</div>
                  <div className="text-lg font-bold text-zinc-100 font-mono">{f.impact_inr}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'tds' && (
        <div className="space-y-3">
          {tdsItems.length === 0 ? (
            <div className="p-8 text-center rounded-2xl bg-zinc-900/40 border border-zinc-800/80 text-zinc-400">
              No TDS review items identified in this date range.
            </div>
          ) : (
            tdsItems.map((t) => (
              <div key={t.payment_id} className="p-4 rounded-xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-zinc-200">Category: {t.matched_category}</div>
                  <div className="text-xs text-zinc-400 mt-0.5">
                    Payment ID: <span className="font-mono">{t.payment_id}</span> ({t.payment_amount_inr}) • Rate: {t.configured_rate_percent}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-zinc-400">TDS Amount</div>
                  <div className="text-base font-bold text-indigo-400 font-mono">{t.tds_amount_inr}</div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'itc' && (
        <div className="p-6 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-4">
          <h3 className="text-sm font-semibold text-zinc-200">Input Tax Credit (ITC) Reconciliation Breakdown</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
              <div className="text-xs text-zinc-400">Expected ITC (Inward Invoices + Fee GST)</div>
              <div className="text-xl font-bold text-zinc-100 font-mono mt-1">{itcExpectedInr}</div>
            </div>
            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
              <div className="text-xs text-zinc-400">Recorded ITC (Ledger Input Accounts)</div>
              <div className="text-xl font-bold text-zinc-100 font-mono mt-1">{itcRecordedInr}</div>
            </div>
            <div className="p-4 rounded-xl bg-zinc-950/60 border border-zinc-800/60">
              <div className="text-xs text-zinc-400">Discrepancy (Expected - Recorded)</div>
              <div className="text-xl font-bold text-amber-400 font-mono mt-1">{itcDiscrepancyInr}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
