'use client';

import React, { useState } from 'react';

/* -------------------------------------------------------------------------- */
/*  Future Scope — Agent Manager Mode                                         */
/*  This is a roadmap / vision page, NOT live functionality.                  */
/* -------------------------------------------------------------------------- */

interface ConnectorCard {
  id: string;
  name: string;
  icon: string;
  status: 'COMING_SOON' | 'BETA' | 'PLANNED';
  description: string;
  features: string[];
  eta: string;
}

const CONNECTORS: ConnectorCard[] = [
  {
    id: 'shopify',
    name: 'Shopify',
    icon: '🛍️',
    status: 'COMING_SOON',
    description: 'Connect your Shopify store. Auto-sync products, orders, inventory & abandoned carts into FinanceOS.',
    features: [
      'Real-time order webhook sync',
      'Product catalog mirror (bi-directional)',
      'Abandoned cart → AI recovery pipeline',
      'Shopify Payments ↔ Razorpay reconciliation',
      'Multi-store management from one dashboard',
    ],
    eta: 'Q1 2027',
  },
  {
    id: 'instagram',
    name: 'Instagram Shopping',
    icon: '📸',
    status: 'PLANNED',
    description: 'Turn your Instagram into an AI-powered storefront. Auto-generate shoppable posts from your catalog.',
    features: [
      'AI-generated product posts & reels captions',
      'Shoppable tag automation via Graph API',
      'DM-based AI buyer agent (chat commerce)',
      'Influencer campaign ROI tracking',
      'Story → Checkout conversion analytics',
    ],
    eta: 'Q2 2027',
  },
  {
    id: 'telegram',
    name: 'Telegram Bot Commerce',
    icon: '✈️',
    status: 'PLANNED',
    description: 'Deploy an AI shopping bot on Telegram. Buyers browse, negotiate, and pay without leaving the chat.',
    features: [
      'Inline catalog browsing with keyboard menus',
      'AI negotiation agent (haggle & upsell)',
      'UPI / Razorpay payment links in-chat',
      'Group-buy & flash sale broadcasting',
      'Order status & shipment tracking bot',
    ],
    eta: 'Q2 2027',
  },
  {
    id: 'whatsapp_business',
    name: 'WhatsApp Business API',
    icon: '💬',
    status: 'COMING_SOON',
    description: 'Full WhatsApp Business API integration. AI-powered catalog, payment collection, and recovery nudges.',
    features: [
      'Interactive product catalog messages',
      'Automated abandoned cart recovery flows',
      'Payment link generation & UPI QR sharing',
      'AI customer support with handoff to human',
      'Broadcast campaigns with read-rate analytics',
    ],
    eta: 'Q1 2027',
  },
  {
    id: 'woocommerce',
    name: 'WooCommerce',
    icon: '🔌',
    status: 'PLANNED',
    description: 'WordPress + WooCommerce plugin for FinanceOS. One-click install to sync your entire store.',
    features: [
      'REST API auto-discovery & sync',
      'Product variant & attribute mapping',
      'Coupon & discount rule engine sync',
      'WooCommerce Payments reconciliation',
      'WordPress admin panel widget',
    ],
    eta: 'Q3 2027',
  },
  {
    id: 'amazon_sp',
    name: 'Amazon Seller Central',
    icon: '📦',
    status: 'PLANNED',
    description: 'Pull your Amazon SP-API data into FinanceOS for unified multi-marketplace analytics.',
    features: [
      'FBA & FBM order aggregation',
      'Buy Box monitoring & repricing signals',
      'A+ Content performance analytics',
      'Returns & refund reconciliation',
      'Unified P&L across Amazon + D2C',
    ],
    eta: 'Q3 2027',
  },
];

interface AgentRunner {
  id: string;
  name: string;
  type: string;
  icon: string;
  description: string;
  capabilities: string[];
}

