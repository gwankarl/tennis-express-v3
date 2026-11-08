import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiErrorDetail } from '../../../../../../backend/src/http/contract';

const { loadConfigMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
}));

vi.mock('~/.server/env.js', () => ({
  loadFrontendConfig: loadConfigMock,
}));

vi.mock('~/.server/api-client.js', () => {
  class ApiRequestError extends Error {
    constructor(
      readonly kind: string,
      message: string,
      readonly options: {
        status?: number;
        errorCode?: string;
        details?: ApiErrorDetail[];
      } = {},
    ) {
      super(message);
      this.name = 'ApiRequestError';
    }

    get errorCode() {
      return this.options.errorCode;
    }

    get details() {
      return this.options.details;
    }
  }

  return {
    ApiRequestError,
    requestJson: vi.fn(),
  };
});

import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { issueCsrfToken } from '~/.server/auth/request-protection.js';
import { action } from '~/routes/auth/register.js';

const requestJsonMock = vi.mocked(requestJson);
const settings = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: 'http://127.0.0.1:5173',
  csrfSecret: 'unit-test-secret-with-more-than-32-bytes',
};

function makeRequest(input: { email?: string; password?: string; origin?: string } = {}): Request {
  const issuedHeaders = new Headers();
  const csrfToken = issueCsrfToken(new Request(settings.frontendOrigin), issuedHeaders, settings);
  const cookie = issuedHeaders.get('set-cookie')?.split(';', 1)[0];

  if (!cookie) {
    throw new Error('Expected a CSRF cookie.');
  }

  const form = new URLSearchParams({
    csrfToken,
    email: input.email ?? 'player@example.test',
    password: input.password ?? 'a safe tennis passphrase',
  });

  return new Request(`${settings.frontendOrigin}/register`, {
    method: 'POST',
    headers: {
      origin: input.origin ?? settings.frontendOrigin,
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
}

function actionPayload(result: unknown): Record<string, unknown> {
  if (typeof result === 'object' && result !== null && 'data' in result) {
    return (result as { data: Record<string, unknown> }).data;
  }

  return result as Record<string, unknown>;
}

beforeEach(() => {
  loadConfigMock.mockReturnValue(settings);
  requestJsonMock.mockReset();
});

describe('registration action', () => {
  it('returns the generic accepted state without returning the password', async () => {
    requestJsonMock.mockResolvedValue({ status: 'accepted' } as never);

    const request = makeRequest({ password: 'private signup password' });
    const result = await action({ request } as Parameters<typeof action>[0]);

    expect(actionPayload(result)).toEqual({ status: 'accepted' });
    expect(JSON.stringify(result)).not.toContain('private signup password');
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/auth/register',
      expect.objectContaining({
        method: 'POST',
        body: { email: 'player@example.test', password: 'private signup password' },
        signal: request.signal,
      }),
    );
  });

  it('returns inline errors for invalid local input without calling Fastify', async () => {
    const result = await action({
      request: makeRequest({ password: 'fourteen chars' }),
    } as Parameters<typeof action>[0]);

    expect(actionPayload(result)).toMatchObject({
      status: 'invalid',
      fieldErrors: { password: 'Use 15–128 characters.' },
    });
    expect(requestJsonMock).not.toHaveBeenCalled();
  });

  it('maps backend validation details to safe inline field errors', async () => {
    requestJsonMock.mockRejectedValue(
      new ApiRequestError('http', 'private backend detail', {
        status: 400,
        errorCode: 'VALIDATION_ERROR',
        details: [{ field: '/password', rule: 'minLength' }],
      }),
    );

    const result = await action({
      request: makeRequest(),
    } as Parameters<typeof action>[0]);

    expect(actionPayload(result)).toMatchObject({
      status: 'invalid',
      fieldErrors: { password: 'Use 15–128 characters.' },
    });
    expect(JSON.stringify(result)).not.toContain('private backend detail');
  });

  it('returns a safe alert when the registration service is unavailable', async () => {
    requestJsonMock.mockRejectedValue(
      new ApiRequestError('network', 'private URL and transport details'),
    );

    const result = await action({
      request: makeRequest(),
    } as Parameters<typeof action>[0]);

    expect(actionPayload(result)).toMatchObject({ status: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private URL');
  });

  it('blocks an untrusted origin before calling Fastify', async () => {
    const result = await action({
      request: makeRequest({ origin: 'https://attacker.example' }),
    } as Parameters<typeof action>[0]);

    expect(actionPayload(result)).toEqual({ status: 'blocked' });
    expect(requestJsonMock).not.toHaveBeenCalled();
  });
});
