import { sha256 } from '@/commerce/commerce-crypto';
import { CommerceDatabase, CommerceTransaction } from '@/commerce/commerce-db';

export type IdempotencyKey = string;

/**
 * Generates a deterministic idempotency key based on inputs and a time window.
 * The time window is rounded to 5-minute buckets.
 * @param buyerAgentId - The ID of the buyer agent.
 * @param productIds - Array of product IDs involved in the transaction.
 * @param amountPaise - The total amount in paise.
 * @returns The generated idempotency key.
 */
export function generateIdempotencyKey(
  buyerAgentId: string,
  productIds: string[],
  amountPaise: number
): IdempotencyKey {
  // 5-minute buckets (5 * 60 * 1000 = 300000 ms)
  const timeWindow = Math.floor(Date.now() / 300000);
  const dataToHash = `${buyerAgentId}:${productIds.sort().join(',')}:${amountPaise}:${timeWindow}`;
  return sha256(dataToHash);
}

/**
 * Checks if a transaction with the given idempotency key already exists.
 * @param key - The idempotency key to check.
 * @returns The existing transaction, or null if not found.
 */
export async function checkDuplicate(key: IdempotencyKey): Promise<CommerceTransaction | null> {
  return CommerceDatabase.getTransactionByIdempotencyKey(key);
}
