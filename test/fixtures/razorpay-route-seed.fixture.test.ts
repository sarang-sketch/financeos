import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type JsonObject = Record<string, unknown>;
const fixturePath = fileURLToPath(new URL('./razorpay-seed.json', import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as JsonObject;
const object = (value: unknown): JsonObject => value as JsonObject;
const list = (value: unknown): JsonObject[] => value as JsonObject[];
const wire = (value: unknown): bigint => BigInt(value as string);
const partB = object(fixture.part_b_synthetic);
const route = object(partB.route);
const expected = object(route.expected);

describe('Razorpay Route seed fixtures (task 19.8)', () => {
  it('keeps every Route payload explicitly synthetic and ingestion-ready', () => {
    const objects = [
      ...list(route.linked_accounts),
      ...list(route.settlements_received),
      ...list(route.transfers),
      ...list(route.transfer_reversals),
    ];
    expect(objects).toHaveLength(12);
    for (const entry of objects) {
      const payload = object(entry.payload);
      expect(payload._financeos_synthetic).toBe(true);
      expect(payload._financeos_synthetic_note).toContain('SYNTHETIC');
    }
  });

  it('contains partial and full reversals using their own integer-paise amounts', () => {
    const reversals = object(expected.reversals);
    const partial = object(reversals.partial);
    const full = object(reversals.full);
    expect(wire(partial.reversal_amount_paise)).toBeGreaterThan(0n);
    expect(wire(partial.reversal_amount_paise)).toBeLessThan(wire(partial.transfer_amount_paise));
    expect(wire(full.reversal_amount_paise)).toBe(wire(full.transfer_amount_paise));
  });

  it('states conservation, on-hold exclusion, pending, and over-allocation exactly', () => {
    const normal = object(expected.normal_split);
    expect(wire(normal.net_transfers_paise) + wire(normal.platform_commission_paise) +
      wire(normal.razorpay_fee_paise) + wire(normal.gst_on_fee_paise)).toBe(wire(normal.payment_amount_paise));
    expect(object(expected.on_hold)).toMatchObject({ excluded_from_expected_payout: true, expected_payout_paise: '0' });
    expect(object(expected.zero_settlement)).toMatchObject({ settlement_ids: [], classification: 'pending', creates_seller_settlement_mismatch: false });
    const over = object(expected.over_allocated_split);
    expect(wire(over.transfers_total_paise) - wire(over.payment_amount_paise)).toBe(wire(over.exception_impact_paise));
    expect(wire(over.exception_impact_paise)).toBeGreaterThan(0n);
  });
});