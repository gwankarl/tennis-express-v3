import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));

vi.mock('~/.server/env.js', () => ({ loadFrontendConfig: loadConfigMock }));
vi.mock('~/.server/api-client.js', () => {
  class ApiRequestError extends Error {
    constructor(
      readonly kind: string,
      message: string,
      options: { status?: number; errorCode?: string } = {},
    ) {
      super(message);
      this.name = 'ApiRequestError';
      this.status = options.status;
      this.errorCode = options.errorCode;
    }

    readonly status?: number;
    readonly errorCode?: string;
  }

  return { ApiRequestError, requestJson: vi.fn() };
});

import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { appendAdminMfaChallengeCookie } from '~/.server/auth/admin-mfa.js';
import { issueSessionCsrfToken } from '~/.server/auth/request-protection.js';
import { action } from '~/routes/admin/mfa-challenge.js';

const requestJsonMock = vi.mocked(requestJson);
const origin = 'http://127.0.0.1:5173';
const sessionToken = 'S'.repeat(43);
const challenge = 'C'.repeat(43);
const rotatedToken = 'R'.repeat(43);
const settings = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: origin,
  csrfSecret: 'unit-test-secret-with-more-than-32-bytes',
};
const challengeExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
const sessionExpiry = new Date(Date.now() + 12 * 60 * 60_000).toISOString();

function makeRequest(
  fields: Record<string, string>,
  requestOrigin = origin,
  includeChallenge = false,
): Request {
  const csrfToken = issueSessionCsrfToken(
    new Request(`${origin}/admin/mfa/challenge`),
    sessionToken,
    settings,
  );
  const headers = new Headers({
    origin: requestOrigin,
    'content-type': 'application/x-www-form-urlencoded',
  });

  if (includeChallenge) {
    const challengeHeaders = new Headers();
    appendAdminMfaChallengeCookie(
      new Request(`${origin}/admin/mfa/challenge`),
      challengeHeaders,
      challenge,
      challengeExpiry,
      settings,
    );
    const cookie = challengeHeaders.get('set-cookie')?.split(';', 1)[0];
    headers.set('cookie', `tx_session=${sessionToken}; ${cookie}`);
  } else {
    headers.set('cookie', `tx_session=${sessionToken}`);
  }

  return new Request(`${origin}/admin/mfa/challenge`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ csrfToken, ...fields }),
  });
}

function resultData(result: unknown): Record<string, unknown> {
  if (typeof result === 'object' && result !== null && 'data' in result) {
    return (result as { data: Record<string, unknown> }).data;
  }

  return result as Record<string, unknown>;
}

function resultHeaders(result: unknown): Headers {
  if (result instanceof Response) return result.headers;

  const init = (result as { init?: { headers?: HeadersInit } }).init;
  return new Headers(init?.headers);
}

beforeEach(() => {
  loadConfigMock.mockReturnValue(settings);
  requestJsonMock.mockReset();
});

describe('administrator MFA challenge actions', () => {
  it('stores the challenge in an HttpOnly cookie without returning its value', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockResolvedValueOnce({ challenge, expiresAt: challengeExpiry } as never);

    const result = await action({
      request: makeRequest({
        step: 'start',
        password: 'private-password-value',
        returnTo: '/account',
      }),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'challenge', returnTo: '/account' });
    expect(JSON.stringify(result)).not.toContain(challenge);
    expect(JSON.stringify(result)).not.toContain('private-password-value');

    const cookie = resultHeaders(result).get('set-cookie') ?? '';
    expect(cookie).toContain(`tx_admin_mfa_challenge=${challenge}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/admin/mfa/');
    expect(cookie).toContain('SameSite=Lax');
    expect(requestJsonMock).toHaveBeenNthCalledWith(
      2,
      '/admin/mfa/elevation/challenge',
      expect.objectContaining({
        method: 'POST',
        body: { password: 'private-password-value' },
      }),
    );
  });

  it('replaces the session cookie and clears the challenge after successful confirmation', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockResolvedValueOnce({
        sessionToken: rotatedToken,
        tokenType: 'Bearer',
        expiresAt: sessionExpiry,
        elevatedUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
      } as never);

    const result = await action({
      request: makeRequest(
        { step: 'confirm', code: '123456', returnTo: '/account/profile' },
        origin,
        true,
      ),
    } as Parameters<typeof action>[0]);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/account/profile');

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`tx_session=${rotatedToken}`);
    expect(cookie).toContain('tx_admin_mfa_challenge=');
    expect(cookie).toContain('Max-Age=0');
    expect(JSON.stringify(result)).not.toContain(rotatedToken);
    expect(requestJsonMock).toHaveBeenNthCalledWith(
      2,
      '/admin/mfa/elevation/confirm',
      expect.objectContaining({
        body: { challenge, code: '123456' },
      }),
    );
  });

  it('uses the safe default when the submitted return path is external', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockResolvedValueOnce({
        sessionToken: rotatedToken,
        tokenType: 'Bearer',
        expiresAt: sessionExpiry,
        elevatedUntil: new Date(Date.now() + 15 * 60_000).toISOString(),
      } as never);

    const result = await action({
      request: makeRequest(
        { step: 'confirm', code: '123456', returnTo: '//attacker.example' },
        origin,
        true,
      ),
    } as Parameters<typeof action>[0]);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).headers.get('Location')).toBe('/account');
  });

  it('rejects untrusted origins before calling Fastify', async () => {
    const result = await action({
      request: makeRequest(
        { step: 'start', password: 'private-password-value' },
        'https://attacker.example',
      ),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'blocked' });
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('does not call the elevation endpoint when the challenge cookie is missing', async () => {
    const result = await action({
      request: makeRequest({ step: 'confirm', code: '123456' }),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'invalid', step: 'start' });
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('maps an invalid or expired TOTP response without exposing backend details', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockRejectedValueOnce(
        new ApiRequestError('http', 'private backend detail', {
          status: 400,
          errorCode: 'REQUEST_ERROR',
        }),
      );

    const result = await action({
      request: makeRequest({ step: 'confirm', code: '123456' }, origin, true),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'invalid', step: 'start' });
    expect(JSON.stringify(result)).not.toContain('private backend detail');
    expect(resultHeaders(result).get('set-cookie')).toContain('Max-Age=0');
  });

  it('keeps the old cookie out of action data when the backend is rate limiting', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockRejectedValueOnce(
        new ApiRequestError('http', 'private backend detail', {
          status: 429,
          errorCode: 'REQUEST_ERROR',
        }),
      );

    const result = await action({
      request: makeRequest({ step: 'confirm', code: '123456' }, origin, true),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'limited', step: 'confirm' });
    expect(JSON.stringify(result)).not.toContain(challenge);
  });
});
