import { describe, expect, it } from 'vitest';
import {
  appendAdminEnrollmentAuthorizationCookie,
  appendAdminMfaChallengeCookie,
  clearAdminEnrollmentAuthorizationCookie,
  clearAdminMfaChallengeCookie,
  readAdminEnrollmentAuthorization,
  readAdminMfaChallenge,
} from '~/.server/auth/admin-mfa.js';

const origin = 'http://127.0.0.1:5173';
const config = { frontendOrigin: origin };
const challenge = 'C'.repeat(43);
const authorization = 'A'.repeat(43);

function cookieValue(setCookie: string | null, name: string): string | undefined {
  if (!setCookie) return undefined;

  const first = setCookie.split(';', 1)[0] ?? '';
  const prefix = `${name}=`;

  return first.startsWith(prefix) ? first.slice(prefix.length) : undefined;
}

describe('administrator MFA cookies', () => {
  it('stores and reads a short-lived challenge in a path-scoped HttpOnly cookie', () => {
    const headers = new Headers();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    appendAdminMfaChallengeCookie(
      new Request(`${origin}/admin/mfa/challenge`),
      headers,
      challenge,
      expiresAt,
      config,
    );

    const setCookie = headers.get('set-cookie') ?? '';

    expect(setCookie).toContain(`tx_admin_mfa_challenge=${challenge}`);
    expect(setCookie).toContain('Path=/admin/mfa/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=');
    expect(setCookie).not.toContain('Domain=');
    expect(setCookie).not.toContain('; Secure');

    expect(readAdminMfaChallenge(setCookie)).toBe(challenge);
  });

  it('marks MFA cookies Secure for HTTPS and keeps them host-only', () => {
    const httpsOrigin = 'https://tennis.example';
    const headers = new Headers();

    appendAdminMfaChallengeCookie(
      new Request(`${httpsOrigin}/admin/mfa/challenge`),
      headers,
      challenge,
      new Date(Date.now() + 60_000).toISOString(),
      { frontendOrigin: httpsOrigin },
    );

    const setCookie = headers.get('set-cookie') ?? '';

    expect(setCookie).toContain('; Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).not.toContain('Domain=');
  });

  it('stores recovery authorization only in an HttpOnly enrollment-path cookie', () => {
    const headers = new Headers();
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    appendAdminEnrollmentAuthorizationCookie(
      new Request(`${origin}/admin/mfa/recovery`),
      headers,
      authorization,
      expiresAt,
      config,
    );

    const setCookie = headers.get('set-cookie') ?? '';

    expect(setCookie).toContain(`tx_admin_enrollment_authorization=${authorization}`);
    expect(setCookie).toContain('Path=/admin/mfa/');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Domain=');
    expect(readAdminEnrollmentAuthorization(setCookie)).toBe(authorization);
  });

  it.each([
    ['challenge', readAdminMfaChallenge],
    ['enrollment authorization', readAdminEnrollmentAuthorization],
  ])('rejects malformed and duplicate %s cookies', (_label, readCookie) => {
    const name =
      _label === 'challenge' ? 'tx_admin_mfa_challenge' : 'tx_admin_enrollment_authorization';

    expect(readCookie(`${name}=not-a-token`)).toBeUndefined();
    expect(readCookie(`${name}=${authorization}; ${name}=${authorization}`)).toBeUndefined();
  });

  it('rejects expired cookie deadlines and malformed token values', () => {
    const headers = new Headers();

    expect(() =>
      appendAdminMfaChallengeCookie(
        new Request(`${origin}/admin/mfa/challenge`),
        headers,
        challenge,
        new Date(Date.now() - 1000).toISOString(),
        config,
      ),
    ).toThrow('The administrator MFA response was invalid.');

    expect(() =>
      appendAdminEnrollmentAuthorizationCookie(
        new Request(`${origin}/admin/mfa/enrollment`),
        headers,
        'invalid-token',
        new Date(Date.now() + 60_000).toISOString(),
        config,
      ),
    ).toThrow('The administrator MFA response was invalid.');
  });

  it('clears each cookie using the same path and HttpOnly scope', () => {
    const challengeHeaders = new Headers();
    const enrollmentHeaders = new Headers();

    clearAdminMfaChallengeCookie(
      new Request(`${origin}/admin/mfa/challenge`),
      challengeHeaders,
      config,
    );
    clearAdminEnrollmentAuthorizationCookie(
      new Request(`${origin}/admin/mfa/enrollment`),
      enrollmentHeaders,
      config,
    );

    expect(challengeHeaders.get('set-cookie')).toContain('Path=/admin/mfa/');
    expect(challengeHeaders.get('set-cookie')).toContain('Max-Age=0');
    expect(challengeHeaders.get('set-cookie')).toContain('HttpOnly');

    expect(enrollmentHeaders.get('set-cookie')).toContain('Path=/admin/mfa/');
    expect(enrollmentHeaders.get('set-cookie')).toContain('Max-Age=0');
    expect(enrollmentHeaders.get('set-cookie')).toContain('HttpOnly');
  });

  it('rejects cookie issuance outside the configured origin and off-loopback HTTP', () => {
    const headers = new Headers();
    const expiry = new Date(Date.now() + 60_000).toISOString();

    expect(() =>
      appendAdminMfaChallengeCookie(
        new Request('https://attacker.example/admin/mfa/challenge'),
        headers,
        challenge,
        expiry,
        config,
      ),
    ).toThrow('The browser session origin is invalid.');

    expect(() =>
      appendAdminMfaChallengeCookie(
        new Request('http://tennis.example/admin/mfa/challenge'),
        headers,
        challenge,
        expiry,
        { frontendOrigin: 'http://tennis.example' },
      ),
    ).toThrow('Secure browser sessions require HTTPS.');
  });
});
