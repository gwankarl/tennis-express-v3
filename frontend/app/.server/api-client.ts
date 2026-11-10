import type { ApiErrorDetail, ApiErrorResponse } from '../../../backend/src/http/contract.js';
import { loadFrontendConfig } from './env.js';

const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'ROUTE_NOT_FOUND',
  'REQUEST_ERROR',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  'ACCOUNT_RESTRICTED',
] as const;

const MAX_RESPONSE_BYTES = 1_048_576;

type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export type ApiRequestErrorKind =
  | 'http'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'invalid-response'
  | 'response-too-large'
  | 'invalid-request';

export interface ApiRequestErrorOptions {
  status?: number;
  errorCode?: ApiErrorCode;
  requestId?: string;
  details?: ApiErrorDetail[];
}

export class ApiRequestError extends Error {
  readonly status?: number;
  readonly errorCode?: ApiErrorCode;
  readonly requestId?: string;
  readonly details?: ApiErrorDetail[];

  constructor(
    readonly kind: ApiRequestErrorKind,
    message: string,
    options: ApiRequestErrorOptions = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = options.status;
    this.errorCode = options.errorCode;
    this.requestId = options.requestId;
    this.details = options.details;
  }
}

export interface JsonRequestOptions<T> {
  validateData(value: unknown): value is T;
  method?: string;
  headers?: HeadersInit;
  body?: unknown;
  signal?: AbortSignal;
}

export interface MultipartRequestOptions<T> {
  validateData(value: unknown): value is T;
  body: FormData;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/**
 * Sends a JSON request to a relative endpoint under /api/v1 and validates its response.
 */
export async function requestJson<T>(endpoint: string, options: JsonRequestOptions<T>): Promise<T> {
  const config = loadFrontendConfig();
  const url = buildApiUrl(config.backendApiBaseUrl, endpoint);
  const controller = new AbortController();
  const timeoutMs = config.backendApiTimeoutMs;
  let timedOut = false;

  const abortForCaller = () => controller.abort();
  options.signal?.addEventListener('abort', abortForCaller, { once: true });

  if (options.signal?.aborted) {
    controller.abort();
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');

  let body: string | undefined;

  if (options.body !== undefined) {
    try {
      body = JSON.stringify(options.body);
    } catch {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortForCaller);
      throw new ApiRequestError('invalid-request', 'The API request could not be created.');
    }

    if (body === undefined) {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortForCaller);
      throw new ApiRequestError('invalid-request', 'The API request could not be created.');
    }

    headers.set('content-type', 'application/json');
  }

  let requestId: string | undefined;

  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body,
      signal: controller.signal,
    });

    requestId = response.headers.get('x-request-id') || undefined;

    const responseBody = await readJsonResponse(response, requestId);

    if (!response.ok) {
      const apiError = parseApiErrorResponse(responseBody, requestId);

      throw new ApiRequestError('http', 'The backend request failed.', {
        status: response.status,
        errorCode: apiError.error.code,
        requestId: apiError.requestId || requestId,
        details: apiError.error.details,
      });
    }

    return parseApiSuccess(responseBody, options.validateData, requestId);
  } catch (error) {
    if (error instanceof ApiRequestError) {
      throw error;
    }

    if (options.signal?.aborted) {
      throw new ApiRequestError('cancelled', 'The API request was cancelled.', {
        requestId,
      });
    }

    if (timedOut) {
      throw new ApiRequestError('timeout', 'The backend request timed out.', {
        requestId,
      });
    }

    throw new ApiRequestError('network', 'The backend could not be reached.', {
      requestId,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortForCaller);
  }
}

/**
 * Sends a multipart request through the server-only API transport. The runtime
 * sets the multipart boundary; callers must not set Content-Type themselves.
 */
