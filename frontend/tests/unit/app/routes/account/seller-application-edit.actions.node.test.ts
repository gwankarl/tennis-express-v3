import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigMock, requestJsonMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
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

  return { ApiRequestError, requestJson: requestJsonMock };
});

vi.mock('~/.server/auth/session.js', () => ({
  clearSessionCookie: vi.fn(),
  loadProtectedUser: vi.fn(),
  readSessionToken: vi.fn(() => 'S'.repeat(43)),
  safeReturnTo: (value: string) => value,
}));

import { ApiRequestError, requestJson } from '~/.server/api-client.js';
import { issueSessionCsrfToken } from '~/.server/auth/request-protection.js';
import { action } from '~/routes/account/seller-application-edit.js';

const requestJsonMocked = vi.mocked(requestJson);
const origin = 'http://127.0.0.1:5173';
const sessionToken = 'S'.repeat(43);
const applicationId = 'c8ca75f9-7d53-4a5c-aee4-8639eb1ff221';
const config = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: origin,
  csrfSecret: 'seller-application-test-secret-with-at-least-32-bytes',
};

function makeSubmitRequest(expectedRevision: number): Request {
  const url = `${origin}/account/seller-application/edit`;
  const csrfToken = issueSessionCsrfToken(new Request(url), sessionToken, config);
  const form = new URLSearchParams({
    csrfToken,
    intent: 'submit',
    applicationId,
    expectedRevision: String(expectedRevision),
  });

  return new Request(url, {
    method: 'POST',
    headers: {
      origin,
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

describe('seller application editor action', () => {
  it('submits the current revision and redirects after acceptance', async () => {
    requestJsonMocked.mockResolvedValue({ application: {} } as never);
    const request = makeSubmitRequest(5);

    const result = await action({ request } as Parameters<typeof action>[0]);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get('location')).toBe('/account/seller-application');
    expect(requestJsonMocked).toHaveBeenCalledWith(
      `/me/seller-applications/${applicationId}/submit`,
      expect.objectContaining({
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}` },
        body: { expectedRevision: 5 },
        signal: request.signal,
      }),
    );
  });

  it('shows a safe stale-revision state without retrying or overwriting the draft', async () => {
    requestJsonMocked.mockRejectedValue(
      new ApiRequestError('http', 'private backend detail', {
        status: 409,
        errorCode: 'REQUEST_ERROR',
      }),
    );

    const result = await action({
      request: makeSubmitRequest(4),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({ status: 'stale' });
    expect(JSON.stringify(result)).not.toContain('private backend detail');
    expect(requestJsonMocked).toHaveBeenCalledTimes(1);
  });

  it('shows missing submission requirements from the validation contract', async () => {
    requestJsonMocked.mockRejectedValue(
      new ApiRequestError('http', 'private backend detail', {
        status: 400,
        errorCode: 'VALIDATION_ERROR',
        details: [{ field: 'evidence.applicant_id', rule: 'required' }],
      }),
    );

    const result = await action({
      request: makeSubmitRequest(5),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toMatchObject({
      status: 'missing',
      missingFields: ['Applicant photo ID'],
    });
    expect(JSON.stringify(result)).not.toContain('private backend detail');
  });
});
