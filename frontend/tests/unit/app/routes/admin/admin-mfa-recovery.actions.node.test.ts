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
import { issueSessionCsrfToken } from '~/.server/auth/request-protection.js';
import { action } from '~/routes/admin/mfa-recovery.js';

const requestJsonMock = vi.mocked(requestJson);
const origin = 'http://127.0.0.1:5173';
const sessionToken = 'S'.repeat(43);
const replacementAuthorization = 'A'.repeat(43);
const adminHoldUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const settings = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: origin,
  csrfSecret: 'unit-test-secret-with-more-than-32-bytes',
};

function makeRequest(requestOrigin = origin): Request {
  const csrfToken = issueSessionCsrfToken(
    new Request(`${origin}/admin/mfa/recovery`),
    sessionToken,
    settings,
  );

  return new Request(`${origin}/admin/mfa/recovery`, {
    method: 'POST',
    headers: {
      origin: requestOrigin,
      cookie: `tx_session=${sessionToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrfToken,
      currentPassword: 'private-current-password',
      recoveryCode: 'AB12CD34-AB12CD34-AB12CD34-AB12CD34',
    }),
  });
}

function resultData(result: unknown): Record<string, unknown> {
  if (typeof result === 'object' && result !== null && 'data' in result) {
    return (result as { data: Record<string, unknown> }).data;
  }

  return result as Record<string, unknown>;
}

function resultHeaders(result: unknown): Headers {
  const init = (result as { init?: { headers?: HeadersInit } }).init;
  return new Headers(init?.headers);
}

beforeEach(() => {
  loadConfigMock.mockReturnValue(settings);
  requestJsonMock.mockReset();
});

describe('administrator MFA recovery actions', () => {
  it('sets the replacement enrollment cookie, clears the revoked session, and omits raw credentials', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockResolvedValueOnce({
        status: 'recovered',
        adminHoldUntil,
        notificationSent: true,
        replacementEnrollmentAuthorization: replacementAuthorization,
      } as never);

    const result = await action({
      request: makeRequest(),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toEqual({
      status: 'recovered',
      adminHoldUntil,
      notificationSent: true,
    });
    expect(JSON.stringify(result)).not.toContain(replacementAuthorization);
    expect(JSON.stringify(result)).not.toContain('private-current-password');
    expect(JSON.stringify(result)).not.toContain('AB12CD34');

    const cookies = resultHeaders(result).get('set-cookie') ?? '';
    expect(cookies).toContain(`tx_admin_enrollment_authorization=${replacementAuthorization}`);
    expect(cookies).toContain('Path=/admin/mfa/');
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('SameSite=Lax');
    expect(cookies).toContain('tx_session=');
    expect(cookies).toContain('Max-Age=0');
    expect(requestJsonMock).toHaveBeenNthCalledWith(
      2,
      '/admin/mfa/recovery',
      expect.objectContaining({
        method: 'POST',
        body: {
          currentPassword: 'private-current-password',
          recoveryCode: 'AB12CD34-AB12CD34-AB12CD34-AB12CD34',
        },
      }),
    );
  });

  it('does not call Fastify when the request origin is not trusted', async () => {
    const result = await action({
      request: makeRequest('https://attacker.example'),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'blocked' });
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('maps a wrong password to safe feedback without clearing the active session', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockRejectedValueOnce(
        new ApiRequestError('http', 'private backend detail', {
          status: 401,
          errorCode: 'REQUEST_ERROR',
        }),
      );

    const result = await action({
      request: makeRequest(),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'invalid' });
    expect(JSON.stringify(result)).not.toContain('private backend detail');
    expect(JSON.stringify(result)).not.toContain('private-current-password');
    expect(resultHeaders(result).get('set-cookie')).toBeNull();
  });

  it('maps a reused recovery code and rate limit to generic statuses', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockRejectedValueOnce(
        new ApiRequestError('http', 'private backend detail', {
          status: 400,
          errorCode: 'REQUEST_ERROR',
        }),
      );

    const invalidCode = await action({
      request: makeRequest(),
    } as Parameters<typeof action>[0]);

    expect(resultData(invalidCode)).toMatchObject({ status: 'invalid' });
    expect(JSON.stringify(invalidCode)).not.toContain('private backend detail');

    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockRejectedValueOnce(
        new ApiRequestError('http', 'private backend detail', {
          status: 429,
          errorCode: 'REQUEST_ERROR',
        }),
      );

    const limited = await action({
      request: makeRequest(),
    } as Parameters<typeof action>[0]);

    expect(resultData(limited)).toMatchObject({ status: 'limited' });
  });
});
