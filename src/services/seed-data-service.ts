import { createServiceClient } from '@/db/clients';
import { getEnv } from '@/config/env';

export const REFERENCE_TENANT_ID = '00000000-0000-0000-0000-000000010001';
export const SECONDARY_TENANT_ID = '00000000-0000-0000-0000-000000010002';

export interface SeedCustomer {
  id: string;
  tenant_id: string;
  name: string;
  email: string;
  phone: string;
  ltv_paise: number;
  total_payments_count: number;
  successful_payments_count: number;
  failed_payments_count: number;
  preferred_channel: string;
  channel_success_rates: Record<string, number>;
}

export interface SeedPaymentFailure {
  id: string;
  tenant_id: string;
  payment_id: string;
  customer_id: string;
  amount_paise: number;
  channel: string;
  failure_reason: string;
  attempts_count: number;
  recovery_probability: number;
  recommended_channel: string;
  evidence_source: 'CUSTOMER_LEVEL' | 'TENANT_LEVEL';
  status: 'FAILED' | 'ANALYZING' | 'PROPOSAL_READY' | 'RETRYING' | 'RECOVERED' | 'UNRECOVERABLE';
  created_at: string;
  error_code: string;
}

export interface SeedRecoveryProposal {
  id: string;
  tenant_id: string;
  failure_id: string;
  customer_id: string;
  amount_paise: number;
  recommended_channel: string;
  recommended_action: string;
  recovery_probability: number;
  expected_recovery_paise: number;
  risk_score: string;
  evidence_source: 'CUSTOMER_LEVEL' | 'TENANT_LEVEL';
  reasoning: string;
  status: 'PENDING' | 'APPROVED' | 'EXECUTING' | 'RECOVERED' | 'FAILED' | 'REJECTED';
  created_at: string;
}

export interface SeedChannelStat {
  id: string;
  tenant_id: string;
  channel: string;
  total_attempts: number;
  successful_attempts: number;
  success_rate: number;
  recovered_paise: number;
}

export interface SeedAuditLog {
  time: string;
  actor: string;
  action: string;
  entity: string;
  status: string;
  hash: string;
}

// 1. Deterministic Seed Customers (Diverse Indian businesses & individuals)
export const SEED_CUSTOMERS: SeedCustomer[] = [
  {
    id: 'cust_88',
    tenant_id: REFERENCE_TENANT_ID,
    name: 'TechLearn Pro Pvt Ltd',
    email: 'billing@techlearnpro.in',
    phone: '+91 98201 12345',
    ltv_paise: 8400000,
    total_payments_count: 9,
    successful_payments_count: 8,
    failed_payments_count: 1,
    preferred_channel: 'card',
    channel_success_rates: { card: 88.9, upi: 50.0, netbanking: 40.0 },
  },
  {
    id: 'cust_92',
    tenant_id: REFERENCE_TENANT_ID,
    name: 'Apex Innovations',
    email: 'finance@apexinnovations.co',
    phone: '+91 98450 67890',
    ltv_paise: 0,
    total_payments_count: 1,
    successful_payments_count: 0, // ZERO PRIOR SUCCESS (Triggers Tenant-Level Fallback)
    failed_payments_count: 1,
    preferred_channel: 'upi',
    channel_success_rates: {},
  },
  {
    id: 'cust_44',
    tenant_id: REFERENCE_TENANT_ID,
    name: 'Zenith Logistics LLP',
    email: 'accounts@zenithlogistics.in',
    phone: '+91 97110 54321',
    ltv_paise: 3850000,
    total_payments_count: 6,
    successful_payments_count: 5,
    failed_payments_count: 1,
    preferred_channel: 'payment_link',
    channel_success_rates: { payment_link: 83.3, upi: 60.0 },
  },
  {
    id: 'cust_19',
    tenant_id: REFERENCE_TENANT_ID,
    name: 'Kavita Sharma',
    email: 'kavita.sharma@gmail.com',
    phone: '+91 99880 11223',
    ltv_paise: 1420000,
    total_payments_count: 4,
    successful_payments_count: 3,
    failed_payments_count: 1,
    preferred_channel: 'whatsapp_interactive',
    channel_success_rates: { upi: 100.0, card: 75.0 },
  },
  {
    id: 'cust_105',
    tenant_id: REFERENCE_TENANT_ID,
    name: 'Rohit Verma',
    email: 'rohit.verma@outlook.in',
    phone: '+91 98102 99887',
    ltv_paise: 2200000,
    total_payments_count: 5,
    successful_payments_count: 4,
    failed_payments_count: 1,
    preferred_channel: 'upi',
    channel_success_rates: { upi: 80.0, card: 50.0 },
  },
  {
    id: 'cust_114',
    tenant_id: REFERENCE_TENANT_ID,
    name: 'Bharat Agritech Ventures',
    email: 'ops@bharatagri.com',
    phone: '+91 94220 33445',
    ltv_paise: 0,
    total_payments_count: 1,
    successful_payments_count: 0, // ZERO PRIOR SUCCESS
    failed_payments_count: 1,
    preferred_channel: 'upi',
    channel_success_rates: {},
  },
  {
    id: 'cust_201',
    tenant_id: REFERENCE_TENANT_ID,
    name: 'Aarav Enterprise Solutions',
    email: 'procurement@aaravsolutions.in',
    phone: '+91 98765 43210',
    ltv_paise: 12500000,
    total_payments_count: 14,
    successful_payments_count: 13,
    failed_payments_count: 1,
    preferred_channel: 'card',
    channel_success_rates: { card: 92.8, upi: 70.0 },
  },
  {
    id: 'cust_202',
    tenant_id: REFERENCE_TENANT_ID,
    name: 'Pooja Retail Organics',
    email: 'finance@poojaretail.com',
    phone: '+91 91234 56789',
    ltv_paise: 5400000,
    total_payments_count: 7,
    successful_payments_count: 6,
    failed_payments_count: 1,
    preferred_channel: 'upi',
    channel_success_rates: { upi: 85.7, payment_link: 75.0 },
  },
];

