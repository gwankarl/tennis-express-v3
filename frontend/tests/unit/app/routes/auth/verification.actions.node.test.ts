import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigMock } = vi.hoisted(() => ({ loadConfigMock: vi.fn() }));

vi.mock('~/.server/env.js', () => ({ loadFrontendConfig: loadConfigMock }));
vi.mock('~/.server/api-client.js', () => {
  class ApiRequestError extends Error {
    constructor(
      readonly kind: string,
      message: string,
      options: {
        status?: number;
        errorCode?: string;
        details?: { field: string; rule: string }[];
      } = {},
    ) {
      super(message);
      this.name = 'ApiRequestError';
      this.status = options.status;
      this.errorCode = options.errorCode;
      this.details = options.details;
    }
    readonly status?: number;
    readonly errorCode?: string;
    readonly details?: { field: string; rule: string }[];
  }

  return { ApiRequestError, requestJson: vi.fn() };
});

import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { issueCsrfToken } from '~/.server/auth/request-protection.js';
import { action as verifyAction, loader as verifyLoader } from '~/routes/auth/verify-email.js';
import { action as resendAction } from '~/routes/auth/resend-verification.js';

const requestJsonMock = vi.mocked(requestJson);
const origin = 'http://localhost:5173';
const token = 'A'.repeat(43);
const settings = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: origin,
  csrfSecret: 'unit-test-secret-with-more-than-32-bytes',
};

function makeRequest(
  path: string,
  fields: Record<string, string>,
  requestOrigin = origin,
): Request {
  const headers = new Headers();
  const csrfToken = issueCsrfToken(new Request(origin), headers, settings);
  const cookie = headers.get('set-cookie')?.split(';', 1)[0];

  if (!cookie) throw new Error('Expected the CSRF cookie.');

  const form = new URLSearchParams({ csrfToken, ...fields });

  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      origin: requestOrigin,
      cookie,
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
  loadConfigMock.mockReturnValue(settings);
  requestJsonMock.mockReset();
});

describe('verification actions', () => {
  it('does not call the verification API when the email link is opened', async () => {
    const request = new Request(`${origin}/verify-email?token=${token}`);
    const result = await verifyLoader({ request } as Parameters<typeof verifyLoader>[0]);

    expect(requestJsonMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('submits a protected verification form and does not return the token or password', async () => {
    requestJsonMock.mockResolvedValue({ status: 'verified' } as never);
    const password = 'signup passphrase with spaces';
    const request = makeRequest('/verify-email', { token, password });

    const result = await verifyAction({ request } as Parameters<typeof verifyAction>[0]);

    expect(resultData(result)).toEqual({ status: 'verified' });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/auth/verify-email',
      expect.objectContaining({
        method: 'POST',
        body: { token, password },
        signal: request.signal,
      }),
    );
  });

  it('maps the backend 401 contract to a safe rejected state', async () => {
    requestJsonMock.mockRejectedValue(
      new ApiRequestError('http', 'private backend details', {
        status: 401,
        errorCode: 'REQUEST_ERROR',
      }),
    );

    const result = await verifyAction({
      request: makeRequest('/verify-email', { token, password: 'signup passphrase' }),
    } as Parameters<typeof verifyAction>[0]);

    expect(resultData(result)).toEqual({ status: 'rejected' });
    expect(JSON.stringify(result)).not.toContain('private backend details');
  });

  it('shows a generic resend confirmation after the accepted response', async () => {
    requestJsonMock.mockResolvedValue({ status: 'accepted' } as never);

    const result = await resendAction({
      request: makeRequest('/resend-verification', { email: 'player@example.test' }),
    } as Parameters<typeof resendAction>[0]);

    expect(resultData(result)).toEqual({ status: 'accepted' });
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/auth/resend-verification',
      expect.objectContaining({
        method: 'POST',
        body: { email: 'player@example.test' },
      }),
    );
  });

  it.each([
    ['/verify-email', verifyAction, { token, password: 'signup passphrase' }],
    ['/resend-verification', resendAction, { email: 'player@example.test' }],
  ] as const)(
    'blocks untrusted-origin submissions to %s before calling the API',
    async (path, action, fields) => {
      const result = await action({
        request: makeRequest(path, fields, 'https://attacker.example'),
      } as never);

      expect(resultData(result)).toEqual({ status: 'blocked' });
      expect(requestJsonMock).not.toHaveBeenCalled();
    },
  );

  it('rejects a malformed token without calling the API', async () => {
    const result = await verifyAction({
      request: makeRequest('/verify-email', { token: 'malformed', password: 'signup passphrase' }),
    } as Parameters<typeof verifyAction>[0]);

    expect(resultData(result)).toMatchObject({ status: 'invalid' });
    expect(requestJsonMock).not.toHaveBeenCalled();
  });
});
