import { beforeEach, describe, expect, it, vi } from 'vitest';

const { configMock, requestJsonMock } = vi.hoisted(() => ({
  configMock: vi.fn(),
  requestJsonMock: vi.fn(),
}));

vi.mock('~/.server/env.js', () => ({ loadFrontendConfig: configMock }));
vi.mock('~/.server/api-client.js', () => {
  class MockApiRequestError extends Error {
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

  return { ApiRequestError: MockApiRequestError, requestJson: requestJsonMock };
});

import { ApiRequestError } from '~/.server/api-client.js';
import { loader } from '~/routes/admin/index.js';

const origin = 'http://127.0.0.1:5173';
const token = 'S'.repeat(43);
const user = {
  id: '7ad9dc2c-308e-4a1a-8c45-a9e9e3e7b5dc',
  email: 'admin@example.test',
};
const config = {
  frontendOrigin: origin,
  csrfSecret: 'admin-route-test-secret-with-over-32-bytes',
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
};

function workspaceState(
  adminEntryState: 'unavailable' | 'mfa_required' | 'available',
  adminMfaFactorState: 'none' | 'pending' | 'active' | null,
) {
  return {
    defaultWorkspace: 'buyer',
    availableWorkspaces: { buyer: true, seller: false },
    sellerApplicationStatus: 'not_applied',
    adminEntryState,
    adminMfaFactorState,
  };
}

function request() {
  return new Request(`${origin}/admin`, {
    headers: { cookie: `tx_session=${token}` },
  });
}

async function expectRedirect(result: Promise<unknown>, location: string) {
  let thrown: unknown;

  try {
    await result;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).headers.get('location')).toBe(location);
}

function mockWorkspace(
  adminEntryState: 'unavailable' | 'mfa_required' | 'available',
  adminMfaFactorState: 'none' | 'pending' | 'active' | null,
) {
  requestJsonMock.mockImplementation(async (endpoint: string) => {
    if (endpoint === '/auth/me') return user;
    if (endpoint === '/me/workspaces') {
      return workspaceState(adminEntryState, adminMfaFactorState);
    }

    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
}

beforeEach(() => {
  configMock.mockReturnValue(config);
  requestJsonMock.mockReset();
});

describe('Admin workspace loader', () => {
  it('sends an account without Admin permission to Buyer', async () => {
    mockWorkspace('unavailable', null);

    await expectRedirect(
      loader({ request: request() } as Parameters<typeof loader>[0]),
      '/account',
    );
  });

  it('routes an administrator without a factor to enrollment and preserves the Admin destination', async () => {
    mockWorkspace('mfa_required', 'none');

    await expectRedirect(
      loader({ request: request() } as Parameters<typeof loader>[0]),
      '/admin/mfa/enrollment?returnTo=%2Fadmin',
    );
  });

  it('continues pending enrollment and preserves the Admin destination', async () => {
    mockWorkspace('mfa_required', 'pending');

    await expectRedirect(
      loader({ request: request() } as Parameters<typeof loader>[0]),
      '/admin/mfa/enrollment?returnTo=%2Fadmin',
    );
  });

  it('routes an administrator with an active factor to the challenge', async () => {
    mockWorkspace('mfa_required', 'active');

    await expectRedirect(
      loader({ request: request() } as Parameters<typeof loader>[0]),
      '/admin/mfa/challenge?returnTo=%2Fadmin',
    );
  });

  it('renders workspace data only when the backend says the session is elevated', async () => {
    mockWorkspace('available', 'active');

    const result = await loader({ request: request() } as Parameters<typeof loader>[0]);

    expect(result).toMatchObject({
      status: 'authenticated',
      availability: {
        adminEntryState: 'available',
        adminMfaFactorState: 'active',
      },
    });
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/me/workspaces',
      expect.objectContaining({
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  });

  it('redirects a direct Admin visit after permission is revoked in the same session', async () => {
    let adminEntryState: 'available' | 'unavailable' = 'available';

    requestJsonMock.mockImplementation(async (endpoint: string) => {
      if (endpoint === '/auth/me') return user;
      if (endpoint === '/me/workspaces') {
        return workspaceState(adminEntryState, adminEntryState === 'available' ? 'active' : null);
      }

      throw new Error(`Unexpected endpoint: ${endpoint}`);
    });

    const firstResult = await loader({ request: request() } as Parameters<typeof loader>[0]);
    expect(firstResult).toMatchObject({ status: 'authenticated' });

    adminEntryState = 'unavailable';

    await expectRedirect(
      loader({ request: request() } as Parameters<typeof loader>[0]),
      '/account',
    );
    expect(
      requestJsonMock.mock.calls.filter(([endpoint]) => endpoint === '/me/workspaces'),
    ).toHaveLength(2);
  });

  it('shows the restricted state when the backend confirms an account restriction', async () => {
    requestJsonMock.mockRejectedValueOnce(
      new ApiRequestError('http', 'private account detail', {
        status: 403,
        errorCode: 'ACCOUNT_RESTRICTED',
      }),
    );

    const result = await loader({ request: request() } as Parameters<typeof loader>[0]);

    expect(result).toMatchObject({ status: 'restricted', csrfToken: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('private account detail');
  });

  it('returns a retryable unavailable state during a temporary workspace API failure', async () => {
    requestJsonMock
      .mockResolvedValueOnce(user)
      .mockRejectedValueOnce(new Error('private network detail'));

    const result = await loader({ request: request() } as Parameters<typeof loader>[0]);

    expect(result).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('private network detail');
    expect(requestJsonMock).toHaveBeenCalledTimes(2);
  });

  it('redirects an expired direct visit to sign-in with the Admin destination', async () => {
    requestJsonMock.mockRejectedValueOnce(
      new ApiRequestError('http', 'private session detail', {
        status: 401,
        errorCode: 'REQUEST_ERROR',
      }),
    );

    await expectRedirect(
      loader({ request: request() } as Parameters<typeof loader>[0]),
      '/login?returnTo=%2Fadmin',
    );
  });
});
