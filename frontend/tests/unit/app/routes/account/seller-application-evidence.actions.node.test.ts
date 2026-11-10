import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadConfigMock, requestMultipartMock } = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  requestMultipartMock: vi.fn(),
}));

vi.mock('~/.server/env.js', () => ({
  loadFrontendConfig: loadConfigMock,
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

  return { ApiRequestError, requestMultipart: requestMultipartMock };
});

vi.mock('~/.server/auth/session.js', () => ({
  clearSessionCookie: vi.fn(),
  readSessionToken: vi.fn(() => 'S'.repeat(43)),
  safeReturnTo: (value: string) => value,
}));

import { ApiRequestError, requestMultipart } from '~/.server/api-client.js';
import { issueSessionCsrfToken } from '~/.server/auth/request-protection.js';
import { action } from '~/routes/account/seller-application-evidence.js';

const requestMultipartMocked = vi.mocked(requestMultipart);
const origin = 'http://127.0.0.1:5173';
const sessionToken = 'S'.repeat(43);
const applicationId = 'c8ca75f9-7d53-4a5c-aee4-8639eb1ff221';
const config = {
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
  frontendOrigin: origin,
  csrfSecret: 'seller-evidence-test-secret-with-at-least-32-bytes',
};

function makeUploadRequest(requestOrigin = origin): Request {
  const url =
    `${origin}/account/seller-application/evidence` +
    `?applicationId=${applicationId}&type=applicant_id&expectedRevision=4`;
  const csrfToken = issueSessionCsrfToken(new Request(url), sessionToken, config);
  const form = new FormData();

  form.set('csrfToken', csrfToken);
  form.set('file', new File(['synthetic test image'], 'synthetic-id.png', { type: 'image/png' }));

  return new Request(url, {
    method: 'POST',
    headers: {
      origin: requestOrigin,
      cookie: `tx_session=${sessionToken}`,
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
  requestMultipartMocked.mockReset();
});

describe('seller application evidence action', () => {
  it('keeps the existing evidence usable and returns a safe failure when replacement upload fails', async () => {
    requestMultipartMocked.mockRejectedValue(
      new ApiRequestError('network', 'private storage or backend detail'),
    );

    const result = await action({
      request: makeUploadRequest(),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toEqual({
      status: 'unavailable',
      type: 'applicant_id',
    });
    expect(JSON.stringify(result)).not.toContain('private storage or backend detail');
    expect(requestMultipartMocked).toHaveBeenCalledWith(
      `/me/seller-applications/${applicationId}/evidence/applicant_id?expectedRevision=4`,
      expect.objectContaining({
        headers: { authorization: `Bearer ${sessionToken}` },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('rejects an untrusted origin before sending a file to the backend', async () => {
    const result = await action({
      request: makeUploadRequest('https://attacker.example'),
    } as Parameters<typeof action>[0]);

    expect(resultData(result)).toEqual({
      status: 'blocked',
      type: 'applicant_id',
    });
    expect(requestMultipartMocked).not.toHaveBeenCalled();
  });
});
