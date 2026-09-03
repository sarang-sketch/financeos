/**
 * GSTIN (Goods and Services Tax Identification Number) structural validator.
 *
 * Requirements: 6.2
 * Format: 15-character string structured as follows:
 *   - Characters 1-2: 2-digit State Code (01-38)
 *   - Characters 3-12: 10-character PAN of the entity (5 uppercase letters, 4 digits, 1 uppercase letter)
 *   - Character 13: 1-character entity code (alphanumeric)
 *   - Character 14: Default character 'Z'
 *   - Character 15: 1-character alphanumeric checksum
 *
 * Rules are checked strictly in order 1 -> 2 -> 3 -> 4 -> 5.
 */

export type GstinValidationFailure =
  | 'invalid_length'
  | 'invalid_state_code'
  | 'invalid_pan_format'
  | 'invalid_entity_code_z'
  | 'invalid_checksum_char';

export interface GstinValidationResult {
  readonly valid: boolean;
  readonly failingRule?: GstinValidationFailure;
  readonly reason?: string;
}

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const ALPHANUMERIC_REGEX = /^[A-Z0-9]$/;

/**
 * Validates a GSTIN string against the 5 structural rules in sequence.
 */
export function validateGstin(gstin: string): GstinValidationResult {
  // Rule 1: Exactly 15 characters
  if (!gstin || typeof gstin !== 'string' || gstin.length !== 15) {
    return {
      valid: false,
      failingRule: 'invalid_length',
      reason: `Expected 15 characters, got ${gstin ? gstin.length : 'empty'}`,
    };
  }

  // Rule 2: Characters 1-2 (State Code) must be two numeric digits between 01 and 38
  const stateCodeStr = gstin.slice(0, 2);
  if (!/^\d{2}$/.test(stateCodeStr)) {
    return {
      valid: false,
      failingRule: 'invalid_state_code',
      reason: `State code "${stateCodeStr}" must be 2 digits`,
    };
  }
  const stateCode = parseInt(stateCodeStr, 10);
  if (stateCode < 1 || stateCode > 38) {
    return {
      valid: false,
      failingRule: 'invalid_state_code',
      reason: `State code "${stateCodeStr}" is outside valid range (01-38)`,
    };
  }

  // Rule 3: Characters 3-12 (PAN) must match 5 uppercase letters, 4 digits, 1 uppercase letter
  const pan = gstin.slice(2, 12);
  if (!PAN_REGEX.test(pan)) {
    return {
      valid: false,
      failingRule: 'invalid_pan_format',
      reason: `PAN part "${pan}" does not match PAN format [A-Z]{5}[0-9]{4}[A-Z]`,
    };
  }

  // Rule 4: Character 14 (index 13) is 'Z'
  const char14 = gstin.charAt(13);
  if (char14 !== 'Z') {
    return {
      valid: false,
      failingRule: 'invalid_entity_code_z',
      reason: `Character 14 is "${char14}", expected "Z"`,
    };
  }

  // Rule 5: Character 15 (index 14) is alphanumeric
  const char15 = gstin.charAt(14);
  if (!ALPHANUMERIC_REGEX.test(char15)) {
    return {
      valid: false,
      failingRule: 'invalid_checksum_char',
      reason: `Character 15 is "${char15}", expected an alphanumeric checksum character`,
    };
  }

  return { valid: true };
}
