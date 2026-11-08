import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigMock, requestJsonMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  requestJsonMock: vi.fn(),
}));

vi.mock('~/.server/env.js', () => ({ loadFrontendConfig: loadConfigMock }));
vi.mock('~/.server/api-client.js', () => {
  class ApiRequestError extends Error {
    constructor(
      readonly kind: string,
      message: string,
      readonly options: {
        status?: number;
        errorCode?: string;
        details?: { field: string; rule: string }[];
      } = {},
    ) {
      super(message);
    }
    get status() {
      return this.options.status;
    }
    get errorCode() {
      return this.options.errorCode;
    }
    get details() {
      return this.options.details;
    }
  }
  return { ApiRequestError, requestJson: requestJsonMock };
});

import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { issueCsrfToken, issueSessionCsrfToken } from '~/.server/request-protection.js';
import { action as loginAction } from '~/routes/login.js';
import { action as accountAction, loader as accountLoader } from '~/routes/account.js';

const requestJsonMocked = vi.mocked(requestJson);
const origin = 'http://127.0.0.1:5173';
const sessionToken = 'S'.repeat(43);
const config = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: origin,
  csrfSecret: 'auth-action-test-secret-with-over-32-bytes',
};

function makeLoginRequest(
  options: {
    originHeader?: string;
    csrfToken?: string;
    returnTo?: string;
    csrf?: boolean;
  } = {},
): Request {
  const headers = new Headers();
  const issuedToken = issueCsrfToken(new Request(origin), headers, config);
  const anonCookie = headers.get('set-cookie')?.split(';', 1)[0];
  if (!anonCookie) throw new Error('Expected anonymous cookie fixture.');

  const form = new URLSearchParams({
    email: 'player@example.test',
    password: 'secret signup password',
    returnTo: options.returnTo ?? '/account',
  });
  if (options.csrf !== false) form.set('csrfToken', options.csrfToken ?? issuedToken);

  return new Request(`${origin}/login`, {
    method: 'POST',
    headers: {
      origin: options.originHeader ?? origin,
      cookie: anonCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
}

function makeAccountRequest(
  intent: 'logout' | 'change-password',
  options: { originHeader?: string; csrfToken?: string; csrf?: boolean } = {},
): Request {
  const csrfToken =
    options.csrfToken ??
    issueSessionCsrfToken(new Request(`${origin}/account`), sessionToken, config);
  const form = new URLSearchParams({ intent });
  if (intent === 'change-password') {
    form.set('currentPassword', 'my existing private password');
    form.set('newPassword', 'a new private tennis passphrase');
  }
  if (options.csrf !== false) form.set('csrfToken', csrfToken);

  return new Request(`${origin}/account`, {
    method: 'POST',
    headers: {
      ...(options.originHeader === undefined ? { origin } : { origin: options.originHeader }),
      cookie: `tx_session=${sessionToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
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
  loadConfigMock.mockReturnValue(config);
  requestJsonMocked.mockReset();
});

describe('login and logout actions', () => {
  it('loads protected account data through /me without exposing the session token', async () => {
    requestJsonMocked.mockResolvedValue({
      id: '7ad9dc2c-308e-4a1a-8c45-a9e9e3e7b5dc',
      email: 'player@example.test',
    } as never);
    const request = new Request(`${origin}/account`, {
      headers: { cookie: `tx_session=${sessionToken}` },
    });

    const result = await accountLoader({ request } as Parameters<typeof accountLoader>[0]);

    expect(result).toMatchObject({
      status: 'authenticated',
      user: { id: '7ad9dc2c-308e-4a1a-8c45-a9e9e3e7b5dc', email: 'player@example.test' },
    });
    expect(JSON.stringify(result)).not.toContain(sessionToken);
    expect(requestJsonMocked).toHaveBeenCalledWith(
      '/auth/me',
      expect.objectContaining({
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: request.signal,
      }),
    );
  });

  it('stores the login token only in the HttpOnly cookie and clears anonymous context', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    requestJsonMocked.mockResolvedValue({
      sessionToken,
      tokenType: 'Bearer',
      expiresAt,
    } as never);
    const request = makeLoginRequest();
    const result = await loginAction({ request } as Parameters<typeof loginAction>[0]);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.headers.get('location')).toBe('/account');
    const cookies = response.headers.get('set-cookie') ?? '';
    expect(cookies).toContain(`tx_session=${sessionToken}`);
    expect(cookies).toContain('HttpOnly');
    expect(cookies).toContain('SameSite=Lax');
    expect(cookies).toContain('tx_anon=');
    expect(response.headers.get('location')).not.toContain(sessionToken);
    expect(requestJsonMocked).toHaveBeenCalledWith(
      '/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: { email: 'player@example.test', password: 'secret signup password' },
        signal: request.signal,
      }),
    );
  });

  it('rejects unsafe return paths by redirecting to the account page', async () => {
    requestJsonMocked.mockResolvedValue({
      sessionToken,
      tokenType: 'Bearer',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    } as never);
    const result = await loginAction({
      request: makeLoginRequest({ returnTo: '//attacker.example' }),
    } as Parameters<typeof loginAction>[0]);

    expect((result as Response).headers.get('location')).toBe('/account');
  });

  it('maps invalid credentials and service failures to safe action data', async () => {
    requestJsonMocked.mockRejectedValueOnce(
      new ApiRequestError('http', 'private detail', {
        status: 401,
        errorCode: 'REQUEST_ERROR',
      }),
    );
    const invalid = await loginAction({
      request: makeLoginRequest(),
    } as Parameters<typeof loginAction>[0]);

    expect(resultData(invalid)).toMatchObject({ status: 'invalid' });
    expect(JSON.stringify(invalid)).not.toContain('secret signup password');
    expect(JSON.stringify(invalid)).not.toContain('private detail');

    requestJsonMocked.mockRejectedValueOnce(new ApiRequestError('network', 'private URL'));
    const unavailable = await loginAction({
      request: makeLoginRequest(),
    } as Parameters<typeof loginAction>[0]);
    expect(resultData(unavailable)).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(unavailable)).not.toContain('private URL');
  });

  it.each([
    ['cross-origin', makeLoginRequest({ originHeader: 'https://attacker.example' })],
    ['missing CSRF', makeLoginRequest({ csrf: false })],
    ['mismatched CSRF', makeLoginRequest({ csrfToken: 'v1.1.invalid' })],
  ])('blocks %s login requests before the backend call', async (_label, request) => {
    const result = await loginAction({ request } as Parameters<typeof loginAction>[0]);
    expect(resultData(result)).toMatchObject({ status: 'blocked' });
    expect(requestJsonMocked).not.toHaveBeenCalled();
  });

  it('revokes the current session and clears its cookie after a protected sign-out', async () => {
    requestJsonMocked.mockResolvedValue({ status: 'logged_out' } as never);
    const request = makeAccountRequest('logout');
    const result = await accountAction({ request } as Parameters<typeof accountAction>[0]);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('set-cookie')).toContain('tx_session=');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(requestJsonMocked).toHaveBeenCalledWith(
      '/auth/logout',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}` },
      }),
    );
  });

  it('does not call logout on rejected requests and keeps the cookie on a temporary failure', async () => {
    const blocked = await accountAction({
      request: makeAccountRequest('logout', { originHeader: 'https://attacker.example' }),
    } as Parameters<typeof accountAction>[0]);
    expect(resultData(blocked)).toMatchObject({ status: 'blocked' });
    expect(requestJsonMocked).not.toHaveBeenCalled();

    requestJsonMocked.mockRejectedValue(new ApiRequestError('timeout', 'private transport data'));
    const unavailable = await accountAction({
      request: makeAccountRequest('logout'),
    } as Parameters<typeof accountAction>[0]);
    expect(resultData(unavailable)).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(unavailable)).not.toContain(sessionToken);
    expect(JSON.stringify(unavailable)).not.toContain('private transport data');
  });

  it('submits a protected password change and clears the cookie on success', async () => {
    requestJsonMocked.mockResolvedValue({ status: 'changed' } as never);
    const request = makeAccountRequest('change-password');
    const result = await accountAction({ request } as Parameters<typeof accountAction>[0]);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.headers.get('location')).toBe('/login?passwordChanged=success');
    expect(response.headers.get('set-cookie')).toContain('tx_session=');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(requestJsonMocked).toHaveBeenCalledWith(
      '/auth/change-password',
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}` },
        body: {
          currentPassword: 'my existing private password',
          newPassword: 'a new private tennis passphrase',
        },
        signal: request.signal,
      }),
    );
    expect(JSON.stringify(result)).not.toContain('my existing private password');
    expect(JSON.stringify(result)).not.toContain('a new private tennis passphrase');
  });

  it.each([
    ['cross-origin', { originHeader: 'https://attacker.example' }],
    ['missing CSRF', { csrf: false }],
    ['mismatched CSRF', { csrfToken: 'v1.1.invalid' }],
  ])('blocks %s password changes before the backend call', async (_label, options) => {
    const result = await accountAction({
      request: makeAccountRequest('change-password', options),
    } as Parameters<typeof accountAction>[0]);
    expect(resultData(result)).toMatchObject({ status: 'blocked' });
    expect(requestJsonMocked).not.toHaveBeenCalled();
  });

  it('returns safe password field errors without echoing either password', async () => {
    requestJsonMocked.mockRejectedValue(
      new ApiRequestError('http', 'private backend detail', {
        status: 400,
        errorCode: 'VALIDATION_ERROR',
        details: [
          { field: 'currentPassword', rule: 'incorrect' },
          { field: 'newPassword', rule: 'too_short' },
        ],
      }),
    );
    const result = await accountAction({
      request: makeAccountRequest('change-password'),
    } as Parameters<typeof accountAction>[0]);

    expect(resultData(result)).toMatchObject({
      status: 'invalid',
      fieldErrors: {
        currentPassword: 'Check your current password and try again.',
        newPassword: 'Use at least 15 characters.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('my existing private password');
    expect(JSON.stringify(result)).not.toContain('a new private tennis passphrase');
    expect(JSON.stringify(result)).not.toContain('private backend detail');
  });

  it('keeps the cookie and returns a safe retry message during a password-change outage', async () => {
    requestJsonMocked.mockRejectedValue(
      new ApiRequestError('timeout', 'private transport details'),
    );
    const result = await accountAction({
      request: makeAccountRequest('change-password'),
    } as Parameters<typeof accountAction>[0]);
    expect(resultData(result)).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private transport details');
    expect(requestJsonMocked).toHaveBeenCalledTimes(1);
  });
});
