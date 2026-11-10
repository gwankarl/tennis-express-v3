import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigMock, loadProtectedUserMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  loadProtectedUserMock: vi.fn(),
}));

vi.mock('~/.server/env.js', () => ({ loadFrontendConfig: loadConfigMock }));
vi.mock('~/.server/auth/session.js', () => ({
  clearSessionCookie: vi.fn(),
  loadProtectedUser: loadProtectedUserMock,
  readSessionToken: vi.fn(() => 'S'.repeat(43)),
}));
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
import { appendAdminEnrollmentAuthorizationCookie } from '~/.server/auth/admin-mfa.js';
import { action, loader } from '~/routes/admin/mfa-enrollment.js';

const requestJsonMock = vi.mocked(requestJson);
const origin = 'http://127.0.0.1:5173';
const sessionToken = 'S'.repeat(43);
const authorization = 'A'.repeat(43);
const setup = {
  secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  provisioningUri: 'otpauth://totp/Tennis%20Xpress:test?secret=JBSWY3DPEHPK3PXP',
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
};
const settings = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: origin,
  csrfSecret: 'unit-test-secret-with-more-than-32-bytes',
};

function makeRequest(
  fields: Record<string, string>,
  requestOrigin = origin,
  includeAuthorizationCookie = false,
): Request {
  const csrfToken = issueSessionCsrfToken(
    new Request(`${origin}/admin/mfa/enrollment`),
    sessionToken,
    settings,
  );
  const form = new URLSearchParams({ csrfToken, ...fields });
  const headers = new Headers({
    origin: requestOrigin,
    'content-type': 'application/x-www-form-urlencoded',
  });

  if (includeAuthorizationCookie) {
    const cookieHeaders = new Headers();
    appendAdminEnrollmentAuthorizationCookie(
      new Request(`${origin}/admin/mfa/enrollment`),
      cookieHeaders,
      authorization,
      new Date(Date.now() + 60 * 60_000).toISOString(),
      settings,
    );
    const enrollmentCookie = cookieHeaders.get('set-cookie')?.split(';', 1)[0];
    headers.set('cookie', `tx_session=${sessionToken}; ${enrollmentCookie}`);
  } else {
    headers.set('cookie', `tx_session=${sessionToken}`);
  }

  return new Request(`${origin}/admin/mfa/enrollment`, {
    method: 'POST',
    headers,
    body: form,
  });
}

function resultData(result: unknown): Record<string, unknown> {
  if (typeof result === 'object' && result !== null && 'data' in result) {
    return (result as { data: Record<string, unknown> }).data;
  }

  return result as Record<string, unknown>;
}

beforeEach(() => {
  loadConfigMock.mockReturnValue(settings);
  loadProtectedUserMock.mockResolvedValue({
    status: 'authenticated',
    user: { id: 'user-1', email: 'admin@example.test' },
    csrfToken: 'session-csrf-token',
    sessionToken,
  });
  requestJsonMock.mockReset();
});

describe('administrator MFA enrollment route actions', () => {
  it('shows no setup secret when the enrollment page is opened', async () => {
    const result = await loader({
      request: new Request(`${origin}/admin/mfa/enrollment`, {
        headers: { cookie: `tx_session=${sessionToken}` },
      }),
    } as Parameters<typeof loader>[0]);

    expect(JSON.stringify(result)).not.toContain(setup.secret);
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('checks CSRF before calling Fastify and keeps password and authorization out of action data', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockResolvedValueOnce(setup as never);

    const password = 'private-password-value';
    const result = await action({
      request: makeRequest({
        step: 'start',
        password,
        authorization,
      }),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'setup', setup });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(authorization);
    expect(requestJsonMock).toHaveBeenNthCalledWith(
      2,
      '/admin/mfa/enrollment',
      expect.objectContaining({
        method: 'POST',
        body: { password, authorization },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('uses the recovery authorization cookie without returning its value', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockResolvedValueOnce(setup as never);

    const result = await action({
      request: makeRequest({ step: 'start', password: 'private-password-value' }, origin, true),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'setup', setup });
    expect(JSON.stringify(result)).not.toContain(authorization);
    expect(result).toHaveProperty('init.headers');
    expect(requestJsonMock).toHaveBeenNthCalledWith(
      2,
      '/admin/mfa/enrollment',
      expect.objectContaining({
        body: { password: 'private-password-value', authorization },
      }),
    );
  });

  it('does not call Fastify for an untrusted origin', async () => {
    const result = await action({
      request: makeRequest(
        { step: 'start', password: 'private-password-value', authorization },
        'https://attacker.example',
      ),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'blocked' });
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('confirms a current code and returns the one-time recovery codes for display', async () => {
    const recoveryCodes = Array.from(
      { length: 10 },
      (_, index) => `${String(index).padStart(8, 'A')}-BBBBBBBB-CCCCCCCC-DDDDDDDD`,
    );
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockResolvedValueOnce({ status: 'enrolled', recoveryCodes } as never);

    const result = await action({
      request: makeRequest({
        step: 'confirm',
        code: '123456',
        setupSecret: setup.secret,
        setupUri: setup.provisioningUri,
        setupExpiresAt: setup.expiresAt,
      }),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toEqual({ status: 'enrolled', recoveryCodes });
    expect(JSON.stringify(result)).not.toContain('123456');
    expect(requestJsonMock).toHaveBeenNthCalledWith(
      2,
      '/admin/mfa/enrollment/confirm',
      expect.objectContaining({
        method: 'POST',
        body: { code: '123456' },
      }),
    );
  });

  it('maps bad confirmation codes safely while retaining the setup display', async () => {
    requestJsonMock
      .mockResolvedValueOnce({ id: 'user-1', email: 'admin@example.test' } as never)
      .mockRejectedValueOnce(
        new ApiRequestError('http', 'private backend detail', { status: 400 }),
      );

    const result = await action({
      request: makeRequest({
        step: 'confirm',
        code: '123456',
        setupSecret: setup.secret,
        setupUri: setup.provisioningUri,
        setupExpiresAt: setup.expiresAt,
      }),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({
      status: 'invalid',
      step: 'confirm',
      setup,
    });
    expect(JSON.stringify(result)).not.toContain('private backend detail');
  });

  it('redirects and clears the session when confirmation finds an expired session', async () => {
    const { clearSessionCookie } = await import('~/.server/auth/session.js');
    requestJsonMock.mockRejectedValue(
      new ApiRequestError('http', 'private backend detail', {
        status: 401,
        errorCode: 'REQUEST_ERROR',
      }),
    );

    const result = await action({
      request: makeRequest({
        step: 'confirm',
        code: '123456',
        setupSecret: setup.secret,
        setupUri: setup.provisioningUri,
        setupExpiresAt: setup.expiresAt,
      }),
    } as Parameters<typeof action>[0]);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/login?returnTo=%2Fadmin%2Fmfa%2Fenrollment');
    expect(clearSessionCookie).toHaveBeenCalled();
  });
});