// 2. Deterministic Seed Payment Failures
export const SEED_PAYMENT_FAILURES: SeedPaymentFailure[] = [
  {
    id: 'pay_fail_901',
    tenant_id: REFERENCE_TENANT_ID,
    payment_id: 'pay_rzp_901a88',
    customer_id: 'cust_88',
    amount_paise: 850000, // ₹8,500.00
    channel: 'card',
    failure_reason: 'bank_server_timeout',
    attempts_count: 2,
    recovery_probability: 81,
    recommended_channel: 'card',
    evidence_source: 'CUSTOMER_LEVEL',
    status: 'PROPOSAL_READY',
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    error_code: 'GATEWAY_ERROR',
  },
  {
    id: 'pay_fail_902',
    tenant_id: REFERENCE_TENANT_ID,
    payment_id: 'pay_rzp_902b92',
    customer_id: 'cust_92',
    amount_paise: 1200000, // ₹12,000.00
    channel: 'upi',
    failure_reason: 'insufficient_funds',
    attempts_count: 1,
    recovery_probability: 68,
    recommended_channel: 'upi',
    evidence_source: 'TENANT_LEVEL', // ZERO PRIOR SUCCESS
    status: 'ANALYZING',
    created_at: new Date(Date.now() - 24 * 60 * 1000).toISOString(),
    error_code: 'INSUFFICIENT_FUNDS',
  },
  {
    id: 'pay_fail_903',
    tenant_id: REFERENCE_TENANT_ID,
    payment_id: 'pay_rzp_903c44',
    customer_id: 'cust_44',
    amount_paise: 450000, // ₹4,500.00
    channel: 'payment_link',
    failure_reason: 'payment_authentication_failed',
    attempts_count: 3,
    recovery_probability: 78,
    recommended_channel: 'razorpay_payment_link',
    evidence_source: 'CUSTOMER_LEVEL',
    status: 'PROPOSAL_READY',
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    error_code: 'AUTH_FAILED',
  },
  {
    id: 'pay_fail_904',
    tenant_id: REFERENCE_TENANT_ID,
    payment_id: 'pay_rzp_904d19',
    customer_id: 'cust_19',
    amount_paise: 240000, // ₹2,400.00
    channel: 'card',
    failure_reason: 'card_expired',
    attempts_count: 1,
    recovery_probability: 84,
    recommended_channel: 'whatsapp_interactive',
    evidence_source: 'CUSTOMER_LEVEL',
    status: 'RETRYING',
    created_at: new Date(Date.now() - 120 * 60 * 1000).toISOString(),
    error_code: 'CARD_EXPIRED',
  },
  {
    id: 'pay_fail_905',
    tenant_id: REFERENCE_TENANT_ID,
    payment_id: 'pay_rzp_905e105',
    customer_id: 'cust_105',
    amount_paise: 150000, // ₹1,500.00
    channel: 'upi',
    failure_reason: 'upi_pin_incorrect',
    attempts_count: 2,
    recovery_probability: 91,
    recommended_channel: 'upi',
    evidence_source: 'CUSTOMER_LEVEL',
    status: 'RECOVERED',
    created_at: new Date(Date.now() - 180 * 60 * 1000).toISOString(),
    error_code: 'USER_DROPOUT',
  },
  {
    id: 'pay_fail_906',
    tenant_id: REFERENCE_TENANT_ID,
    payment_id: 'pay_rzp_906f114',
    customer_id: 'cust_114',
    amount_paise: 1850000, // ₹18,500.00
    channel: 'netbanking',
    failure_reason: 'bank_server_timeout',
    attempts_count: 1,
    recovery_probability: 58,
    recommended_channel: 'payment_link',
    evidence_source: 'TENANT_LEVEL', // ZERO PRIOR SUCCESS
    status: 'PROPOSAL_READY',
    created_at: new Date(Date.now() - 210 * 60 * 1000).toISOString(),
    error_code: 'NETBANKING_TIMEOUT',
  },
  {
    id: 'pay_fail_907',
    tenant_id: REFERENCE_TENANT_ID,
    payment_id: 'pay_rzp_907g201',
    customer_id: 'cust_201',
    amount_paise: 950000, // ₹9,500.00
    channel: 'card',
    failure_reason: 'bank_server_timeout',
    attempts_count: 2,
    recovery_probability: 88,
    recommended_channel: 'card',
    evidence_source: 'CUSTOMER_LEVEL',
    status: 'PROPOSAL_READY',
    created_at: new Date(Date.now() - 300 * 60 * 1000).toISOString(),
    error_code: 'GATEWAY_ERROR',
  },
];

