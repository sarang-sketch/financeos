/**
 * Where the Razorpay basic-auth **pair** comes from — the gap task 6.1 left open.
 *
 * The transport needs `{ keyId, keySecret }`. The stores available today give one and a
 * half of those:
 *
 * - `ConfigurationService.readCredentialForServerUse(tenantId, 'razorpay_test')` returns a
 *   single {@link Secret}, the sealed `razorpay_key_secret_encrypted` column.
 * - `tenant_configuration.razorpay_key_id_masked` holds a **mask** —
 *   `[redacted:credential:razorpay_test]`, written by `putCredential` — not the key id. It
 *   is unusable as a basic-auth username by design: the column exists so a client can
 *   learn that a credential is set, not what it is.
 *
 * So there is currently nowhere per-Tenant to keep the basic-auth username, and this
 * module states the resolution rather than leaving each call site to improvise:
 *
 * 1. **A stored `key_id:key_secret` pair is the per-Tenant answer.** The sealed value is
 *    split at its first `:`. That is exactly the shape basic auth encodes, a Razorpay key
 *    id (`rzp_test_…`) contains no colon, and it keeps both halves inside one sealed
 *    envelope, so neither can be read without the encryption key. This is the shape task
 *    7.1's seeding should write.
 * 2. **A stored value with no colon is treated as the secret alone**, and the key id has
 *    to come from the platform's `RAZORPAY_KEY_ID`. That is only correct for the reference
 *    Tenant, so it is permitted **only** when the caller names that Tenant explicitly;
 *    otherwise {@link RazorpayKeyIdUnavailableError} is raised rather than authenticating a
 *    Tenant's ingestion with the platform's key.
 * 3. **No stored credential at all** falls back to the `RAZORPAY_KEY_ID` /
 *    `RAZORPAY_KEY_SECRET` pair, again only for the named reference Tenant. Every other
 *    Tenant gets `CredentialNotConfiguredError` from the configuration service, unchanged.
 *
 * Nothing here reveals a credential. Both halves stay {@link Secret}, so neither can reach
 * a log line, an error message or `JSON.stringify` output without an explicit `.reveal()`,
 * and the only `.reveal()` on this path is the one inside the transport that builds the
 * `Authorization` header (Requirement 14.5).
 */

import {
  CredentialNotConfiguredError,
  type ConfigurationService,
  type TenantId,
} from '@/config/configuration-service';
import { getEnv, Secret, type Env } from '@/config/env';
import {
  createRazorpayClient,
  type RazorpayClient,
  type RazorpayClientDeps,
  type RazorpayCredential,
} from '@/ingestion/razorpay-client';

/**
 * Raised when a Tenant's sealed credential carries only the secret and the Tenant is not
 * the reference Tenant, so no basic-auth username is available for it.
 */
export class RazorpayKeyIdUnavailableError extends Error {
  override readonly name = 'RazorpayKeyIdUnavailableError';

  constructor(tenantId: TenantId) {
    super(
      `no Razorpay key id is available for Tenant ${tenantId}: the stored credential is a ` +
        `secret with no 'key_id:key_secret' prefix, and tenant_configuration.` +
        `razorpay_key_id_masked holds a mask rather than the key id. Store the credential ` +
        `as 'key_id:key_secret'. The platform RAZORPAY_KEY_ID is not used for another ` +
        `Tenant's ingestion.`,
    );
  }
}

export interface RazorpayCredentialSource {
  readonly configuration: ConfigurationService;
  /**
   * The Tenant the platform's own `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` belong to,
   * usually the demo Tenant task 7.1 seeds. Omit it and there is no env fallback at all.
   */
  readonly referenceTenantId?: TenantId;
  readonly env?: Env;
}

/** The pair for one Tenant, resolved per call so a rotation mid-run is picked up. */
export async function resolveRazorpayCredential(
  tenantId: TenantId,
  source: RazorpayCredentialSource,
): Promise<RazorpayCredential> {
  const env = source.env ?? getEnv();
  const isReference =
    source.referenceTenantId !== undefined && source.referenceTenantId === tenantId;

  let stored: Secret;
  try {
    stored = await source.configuration.readCredentialForServerUse(tenantId, 'razorpay_test');
  } catch (cause) {
    if (cause instanceof CredentialNotConfiguredError && isReference) {
      return { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET };
    }
    throw cause;
  }

  // The one reveal on this path, and its two halves are re-wrapped immediately.
  const value = stored.reveal();
  const colon = value.indexOf(':');
  if (colon > 0 && colon < value.length - 1) {
    return {
      keyId: new Secret('RAZORPAY_KEY_ID', value.slice(0, colon)),
      keySecret: new Secret('RAZORPAY_KEY_SECRET', value.slice(colon + 1)),
    };
  }

  if (!isReference) {
    throw new RazorpayKeyIdUnavailableError(tenantId);
  }
  return { keyId: env.RAZORPAY_KEY_ID, keySecret: stored };
}

/**
 * A transport bound to one Tenant's credential.
 *
 * The credential is passed as a thunk, so it is resolved per request rather than captured
 * as plaintext for the life of the client, and a rotation mid-run is picked up on the next
 * request (`RazorpayClientDeps.credential`).
 */
export function createRazorpayClientForTenant(
  tenantId: TenantId,
  source: RazorpayCredentialSource,
  overrides: Omit<RazorpayClientDeps, 'credential'> = {},
): RazorpayClient {
  return createRazorpayClient({
    ...overrides,
    credential: () => resolveRazorpayCredential(tenantId, source),
  });
}