const AGENT_RUNNERS: AgentRunner[] = [
  {
    id: 'buyer_agent',
    name: 'AI Buyer Agent',
    type: 'Autonomous Buyer',
    icon: '🤖',
    description: 'Deploys on any connected channel. Understands natural language purchase intent, matches products, negotiates offers, and completes checkout autonomously.',
    capabilities: ['Intent extraction (Gemini)', 'Product matching', 'Price negotiation', 'Checkout completion', 'Upsell attachment'],
  },
  {
    id: 'recovery_agent',
    name: 'Cart Recovery Agent',
    type: 'Recovery Specialist',
    icon: '🛒',
    description: 'Monitors all connected storefronts for abandoned carts. Auto-dispatches recovery nudges via WhatsApp, Email, SMS, or Push with AI-optimized timing.',
    capabilities: ['Cart drop detection', 'Intent scoring', 'Multi-channel nudge', 'Debounce policies', 'A/B test messaging'],
  },
  {
    id: 'content_agent',
    name: 'Content & Post Generator',
    type: 'Creative Agent',
    icon: '🎨',
    description: 'Generates product descriptions, social media posts, Instagram captions, and ad copy from your catalog using Gemini API.',
    capabilities: ['Product description writing', 'Instagram caption generation', 'Ad copy (Google/Meta)', 'SEO meta tag generation', 'Multi-language support'],
  },
  {
    id: 'finance_agent',
    name: 'Treasury & Wallet Agent',
    type: 'Finance Manager',
    icon: '💰',
    description: 'Each agent has its own wallet with spending limits. The Treasury Agent monitors balances, auto-tops-up from merchant funds, and generates P&L reports per agent.',
    capabilities: ['Per-agent wallet ledger', 'Auto top-up rules', 'Spend ceiling enforcement', 'Real-time P&L per agent', 'Cross-agent fund transfer'],
  },
  {
    id: 'analytics_agent',
    name: 'Revenue Intelligence Agent',
    type: 'Analytics',
    icon: '📊',
    description: 'Aggregates data across all connected platforms. Generates unified dashboards, forecasts revenue, and recommends growth strategies.',
    capabilities: ['Multi-platform aggregation', 'Revenue forecasting', 'Anomaly detection', 'Strategy recommendations', 'Monte Carlo simulations'],
  },
  {
    id: 'compliance_agent',
    name: 'Compliance & Audit Agent',
    type: 'Governance',
    icon: '🛡️',
    description: 'Ensures every agent action is recorded with a tamper-evident SHA-256 audit trail. Flags policy violations and generates compliance reports.',
    capabilities: ['SHA-256 audit chain', 'Policy violation alerts', 'RBI/SEBI compliance checks', 'Export-ready audit reports', 'Real-time governance dashboard'],
  },
];

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string; label: string }> = {
  COMING_SOON: { bg: 'rgba(251, 191, 36, 0.12)', text: '#d97706', border: 'rgba(251, 191, 36, 0.3)', label: 'Coming Soon' },
  BETA: { bg: 'rgba(34, 197, 94, 0.12)', text: '#16a34a', border: 'rgba(34, 197, 94, 0.3)', label: 'Beta' },
  PLANNED: { bg: 'rgba(99, 102, 241, 0.12)', text: '#6366f1', border: 'rgba(99, 102, 241, 0.3)', label: 'Planned' },
};