// 3. Deterministic Seed Recovery Proposals
export const SEED_RECOVERY_PROPOSALS: SeedRecoveryProposal[] = [
  {
    id: 'prop_901',
    tenant_id: REFERENCE_TENANT_ID,
    failure_id: 'pay_fail_901',
    customer_id: 'cust_88',
    amount_paise: 850000,
    recommended_channel: 'Card Dynamic Retry',
    recommended_action: 'Trigger Card Dynamic Retry via Gateway Route',
    recovery_probability: 81,
    expected_recovery_paise: 688500, // 850000 * 0.81
    risk_score: 'Low (6/100)',
    evidence_source: 'CUSTOMER_LEVEL',
    reasoning:
      'Customer has 8 historical card payments with 88.9% success. Bank server timeout error classified as transient. Immediate card retry selected.',
    status: 'PENDING',
    created_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  },
  {
    id: 'prop_902',
    tenant_id: REFERENCE_TENANT_ID,
    failure_id: 'pay_fail_902',
    customer_id: 'cust_92',
    amount_paise: 1200000,
    recommended_channel: 'UPI Payment Link',
    recommended_action: 'Generate Razorpay WhatsApp Payment Link',
    recovery_probability: 68,
    expected_recovery_paise: 816000, // 1200000 * 0.68
    risk_score: 'Medium (18/100)',
    evidence_source: 'TENANT_LEVEL',
    reasoning:
      'Customer has zero prior successful payments. Deterministically falling back to tenant-level aggregate UPI link conversion rates.',
    status: 'PENDING',
    created_at: new Date(Date.now() - 24 * 60 * 1000).toISOString(),
  },
  {
    id: 'prop_903',
    tenant_id: REFERENCE_TENANT_ID,
    failure_id: 'pay_fail_903',
    customer_id: 'cust_44',
    amount_paise: 450000,
    recommended_channel: 'WhatsApp Interactive Link',
    recommended_action: 'Send Interactive Smart Recovery Link',
    recovery_probability: 78,
    expected_recovery_paise: 351000, // 450000 * 0.78
    risk_score: 'Low (8/100)',
    evidence_source: 'CUSTOMER_LEVEL',
    reasoning:
      'High corporate LTV (₹38.5k); interactive payment links convert at 78% after 3D Secure authentication timeouts.',
    status: 'PENDING',
    created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'prop_906',
    tenant_id: REFERENCE_TENANT_ID,
    failure_id: 'pay_fail_906',
    customer_id: 'cust_114',
    amount_paise: 1850000,
    recommended_channel: 'Razorpay Payment Link',
    recommended_action: 'Issue Instant SMS & WhatsApp Payment Link',
    recovery_probability: 58,
    expected_recovery_paise: 1073000,
    risk_score: 'Medium (15/100)',
    evidence_source: 'TENANT_LEVEL',
    reasoning:
      'Customer has no prior successful payments. Estimated using tenant-level netbanking recovery fallback.',
    status: 'PENDING',
    created_at: new Date(Date.now() - 210 * 60 * 1000).toISOString(),
  },
];

