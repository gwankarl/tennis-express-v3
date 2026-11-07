import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../app/.server/api-client.js', () => {
  class ApiRequestError extends Error {
    constructor(readonly kind: string) {
      super(kind);
    }
  }

  return {
    ApiRequestError,
    requestJson: vi.fn(),
  };
});

import { ApiRequestError, requestJson } from '../../../../app/.server/api-client.js';
import { loader } from '../../../../app/routes/home.js';

const requestJsonMock = vi.mocked(requestJson);

function runLoader(request: Request) {
  return loader({ request } as Parameters<typeof loader>[0]);
}

beforeEach(() => {
  requestJsonMock.mockReset();
});

describe('home loader', () => {
  it('returns available when health data validates', async () => {
    const request = new Request('http://frontend.test/');
    requestJsonMock.mockResolvedValue({ status: 'ok' } as never);

    await expect(runLoader(request)).resolves.toEqual({
      backendStatus: 'available',
    });

    expect(requestJsonMock).toHaveBeenCalledWith(
      '/health',
      expect.objectContaining({
        signal: request.signal,
        validateData: expect.any(Function),
      }),
    );
  });

  it.each(['http', 'network', 'timeout', 'invalid-response', 'response-too-large'] as const)(
    'returns unavailable for expected %s failures',
    async (kind) => {
      requestJsonMock.mockRejectedValue(new ApiRequestError(kind, 'Simulated backend failure.'));

      await expect(runLoader(new Request('http://frontend.test/'))).resolves.toEqual({
        backendStatus: 'unavailable',
      });
    },
  );

  it('lets cancellation propagate', async () => {
    const cancellation = new ApiRequestError('cancelled', 'Simulated request cancellation.');
    requestJsonMock.mockRejectedValue(cancellation);

    await expect(runLoader(new Request('http://frontend.test/'))).rejects.toBe(cancellation);
  });
});