export async function requestMultipart<T>(
  endpoint: string,
  options: MultipartRequestOptions<T>,
): Promise<T> {
  const config = loadFrontendConfig();
  const url = buildApiUrl(config.backendApiBaseUrl, endpoint);
  const controller = new AbortController();
  let timedOut = false;

  const abortForCaller = () => controller.abort();
  options.signal?.addEventListener('abort', abortForCaller, { once: true });

  if (options.signal?.aborted) controller.abort();

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.backendApiTimeoutMs);

  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  headers.delete('content-type');

  let requestId: string | undefined;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: options.body,
      signal: controller.signal,
    });

    requestId = response.headers.get('x-request-id') || undefined;
    const responseBody = await readJsonResponse(response, requestId);

    if (!response.ok) {
      const apiError = parseApiErrorResponse(responseBody, requestId);

      throw new ApiRequestError('http', 'The backend request failed.', {
        status: response.status,
        errorCode: apiError.error.code,
        requestId: apiError.requestId || requestId,
        details: apiError.error.details,
      });
    }

    return parseApiSuccess(responseBody, options.validateData, requestId);
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;

    if (options.signal?.aborted) {
      throw new ApiRequestError('cancelled', 'The API request was cancelled.', { requestId });
    }

    if (timedOut) {
      throw new ApiRequestError('timeout', 'The backend request timed out.', { requestId });
    }

    throw new ApiRequestError('network', 'The backend could not be reached.', { requestId });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortForCaller);
  }
}

function buildApiUrl(baseUrl: string, endpoint: string): URL {
  const relativeEndpoint = endpoint.replace(/^\/+/, '');
  const endpointPath = relativeEndpoint.split(/[?#]/, 1)[0];

  if (
    relativeEndpoint.length === 0 ||
    /^[a-z][a-z\d+.-]*:/i.test(relativeEndpoint) ||
    relativeEndpoint.startsWith('//') ||
    relativeEndpoint.includes('\\') ||
    endpointPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new ApiRequestError('invalid-request', 'The API endpoint is invalid.');
  }

  const apiRoot = new URL(`${baseUrl.replace(/\/+$/, '')}/api/v1/`);
  const url = new URL(relativeEndpoint, apiRoot);

  if (url.origin !== apiRoot.origin || !url.pathname.startsWith(apiRoot.pathname)) {
    throw new ApiRequestError('invalid-request', 'The API endpoint is invalid.');
  }

  return url;
}

async function readJsonResponse(
  response: Response,
  requestId: string | undefined,
): Promise<unknown> {
  const contentLength = response.headers.get('content-length');

  if (contentLength && /^\d+$/.test(contentLength)) {
    if (Number(contentLength) > MAX_RESPONSE_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      throw new ApiRequestError(
        'response-too-large',
        'The backend response exceeded the allowed size.',
        { requestId },
      );
    }
  }

  if (!response.body) {
    throw new ApiRequestError('invalid-response', 'The backend returned an invalid response.', {
      requestId,
    });
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new ApiRequestError(
          'response-too-large',
          'The backend response exceeded the allowed size.',
          { requestId },
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ApiRequestError('invalid-response', 'The backend returned an invalid response.', {
      requestId,
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiRequestError('invalid-response', 'The backend returned an invalid response.', {
      requestId,
    });
  }
}

function parseApiSuccess<T>(
  value: unknown,
  validateData: (data: unknown) => data is T,
  requestId: string | undefined,
): T {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'data')) {
    throw new ApiRequestError('invalid-response', 'The backend returned an invalid response.', {
      requestId,
    });
  }

  let data: T;

  try {
    if (!validateData(value.data)) {
      throw new Error();
    }

    data = value.data;
  } catch {
    throw new ApiRequestError('invalid-response', 'The backend returned an invalid response.', {
      requestId,
    });
  }

  return data;
}

function parseApiErrorResponse(
  value: unknown,
  headerRequestId: string | undefined,
): ApiErrorResponse {
  if (!isRecord(value) || !isRecord(value.error)) {
    throw invalidErrorResponse(headerRequestId);
  }

  const { code, message, details } = value.error;
  const requestId = value.requestId;

  if (
    typeof code !== 'string' ||
    !API_ERROR_CODES.includes(code as ApiErrorCode) ||
    typeof message !== 'string' ||
    typeof requestId !== 'string' ||
    requestId.length === 0 ||
    (details !== undefined &&
      (!Array.isArray(details) ||
        !details.every(
          (detail) =>
            isRecord(detail) && typeof detail.field === 'string' && typeof detail.rule === 'string',
        )))
  ) {
    throw invalidErrorResponse(headerRequestId);
  }

  return value as unknown as ApiErrorResponse;
}

function invalidErrorResponse(requestId: string | undefined): ApiRequestError {
  return new ApiRequestError(
    'invalid-response',
    'The backend returned an invalid error response.',
    { requestId },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
