/**
 * CommerceOS Protocol Adapter — Internal Commerce Model Types
 *
 * Protocol-agnostic domain representations for intents, offers,
 * authorizations, transactions, and final results.
 * All monetary amounts are in paise (integer, never float).
 */

/**
 * Structured breakdown of buyer intent requirements.
 */
export interface StructuredCommerceIntent {
  category: string;
  budgetMaxPaise: number;
  requirements: string[];
  deliveryDeadline: string;
  occasion: string | null;
  giftableRequired: boolean;
}

/**
 * The universal internal representation of a commerce intent.
 */
export interface CommerceIntent {
  id: string;
  buyerAgentId: string;
  naturalLanguageQuery: string;
  structuredIntent: StructuredCommerceIntent;
  timestamp: string;
}

/**
 * Upsell bundle option attached to an offer.
 */
export interface CommerceOfferUpsell {
  productId: string;
  pricePaise: number;
}

/**
 * A commerce offer from the merchant agent.
 */
export interface CommerceOffer {
  id: string;
  intentId: string;
  productId: string;
  basePricePaise: number;
  discountPaise: number;
  finalPricePaise: number;
  upsell: CommerceOfferUpsell | null;
  totalPaise: number;
  reasons: string[];
  expiresAt: string;
}

/**
 * Authorization outcome from the Money Firewall.
 */
export interface CommerceAuthorization {
  id: string;
  offerId: string;
  allowed: boolean;
  governanceLevel: string;
  reason: string;
  policySnapshot: Record<string, unknown>;
  sha256Digest: string;
}

/**
 * Allowed status values for payment transactions.
 */
export type CommercePaymentStatus =
  | 'INITIATED'
  | 'PENDING'
  | 'VERIFYING'
  | 'CAPTURED'
  | 'FAILED';

/**
 * A payment transaction record.
 */
export interface CommercePaymentTransaction {
  id: string;
  authorizationId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  amountPaise: number;
  status: CommercePaymentStatus;
}

/**
 * Audit trail entry associated with final execution.
 */
export interface CommerceAuditTrailEntry {
  eventId: string;
  action: string;
  timestamp: string;
  result: string;
}

/**
 * Allowed status values for final commerce results.
 */
export type CommerceResultStatus = 'CONFIRMED' | 'FAILED' | 'TIMEOUT_RECOVERING';

/**
 * The final commerce resolution result.
 */
export interface CommerceResult {
  transactionId: string;
  orderId: string;
  status: CommerceResultStatus;
  auditTrail: CommerceAuditTrailEntry[];
}
