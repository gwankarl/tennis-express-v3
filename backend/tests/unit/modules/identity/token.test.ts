import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  digestIdentityToken,
  generateEmailVerificationToken,
  generatePasswordRecoveryToken,
  generateSessionToken,
  isTokenExpired,
} from '../../../../src/modules/identity/token.js';

describe('identity token utilities', () => {
  it.each([
    ['session', generateSessionToken],
    ['email verification', generateEmailVerificationToken],
    ['password recovery', generatePasswordRecoveryToken],
  ])('generates and digests a %s token', (_purpose, generate) => {
    const token = generate();

    expect(token.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(token.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(token.digest).toBe(createHash('sha256').update(token.rawToken, 'utf8').digest('hex'));
    expect(digestIdentityToken(token.rawToken)).toBe(token.digest);
  });

  it('generates distinct raw tokens', () => {
    expect(generateSessionToken().rawToken).not.toBe(generateSessionToken().rawToken);
  });
});

describe('isTokenExpired', () => {
  const expiry = new Date('2030-05-01T12:00:00.000Z');

  it('returns false immediately before expiry', () => {
    expect(isTokenExpired(expiry, new Date('2030-05-01T11:59:59.999Z'))).toBe(false);
  });

  it('returns true exactly at the expiry timestamp', () => {
    expect(isTokenExpired(expiry, new Date('2030-05-01T12:00:00.000Z'))).toBe(true);
  });

  it('returns true after expiry', () => {
    expect(isTokenExpired(expiry, new Date('2030-05-01T12:00:00.001Z'))).toBe(true);
  });
});
