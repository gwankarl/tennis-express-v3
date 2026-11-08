import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'tx_anon';
const COOKIE_TTL_SECONDS = 15 * 60;
const MAX_FORM_BODY_BYTES = 16_384;

export interface RequestProtectionSettings {
  frontendOrigin: string;
  csrfSecret: string;
}

export class RequestProtectionError extends Error {
  constructor(
    readonly status: 400 | 403 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = 'RequestProtectionError';
  }
}

/**
 * Creates a short-lived form token and sets its signed, HttpOnly browser cookie.
 * The cookie is host-only because this function never sets a Domain attribute.
 */
export function issueCsrfToken(
  request: Request,
  responseHeaders: Headers,
  settings: RequestProtectionSettings,
): string {
  assertSigningSecret(settings.csrfSecret);
  responseHeaders.set('Cache-Control', 'private, no-store');

  const requestUrl = new URL(request.url);

  if (requestUrl.origin !== settings.frontendOrigin) {
    throw new RequestProtectionError(403, 'Request origin could not be verified.');
  }

  const secure = requestUrl.protocol === 'https:';

  if (!secure && !isLoopbackHost(requestUrl.hostname)) {
    throw new RequestProtectionError(403, 'Secure form protection is unavailable.');
  }

  const now = Math.floor(Date.now() / 1000);
  const existingCookie = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  const existing = existingCookie
    ? verifyAnonymousCookie(existingCookie, settings.csrfSecret, now)
    : undefined;

  let nonce: string;
  let expiresAt: number;

  if (existing) {
    ({ nonce, expiresAt } = existing);
  } else {
    nonce = randomBytes(32).toString('base64url');
    expiresAt = now + COOKIE_TTL_SECONDS;

    const cookieValue = createAnonymousCookie(nonce, expiresAt, settings.csrfSecret);
    const attributes = [
      `${COOKIE_NAME}=${cookieValue}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${COOKIE_TTL_SECONDS}`,
    ];

    if (secure) {
      attributes.push('Secure');
    }

    responseHeaders.append('Set-Cookie', attributes.join('; '));
  }

  return createCsrfToken(nonce, expiresAt, settings.csrfSecret);
}

/**
 * Verifies a same-origin URL-encoded form before invoking the supplied backend
 * operation. The callback is never called when any protection check fails.
 */
export async function withProtectedFormRequest<T>(
  request: Request,
  settings: RequestProtectionSettings,
  backendCall: (form: URLSearchParams) => Promise<T> | T,
): Promise<T> {
  assertSigningSecret(settings.csrfSecret);
  assertTrustedRequestOrigin(request, settings.frontendOrigin);

  if (request.method !== 'POST') {
    throw new RequestProtectionError(400, 'The form request is invalid.');
  }

  const form = await readBoundedForm(request);
  const submittedTokens = form.getAll('csrfToken');

  if (submittedTokens.length !== 1) {
    throw new RequestProtectionError(403, 'The form could not be verified.');
  }

  const cookieValue = readCookie(request.headers.get('cookie'), COOKIE_NAME);
  const now = Math.floor(Date.now() / 1000);
  const anonymousCookie = cookieValue
    ? verifyAnonymousCookie(cookieValue, settings.csrfSecret, now)
    : undefined;

  if (
    !anonymousCookie ||
    !verifyCsrfToken(
      submittedTokens[0] ?? '',
      anonymousCookie.nonce,
      anonymousCookie.expiresAt,
      settings.csrfSecret,
      now,
    )
  ) {
    throw new RequestProtectionError(403, 'The form could not be verified.');
  }

  return backendCall(form);
}

const SESSION_CSRF_TTL_SECONDS = 15 * 60;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * Issues a short-lived CSRF token bound to the current bearer session.
 * The session token itself is never included in this token.
 */
export function issueSessionCsrfToken(
  request: Request,
  sessionToken: string,
  settings: RequestProtectionSettings,
): string {
  assertSigningSecret(settings.csrfSecret);
  assertPageOrigin(request, settings.frontendOrigin);

  if (!SESSION_TOKEN_PATTERN.test(sessionToken)) {
    throw new RequestProtectionError(403, 'The session could not be verified.');
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_CSRF_TTL_SECONDS;
  const binding = sign(settings.csrfSecret, `session:${sessionToken}`);
  const signature = sign(settings.csrfSecret, `session-csrf:${binding}:${expiresAt}`);

  return `v1.${expiresAt}.${signature}`;
}

/**
 * Verifies a signed-in form's origin and CSRF token before running its callback.
 */
export async function withProtectedSessionFormRequest<T>(
  request: Request,
  sessionToken: string,
  settings: RequestProtectionSettings,
  operation: (form: URLSearchParams) => Promise<T> | T,
): Promise<T> {
  assertSigningSecret(settings.csrfSecret);
  assertTrustedRequestOrigin(request, settings.frontendOrigin);

  if (request.method !== 'POST' || !SESSION_TOKEN_PATTERN.test(sessionToken)) {
    throw new RequestProtectionError(403, 'The form could not be verified.');
  }

  const form = await readBoundedForm(request);
  const submittedTokens = form.getAll('csrfToken');

  if (
    submittedTokens.length !== 1 ||
    !verifySessionCsrfToken(submittedTokens[0] ?? '', sessionToken, settings)
  ) {
    throw new RequestProtectionError(403, 'The form could not be verified.');
  }

  return operation(form);
}

/** Clears the anonymous CSRF cookie after a successful sign-in. */
export function clearAnonymousCsrfCookie(
  request: Request,
  responseHeaders: Headers,
  settings: RequestProtectionSettings,
): void {
  const secure = assertPageOrigin(request, settings.frontendOrigin);
  const attributes = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];

  if (secure) {
    attributes.push('Secure');
  }

  responseHeaders.append('Set-Cookie', attributes.join('; '));
}

