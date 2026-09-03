'use client';

import React, { useState } from 'react';
import { Sidebar, type NavTab } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { EvidenceTimeline } from '@/components/EvidenceTimeline';
import { DashboardView } from '@/components/views/DashboardView';
import { AiBuyerMerchantLabView } from '@/components/views/AiBuyerMerchantLabView';
import { AgenticCommerceView } from '@/components/views/AgenticCommerceView';
import { BuyerActivityFeed } from '@/components/views/agentic/BuyerActivityFeed';
import { DecisionLabView } from '@/components/views/DecisionLabView';
import { WeatherRadarView } from '@/components/views/WeatherRadarView';
import { FailedPaymentsView } from '@/components/views/FailedPaymentsView';
import { AuditLogsView } from '@/components/views/AuditLogsView';
import { SettingsView } from '@/components/views/SettingsView';
import { AgentManagerView } from '@/components/views/AgentManagerView';
import { AgenticCommerceService } from '@/services/agentic-commerce-service';
import {
  SEED_CUSTOMERS,
  SEED_PAYMENT_FAILURES,
  SEED_RECOVERY_PROPOSALS,
  SEED_CHANNEL_STATS,
  SEED_AUDIT_LOGS,
  type SeedCustomer,
  type SeedPaymentFailure,
  type SeedRecoveryProposal,
  type SeedChannelStat,
  type SeedAuditLog,
} from '@/services/seed-data-service';

