import { NextResponse } from 'next/server';
import { RecoveryDataService } from '@/services/recovery-data-service';
import { getLiveFailedTransactions } from '@/services/live-transaction-store';

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') || undefined;
    const search = searchParams.get('search') || undefined;

    const tenantId = req.headers.get('x-tenant-id') || undefined;
    const service = new RecoveryDataService(tenantId);
    const seedPayments = await service.getFailedPayments({ status, search });

    // Prepend live failed transactions from AI Buyer Lab (on top of seed data)
    const liveFailures = getLiveFailedTransactions();
    const livePaymentEntries = liveFailures.map((txn) => ({
      id: txn.id,
      razorpayPaymentId: txn.razorpayOrderId,
      amount: txn.amountPaise,
      currency: 'INR',
      status: 'failed' as const,
      method: txn.channel.toLowerCase().includes('upi') ? 'upi' : 'card',
      description: `AI Buyer Transaction — ${txn.productName}`,
      email: 'ai-buyer@playcraft.toys',
      contact: '+91 00000 00000',
      error_code: 'LIVE_FAILURE',
      error_description: txn.errorReason || 'Transaction failed during AI Buyer checkout',
      error_source: 'gateway',
      created_at: Math.floor(new Date(txn.timestamp).getTime() / 1000),
      proposedAction: 'Smart Retry via alternate gateway',
      recoveryConfidence: 0.65,
      auditSha256: txn.auditSha256,
    }));

    const payments = [...livePaymentEntries, ...seedPayments];
    return NextResponse.json({ payments, count: payments.length });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed payments error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
