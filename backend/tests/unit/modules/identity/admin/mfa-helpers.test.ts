import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptMfaSeed,
  encryptMfaSeed,
  MfaCryptoError,
} from '../../../../../src/modules/identity/admin/mfa-crypto.js';
import {
  digestRecoveryCode,
  generateRecoveryCodes,
} from '../../../../../src/modules/identity/admin/recovery-codes.js';
import {
  createTotpCode,
  createTotpProvisioningUri,
  generateTotpSecret,
  verifyTotpCode,
} from '../../../../../src/modules/identity/admin/totp.js';

describe('administrator MFA seed encryption', () => {
  const key = randomBytes(32).toString('base64');
  const context = {
    userId: '11111111-1111-4111-8111-111111111111',
    factorId: '22222222-2222-4222-8222-222222222222',
  };

  it('round-trips a seed with its key version and factor context', () => {
    const seed = generateTotpSecret();
    const encrypted = encryptMfaSeed(seed, key, 'v1', context);

    expect(encrypted.keyVersion).toBe('v1');
    expect(encrypted.secretCiphertext).not.toContain(seed);
    expect(decryptMfaSeed(encrypted.secretCiphertext, key, 'v1', context)).toBe(seed);
  });

  it('rejects a ciphertext used with a different factor context', () => {
    const encrypted = encryptMfaSeed(generateTotpSecret(), key, 'v1', context);

    expect(() =>
      decryptMfaSeed(encrypted.secretCiphertext, key, 'v1', {
        ...context,
        factorId: '33333333-3333-4333-8333-333333333333',
      }),
    ).toThrow(MfaCryptoError);
  });

  it('rejects an altered ciphertext', () => {
    const encrypted = encryptMfaSeed(generateTotpSecret(), key, 'v1', context);
    const parts = encrypted.secretCiphertext.split('.');
    parts[3] = `${parts[3]}A`;

    expect(() => decryptMfaSeed(parts.join('.'), key, 'v1', context)).toThrow(MfaCryptoError);
  });
});

describe('TOTP helpers', () => {
  it('creates and verifies a code using an explicit clock time', () => {
    const secret = generateTotpSecret();
    const now = new Date('2030-05-01T12:00:00.000Z');
    const currentStep = Math.floor(now.getTime() / 1000 / 30);
    const code = createTotpCode(secret, currentStep);

    expect(verifyTotpCode(secret, code, now)).toBe(currentStep);
    expect(verifyTotpCode(secret, 'not-code', now)).toBeNull();
    expect(verifyTotpCode(secret, '000000', new Date(Number.NaN))).toBeNull();
  });

  it('builds a standards-compatible authenticator provisioning URI', () => {
    const secret = generateTotpSecret();
    const uri = createTotpProvisioningUri(secret, 'admin@example.test');
    const parsed = new URL(uri);

    expect(parsed.protocol).toBe('otpauth:');
    expect(parsed.hostname).toBe('totp');
    expect(parsed.searchParams.get('secret')).toBe(secret);
    expect(parsed.searchParams.get('issuer')).toBe('Tennis Xpress');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
  });
});

describe('recovery-code helpers', () => {
  it('generates ten unique display codes and separate SHA-256 digests', () => {
    const generated = generateRecoveryCodes();

    expect(generated.rawCodes).toHaveLength(10);
    expect(generated.digests).toHaveLength(10);
    expect(new Set(generated.rawCodes).size).toBe(10);
    expect(new Set(generated.digests).size).toBe(10);
    expect(generated.digests.every((digest) => /^[a-f0-9]{64}$/u.test(digest))).toBe(true);
    expect(
      generated.rawCodes.every(
        (code, index) => digestRecoveryCode(code) === generated.digests[index],
      ),
    ).toBe(true);
  });

  it('accepts spacing and case normalization but rejects malformed codes', () => {
    const code = generateRecoveryCodes().rawCodes[0]!;

    expect(digestRecoveryCode(code.toLowerCase())).toBe(
      digestRecoveryCode(code.replaceAll('-', ' ')),
    );
    expect(() => digestRecoveryCode('not-a-recovery-code')).toThrow('Recovery code is invalid.');
  });
});