function verifySessionCsrfToken(
  value: string,
  sessionToken: string,
  settings: RequestProtectionSettings,
): boolean {
  const parts = value.split('.');

  if (parts.length !== 3 || parts[0] !== 'v1' || !/^\d+$/u.test(parts[1] ?? '')) {
    return false;
  }

  const expiresAt = Number(parts[1]);

  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  const binding = sign(settings.csrfSecret, `session:${sessionToken}`);
  const expected = sign(settings.csrfSecret, `session-csrf:${binding}:${expiresAt}`);

  return safeEqual(parts[2] ?? '', expected);
}

/**
 * Confirms the server-rendered page uses the configured origin and allows
 * insecure cookies only on loopback HTTP.
 */
function assertPageOrigin(request: Request, frontendOrigin: string): boolean {
  const url = new URL(request.url);

  if (url.origin !== frontendOrigin) {
    throw new RequestProtectionError(403, 'Request origin could not be verified.');
  }

  if (url.protocol === 'https:') {
    return true;
  }

  if (url.protocol === 'http:' && isLoopbackHost(url.hostname)) {
    return false;
  }

  throw new RequestProtectionError(403, 'Secure form protection is unavailable.');
}

function assertTrustedRequestOrigin(request: Request, frontendOrigin: string): void {
  const origin = request.headers.get('origin');

  if (origin !== null) {
    if (origin !== frontendOrigin) {
      throw new RequestProtectionError(403, 'Request origin could not be verified.');
    }

    return;
  }

  const referer = request.headers.get('referer');

  if (!referer) {
    throw new RequestProtectionError(403, 'Request origin could not be verified.');
  }

  try {
    if (new URL(referer).origin !== frontendOrigin) {
      throw new RequestProtectionError(403, 'Request origin could not be verified.');
    }
  } catch (error) {
    if (error instanceof RequestProtectionError) {
      throw error;
    }

    throw new RequestProtectionError(403, 'Request origin could not be verified.');
  }
}

async function readBoundedForm(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();

  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new RequestProtectionError(415, 'The form content type is not supported.');
  }

  const contentLength = request.headers.get('content-length');

  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength)) {
      throw new RequestProtectionError(400, 'The form request is invalid.');
    }

    if (Number(contentLength) > MAX_FORM_BODY_BYTES) {
      throw new RequestProtectionError(413, 'The form is too large.');
    }
  }

  if (!request.body) {
    throw new RequestProtectionError(400, 'The form request is invalid.');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > MAX_FORM_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new RequestProtectionError(413, 'The form is too large.');
      }

      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RequestProtectionError) {
      throw error;
    }

    throw new RequestProtectionError(400, 'The form request could not be read.');
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RequestProtectionError(400, 'The form request is invalid.');
  }
}

function createAnonymousCookie(nonce: string, expiresAt: number, secret: string): string {
  const payload = `v1.${nonce}.${expiresAt}`;
  return `${payload}.${sign(secret, `cookie:${payload}`)}`;
}

function verifyAnonymousCookie(
  value: string,
  secret: string,
  now: number,
): { nonce: string; expiresAt: number } | undefined {
  const parts = value.split('.');

  if (
    parts.length !== 4 ||
    parts[0] !== 'v1' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(parts[1] ?? '') ||
    !/^\d+$/u.test(parts[2] ?? '')
  ) {
    return undefined;
  }

  const nonce = parts[1] ?? '';
  const expiresAt = Number(parts[2]);
  const payload = `v1.${nonce}.${expiresAt}`;
  const expectedSignature = sign(secret, `cookie:${payload}`);

  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= now ||
    !safeEqual(parts[3] ?? '', expectedSignature)
  ) {
    return undefined;
  }

  return { nonce, expiresAt };
}

function createCsrfToken(nonce: string, expiresAt: number, secret: string): string {
  const signature = sign(secret, `csrf:${nonce}:${expiresAt}`);
  return `v1.${expiresAt}.${signature}`;
}

function verifyCsrfToken(
  value: string,
  nonce: string,
  cookieExpiry: number,
  secret: string,
  now: number,
): boolean {
  const parts = value.split('.');

  if (parts.length !== 3 || parts[0] !== 'v1' || !/^\d+$/u.test(parts[1] ?? '')) {
    return false;
  }

  const expiresAt = Number(parts[1]);

  if (!Number.isSafeInteger(expiresAt) || expiresAt !== cookieExpiry || expiresAt <= now) {
    return false;
  }

  return safeEqual(parts[2] ?? '', sign(secret, `csrf:${nonce}:${expiresAt}`));
}

function sign(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);

  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) {
    return undefined;
  }

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');

    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }

    return part.slice(separator + 1).trim();
  }

  return undefined;
}

function assertSigningSecret(secret: string): void {
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error('Frontend request-protection configuration is invalid.');
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  return (
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]'
  );
}
