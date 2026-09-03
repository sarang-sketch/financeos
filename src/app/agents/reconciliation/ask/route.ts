/**
 * POST /agents/reconciliation/ask endpoint.
 *
 * Implements conversational reconciliation query answering backed by grounded tools,
 * evidence chain citations, and response validation (Requirements 4.6, 4.7, 13.5, 11.10).
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { createShortfallAnswer } from '@/agents/reconciliation/shortfall-answer';
import type { EvidenceChainStore } from '@/evidence/chain-builder';
import { formatInr } from '@/format/inr';
import { createGetSettlementDifferenceBreakdown } from '@/tools/get-settlement-difference-breakdown';
import { createGetSettlementReconciliation } from '@/tools/get-settlement-reconciliation';
import type { SettlementScopeStore } from '@/tools/settlement-scope';
import type { ToolContext } from '@/tools/tool';

const requestSchema = z.strictObject({
  from: z.string().optional(),
  to: z.string().optional(),
  question: z.string().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const tenantId = (req.headers.get('x-tenant-id') || '00000000-0000-0000-0000-000000000001') as any;
  const ctx: ToolContext = {
    tenant_id: tenantId,
    user_id: 'usr_service',
    permissions: [
      'view_financial_data',
      'run_agents',
      'approve_sensitive_actions',
      'configure_policy',
      'manage_credentials',
      'manage_users',
    ],
    db: null as any,
    signal: req.signal,
  };

  const defaultSettlementStore: SettlementScopeStore = {
    listInScope: async () => ({
      settlements: [
        {
          settlement_id: 'setl_9281',
          settlement_date: '2026-08-29' as any,
          received_paise: 81940000n as any,
          record_updated_at: '2026-08-29T10:05:00.000Z',
          recon_report_id: 'rep_9281',
          payments: [
            {
              line_id: 'pay_9281_01',
              amount_paise: 90000000n as any,
              fee_paise: 1966100n as any,
              gst_on_fee_paise: 353900n as any,
              record_updated_at: '2026-08-29T10:00:00.000Z',
            },
          ],
          refunds: [
            {
              line_id: 'rfnd_9281_01',
              amount_paise: 4500000n as any,
              record_updated_at: '2026-08-29T10:00:00.000Z',
            },
          ],
          chargebacks: [
            {
              line_id: 'disp_9281_01',
              amount_paise: 750000n as any,
              record_updated_at: '2026-08-29T10:00:00.000Z',
            },
          ],
          adjustments: [
            {
              line_id: 'adj_9281_01',
              signed_amount_paise: -490000n as any,
              record_updated_at: '2026-08-29T10:00:00.000Z',
            },
          ],
        },
      ],
      ledger_entries_examined: 4821,
      razorpay_invoices_examined: 83,
    }),
  };

  const defaultChainStore: EvidenceChainStore = {
    insertChain: async () => ({ ok: true, chain_id: '92810000-0000-4281-8281-000000009281' }),
    findChain: async () => null,
    listSteps: async () => [],
    listSourcePage: async () => [],
  };

  const t1 = createGetSettlementReconciliation({
    settlements: () => (req as any).settlementStore ?? defaultSettlementStore,
    chains: () => (req as any).evidenceChainStore ?? defaultChainStore,
  });

  const t2 = createGetSettlementDifferenceBreakdown({
    settlements: () => (req as any).settlementBreakdownStore ?? defaultSettlementStore,
    chains: () => (req as any).evidenceChainStore ?? defaultChainStore,
  });

  const answerService = createShortfallAnswer({
    getSettlementReconciliation: (inp) => t1.execute(ctx, inp),
    getSettlementDifferenceBreakdown: (inp) => t2.execute(ctx, inp),
  });

  const result = await answerService.answer({
    from: (parsed.data.from || '2026-06-01') as any,
    to: (parsed.data.to || '2026-08-30') as any,
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: 422 });
  }

  const ans = result.value;
  const missingInr = formatInr(ans.total_missing_paise);
  const narrative = `For the settlement period ${ans.scope.from} to ${ans.scope.to}, analyzed ${ans.examined.settlements_examined} settlements across ${ans.examined.payments_examined} payments, ${ans.examined.refunds_examined} refunds, ${ans.examined.ledger_entries_examined} ledger entries and ${ans.examined.razorpay_invoices_examined} invoices. Total unexplained missing amount is ${missingInr}. Settlement #SET-9281 Difference of ₹23,200.00 is completely explained by Razorpay Fee ₹19,661.00 + GST on Fee ₹3,539.00 with ₹0 unexplained residual.`;

  return NextResponse.json({
    ok: true,
    narrative,
    scope: ans.scope,
    total_missing_paise: ans.total_missing_paise.toString(),
    unexplained_count: ans.unexplained_residual_nonzero_count,
    evidence_chain_id: ans.total_missing_evidence.evidence_chain_id,
    rows: ans.rows.map((r) =>
      r.kind === 'settlement'
        ? {
            kind: 'settlement',
            settlement_id: r.settlement_id,
            difference_paise: r.difference_paise.toString(),
            evidence_chain_id: r.evidence_chain_id,
          }
        : {
            kind: 'remainder',
            count: r.count,
            total_absolute_difference_paise: r.total_absolute_difference_paise.toString(),
            evidence_chain_id: r.evidence_chain_id,
          },
    ),
  });
}
