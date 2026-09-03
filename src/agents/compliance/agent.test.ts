import { describe, expect, it } from 'vitest';
import { ComplianceAgent } from './agent';

describe('ComplianceAgent', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001' as any;
  const range = { from: '2026-01-01' as any, to: '2026-03-31' as any };

  it('detects invalid GSTINs and creates exceptions with fingerprint', async () => {
    const agent = new ComplianceAgent();
    const res = await agent.run({
      tenant_id: tenantId,
      range,
      invoices: [
        {
          id: 'inv_bad_gstin',
          invoice_date: '2026-01-15' as any,
          customer_gstin: '99AAAAA0000A1Z5', // invalid state 99
          total_amount_paise: 11800n,
          taxable_amount_paise: 10000n,
          tax_amount_paise: 1800n,
        },
      ],
      payments: [],
      credit_notes: [],
    });

    expect(res.exceptions.length).toBeGreaterThan(0);
    const exc = res.exceptions.find((e) => e.category === 'invalid_gstin');
    expect(exc).toBeDefined();
    expect(exc!.impact_paise).toBe(1800n);
    expect(exc!.fingerprint).toBeDefined();
    expect(exc!.source_records[0]?.id).toBe('inv_bad_gstin');
  });

  it('detects missing GSTIN or HSN/SAC on invoices', async () => {
    const agent = new ComplianceAgent();
    const res = await agent.run({
      tenant_id: tenantId,
      range,
      invoices: [
        {
          id: 'inv_missing_gst',
          invoice_date: '2026-01-15' as any,
          customer_gstin: null,
          total_amount_paise: 10000n,
          taxable_amount_paise: 10000n,
          tax_amount_paise: 0n,
        },
      ],
      payments: [],
      credit_notes: [],
    });

    const exc = res.exceptions.find((e) => e.category === 'missing_gst_information');
    expect(exc).toBeDefined();
  });

  it('detects GST rate anomalies not matching valid slabs', async () => {
    const agent = new ComplianceAgent();
    const res = await agent.run({
      tenant_id: tenantId,
      range,
      invoices: [
        {
          id: 'inv_odd_gst',
          invoice_date: '2026-01-15' as any,
          customer_gstin: '29ABCDE1234F1Z5',
          total_amount_paise: 10700n,
          taxable_amount_paise: 10000n,
          tax_amount_paise: 700n, // 7.00% is not in [0, 0.25, 3, 5, 12, 18, 28]
        },
      ],
      payments: [],
      credit_notes: [],
    });

    const exc = res.exceptions.find((e) => e.category === 'gst_anomaly');
    expect(exc).toBeDefined();
  });

  it('detects unmatched credit notes with non-existent invoice refs', async () => {
    const agent = new ComplianceAgent();
    const res = await agent.run({
      tenant_id: tenantId,
      range,
      invoices: [],
      payments: [],
      credit_notes: [
        {
          id: 'cn_orphan',
          credit_note_date: '2026-01-20' as any,
          invoice_id: 'inv_missing_ref',
          amount_paise: 5000n,
        },
      ],
    });

    const exc = res.exceptions.find((e) => e.category === 'unmatched_credit_note');
    expect(exc).toBeDefined();
  });

  it('detects high-value payments without customer GSTIN as record needing review', async () => {
    const agent = new ComplianceAgent();
    const res = await agent.run({
      tenant_id: tenantId,
      range,
      invoices: [],
      payments: [
        {
          id: 'pay_large_1',
          payment_date: '2026-01-10' as any,
          customer_id: 'cust_unregistered_vip',
          customer_gstin: null,
          amount_paise: 3000000n, // 30,000 INR
          fee_paise: 60000n,
          gst_on_fee_paise: 10800n,
        },
        {
          id: 'pay_large_2',
          payment_date: '2026-01-12' as any,
          customer_id: 'cust_unregistered_vip',
          customer_gstin: null,
          amount_paise: 2500000n, // 25,000 INR -> total 55,000 INR >= 50,000 INR threshold
          fee_paise: 50000n,
          gst_on_fee_paise: 9000n,
        },
      ],
      credit_notes: [],
    });

    const exc = res.exceptions.find((e) => e.category === 'record_needing_review');
    expect(exc).toBeDefined();
    expect(exc!.impact_paise).toBe(5500000n);
  });

  it('computes TDS review items for vendor payments and rounds with applyRate', async () => {
    const agent = new ComplianceAgent();
    const res = await agent.run({
      tenant_id: tenantId,
      range,
      invoices: [],
      payments: [
        {
          id: 'pay_vendor_contractor',
          payment_date: '2026-01-15' as any,
          vendor_id: 'vend_tech_services',
          is_vendor_payment: true,
          category: 'professional_services',
          amount_paise: 10000000n, // 100,000 INR
          fee_paise: 0n,
          gst_on_fee_paise: 0n,
        },
      ],
      credit_notes: [],
      config: {
        tds_rates: {
          professional_services: 10.0, // 10% TDS (1000 bps)
        },
      },
    });

    expect(res.tds_review_items.length).toBe(1);
    const item = res.tds_review_items[0];
    expect(item).toBeDefined();
    expect(item!.recommended_tds_deduction_paise).toBe(1000000n); // 10,000 INR
    expect(item!.applicable_rate_bps).toBe(1000n);
  });
});
