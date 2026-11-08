import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigMock, loadProtectedUserMock, requestJsonMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  loadProtectedUserMock: vi.fn(),
  requestJsonMock: vi.fn(),
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
        details?: { field: string; rule: string }[];
      } = {},
    ) {
      super(message);
      this.name = 'ApiRequestError';
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

vi.mock('~/.server/auth/session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/.server/auth/session.js')>();

  return {
    ...actual,
    loadProtectedUser: loadProtectedUserMock,
  };
});

import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { issueSessionCsrfToken } from '~/.server/auth/request-protection.js';
import { action, loader } from '~/routes/account/profile.js';

const requestJsonMocked = vi.mocked(requestJson);
const origin = 'http://127.0.0.1:5173';
const sessionToken = 'S'.repeat(43);
const config = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: origin,
  csrfSecret: 'profile-test-csrf-secret-with-at-least-32-bytes',
};
const profile = {
  id: '7ad9dc2c-308e-4a1a-8c45-a9e9e3e7b5dc',
  displayName: null,
  email: 'player@example.test',
  emailVerifiedAt: '2026-01-01T00:00:00.000Z',
};

function makeLoaderRequest(): Request {
  return new Request(`${origin}/account/profile`, {
    headers: { cookie: `tx_session=${sessionToken}` },
  });
}

function makeFormRequest(
  displayName: string,
  options: { originHeader?: string; csrfToken?: string } = {},
): Request {
  const csrfToken =
    options.csrfToken ??
    issueSessionCsrfToken(new Request(`${origin}/account/profile`), sessionToken, config);
  const form = new URLSearchParams({ csrfToken, displayName });

  return new Request(`${origin}/account/profile`, {
    method: 'POST',
    headers: {
      origin: options.originHeader ?? origin,
      cookie: `tx_session=${sessionToken}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
}

function returnedData(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && 'data' in value) {
    return (value as { data: Record<string, unknown> }).data;
  }

  return value as Record<string, unknown>;
}

beforeEach(() => {
  loadConfigMock.mockReturnValue(config);
  loadProtectedUserMock.mockReset();
  loadProtectedUserMock.mockResolvedValue({
    status: 'authenticated',
    user: { id: profile.id, email: profile.email },
    csrfToken: 'session-bound-csrf',
    sessionToken,
  });
  requestJsonMocked.mockReset();
});

describe('profile loader', () => {
  it('loads an unset display name and does not expose the session token', async () => {
    requestJsonMocked.mockResolvedValue(profile as never);
    const request = makeLoaderRequest();

    const result = await loader({ request } as Parameters<typeof loader>[0]);

    expect(result).toEqual({
      status: 'authenticated',
      profile,
      csrfToken: 'session-bound-csrf',
    });
    expect(JSON.stringify(result)).not.toContain(sessionToken);
    expect(requestJsonMocked).toHaveBeenCalledWith(
      '/me/profile',
      expect.objectContaining({
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: request.signal,
      }),
    );
  });

  it('loads an existing display name', async () => {
    const existingProfile = { ...profile, displayName: 'First Player' };
    requestJsonMocked.mockResolvedValue(existingProfile as never);

    const result = await loader({ request: makeLoaderRequest() } as Parameters<typeof loader>[0]);

    expect(result).toMatchObject({
      status: 'authenticated',
      profile: existingProfile,
    });
  });

  it('clears an expired session and redirects to sign-in', async () => {
    requestJsonMocked.mockRejectedValue(
      new ApiRequestError('http', 'private backend detail', {
        status: 401,
        errorCode: 'REQUEST_ERROR',
      }),
    );
    const request = makeLoaderRequest();

    let thrown: unknown;
    try {
      await loader({ request } as Parameters<typeof loader>[0]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get('location')).toBe(
      '/login?returnTo=%2Faccount%2Fprofile',
    );
    expect((thrown as Response).headers.get('set-cookie')).toContain('tx_session=');
    expect(JSON.stringify(thrown)).not.toContain('private backend detail');
  });
});

describe('profile action', () => {
  it('sends only a trimmed displayName and returns a safe saved state', async () => {
    requestJsonMocked.mockResolvedValue({ ...profile, displayName: 'New Player' } as never);
    const request = makeFormRequest('  New Player  ');

    const result = await action({ request } as Parameters<typeof action>[0]);

    expect(returnedData(result)).toEqual({ status: 'saved', displayName: 'New Player' });
    expect(requestJsonMocked).toHaveBeenCalledWith(
      '/me/profile',
      expect.objectContaining({
        method: 'PATCH',
        headers: { authorization: `Bearer ${sessionToken}` },
        body: { displayName: 'New Player' },
        signal: request.signal,
      }),
    );
  });

  it('rejects blank and overlong names before calling the API', async () => {
    const blank = await action({
      request: makeFormRequest('   '),
    } as Parameters<typeof action>[0]);
    const long = await action({
      request: makeFormRequest('x'.repeat(101)),
    } as Parameters<typeof action>[0]);

    expect(returnedData(blank)).toMatchObject({
      status: 'invalid',
      fieldError: 'Enter a display name.',
    });
    expect(returnedData(long)).toMatchObject({
      status: 'invalid',
      fieldError: 'Use 100 characters or fewer.',
    });
    expect(requestJsonMocked).not.toHaveBeenCalled();
  });

  it('maps backend validation errors without exposing backend details', async () => {
    requestJsonMocked.mockRejectedValue(
      new ApiRequestError('http', 'private backend detail', {
        status: 400,
        errorCode: 'VALIDATION_ERROR',
        details: [{ field: '/displayName', rule: 'maxLength' }],
      }),
    );

    const result = await action({
      request: makeFormRequest('Player Name'),
    } as Parameters<typeof action>[0]);

    expect(returnedData(result)).toMatchObject({
      status: 'invalid',
      displayName: 'Player Name',
      fieldError: 'Use 100 characters or fewer.',
    });
    expect(JSON.stringify(result)).not.toContain('private backend detail');
  });

  it('preserves the submitted value when the service is unavailable', async () => {
    requestJsonMocked.mockRejectedValue(new ApiRequestError('network', 'private backend URL'));

    const result = await action({
      request: makeFormRequest('Player Name'),
    } as Parameters<typeof action>[0]);

    expect(returnedData(result)).toEqual({
      status: 'unavailable',
      displayName: 'Player Name',
    });
    expect(JSON.stringify(result)).not.toContain('private backend URL');
  });

  it('blocks an untrusted origin before calling the API', async () => {
    const result = await action({
      request: makeFormRequest('Player Name', { originHeader: 'https://attacker.example' }),
    } as Parameters<typeof action>[0]);

    expect(returnedData(result)).toMatchObject({ status: 'blocked' });
    expect(requestJsonMocked).not.toHaveBeenCalled();
  });
});
