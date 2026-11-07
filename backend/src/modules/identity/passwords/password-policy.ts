export const PASSWORD_MIN_CODE_POINTS = 15;
export const PASSWORD_MAX_CODE_POINTS = 128;

export type PasswordPolicyResult =
  | { valid: true; codePointCount: number }
  | {
      valid: false;
      reason: 'too_short' | 'too_long';
      codePointCount: number;
    };

/**
 * Checks password length after NFC normalization, matching the password
 * normalization used by the Argon2id helper. Spaces and passphrases are valid.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const codePointCount = [...password.normalize('NFC')].length;

  if (codePointCount < PASSWORD_MIN_CODE_POINTS) {
    return { valid: false, reason: 'too_short', codePointCount };
  }

  if (codePointCount > PASSWORD_MAX_CODE_POINTS) {
    return { valid: false, reason: 'too_long', codePointCount };
  }

  return { valid: true, codePointCount };
}
