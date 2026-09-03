/**
 * Live Transaction Store — In-Memory Singleton
 *
 * Records every real transaction from the AI Buyer ↔ Merchant Lab flow.
 * Dashboard and Failed Payments APIs read from this store to show real-time data
 * ON TOP of existing seed data (seed data is never removed).
 */

import { createHash } from 'crypto';

export interface LiveTransaction {
  id: string;
  type: 'SUCCESS' | 'FAILED' | 'BLOCKED';
  amountPaise: number;
  razorpayOrderId: string;
  productName: string;
  buyerQuery: string;
  channel: string;
  errorReason?: string;
  firewallAction?: string;
  timestamp: string;
  auditSha256: string;
}

// Module-level singleton — persists across API calls within the same server process
const liveTransactions: LiveTransaction[] = [];

export function pushLiveTransaction(txn: Omit<LiveTransaction, 'auditSha256'>): void {
  const hash = createHash('sha256')
    .update(JSON.stringify({ id: txn.id, type: txn.type, amountPaise: txn.amountPaise, timestamp: txn.timestamp }))
    .digest('hex')
    .substring(0, 16);

  liveTransactions.unshift({ ...txn, auditSha256: hash });

  // Cap at 200 entries to prevent memory leaks
  if (liveTransactions.length > 200) liveTransactions.pop();
}

export function getLiveTransactions(): LiveTransaction[] {
  return [...liveTransactions];
}

export function getLiveFailedTransactions(): LiveTransaction[] {
  return liveTransactions.filter((t) => t.type === 'FAILED' || t.type === 'BLOCKED');
}

export function getLiveSuccessTransactions(): LiveTransaction[] {
  return liveTransactions.filter((t) => t.type === 'SUCCESS');
}

export function getLiveTransactionStats() {
  const successes = liveTransactions.filter((t) => t.type === 'SUCCESS');
  const failures = liveTransactions.filter((t) => t.type === 'FAILED' || t.type === 'BLOCKED');
  return {
    totalLiveOrders: liveTransactions.length,
    liveSuccessCount: successes.length,
    liveFailedCount: failures.length,
    liveRevenuePaise: successes.reduce((sum, t) => sum + t.amountPaise, 0),
    liveFailedPaise: failures.reduce((sum, t) => sum + t.amountPaise, 0),
  };
}
