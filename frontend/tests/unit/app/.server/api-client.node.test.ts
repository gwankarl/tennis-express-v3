import { beforeEach, describe, expect, it, vi } from 'vitest';

interface HealthData {
  status: 'ok';
}

type ApiClientModule = typeof import('../../../../app/.server/api-client.js');

let apiClient: ApiClientModule;

function isHealthData(value: unknown): value is HealthData {
  return typeof value === 'object' && value !== null && 'status' in value && value.status === 'ok';
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  });
}

async function requestHealth() {
  return apiClient.requestJson('/health', {
    validateData: isHealthData,
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('BACKEND_API_BASE_URL', 'http://backend.test');
  vi.stubEnv('BACKEND_API_TIMEOUT_MS', '25');
  vi.stubGlobal('fetch', vi.fn());

  apiClient = await import('../../../../app/.server/api-client.js');
});

describe('requestJson', () => {
  it('validates a success response and builds the versioned API URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { status: 'ok' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestHealth()).resolves.toEqual({ status: 'ok' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://backend.test/api/v1/health');
  });

  it('preserves status, error code, and request ID for backend HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: 'ROUTE_NOT_FOUND',
              message: 'Route not found',
            },
            requestId: 'test-request-id',
          },
          404,
          { 'x-request-id': 'test-request-id' },
        ),
      ),
    );

    await expect(requestHealth()).rejects.toMatchObject({
      kind: 'http',
      status: 404,
      errorCode: 'ROUTE_NOT_FOUND',
      requestId: 'test-request-id',
    });
  });

  it('classifies fetch rejection as a network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket detail')));

    await expect(requestHealth()).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('rejects malformed JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(requestHealth()).rejects.toMatchObject({
      kind: 'invalid-response',
    });
  });

  it('rejects a response larger than the byte limit without Content-Length', async () => {
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_048_577));
        controller.close();
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(oversizedBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    await expect(requestHealth()).rejects.toMatchObject({
      kind: 'response-too-large',
    });
  });

  it('times out while waiting for response headers', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = requestHealth();
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
  });

  it('times out while reading the response body', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener(
                'abort',
                () => controller.error(new Error('aborted')),
                { once: true },
              );
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = requestHealth();
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);

    await assertion;
  });

  it('propagates caller cancellation as a distinct error kind', async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const pending = apiClient.requestJson('/health', {
      validateData: isHealthData,
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
  });
});