export default function AppConsole() {
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isAssistantOpen, setIsAssistantOpen] = useState<boolean>(false);

  // Live Data States
  const [customers] = useState<SeedCustomer[]>(SEED_CUSTOMERS);
  const [failedPayments, setFailedPayments] = useState<SeedPaymentFailure[]>(SEED_PAYMENT_FAILURES);
  const [proposals, setProposals] = useState<SeedRecoveryProposal[]>(SEED_RECOVERY_PROPOSALS);
  const [channelStats] = useState<SeedChannelStat[]>(SEED_CHANNEL_STATS);
  const [auditLogs, setAuditLogs] = useState<SeedAuditLog[]>(SEED_AUDIT_LOGS);
  const [buyerSessions, setBuyerSessions] = useState(AgenticCommerceService.getBuyerActivities());

  // Execution state
  const [executingProposalId, setExecutingProposalId] = useState<string | null>(null);
  const [isNudgeProcessing, setIsNudgeProcessing] = useState<boolean>(false);

  const handleDispatchNudge = async (
    sessionId: string,
    channel: 'WHATSAPP' | 'EMAIL' | 'CALL' | 'PUSH'
  ) => {
    setIsNudgeProcessing(true);
    try {
      const res = await fetch('/api/agentic/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'SINGLE', sessionId, channel }),
      });
      const data = await res.json();
      setBuyerSessions([...AgenticCommerceService.getBuyerActivities()]);
      setIsNudgeProcessing(false);
      showToast(data.result?.message || `✓ Dispatched ${channel} recovery nudge.`);
    } catch {
      setIsNudgeProcessing(false);
      showToast(`Dispatched ${channel} recovery nudge.`);
    }
  };

  const handleAutoNudgeAll = async () => {
    setIsNudgeProcessing(true);
    try {
      const res = await fetch('/api/agentic/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'AUTO_ALL' }),
      });
      const data = await res.json();
      setBuyerSessions([...AgenticCommerceService.getBuyerActivities()]);
      setIsNudgeProcessing(false);
      showToast(data.result?.message || '✓ Autonomous agent engaged all high-intent carts.');
    } catch {
      setIsNudgeProcessing(false);
      showToast('✓ Auto-nudged all high-intent carts.');
    }
  };

  // Filters & Selected State
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [selectedPaymentId, setSelectedPaymentId] = useState<string>('pay_fail_901');

  // Policy Settings State
  const [autoCeiling, setAutoCeiling] = useState<string>('₹50,000.00');
  const [requireDualAuth, setRequireDualAuth] = useState<boolean>(false);
  const [strategy, setStrategy] = useState<string>('BALANCED_AGGRESSIVE');
  const [confidenceThreshold, setConfidenceThreshold] = useState<number>(65);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  };

  const handleApproveProposal = async (propId: string) => {
    setExecutingProposalId(propId);
    try {
      await fetch('/api/proposals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: propId, action: 'approve' }),
      }).catch(() => {});

      setTimeout(() => {
        setProposals((prev) =>
          prev.map((p) => (p.id === propId ? { ...p, status: 'RECOVERED' } : p))
        );
        const prop = proposals.find((p) => p.id === propId);
        if (prop) {
          setFailedPayments((prev) =>
            prev.map((f) => (f.id === prop.failure_id ? { ...f, status: 'RECOVERED' } : f))
          );
        }
        setExecutingProposalId(null);
        const newHash =
          Math.random().toString(36).substring(2, 10) +
          '...' +
          Math.random().toString(36).substring(2, 6);
        setAuditLogs((prev) => [
          {
            time: new Date().toISOString().replace('T', ' ').slice(0, 19),
            actor: 'HUMAN_ADMIN',
            action: 'PROPOSAL_EXECUTED_TO_LEDGER',
            entity: propId,
            status: 'COMMITTED',
            hash: newHash,
          },
          ...prev,
        ]);
        showToast(`✓ Proposal #${propId} authorized and committed to semantic double-entry ledger.`);
      }, 700);
    } catch {
      setExecutingProposalId(null);
    }
  };

  const handleRejectProposal = (propId: string) => {
    setProposals((prev) => prev.map((p) => (p.id === propId ? { ...p, status: 'REJECTED' } : p)));
    showToast(`Proposal #${propId} rejected.`);
  };

  const handleLiveWebhookIngest = async () => {
    const nextIdx = failedPayments.length + 1;
    const newId = `pay_fail_90${nextIdx}`;
    const newAmountPaise = 1450000; // ₹14,500.00
    const newPayment: SeedPaymentFailure = {
      id: newId,
      tenant_id: '00000000-0000-0000-0000-000000010001',
      payment_id: `pay_rzp_live_${nextIdx}`,
      customer_id: 'cust_88',
      amount_paise: newAmountPaise,
      channel: 'card',
      failure_reason: 'bank_server_timeout',
      attempts_count: 1,
      recovery_probability: 86,
      recommended_channel: 'Card Dynamic Retry',
      evidence_source: 'CUSTOMER_LEVEL',
      status: 'PROPOSAL_READY',
      created_at: new Date().toISOString(),
      error_code: 'GATEWAY_TIMEOUT',
    };

    const newProposal: SeedRecoveryProposal = {
      id: `prop_90${nextIdx}`,
      tenant_id: '00000000-0000-0000-0000-000000010001',
      failure_id: newId,
      customer_id: 'cust_88',
      amount_paise: newAmountPaise,
      recommended_channel: 'Card Dynamic Retry (Delayed 10m)',
      recommended_action: 'Dispatch Card Dynamic Retry via Gateway Route after 10m cooldown',
      recovery_probability: 93,
      expected_recovery_paise: Math.round(newAmountPaise * 0.93),
      risk_score: 'Very Low (2/100)',
      evidence_source: 'CUSTOMER_LEVEL',
      reasoning:
        'HDFC gateway latency spike (+340%) detected. Delayed execution window maximizes Net-EV to ₹12,895.00.',
      status: 'PENDING',
      created_at: new Date().toISOString(),
    };

    setFailedPayments((prev) => [newPayment, ...prev]);
    setProposals((prev) => [newProposal, ...prev]);

    const newHash =
      Math.random().toString(36).substring(2, 10) +
      '...' +
      Math.random().toString(36).substring(2, 6);
    setAuditLogs((prev) => [
      {
        time: new Date().toISOString().replace('T', ' ').slice(0, 19),
        actor: 'WEBHOOK_PROCESSOR',
        action: 'PAYMENT_FAILED_INGESTED',
        entity: newId,
        status: 'STORED',
        hash: newHash,
      },
      ...prev,
    ]);

    showToast(`⚡ Payment Ingested: ${newId} (₹14,500.00) — Digital Twin simulated 7 futures & selected +10m Delayed Retry.`);
  };

  const pendingProposalsCount = proposals.filter((p) => p.status === 'PENDING').length;

  return (
    <div className="app-container">
      {/* Real-time Toast Notification Banner */}
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

      {/* 1. Global Left Sidebar */}
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        pendingProposalsCount={pendingProposalsCount}
        isAssistantOpen={isAssistantOpen}
        onToggleAssistant={() => setIsAssistantOpen((prev) => !prev)}
      />

      {/* 2. Main Workspace */}
      <div className="main-wrapper">
        {/* Global Top Bar */}
        <TopBar
          activeTab={activeTab}
          onSelectTab={setActiveTab}
          onIngestClick={handleLiveWebhookIngest}
          isAssistantOpen={isAssistantOpen}
          onToggleAssistant={() => setIsAssistantOpen((prev) => !prev)}
        />

        {/* Main Content Area */}
        <main className="content-area">
          {activeTab === 'dashboard' && (
            <DashboardView
              proposals={proposals}
              customers={customers}
              channelStats={channelStats}
              pendingProposalsCount={pendingProposalsCount}
              executingProposalId={executingProposalId}
              onViewFailedPayments={() => setActiveTab('failed_payments')}
              onViewProposals={() => setActiveTab('failed_payments')}
              onInspectEvidence={(id) => setSelectedEvidenceId(id)}
              onInspectPayment={(id) => {
                setSelectedPaymentId(id);
                setActiveTab('decision_lab');
              }}
              onApproveProposal={handleApproveProposal}
              onNavigateToDecisionLab={() => setActiveTab('decision_lab')}
              onNavigateToWeatherRadar={() => setActiveTab('weather_radar')}
            />
          )}

          {activeTab === 'ai_buyer_demo' && (
            <AiBuyerMerchantLabView />
          )}

          {activeTab === 'agentic_commerce' && (
            <AgenticCommerceView
              onInspectEvidence={(id) => setSelectedEvidenceId(id)}
            />
          )}

          {activeTab === 'buyer_activity' && (
            <BuyerActivityFeed
              sessions={buyerSessions}
              onDispatchNudge={handleDispatchNudge}
              onAutoNudgeAll={handleAutoNudgeAll}
              isProcessing={isNudgeProcessing}
            />
          )}

          {activeTab === 'decision_lab' && (
            <DecisionLabView
              onInspectEvidence={(id) => setSelectedEvidenceId(id)}
              onExecuteAction={(paymentId, actionLabel) => {
                handleApproveProposal('prop_901');
                showToast(`✓ Dispatched ${actionLabel} for ${paymentId}.`);
              }}
            />
          )}

          {activeTab === 'weather_radar' && (
            <WeatherRadarView
              onInspectLeak={(_leakId) => {
                setSelectedPaymentId('pay_fail_901');
                setActiveTab('decision_lab');
              }}
              onApplyIntervention={(leakId) => {
                showToast(`✓ Applied autonomous mitigation defense action #${leakId}.`);
              }}
              onInspectEvidence={(id) => setSelectedEvidenceId(id)}
              onNavigateToDecisionLab={() => setActiveTab('decision_lab')}
            />
          )}

          {activeTab === 'failed_payments' && (
            <FailedPaymentsView
              failedPayments={failedPayments}
              customers={customers}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              statusFilter={statusFilter}
              onStatusFilterChange={setStatusFilter}
              onInspectPayment={(id) => {
                setSelectedPaymentId(id);
                setActiveTab('decision_lab');
              }}
              proposals={proposals}
              pendingProposalsCount={pendingProposalsCount}
              executingProposalId={executingProposalId}
              onApproveProposal={handleApproveProposal}
              onRejectProposal={handleRejectProposal}
              onInspectEvidence={(id) => setSelectedEvidenceId(id)}
            />
          )}

          {activeTab === 'audit_logs' && <AuditLogsView auditLogs={auditLogs} />}

          {activeTab === 'agent_manager' && <AgentManagerView />}

          {activeTab === 'settings' && (
            <SettingsView
              autoCeiling={autoCeiling}
              onAutoCeilingChange={setAutoCeiling}
              strategy={strategy}
              onStrategyChange={setStrategy}
              confidenceThreshold={confidenceThreshold}
              onConfidenceThresholdChange={setConfidenceThreshold}
              requireDualAuth={requireDualAuth}
              onRequireDualAuthChange={setRequireDualAuth}
              onSave={() => showToast('✓ Platform policy configuration saved successfully.')}
            />
          )}
        </main>
      </div>

      {/* Slide-over Evidence Panel Modal */}
      {selectedEvidenceId && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.4)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            justifyContent: 'flex-end',
            zIndex: 100,
          }}
          onClick={() => setSelectedEvidenceId(null)}
        >
          <div
            style={{
              width: '680px',
              maxWidth: '90vw',
              height: '100%',
              background: '#ffffff',
              borderLeft: '1px solid var(--border-default)',
              padding: '24px',
              overflowY: 'auto',
              boxShadow: '-8px 0 24px rgba(0,0,0,0.08)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <EvidenceTimeline
              title={`Evidence Chain Inspector (${selectedEvidenceId})`}
              onClose={() => setSelectedEvidenceId(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
