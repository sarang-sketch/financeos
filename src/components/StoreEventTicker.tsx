'use client';

import React, { useState } from 'react';

export interface StoreEventItem {
  id: string;
  time: string;
  type: 'UAP_DISCOVERY' | 'CART_NUDGE' | 'RZP_PAYMENT' | 'AI_BUYER_ORDER' | 'POLICY_INTERCEPT';
  source: string;
  summary: string;
  amountInr?: string;
  badgeColor: string;
}

const INITIAL_EVENTS: StoreEventItem[] = [
  {
    id: 'evt_101',
    time: '16:04:12 IST',
    type: 'AI_BUYER_ORDER',
    source: 'AutoProcure-Bot (ACP/1.2)',
    summary: 'Autonomous checkout for 2,000,000 Tokens (Annual SLA)',
    amountInr: '₹13,000.00',
    badgeColor: 'badge-brand',
  },
  {
    id: 'evt_102',
    time: '16:02:40 IST',
    type: 'CART_NUDGE',
    source: 'Cart Nudge Dispatcher',
    summary: 'WhatsApp Razorpay link delivered to Aarav Sharma (+91 98201 44812)',
    amountInr: '₹24,000.00',
    badgeColor: 'badge-success',
  },
  {
    id: 'evt_103',
    time: '15:58:19 IST',
    type: 'UAP_DISCOVERY',
    source: 'Claude Procurement Agent',
    summary: 'Machine-readable catalog inspection via /.well-known/agent-commerce.json',
    badgeColor: 'badge-info',
  },
  {
    id: 'evt_104',
    time: '15:54:02 IST',
    type: 'POLICY_INTERCEPT',
    source: 'RFC-8785 Policy Gate',
    summary: 'Under-margin discount (25%) halted; auto-countered at 15% margin floor',
    badgeColor: 'badge-warning',
  },
  {
    id: 'evt_105',
    time: '15:49:33 IST',
    type: 'RZP_PAYMENT',
    source: 'Razorpay Webhook (Test-Mode)',
    summary: 'Payment captured: order_rzp_rec_9921 for Priya Patel',
    amountInr: '₹18,500.00',
    badgeColor: 'badge-success',
  },
];

const SIMULATED_STREAM: StoreEventItem[] = [
  {
    id: 'evt_new_1',
    time: 'Just now',
    type: 'AI_BUYER_ORDER',
    source: 'LangChain Autonomous Buyer',
    summary: 'Initiated AP2 voucher handshake for Batch Inference SKU',
    amountInr: '₹4,500.00',
    badgeColor: 'badge-brand',
  },
  {
    id: 'evt_new_2',
    time: 'Just now',
    type: 'RZP_PAYMENT',
    source: 'Razorpay Webhook (Test-Mode)',
    summary: 'Smart UPI QR scan completed for cart recovery #sess_cart_04',
    amountInr: '₹14,200.00',
    badgeColor: 'badge-success',
  },
  {
    id: 'evt_new_3',
    time: 'Just now',
    type: 'UAP_DISCOVERY',
    source: 'Perplexity Shopping Agent',
    summary: 'Queried machine-readable schema endpoint /api/agentic/catalog',
    badgeColor: 'badge-info',
  },
];

export function StoreEventTicker() {
  const [events, setEvents] = useState<StoreEventItem[]>(INITIAL_EVENTS);
  const [streamIndex, setStreamIndex] = useState<number>(0);
  const [isPulsing, setIsPulsing] = useState<boolean>(false);

  const handleSimulateEvent = () => {
    const template = SIMULATED_STREAM[streamIndex % SIMULATED_STREAM.length]!;
    const nextEvt: StoreEventItem = {
      id: `evt_sim_${Date.now()}`,
      time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST',
      type: template.type,
      source: template.source,
      summary: template.summary,
      amountInr: template.amountInr,
      badgeColor: template.badgeColor,
    };
    setEvents([nextEvt, ...events.slice(0, 5)]);
    setStreamIndex((prev) => prev + 1);
    setIsPulsing(true);
    setTimeout(() => setIsPulsing(false), 800);
  };

  return (
    <div className="panel" style={{ padding: '20px', background: '#ffffff', borderRadius: '8px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: isPulsing ? 'var(--brand)' : 'var(--success)' }} />
          <h3 style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>
            Real-Time Storefront & AI Buyer Webhook Ticker
          </h3>
          <span className="badge badge-neutral" style={{ fontSize: '10px' }}>
            Live Stream
          </span>
        </div>

        <button
          onClick={handleSimulateEvent}
          className="btn btn-secondary"
          style={{ fontSize: '11px', padding: '4px 10px', fontWeight: 700 }}
        >
          ⚡ Simulate Inbound Store Webhook
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {events.map((evt) => (
          <div
            key={evt.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '10px 14px',
              borderRadius: '6px',
              background: 'var(--bg-surface-subtle)',
              border: '1px solid var(--border-subtle)',
              fontSize: '12px',
              gap: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: '0' }}>
              <span className={`badge ${evt.badgeColor}`} style={{ fontSize: '10px', flexShrink: 0 }}>
                {evt.type}
              </span>
              <span style={{ fontWeight: 600, color: 'var(--text-primary)', flexShrink: 0 }}>
                {evt.source}:
              </span>
              <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {evt.summary}
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
              {evt.amountInr && (
                <span className="mono" style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                  {evt.amountInr}
                </span>
              )}
              <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {evt.time}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
