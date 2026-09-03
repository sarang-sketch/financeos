import { describe, expect, it } from 'vitest';
import { Secret } from '@/config/env';
import {
  CREDENTIAL_ENVELOPE_VERSION,
  CredentialDecryptionError,
  openCredential,
  sealCredential,
  type CredentialBinding,
} from '@/config/credential-crypto';

/**
 * Every plaintext in this file carries a sentinel. No ciphertext, no error message, no
 * stack, and no serialisation may contain it — the same discipline `env.test.ts` uses for
 * `Secret`, applied to the credential envelope (Requirement 14.5).
 */
const SENTINEL = 'SENTINEL_CREDENTIAL_DO_NOT_LEAK';

const KEY = new Secret('CREDENTIAL_ENCRYPTION_KEY', 'unit-test-master-key-0123456789abcdef');
const OTHER_KEY = new Secret('CREDENTIAL_ENCRYPTION_KEY', 'other-master-key-fedcba9876543210xyz');

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

const PROVIDER: CredentialBinding = { tenantId: TENANT, slot: 'provider_keys' };
const RAZORPAY: CredentialBinding = { tenantId: TENANT, slot: 'razorpay_test' };

const VALUE = `gsk_live_${SENTINEL}`;

describe('sealCredential / openCredential', () => {
  it('round-trips a credential value', () => {
    const sealed = sealCredential(VALUE, KEY, PROVIDER);

    expect(openCredential(sealed, KEY, PROVIDER).reveal()).toBe(VALUE);
  });

  it('writes the version byte first, so a future scheme is distinguishable on read', () => {
    const sealed = sealCredential(VALUE, KEY, PROVIDER);

    expect(sealed[0]).toBe(CREDENTIAL_ENVELOPE_VERSION);
  });

  it('produces different bytes each time, because the IV is fresh per seal', () => {
    const a = Buffer.from(sealCredential(VALUE, KEY, PROVIDER)).toString('hex');
    const b = Buffer.from(sealCredential(VALUE, KEY, PROVIDER)).toString('hex');

    expect(a).not.toBe(b);
    // Different ciphertext, same plaintext: nothing is inferable from ciphertext equality.
    expect(openCredential(Uint8Array.from(Buffer.from(a, 'hex')), KEY, PROVIDER).reveal()).toBe(
      openCredential(Uint8Array.from(Buffer.from(b, 'hex')), KEY, PROVIDER).reveal(),
    );
  });

  it('holds no plaintext in the sealed bytes', () => {
    const sealed = Buffer.from(sealCredential(VALUE, KEY, PROVIDER));

    expect(sealed.toString('utf8')).not.toContain(SENTINEL);
    expect(sealed.toString('latin1')).not.toContain(SENTINEL);
    expect(sealed.toString('hex')).not.toContain(Buffer.from(SENTINEL, 'utf8').toString('hex'));
  });

  it('rejects a tampered ciphertext instead of returning altered bytes', () => {
    const sealed = Buffer.from(sealCredential(VALUE, KEY, PROVIDER));
    sealed[sealed.length - 1] = (sealed.at(-1) ?? 0) ^ 0xff;

    expect(() => openCredential(sealed, KEY, PROVIDER)).toThrowError(CredentialDecryptionError);
  });

  it('rejects a tampered authentication tag', () => {
    const sealed = Buffer.from(sealCredential(VALUE, KEY, PROVIDER));
    sealed[14] = (sealed[14] ?? 0) ^ 0x01;

    expect(() => openCredential(sealed, KEY, PROVIDER)).toThrowError(CredentialDecryptionError);
  });

  it('rejects a ciphertext replayed into another Tenant, because the tag binds the Tenant', () => {
    const sealed = sealCredential(VALUE, KEY, PROVIDER);

    expect(() =>
      openCredential(sealed, KEY, { tenantId: OTHER_TENANT, slot: 'provider_keys' }),
    ).toThrowError(CredentialDecryptionError);
  });

  it('rejects a ciphertext moved into the other credential slot', () => {
    const sealed = sealCredential(VALUE, KEY, PROVIDER);

    expect(() => openCredential(sealed, KEY, RAZORPAY)).toThrowError(CredentialDecryptionError);
  });

  it('rejects a ciphertext under the wrong key', () => {
    const sealed = sealCredential(VALUE, KEY, PROVIDER);

    expect(() => openCredential(sealed, OTHER_KEY, PROVIDER)).toThrowError(
      CredentialDecryptionError,
    );
  });

  it('rejects a truncated envelope', () => {
    expect(() => openCredential(new Uint8Array(10), KEY, PROVIDER)).toThrowError(
      /shorter than/,
    );
  });

  it('rejects an unknown envelope version', () => {
    const sealed = Buffer.from(sealCredential(VALUE, KEY, PROVIDER));
    sealed[0] = 99;

    expect(() => openCredential(sealed, KEY, PROVIDER)).toThrowError(/envelope version/);
  });

  it('names the slot but never the value or the key in a failure', () => {
    const sealed = sealCredential(VALUE, KEY, PROVIDER);
    const attempts = [
      () => openCredential(sealed, KEY, { tenantId: OTHER_TENANT, slot: 'provider_keys' }),
      () => openCredential(sealed, OTHER_KEY, PROVIDER),
      () => openCredential(new Uint8Array(4), KEY, PROVIDER),
    ];

    for (const attempt of attempts) {
      try {
        attempt();
        expect.unreachable('the credential must not open');
      } catch (error) {
        const thrown = error as Error;
        expect(thrown).toBeInstanceOf(CredentialDecryptionError);
        expect(thrown.message).toContain('provider_keys');
        expect(thrown.message).not.toContain(SENTINEL);
        expect(thrown.stack ?? '').not.toContain(SENTINEL);
        expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(
          SENTINEL,
        );
      }
    }
  });

  it('returns the plaintext as a Secret, so it cannot serialise by accident', () => {
    const opened = openCredential(sealCredential(VALUE, KEY, PROVIDER), KEY, PROVIDER);

    expect(`${opened}`).toBe('[redacted:credential:provider_keys]');
    expect(JSON.stringify({ credential: opened })).not.toContain(SENTINEL);
    expect(String(opened)).not.toContain(SENTINEL);
    // The value is reachable only through the explicit, grep-able call.
    expect(opened.reveal()).toBe(VALUE);
  });

  it('round-trips a value that is itself JSON, which is how the provider map is stored', () => {
    const map = JSON.stringify({ gemini: `AIza_${SENTINEL}`, groq: `gsk_${SENTINEL}` });

    const opened = openCredential(sealCredential(map, KEY, PROVIDER), KEY, PROVIDER);

    expect(JSON.parse(opened.reveal())).toEqual({
      gemini: `AIza_${SENTINEL}`,
      groq: `gsk_${SENTINEL}`,
    });
  });
});
