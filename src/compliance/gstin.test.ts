import { describe, expect, it } from 'vitest';
import { validateGstin } from './gstin';

describe('GSTIN structural validation (Requirement 6.3)', () => {
  it('validates a correct Karnataka GSTIN', () => {
    // 29 Karnataka, ABCDE1234F PAN, 1 entity num, Z default, 5 checksum
    const result = validateGstin('29ABCDE1234F1Z5');
    expect(result.valid).toBe(true);
    expect(result.failingRule).toBeUndefined();
  });

  it('validates boundary state codes 01 (Jammu & Kashmir) and 38 (Ladakh)', () => {
    expect(validateGstin('01ABCDE1234F1Z1').valid).toBe(true);
    expect(validateGstin('38ABCDE1234F1Z9').valid).toBe(true);
  });

  it('rejects state code 00 or 39 as invalid_state_code', () => {
    const res00 = validateGstin('00ABCDE1234F1Z1');
    expect(res00.valid).toBe(false);
    expect(res00.failingRule).toBe('invalid_state_code');

    const res39 = validateGstin('39ABCDE1234F1Z1');
    expect(res39.valid).toBe(false);
    expect(res39.failingRule).toBe('invalid_state_code');
  });

  it('rejects length != 15 as invalid_length', () => {
    expect(validateGstin('29ABCDE1234F1Z').failingRule).toBe('invalid_length');
    expect(validateGstin('29ABCDE1234F1Z50').failingRule).toBe('invalid_length');
    expect(validateGstin(null as unknown as string).failingRule).toBe('invalid_length');
  });

  it('rejects malformed PAN part as invalid_pan_format', () => {
    // 4 letters instead of 5
    expect(validateGstin('29ABCD11234F1Z5').failingRule).toBe('invalid_pan_format');
    // letter in digit part
    expect(validateGstin('29ABCDEX234F1Z5').failingRule).toBe('invalid_pan_format');
  });

  it('rejects character 14 != Z as invalid_entity_code_z', () => {
    expect(validateGstin('29ABCDE1234F1A5').failingRule).toBe('invalid_entity_code_z');
    expect(validateGstin('29ABCDE1234F195').failingRule).toBe('invalid_entity_code_z');
  });

  it('rejects character 15 non-alphanumeric as invalid_checksum_char', () => {
    expect(validateGstin('29ABCDE1234F1Z!').failingRule).toBe('invalid_checksum_char');
    expect(validateGstin('29ABCDE1234F1Z_').failingRule).toBe('invalid_checksum_char');
  });
});
