/**
 * CommerceOS Protocol Adapter — Internal Adapter
 *
 * Direct pass-through adapter for internal UI interactions and demo flows,
 * requiring no protocol translation.
 */

import type { ProtocolAdapter } from './adapter';
import type {
  CommerceIntent,
  CommerceOffer,
  CommerceAuthorization,
  CommerceResult,
} from './types';

/**
 * Direct adapter for the demo UI and internal services (no protocol translation needed).
 */
export class InternalAdapter implements ProtocolAdapter {
  readonly protocolName = 'INTERNAL';
  readonly protocolVersion = '1.0';

  /**
   * Parse an incoming internal request into a CommerceIntent.
   */
  parseIntent(request: unknown): CommerceIntent {
    return request as CommerceIntent;
  }

  /**
   * Format an offer directly for internal consumption.
   */
  formatOffer(offer: CommerceOffer): unknown {
    return offer;
  }

  /**
   * Format an authorization directly for internal consumption.
   */
  formatAuthorization(auth: CommerceAuthorization): unknown {
    return auth;
  }

  /**
   * Format a commerce execution result directly for internal consumption.
   */
  formatResult(result: CommerceResult): unknown {
    return result;
  }
}
