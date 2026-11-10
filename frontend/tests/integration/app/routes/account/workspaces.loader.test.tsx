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
import { issueSessionCsrfToken } from '~/.server/auth/request-protection.js';
import { setWorkspacePreferenceCookie } from '~/.server/auth/workspace-preference.js';
import { action as accountAction, loader as accountLoader } from '~/routes/account/layout.js';
import { loader as sellerLoader } from '~/routes/account/seller.js';

const origin = 'http://127.0.0.1:5173';
const token = 'S'.repeat(43);
const user = {
  id: '7ad9dc2c-308e-4a1a-8c45-a9e9e3e7b5dc',
  email: 'player@example.test',
};
const config = {
  frontendOrigin: origin,
  csrfSecret: 'workspace-route-test-secret-with-over-32-bytes',
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
};

function workspaces(seller: boolean) {
  return {
    defaultWorkspace: 'buyer',
    availableWorkspaces: { buyer: true, seller },
    sellerApplicationStatus: seller ? 'approved' : 'pending',
    adminEntryState: 'unavailable',
    adminMfaFactorState: null,
  };
}

function mockAuthenticated(seller: boolean) {
  requestJsonMock.mockImplementation(async (endpoint: string) => {
    if (endpoint === '/auth/me') return user;
    if (endpoint === '/me/workspaces') return workspaces(seller);
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  });
}

function requestWithSession(path: string, cookie = `tx_session=${token}`) {
  return new Request(`${origin}${path}`, { headers: { cookie } });
}

function preferenceCookie(preference: 'buyer' | 'seller') {
  const headers = new Headers();
  setWorkspacePreferenceCookie(
    new Request(`${origin}/account`),
    headers,
    user.id,
    preference,
    config,
  );
  const preferenceCookie = headers.get('set-cookie')?.split(';', 1)[0];
  if (!preferenceCookie) throw new Error('Expected workspace preference cookie.');
  return `tx_session=${token}; ${preferenceCookie}`;
}

function makeSwitchRequest(workspace: string) {
  const csrfToken = issueSessionCsrfToken(new Request(`${origin}/account`), token, config);
  const body = new URLSearchParams({ csrfToken, workspace });
  return new Request(`${origin}/account`, {
    method: 'POST',
    headers: {
      origin,
      cookie: `tx_session=${token}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
}

async function expectThrownRedirect(result: Promise<unknown>, location: string) {
  let thrown: unknown;

  try {
    await result;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).headers.get('location')).toBe(location);
}

beforeEach(() => {
  configMock.mockReturnValue(config);
  requestJsonMock.mockReset();
});

describe('workspace routes', () => {
  it('restores an available Seller preference only at the default Account entry', async () => {
    mockAuthenticated(true);

    await expectThrownRedirect(
      accountLoader({
        request: requestWithSession('/account', preferenceCookie('seller')),
      } as Parameters<typeof accountLoader>[0]),
      '/seller',
    );
  });

  it('ignores a signed Seller preference after Seller availability is lost', async () => {
    mockAuthenticated(false);

    const result = await accountLoader({
      request: requestWithSession('/account', preferenceCookie('seller')),
    } as Parameters<typeof accountLoader>[0]);

    expect(result).toMatchObject({
      status: 'authenticated',
      availability: { availableWorkspaces: { buyer: true, seller: false } },
    });
  });

  it('ignores a tampered Seller preference and stays in Buyer', async () => {
    mockAuthenticated(true);
    const cookie = preferenceCookie('seller');
    const tamperedCookie = `${cookie.slice(0, -1)}A`;

    const result = await accountLoader({
      request: requestWithSession('/account', tamperedCookie),
    } as Parameters<typeof accountLoader>[0]);

    expect(result).toMatchObject({ status: 'authenticated' });
  });

  it('records an explicit Seller choice and redirects only when the API says Seller is available', async () => {
    mockAuthenticated(true);

    const result = await accountAction({
      request: makeSwitchRequest('seller'),
    } as Parameters<typeof accountAction>[0]);

    expect(result).toBeInstanceOf(Response);
    const response = result as unknown as Response;
    expect(response.headers.get('location')).toBe('/seller');
    expect(response.headers.get('set-cookie')).toContain('tx_workspace=');
    expect(requestJsonMock).toHaveBeenCalledWith(
      '/me/workspaces',
      expect.objectContaining({
        headers: { authorization: `Bearer ${token}` },
      }),
    );
  });

  it('shows the Seller-unavailable state and confirms Buyer eligibility after Seller access is lost', async () => {
    mockAuthenticated(false);

    const result = await sellerLoader({
      request: requestWithSession('/seller'),
    } as Parameters<typeof sellerLoader>[0]);

    expect(result).toEqual({ status: 'seller-unavailable', buyerAvailable: true });
  });

  it('redirects an expired deep link to sign-in and preserves its safe destination', async () => {
    requestJsonMock.mockRejectedValueOnce(
      new ApiRequestError('http', 'Request failed', {
        status: 401,
        errorCode: 'REQUEST_ERROR',
      }),
    );

    await expectThrownRedirect(
      sellerLoader({
        request: requestWithSession('/seller?tab=listings'),
      } as Parameters<typeof sellerLoader>[0]),
      '/login?returnTo=%2Fseller%3Ftab%3Dlistings',
    );
  });

  it('keeps the requested Seller route on temporary API failure', async () => {
    requestJsonMock.mockRejectedValueOnce(new Error('simulated network failure'));

    const result = await sellerLoader({
      request: requestWithSession('/seller'),
    } as Parameters<typeof sellerLoader>[0]);

    expect(result).toEqual({ status: 'unavailable' });
  });

  it('returns the restricted state without exposing the session token', async () => {
    requestJsonMock.mockRejectedValueOnce(
      new ApiRequestError('http', 'Account access is restricted', {
        status: 403,
        errorCode: 'ACCOUNT_RESTRICTED',
      }),
    );

    const result = await accountLoader({
      request: requestWithSession('/account'),
    } as Parameters<typeof accountLoader>[0]);

    expect(result).toMatchObject({ status: 'restricted', csrfToken: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(requestJsonMock).toHaveBeenCalledTimes(1);
  });
});
