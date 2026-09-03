/**
 * CommerceOS Protocol Adapter Interface
 *
 * Defines the contract for translating between external agentic commerce protocols
 * (e.g. AP2, UCP, ACP, or internal demo protocols) and the canonical internal
 * CommerceOS model.
 */

import type {
  CommerceIntent,
  CommerceOffer,
  CommerceAuthorization,
  CommercePaymentTransaction,
  CommerceResult,
} from './types';

/**
 * Protocol adapter interface — translates between external protocol formats
 * and the internal commerce model.
 */
export interface ProtocolAdapter {
  /** Identifier of the protocol (e.g. 'INTERNAL', 'AP2', 'UCP', 'ACP') */
  readonly protocolName: string;

  /** Version of the protocol specification implemented */
  readonly protocolVersion: string;

  /**
   * Parse an incoming external request into a canonical CommerceIntent.
   * @throws Error if the incoming payload cannot be parsed or validated.
   */
  parseIntent(externalRequest: unknown): CommerceIntent;

  /**
   * Format an internal offer for the external protocol.
   */
  formatOffer(offer: CommerceOffer): unknown;

  /**
   * Format an internal authorization result for the external protocol.
   */
  formatAuthorization(auth: CommerceAuthorization): unknown;

  /**
   * Format a final execution result for the external protocol.
   */
  formatResult(result: CommerceResult): unknown;
}

export type {
  CommerceIntent,
  CommerceOffer,
  CommerceAuthorization,
  CommercePaymentTransaction,
  CommerceResult,
};
