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

import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { issueCsrfToken } from '~/.server/request-protection.js';
import { action as forgotAction, loader as forgotLoader } from '~/routes/forgot-password.js';
import { action as resetAction, loader as resetLoader } from '~/routes/reset-password.js';

const requestJsonMocked = vi.mocked(requestJson);
const origin = 'http://127.0.0.1:5173';
const resetToken = 'R'.repeat(43);
const config = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: origin,
  csrfSecret: 'password-recovery-test-secret-over-32-bytes',
};

function makeFormRequest(
  path: string,
  fields: Record<string, string>,
  options: { originHeader?: string; includeCsrf?: boolean } = {},
): Request {
  const responseHeaders = new Headers();
  const csrfToken = issueCsrfToken(new Request(origin), responseHeaders, config);
  const anonCookie = responseHeaders.get('set-cookie')?.split(';', 1)[0];

  if (!anonCookie) throw new Error('Expected the anonymous CSRF cookie.');

  const body = new URLSearchParams(fields);
  if (options.includeCsrf !== false) body.set('csrfToken', csrfToken);

  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      origin: options.originHeader ?? origin,
      cookie: anonCookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
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

describe('password recovery actions', () => {
  it('returns the same generic confirmation state after a valid recovery request', async () => {
    requestJsonMocked.mockResolvedValue({ status: 'accepted' } as never);
    const request = makeFormRequest('/forgot-password', { email: 'player@example.test' });

    const result = await forgotAction({ request } as Parameters<typeof forgotAction>[0]);

    expect(resultData(result)).toEqual({ status: 'accepted' });
    expect(JSON.stringify(result)).not.toContain('resetToken');
    expect(requestJsonMocked).toHaveBeenCalledWith(
      '/auth/forgot-password',
      expect.objectContaining({
        method: 'POST',
        body: { email: 'player@example.test' },
        signal: request.signal,
      }),
    );
  });

  it('does not put the raw link token in reset loader data or call the API when the link opens', async () => {
    const request = new Request(`${origin}/reset-password?token=${resetToken}`);
    const result = await resetLoader({ request } as Parameters<typeof resetLoader>[0]);

    expect(JSON.stringify(result)).not.toContain(resetToken);
    expect(requestJsonMocked).not.toHaveBeenCalled();
  });

  it('redirects after reset without returning the password or reset token', async () => {
    const password = 'a new safe tennis passphrase';
    requestJsonMocked.mockResolvedValue({ status: 'reset' } as never);
    const request = makeFormRequest('/reset-password', { token: resetToken, password });

    const result = await resetAction({ request } as Parameters<typeof resetAction>[0]);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.headers.get('location')).toBe('/login?passwordReset=success');
    expect(response.headers.get('location')).not.toContain(resetToken);
    expect(response.headers.get('location')).not.toContain(password);
    expect(requestJsonMocked).toHaveBeenCalledWith(
      '/auth/reset-password',
      expect.objectContaining({
        method: 'POST',
        body: { token: resetToken, password },
        signal: request.signal,
      }),
    );
  });

  it('shows an unusable-link action state for expired, consumed, or unknown tokens', async () => {
    requestJsonMocked.mockRejectedValue(
      new ApiRequestError('http', 'private backend error', {
        status: 401,
        errorCode: 'REQUEST_ERROR',
      }),
    );
    const password = 'a new safe tennis passphrase';

    const result = await resetAction({
      request: makeFormRequest('/reset-password', { token: resetToken, password }),
    } as Parameters<typeof resetAction>[0]);

    expect(resultData(result)).toEqual({ status: 'unusable' });
    expect(JSON.stringify(result)).not.toContain(resetToken);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain('private backend error');
  });

  it.each([
    ['/forgot-password', forgotAction, { email: 'player@example.test' }],
    [
      '/reset-password',
      resetAction,
      { token: resetToken, password: 'a new safe tennis passphrase' },
    ],
  ] as const)(
    'blocks an untrusted-origin %s request before calling the backend',
    async (path, action, fields) => {
      const result = await action({
        request: makeFormRequest(path, fields, { originHeader: 'https://attacker.example' }),
      } as never);

      expect(resultData(result)).toEqual({ status: 'blocked' });
      expect(requestJsonMocked).not.toHaveBeenCalled();
    },
  );

  it('blocks a reset with no CSRF token before calling the backend', async () => {
    const result = await resetAction({
      request: makeFormRequest(
        '/reset-password',
        { token: resetToken, password: 'a new safe tennis passphrase' },
        { includeCsrf: false },
      ),
    } as Parameters<typeof resetAction>[0]);

    expect(resultData(result)).toEqual({ status: 'blocked' });
    expect(requestJsonMocked).not.toHaveBeenCalled();
  });

  it('returns only a CSRF token from the recovery loader', async () => {
    const request = new Request(`${origin}/forgot-password`);
    const result = await forgotLoader({ request } as Parameters<typeof forgotLoader>[0]);

    expect(JSON.stringify(result)).not.toContain('player@example.test');
  });
});
