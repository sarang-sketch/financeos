/**
 * Authenticated encryption for the per-Tenant credentials stored in
 * `tenant_configuration.razorpay_key_secret_encrypted` and
 * `.provider_keys_encrypted` (Requirement 14.5).
 *
 * ## Why AES-256-GCM and not a stream cipher or a bare CBC mode
 *
 * GCM is authenticated: the 16-byte tag is verified before any plaintext is
 * released, so a ciphertext that has been altered in the database — by a
 * corrupted backup restore, a partial write, or an attacker with table write
 * access but no key — fails to open rather than yielding garbage that a Razorpay
 * or Model_Provider call would then send over the wire as if it were a key. A
 * confidentiality-only mode would decrypt tampered bytes into a plausible-looking
 * string and the failure would surface as a provider auth error, at which point
 * the tampering is indistinguishable from key rotation.
 *
 * ## The envelope
 *
 *     byte 0        envelope version (1)
 *     bytes 1..12   96-bit random IV, fresh for every seal
 *     bytes 13..28  128-bit GCM authentication tag
 *     bytes 29..    ciphertext
 *
 * The version byte is first so a future key-wrapping or KMS-backed scheme can be
 * distinguished on read without a schema migration. The IV is random per seal, so
 * sealing the same value twice produces different bytes and nothing can be
 * inferred from ciphertext equality.
 *
 * ## Additional authenticated data
 *
 * Each seal binds the Tenant identifier and the credential slot into the tag via
 * AAD. A ciphertext lifted from one Tenant's row and pasted into another's
 * therefore fails to open instead of silently making Tenant A's key active for
 * Tenant B. The AAD is not secret; it is a binding, and it is reconstructed on
 * open from the row being read.
 *
 * ## The key
 *
 * The 32-byte cipher key is derived by HKDF-SHA256 from `CREDENTIAL_ENCRYPTION_KEY`,
 * exactly as `.env.example` documents, so any environment string of 32 or more
 * characters yields a well-formed key. Derivation is deterministic — fixed salt and
 * fixed info label — so a restart opens what a previous process sealed.
 *
 * There is no key here and there is no default key. The key arrives as a `Secret`
 * from `@/config/env`, whose loader refuses to start on a missing or short value.
 * Anything that can read the environment can decrypt every stored credential:
 * there is no KMS and no per-Tenant data key in the MVP, and rotating the
 * environment key means re-sealing every stored credential.
 *
 * ## Leak discipline
 *
 * No function here logs. `openCredential` returns a {@link Secret}, not a bare
 * string, so the plaintext inherits the masking of `toString`, `toJSON`,
 * `Symbol.toPrimitive` and the Node inspect hook, and reaching the characters
 * requires an explicit `.reveal()`. {@link CredentialDecryptionError} carries the
 * slot label and a structural reason only — never the ciphertext, never the key,
 * never a partial plaintext.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { Secret } from '@/config/env';

/** The current envelope version. Written as byte 0 of every sealed value. */
export const CREDENTIAL_ENVELOPE_VERSION = 1;

const CIPHER = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/**
 * Fixed HKDF inputs. Changing either value invalidates every stored credential,
 * so they are constants rather than configuration.
 */
const HKDF_SALT = 'financeos:tenant_configuration:credential';
const HKDF_INFO = 'financeos:credential-encryption:aes-256-gcm:v1';

/**
 * The slot a sealed value belongs to. Bound into the authentication tag, so a
 * ciphertext cannot be moved between Tenants or between slots.
 *
 * `provider_keys` is one slot rather than three because the schema gives the three
 * Model_Provider keys a single `provider_keys_encrypted BYTEA` column.
 */
export type CredentialSlot = 'razorpay_test' | 'provider_keys';

/** What the tag binds a ciphertext to. Not secret; a binding. */
export interface CredentialBinding {
  readonly tenantId: string;
  readonly slot: CredentialSlot;
}

/**
 * Thrown when a sealed credential cannot be opened: wrong key, wrong Tenant,
 * wrong slot, truncated bytes, unknown envelope version, or a failed tag check.
 *
 * The message names the slot and the structural reason. It never carries the
 * ciphertext, the key, or any plaintext fragment, because an error message is one
 * of the four channels Requirement 14.5 excludes a credential value from.
 */
export class CredentialDecryptionError extends Error {
  override readonly name = 'CredentialDecryptionError';

  readonly slot: CredentialSlot;

  constructor(binding: CredentialBinding, reason: string) {
    super(
      `stored credential in slot '${binding.slot}' could not be decrypted: ${reason}. ` +
        `No credential value is included in this message.`,
    );
    this.slot = binding.slot;
  }
}

function deriveKey(masterKey: Secret): Buffer {
  // `reveal()` is the sanctioned plaintext access, and it is confined to this line.
  return Buffer.from(hkdfSync('sha256', masterKey.reveal(), HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

function aad(binding: CredentialBinding): Buffer {
  return Buffer.from(`financeos|v1|${binding.tenantId}|${binding.slot}`, 'utf8');
}

/**
 * Encrypt `plaintext` under the deployment key, returning the versioned envelope
 * for the `BYTEA` column. Every call uses a fresh random IV.
 */
export function sealCredential(
  plaintext: string,
  masterKey: Secret,
  binding: CredentialBinding,
): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(CIPHER, deriveKey(masterKey), iv);
  cipher.setAAD(aad(binding));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Uint8Array.from(
    Buffer.concat([Buffer.of(CREDENTIAL_ENVELOPE_VERSION), iv, cipher.getAuthTag(), ciphertext]),
  );
}

/**
 * Decrypt a sealed envelope. The authentication tag is verified first, so a
 * tampered ciphertext raises {@link CredentialDecryptionError} rather than
 * returning altered bytes.
 *
 * Returns a {@link Secret}: the plaintext is reachable only through `.reveal()`,
 * and every serialisation path yields a mask.
 */
export function openCredential(
  sealed: Uint8Array,
  masterKey: Secret,
  binding: CredentialBinding,
): Secret {
  if (sealed.length < HEADER_BYTES + 1) {
    throw new CredentialDecryptionError(
      binding,
      `envelope is ${sealed.length} bytes, shorter than the ${HEADER_BYTES + 1}-byte minimum`,
    );
  }

  const envelope = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  const version = envelope[0];
  if (version !== CREDENTIAL_ENVELOPE_VERSION) {
    throw new CredentialDecryptionError(
      binding,
      `unknown envelope version ${String(version)}, expected ${CREDENTIAL_ENVELOPE_VERSION}`,
    );
  }

  const iv = envelope.subarray(1, 1 + IV_BYTES);
  const tag = envelope.subarray(1 + IV_BYTES, HEADER_BYTES);
  const ciphertext = envelope.subarray(HEADER_BYTES);

  let plaintext: string;
  try {
    const decipher = createDecipheriv(CIPHER, deriveKey(masterKey), iv);
    decipher.setAAD(aad(binding));
    decipher.setAuthTag(tag);
    plaintext = decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
  } catch {
    // The underlying message is discarded rather than wrapped: OpenSSL error text
    // is not a leak channel we control, so nothing from it is propagated.
    throw new CredentialDecryptionError(
      binding,
      'authentication tag check failed — the value was sealed with a different key, ' +
        'for a different Tenant or slot, or the stored bytes were altered',
    );
  }

  return new Secret(`credential:${binding.slot}`, plaintext);
}
