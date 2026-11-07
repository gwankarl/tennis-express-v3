import { describe, expect, it } from 'vitest';
import { checkPasswordPolicy } from '../../../../../src/modules/identity/passwords/password-policy.js';

describe('checkPasswordPolicy', () => {
  it.each([
    ['14 code points fail', 'a'.repeat(14), false],
    ['15 code points pass', 'a'.repeat(15), true],
    ['128 code points pass', 'a'.repeat(128), true],
    ['129 code points fail', 'a'.repeat(129), false],
    ['15 emoji code points pass', '🎾'.repeat(15), true],
    ['a passphrase with spaces passes', 'long tennis passphrase', true],
  ])('%s', (_description, password, expectedValid) => {
    expect(checkPasswordPolicy(password).valid).toBe(expectedValid);
  });
});