// 4. Deterministic Seed Channel Statistics
export const SEED_CHANNEL_STATS: SeedChannelStat[] = [
  {
    id: 'stat_upi',
    tenant_id: REFERENCE_TENANT_ID,
    channel: 'UPI Smart Retry',
    total_attempts: 240,
    successful_attempts: 187,
    success_rate: 77.92,
    recovered_paise: 184000000, // ₹18.4L
  },
  {
    id: 'stat_card',
    tenant_id: REFERENCE_TENANT_ID,
    channel: 'Card Dynamic Retry',
    total_attempts: 120,
    successful_attempts: 73,
    success_rate: 60.83,
    recovered_paise: 92000000, // ₹9.2L
  },
  {
    id: 'stat_link',
    tenant_id: REFERENCE_TENANT_ID,
    channel: 'Payment Link (WhatsApp/SMS)',
    total_attempts: 85,
    successful_attempts: 71,
    success_rate: 83.53,
    recovered_paise: 45000000, // ₹4.5L
  },
  {
    id: 'stat_netbanking',
    tenant_id: REFERENCE_TENANT_ID,
    channel: 'Netbanking / AutoPay',
    total_attempts: 55,
    successful_attempts: 24,
    success_rate: 43.64,
    recovered_paise: 14000000, // ₹1.4L
  },
];

// 5. Deterministic Seed Audit Logs
export const SEED_AUDIT_LOGS: SeedAuditLog[] = [
  { time: '2026-08-30 11:15:08', actor: 'AI_AGENT', action: 'RECOVERY_PROPOSAL_GENERATED', entity: 'prop_901', status: 'SUCCESS', hash: 'a7f8c92b...3f81' },
  { time: '2026-08-30 11:14:45', actor: 'SYSTEM', action: 'PAYMENT_FAILED_INGESTED', entity: 'pay_fail_901', status: 'STORED', hash: '9b2c140e...88ef' },
  { time: '2026-08-30 10:45:00', actor: 'AI_AGENT', action: 'RECOVERY_PROPOSAL_GENERATED', entity: 'prop_902', status: 'SUCCESS', hash: '4f1a980c...7712' },
  { time: '2026-08-30 09:30:12', actor: 'SYSTEM', action: 'RECOVERY_ATTEMPT_EXECUTED', entity: 'pay_fail_905', status: 'RECOVERED', hash: '8e4412bc...9041' },
  { time: '2026-08-30 09:00:00', actor: 'SYSTEM', action: 'INGESTION_RUN_COMPLETED', entity: 'run_20260830', status: 'SUCCESS', hash: '2b1156fe...554a' },
];

/**
 * Executes database seed insertion into Supabase PostgreSQL.
 * Idempotent: safe to run multiple times without duplicating data.
 */
