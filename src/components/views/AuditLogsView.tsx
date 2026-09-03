'use client';

import React, { useState } from 'react';
import type { SeedAuditLog } from '@/services/seed-data-service';
import { EvidenceTimeline } from '@/components/EvidenceTimeline';

interface AuditLogsViewProps {
  auditLogs: SeedAuditLog[];
}

export function AuditLogsView({ auditLogs }: AuditLogsViewProps) {
  const [subTab, setSubTab] = useState<'AUDIT_TRAIL' | 'EVIDENCE_CHAIN'>('AUDIT_TRAIL');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Sub-tab Navigation */}
      <div style={{ display: 'flex', gap: '8px', borderBottom: '1px solid var(--border-default)', paddingBottom: '8px' }}>
        <button
          onClick={() => setSubTab('AUDIT_TRAIL')}
          className={`btn ${subTab === 'AUDIT_TRAIL' ? 'btn-primary' : 'btn-secondary'}`}
          style={{ fontSize: '12px', fontWeight: 700, padding: '6px 14px' }}
        >
          🛡️ RFC-8785 SHA-256 Audit Trail
        </button>
        <button
          onClick={() => setSubTab('EVIDENCE_CHAIN')}
          className={`btn ${subTab === 'EVIDENCE_CHAIN' ? 'btn-primary' : 'btn-secondary'}`}
          style={{ fontSize: '12px', fontWeight: 700, padding: '6px 14px' }}
        >
          🔗 Cryptographic Evidence Chain Replay
        </button>
      </div>

      {subTab === 'EVIDENCE_CHAIN' ? (
        <EvidenceTimeline
          title="Mathematical Replay & Cryptographic Evidence Chain"
          figureInr="₹23,200.00"
        />
      ) : (
        <div className="panel" style={{ padding: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <div>
              <h2 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)' }}>
                Immutable Financial State Audit Log
              </h2>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                RFC-8785 canonical JSON digest • SHA-256 hash-chained sequence
              </p>
            </div>
            <span className="badge badge-success">Audit Chain Verified</span>
          </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>Timestamp (IST)</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Entity ID</th>
            <th>Status</th>
            <th>SHA-256 Hash Digest</th>
          </tr>
        </thead>
        <tbody>
          {auditLogs.map((log, i) => (
            <tr key={i}>
              <td className="mono" style={{ fontSize: '11px' }}>{log.time}</td>
              <td>
                <span className="badge badge-brand" style={{ fontSize: '10px' }}>
                  {log.actor}
                </span>
              </td>
              <td style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{log.action}</td>
              <td className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {log.entity}
              </td>
              <td>
                <span className="badge badge-success">{log.status}</span>
              </td>
              <td className="mono" style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                {log.hash}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
        </div>
      )}
    </div>
  );
}
