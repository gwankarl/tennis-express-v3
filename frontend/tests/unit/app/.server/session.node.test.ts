import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requestJsonMock } = vi.hoisted(() => ({ requestJsonMock: vi.fn() }));

vi.mock('~/.server/api-client.js', () => {
  class ApiRequestError extends Error {
    constructor(
      readonly kind: string,
      message: string,
      readonly options: { status?: number; errorCode?: string } = {},
    ) {
      super(message);
    }

    get status() {
      return this.options.status;
    }

    get errorCode() {
      return this.options.errorCode;
    }
  }

  return { ApiRequestError, requestJson: requestJsonMock };
});

import { ApiRequestError } from '~/.server/api-client.js';
import {
  appendSessionCookie,
  loadProtectedUser,
  safeReturnTo,
} from '~/.server/auth/session.js';
import {
  issueSessionCsrfToken,
  withProtectedSessionFormRequest,
} from '~/.server/auth/request-protection.js';

const origin = 'http://127.0.0.1:5173';
const sessionToken = 'S'.repeat(43);
const otherSessionToken = 'T'.repeat(43);
const config = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: origin,
  csrfSecret: 'session-test-secret-with-more-than-32-bytes',
};

function sessionFormRequest(
  token: string,
  csrfToken: string,
  options: { origin?: string; referer?: string } = {},
): Request {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    cookie: `tx_session=${token}`,
  });
  if (options.origin !== undefined) headers.set('origin', options.origin);
  if (options.referer !== undefined) headers.set('referer', options.referer);

  return new Request(`${origin}/account`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ csrfToken }),
  });
}

beforeEach(() => requestJsonMock.mockReset());
afterEach(() => vi.useRealTimers());

describe('browser session helpers', () => {
  it('sets a host-only HttpOnly Lax cookie capped at the backend deadline', () => {
    const headers = new Headers();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    appendSessionCookie(new Request(`${origin}/login`), headers, sessionToken, expiresAt, config);

    const cookie = headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`tx_session=${sessionToken}`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toMatch(/;\s*Domain=/iu);
    expect(cookie).not.toContain('Secure');
    expect(Number(cookie.match(/Max-Age=(\d+)/u)?.[1])).toBeLessThanOrEqual(3600);
  });

  it('adds Secure over HTTPS and rejects expired or non-loopback HTTP cookies', () => {
    const secureHeaders = new Headers();
    appendSessionCookie(
      new Request('https://tennis.example/login'),
      secureHeaders,
      sessionToken,
      new Date(Date.now() + 60_000).toISOString(),
      { ...config, frontendOrigin: 'https://tennis.example' },
    );
    expect(secureHeaders.get('set-cookie')).toContain('; Secure');

    expect(() =>
      appendSessionCookie(
        new Request(`${origin}/login`),
        new Headers(),
        sessionToken,
        new Date(Date.now() - 1000).toISOString(),
        config,
      ),
    ).toThrow();

    expect(() =>
      appendSessionCookie(
        new Request('http://example.test/login'),
        new Headers(),
        sessionToken,
        new Date(Date.now() + 60_000).toISOString(),
        { ...config, frontendOrigin: 'http://example.test' },
      ),
    ).toThrow();
  });

  it('accepts only safe same-app return destinations', () => {
    expect(safeReturnTo('/account?tab=profile')).toBe('/account?tab=profile');
    expect(safeReturnTo('//attacker.example')).toBe('/account');
    expect(safeReturnTo('/\\attacker.example')).toBe('/account');
    expect(safeReturnTo('https://attacker.example')).toBe('/account');
  });

  it('binds the sign-out CSRF token to its session and rejects expiry/origin failures before callback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T12:00:00.000Z'));
    const pageRequest = new Request(`${origin}/account`);
    const csrfToken = issueSessionCsrfToken(pageRequest, sessionToken, config);
    const operation = vi.fn(async () => 'called');

    await expect(
      withProtectedSessionFormRequest(
        sessionFormRequest(otherSessionToken, csrfToken),
        otherSessionToken,
        config,
        operation,
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      withProtectedSessionFormRequest(
        sessionFormRequest(sessionToken, csrfToken, { origin: 'https://attacker.example' }),
        sessionToken,
        config,
        operation,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(operation).not.toHaveBeenCalled();

    vi.setSystemTime(new Date('2026-11-08T12:16:00.000Z'));
    await expect(
      withProtectedSessionFormRequest(
        sessionFormRequest(sessionToken, csrfToken),
        sessionToken,
        config,
        operation,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(operation).not.toHaveBeenCalled();
  });

  it('redirects expired sessions and clears their cookie, but treats outages separately', async () => {
    const request = new Request(`${origin}/account`, {
      headers: { cookie: `tx_session=${sessionToken}` },
    });
    requestJsonMock.mockRejectedValueOnce(
      new ApiRequestError('http', 'private backend error', {
        status: 401,
        errorCode: 'REQUEST_ERROR',
      }),
    );

    let redirectResponse: Response | undefined;
    try {
      await loadProtectedUser(request, config);
    } catch (error) {
      if (error instanceof Response) redirectResponse = error;
    }

    expect(redirectResponse?.status).toBe(302);
    expect(redirectResponse?.headers.get('location')).toContain('/login?returnTo=');
    expect(redirectResponse?.headers.get('set-cookie')).toContain('Max-Age=0');

    requestJsonMock.mockRejectedValueOnce('private URL');
    await expect(loadProtectedUser(request, config)).resolves.toEqual({ status: 'unavailable' });
  });
});
