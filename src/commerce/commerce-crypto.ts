/**
 * CommerceOS Audit Cryptography
 *
 * Real SHA-256 audit digests for the commerce audit ledger.
 * Every audit event gets a deterministic hash computed from:
 *   1. The event's own data (actor, action, input, decision, policy, result)
 *   2. The previous event's digest (chain-linking for tamper evidence)
 *
 * Uses Node.js `crypto` — no external dependencies.
 */

import { createHash } from 'node:crypto';

/**
 * Canonical JSON serialization (simplified RFC 8785):
 * - Keys sorted lexicographically at every level
 * - No whitespace
 * - Deterministic output for the same input
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `"${value.toString()}"`;

  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJson(item));
    return `[${items.join(',')}]`;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    );
    return `{${pairs.join(',')}}`;
  }

  return JSON.stringify(value);
}

/**
 * Compute SHA-256 hex digest from canonical JSON of the given data.
 */
export function sha256(data: unknown): string {
  const canonical = canonicalJson(data);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * The audit event payload shape used for digest computation.
 * Matches the `commerce_audit_events` table columns.
 */
export interface AuditDigestPayload {
  transaction_id?: string | null;
  order_id?: string | null;
  actor: string;
  action: string;
  input: Record<string, unknown>;
  decision: Record<string, unknown>;
  reason: string;
  policy_snapshot: Record<string, unknown>;
  result: string;
}

/**
 * Compute the SHA-256 digest for an audit event.
 *
 * The digest chains to the previous event's digest for tamper evidence:
 *   digest = SHA-256(previous_digest + canonical(payload))
 *
 * If there is no previous event (first event in chain), uses the string
 * "GENESIS" as the chain seed.
 */
export function computeAuditDigest(
  payload: AuditDigestPayload,
  previousDigest: string = 'GENESIS'
): string {
  const canonical = canonicalJson(payload);
  return createHash('sha256')
    .update(previousDigest + canonical, 'utf8')
    .digest('hex');
}

/**
 * Generate a unique event ID with timestamp prefix for ordering.
 * Format: evt_{timestamp}_{random}
 */
export function generateEventId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `evt_${ts}_${rand}`;
}

/**
 * Generate a unique order ID.
 * Format: ORD-{sequential_number}
 */
let orderCounter = 1000;
export function generateOrderId(): string {
  orderCounter += 1;
  return `ORD-${orderCounter}`;
}

/**
 * Generate a unique transaction ID.
 * Format: txn_{timestamp}_{random}
 */
export function generateTransactionId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `txn_${ts}_${rand}`;
}