export async function seedDatabase(tenantId: string = REFERENCE_TENANT_ID): Promise<{ ok: boolean; count: number; error?: string }> {
  try {
    const { client } = createServiceClient({ tenantId });

    // 1. Ensure Tenant exists
    await client.from('tenants').upsert([
      { tenant_id: REFERENCE_TENANT_ID, name: 'EdTech India Ltd', created_at: new Date().toISOString() },
      { tenant_id: SECONDARY_TENANT_ID, name: 'FinFlow SaaS India', created_at: new Date().toISOString() },
    ], { onConflict: 'tenant_id' });

    // 2. Seed Customers
    const customerInserts = SEED_CUSTOMERS.map((c) => ({
      id: c.id,
      tenant_id: c.tenant_id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      updated_at: new Date().toISOString(),
    }));
    await client.from('customers').upsert(customerInserts, { onConflict: 'tenant_id,id' });

    // 3. Seed Customer LTV
    const ltvInserts = SEED_CUSTOMERS.map((c) => ({
      customer_id: c.id,
      tenant_id: c.tenant_id,
      ltv_paise: c.ltv_paise,
      total_payments_count: c.total_payments_count,
      successful_payments_count: c.successful_payments_count,
      failed_payments_count: c.failed_payments_count,
      preferred_channel: c.preferred_channel,
      channel_success_rates: c.channel_success_rates,
      updated_at: new Date().toISOString(),
    }));
    await client.from('customer_ltv').upsert(ltvInserts, { onConflict: 'tenant_id,customer_id' });

    // 4. Seed Payment Failures
    const failureInserts = SEED_PAYMENT_FAILURES.map((f) => ({
      id: f.id,
      tenant_id: f.tenant_id,
      payment_id: f.payment_id,
      customer_id: f.customer_id,
      amount_paise: f.amount_paise,
      channel: f.channel,
      failure_reason: f.failure_reason,
      attempts_count: f.attempts_count,
      recovery_probability: f.recovery_probability,
      recommended_channel: f.recommended_channel,
      evidence_source: f.evidence_source,
      status: f.status,
      created_at: f.created_at,
      error_code: f.error_code,
      updated_at: new Date().toISOString(),
    }));
    await client.from('payment_failures').upsert(failureInserts, { onConflict: 'tenant_id,id' });

    // 5. Seed Recovery Proposals
    const proposalInserts = SEED_RECOVERY_PROPOSALS.map((p) => ({
      id: p.id,
      tenant_id: p.tenant_id,
      failure_id: p.failure_id,
      customer_id: p.customer_id,
      amount_paise: p.amount_paise,
      recommended_channel: p.recommended_channel,
      recommended_action: p.recommended_action,
      recovery_probability: p.recovery_probability,
      expected_recovery_paise: p.expected_recovery_paise,
      risk_score: p.risk_score,
      evidence_source: p.evidence_source,
      reasoning: p.reasoning,
      status: p.status,
      created_at: p.created_at,
    }));
    await client.from('recovery_proposals').upsert(proposalInserts, { onConflict: 'tenant_id,id' });

    // 6. Seed Channel Stats
    const statInserts = SEED_CHANNEL_STATS.map((s) => ({
      id: s.id,
      tenant_id: s.tenant_id,
      channel: s.channel,
      total_attempts: s.total_attempts,
      successful_attempts: s.successful_attempts,
      success_rate: s.success_rate,
      recovered_paise: s.recovered_paise,
      updated_at: new Date().toISOString(),
    }));
    await client.from('channel_statistics').upsert(statInserts, { onConflict: 'tenant_id,id' });

    // 7. Seed Policy
    await client.from('recovery_policies').upsert([
      {
        tenant_id: REFERENCE_TENANT_ID,
        auto_execution_ceiling_paise: 5000000,
        require_dual_auth: false,
        strategy: 'BALANCED_AGGRESSIVE',
        channel_priorities: ['upi', 'card', 'payment_link', 'netbanking'],
        min_confidence_threshold: 65,
        updated_at: new Date().toISOString(),
      },
    ], { onConflict: 'tenant_id' });

    return { ok: true, count: SEED_CUSTOMERS.length + SEED_PAYMENT_FAILURES.length };
  } catch (err: any) {
    return { ok: false, count: 0, error: err.message };
  }
}