export function AgentManagerView() {
  const [activeSection, setActiveSection] = useState<'connectors' | 'agents' | 'wallets' | 'content'>('connectors');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      {/* Hero Banner */}
      <div
        className="panel-raised"
        style={{
          padding: '28px 32px',
          background: 'linear-gradient(135deg, #0f172a 0%, #1e1b4b 50%, #312e81 100%)',
          color: '#ffffff',
          borderRadius: '12px',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div style={{
          position: 'absolute',
          top: '-40px',
          right: '-20px',
          fontSize: '140px',
          opacity: 0.06,
          transform: 'rotate(-12deg)',
          pointerEvents: 'none',
        }}>
          🚀
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
          <span className="badge badge-warning" style={{ fontSize: '10px', fontWeight: 800 }}>FUTURE SCOPE</span>
          <span className="badge badge-brand" style={{ fontSize: '10px', fontWeight: 700 }}>ROADMAP 2027</span>
        </div>
        <h2 style={{ fontSize: '22px', fontWeight: 900, letterSpacing: '-0.02em', margin: '0 0 6px 0' }}>
          🤖 Agent Manager Mode
        </h2>
        <p style={{ fontSize: '14px', color: '#cbd5e1', maxWidth: '720px', lineHeight: 1.6, margin: 0 }}>
          The next evolution of FinanceOS. Deploy autonomous AI agents across every sales channel —
          Shopify, Instagram, Telegram, WhatsApp. Each agent has its own wallet, its own P&L,
          and generates content, closes sales, and recovers revenue <strong>completely autonomously</strong>.
        </p>
        <div style={{ display: 'flex', gap: '12px', marginTop: '16px', flexWrap: 'wrap' }}>
          <div style={{ padding: '8px 14px', borderRadius: '8px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', fontSize: '12px' }}>
            <span style={{ fontWeight: 800, color: '#fbbf24' }}>6</span> <span style={{ color: '#94a3b8' }}>Platform Connectors</span>
          </div>
          <div style={{ padding: '8px 14px', borderRadius: '8px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', fontSize: '12px' }}>
            <span style={{ fontWeight: 800, color: '#34d399' }}>6</span> <span style={{ color: '#94a3b8' }}>Agent Types</span>
          </div>
          <div style={{ padding: '8px 14px', borderRadius: '8px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', fontSize: '12px' }}>
            <span style={{ fontWeight: 800, color: '#818cf8' }}>∞</span> <span style={{ color: '#94a3b8' }}>Agent Wallets with Auto-Ledger</span>
          </div>
          <div style={{ padding: '8px 14px', borderRadius: '8px', background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.12)', fontSize: '12px' }}>
            <span style={{ fontWeight: 800, color: '#f472b6' }}>API</span> <span style={{ color: '#94a3b8' }}>Gemini-Powered Post Generation</span>
          </div>
        </div>
      </div>

      {/* Section Tabs */}
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        {([
          { id: 'connectors' as const, label: '🔗 Platform Connectors', count: CONNECTORS.length },
          { id: 'agents' as const, label: '🤖 Agent Runners', count: AGENT_RUNNERS.length },
          { id: 'wallets' as const, label: '💰 Agent Wallets & P&L', count: null },
          { id: 'content' as const, label: '🎨 AI Content Generation', count: null },
        ]).map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSection(tab.id)}
            className={activeSection === tab.id ? 'btn btn-primary' : 'btn btn-secondary'}
            style={{ fontSize: '12px', fontWeight: 700, padding: '8px 16px', gap: '6px' }}
          >
            {tab.label}
            {tab.count !== null && (
              <span className="badge badge-neutral" style={{ fontSize: '10px', marginLeft: '6px' }}>{tab.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* --- SECTION: Connectors --- */}
      {activeSection === 'connectors' && (
        <div>
          <div style={{ marginBottom: '16px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px 0' }}>
              Platform Connectors
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              Connect your storefronts. Every connector auto-syncs products, orders, and buyer activity into FinanceOS for unified AI-powered commerce.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '16px' }}>
            {CONNECTORS.map((c) => {
              const statusStyle = STATUS_COLORS[c.status] ?? { bg: 'rgba(99, 102, 241, 0.12)', text: '#6366f1', border: 'rgba(99, 102, 241, 0.3)', label: 'Planned' };
              return (
                <div
                  key={c.id}
                  className="panel-raised"
                  style={{
                    padding: '20px',
                    borderRadius: '10px',
                    border: '1px solid var(--border-default)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '12px',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{
                    position: 'absolute', top: '12px', right: '12px',
                    fontSize: '10px', fontWeight: 800, padding: '3px 10px',
                    borderRadius: '12px',
                    background: statusStyle.bg,
                    color: statusStyle.text,
                    border: `1px solid ${statusStyle.border}`,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}>
                    {statusStyle.label}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{
                      width: '44px', height: '44px', borderRadius: '10px',
                      background: 'var(--bg-surface-subtle)', display: 'flex',
                      alignItems: 'center', justifyContent: 'center', fontSize: '24px',
                      border: '1px solid var(--border-subtle)',
                    }}>
                      {c.icon}
                    </div>
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)' }}>{c.name}</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>ETA: {c.eta}</div>
                    </div>
                  </div>
                  <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 }}>
                    {c.description}
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {c.features.map((f, i) => (
                      <div key={i} style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                        <span style={{ color: 'var(--brand)', fontWeight: 800, flexShrink: 0 }}>✓</span>
                        <span>{f}</span>
                      </div>
                    ))}
                  </div>
                  <button
                    disabled
                    className="btn btn-secondary"
                    style={{ fontSize: '11px', fontWeight: 700, padding: '6px 14px', opacity: 0.55, cursor: 'not-allowed', alignSelf: 'flex-start' }}
                  >
                    🔒 Connect (Coming Soon)
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* --- SECTION: Agent Runners --- */}
      {activeSection === 'agents' && (
        <div>
          <div style={{ marginBottom: '16px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px 0' }}>
              Agent Runners — Add & Deploy AI Agents
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              Each agent is an autonomous worker that runs 24/7 across your connected platforms. Add agents, assign them wallets, set spending limits, and let them drive revenue.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '16px' }}>
            {AGENT_RUNNERS.map((agent) => (
              <div
                key={agent.id}
                className="panel-raised"
                style={{
                  padding: '20px',
                  borderRadius: '10px',
                  border: '1px solid var(--border-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{
                      width: '44px', height: '44px', borderRadius: '10px',
                      background: 'linear-gradient(135deg, rgba(79, 70, 229, 0.15) 0%, rgba(37, 99, 235, 0.08) 100%)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '22px',
                      border: '1px solid rgba(79, 70, 229, 0.2)',
                    }}>
                      {agent.icon}
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>{agent.name}</div>
                      <div style={{ fontSize: '11px', color: 'var(--brand)', fontWeight: 600 }}>{agent.type}</div>
                    </div>
                  </div>
                  <span className="badge badge-warning" style={{ fontSize: '9px', fontWeight: 800 }}>UPCOMING</span>
                </div>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 }}>
                  {agent.description}
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {agent.capabilities.map((cap, i) => (
                    <span
                      key={i}
                      className="badge badge-neutral"
                      style={{ fontSize: '10px', padding: '2px 8px' }}
                    >
                      {cap}
                    </span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button
                    disabled
                    className="btn btn-primary"
                    style={{ fontSize: '11px', fontWeight: 700, padding: '6px 14px', opacity: 0.55, cursor: 'not-allowed' }}
                  >
                    ➕ Add Agent
                  </button>
                  <button
                    disabled
                    className="btn btn-secondary"
                    style={{ fontSize: '11px', fontWeight: 700, padding: '6px 14px', opacity: 0.55, cursor: 'not-allowed' }}
                  >
                    ⚙️ Configure
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* --- SECTION: Agent Wallets --- */}
      {activeSection === 'wallets' && (
        <div>
          <div style={{ marginBottom: '16px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px 0' }}>
              💰 Agent Wallets — Every Agent Has Its Own Ledger
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              Each deployed agent gets a dedicated wallet. Set spending ceilings, track P&L per agent, and auto-reconcile against your master merchant account.
            </p>
          </div>

          {/* Wallet Architecture Diagram */}
          <div className="panel-raised" style={{ padding: '24px', borderRadius: '10px', border: '1px solid var(--border-default)' }}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '16px' }}>
              Wallet Architecture (Planned)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
              {[
                { label: 'Master Merchant Wallet', balance: '₹12,50,000', icon: '🏦', color: '#4f46e5' },
                { label: 'AI Buyer Agent Wallet', balance: '₹2,00,000', icon: '🤖', color: '#2563eb' },
                { label: 'Recovery Agent Wallet', balance: '₹50,000', icon: '🛒', color: '#16a34a' },
                { label: 'Content Agent Wallet', balance: '₹15,000', icon: '🎨', color: '#d97706' },
                { label: 'Ad Spend Wallet', balance: '₹3,00,000', icon: '📢', color: '#dc2626' },
                { label: 'Reserve / Escrow', balance: '₹5,00,000', icon: '🔒', color: '#6b7280' },
              ].map((wallet, i) => (
                <div
                  key={i}
                  style={{
                    padding: '16px',
                    borderRadius: '8px',
                    border: `1px solid ${wallet.color}30`,
                    background: `${wallet.color}08`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '20px' }}>{wallet.icon}</span>
                    <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-secondary)' }}>{wallet.label}</span>
                  </div>
                  <div className="mono tabular-nums" style={{ fontSize: '18px', fontWeight: 800, color: wallet.color }}>
                    {wallet.balance}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Auto-reconciled daily</div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: '20px', padding: '14px 18px', borderRadius: '8px', background: 'rgba(251, 191, 36, 0.08)', border: '1px solid rgba(251, 191, 36, 0.2)' }}>
              <div style={{ fontSize: '12px', fontWeight: 800, color: '#d97706', marginBottom: '6px' }}>
                ⚠️ How Agent Wallets Will Work
              </div>
              <ul style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0, paddingLeft: '16px', lineHeight: 1.7 }}>
                <li>Every agent gets a <strong>dedicated wallet</strong> funded from the merchant&apos;s master account.</li>
                <li>Spending is capped by <strong>configurable ceilings</strong> (daily, weekly, per-transaction).</li>
                <li>The <strong>Money Firewall</strong> validates every agent transaction before execution.</li>
                <li>Real-time <strong>P&L per agent</strong> — know which agent is making you money and which is burning it.</li>
                <li><strong>Auto top-up</strong> when balance drops below threshold (requires merchant approval above ₹50K).</li>
                <li>Full <strong>SHA-256 audit trail</strong> for every wallet transaction — tamper-evident and compliance-ready.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* --- SECTION: Content Generation --- */}
      {activeSection === 'content' && (
        <div>
          <div style={{ marginBottom: '16px' }}>
            <h3 style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text-primary)', margin: '0 0 4px 0' }}>
              🎨 AI Content & Post Generation via Gemini API
            </h3>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0 }}>
              Auto-generate social media posts, product descriptions, ad copy, and marketing campaigns from your catalog data — all powered by the Gemini API.
            </p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
            {[
              {
                title: 'Instagram Post Generator',
                icon: '📸',
                desc: 'Automatically create engaging Instagram captions, hashtags, and shoppable post text from your product catalog.',
                example: '"🏎️ Speed meets durability! Our 1:10 All-Terrain RC Monster Truck hits 60 km/h — perfect birthday surprise for young speedsters! 🎂🎁 Shop now → link in bio #RCCars #ToysForKids #PlayCraftToys"',
              },
              {
                title: 'Telegram Broadcast Messages',
                icon: '✈️',
                desc: 'Generate broadcast announcement messages for Telegram channels — flash sales, new arrivals, stock alerts.',
                example: '"🚨 FLASH SALE — 24 Hours Only!\n🤖 Smart AI STEM Robotics Kit: ₹4,499 → ₹3,599 (20% OFF)\n🔋 FREE LiPo Battery with every purchase!\nOrder now: /buy_stem_kit"',
              },
              {
                title: 'Product Descriptions',
                icon: '📝',
                desc: 'Generate SEO-optimized product descriptions, bullet points, and meta tags for your D2C website.',
                example: '"[SEO Title] Smart AI STEM Programmable Robotics Kit for Kids Ages 8-14 | Scratch & Python Coding | PlayCraft Toys\n[Meta] Educational robot with obstacle sensors, line tracking & Bluetooth app. Perfect STEM gift for young coders."',
              },
              {
                title: 'Ad Copy (Google / Meta)',
                icon: '📢',
                desc: 'Generate ready-to-deploy ad headlines, descriptions, and CTAs optimized for conversion on Google Ads and Meta Ads.',
                example: '"[Headline] Birthday Gift Sorted in 2 Minutes 🎁\n[Description] AI picks the perfect toy. RC cars, STEM kits, LEGO sets — all under ₹5,000. Free gift wrap included.\n[CTA] Shop Now"',
              },
            ].map((card, i) => (
              <div
                key={i}
                className="panel-raised"
                style={{
                  padding: '20px',
                  borderRadius: '10px',
                  border: '1px solid var(--border-default)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '22px' }}>{card.icon}</span>
                    <span style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text-primary)' }}>{card.title}</span>
                  </div>
                  <span className="badge badge-warning" style={{ fontSize: '9px', fontWeight: 800 }}>UPCOMING</span>
                </div>
                <p style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 }}>
                  {card.desc}
                </p>
                <div style={{
                  padding: '12px 14px',
                  borderRadius: '6px',
                  background: 'var(--bg-surface-subtle)',
                  border: '1px solid var(--border-subtle)',
                  fontSize: '11px',
                  color: 'var(--text-secondary)',
                  lineHeight: 1.6,
                  fontFamily: 'var(--font-mono)',
                  whiteSpace: 'pre-wrap',
                }}>
                  <div style={{ fontSize: '10px', fontWeight: 800, color: 'var(--brand)', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Example Output Preview
                  </div>
                  {card.example}
                </div>
                <button
                  disabled
                  className="btn btn-primary"
                  style={{ fontSize: '11px', fontWeight: 700, padding: '6px 14px', opacity: 0.55, cursor: 'not-allowed', alignSelf: 'flex-start' }}
                >
                  ✨ Generate (Coming Soon)
                </button>
              </div>
            ))}
          </div>

          {/* How it works */}
          <div className="panel-raised" style={{ padding: '20px', borderRadius: '10px', border: '1px solid var(--border-default)', marginTop: '16px' }}>
            <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '12px' }}>
              ⚙️ How AI Content Generation Will Work
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
              {[
                { step: '1', title: 'Catalog Sync', desc: 'Products auto-synced from connected platforms (Shopify, WooCommerce, etc.)' },
                { step: '2', title: 'Gemini API', desc: 'Gemini generates context-aware copy, captions, and ad text from product data' },
                { step: '3', title: 'Review & Edit', desc: 'Merchant reviews, edits, and approves generated content in the dashboard' },
                { step: '4', title: 'Auto-Publish', desc: 'Approved content auto-published to Instagram, Telegram, WhatsApp, and ads' },
              ].map((s) => (
                <div key={s.step} style={{ padding: '14px', borderRadius: '8px', background: 'var(--bg-surface-subtle)', border: '1px solid var(--border-subtle)' }}>
                  <div style={{ fontSize: '20px', fontWeight: 900, color: 'var(--brand)', marginBottom: '4px' }}>{s.step}</div>
                  <div style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-primary)', marginBottom: '4px' }}>{s.title}</div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>{s.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
