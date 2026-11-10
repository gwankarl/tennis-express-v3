import type { FrontendServerConfig } from '../env.js';

const ADMIN_MFA_CHALLENGE_COOKIE = 'tx_admin_mfa_challenge';
const ADMIN_ENROLLMENT_AUTHORIZATION_COOKIE = 'tx_admin_enrollment_authorization';
const ADMIN_MFA_CHALLENGE_PATH = '/admin/mfa/';
const ADMIN_ENROLLMENT_PATH = '/admin/mfa/';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type CookieConfig = Pick<FrontendServerConfig, 'frontendOrigin'>;

/** Stores the one-time challenge in an HttpOnly cookie until its backend expiry. */
export function appendAdminMfaChallengeCookie(
  request: Request,
  headers: Headers,
  challenge: string,
  expiresAt: string,
  config: CookieConfig,
): void {
  appendTokenCookie(
    request,
    headers,
    ADMIN_MFA_CHALLENGE_COOKIE,
    ADMIN_MFA_CHALLENGE_PATH,
    challenge,
    expiresAt,
    config,
  );
}

/** Reads only a well-formed elevation challenge from the incoming cookie header. */
export function readAdminMfaChallenge(cookieHeader: string | null): string | undefined {
  return readTokenCookie(cookieHeader, ADMIN_MFA_CHALLENGE_COOKIE);
}

/** Clears the challenge cookie using the same path and security attributes. */
export function clearAdminMfaChallengeCookie(
  request: Request,
  headers: Headers,
  config: CookieConfig,
): void {
  clearTokenCookie(request, headers, ADMIN_MFA_CHALLENGE_COOKIE, ADMIN_MFA_CHALLENGE_PATH, config);
}

/**
 * Stores the recovery-issued enrollment authorization in an HttpOnly cookie.
 * `expiresAt` must be the backend authorization deadline.
 */
export function appendAdminEnrollmentAuthorizationCookie(
  request: Request,
  headers: Headers,
  authorization: string,
  expiresAt: string,
  config: CookieConfig,
): void {
  appendTokenCookie(
    request,
    headers,
    ADMIN_ENROLLMENT_AUTHORIZATION_COOKIE,
    ADMIN_ENROLLMENT_PATH,
    authorization,
    expiresAt,
    config,
  );
}

/** Reads the recovery-issued authorization only on the server. */
export function readAdminEnrollmentAuthorization(cookieHeader: string | null): string | undefined {
  return readTokenCookie(cookieHeader, ADMIN_ENROLLMENT_AUTHORIZATION_COOKIE);
}

/** Clears the recovery authorization cookie after backend consumption. */
export function clearAdminEnrollmentAuthorizationCookie(
  request: Request,
  headers: Headers,
  config: CookieConfig,
): void {
  clearTokenCookie(
    request,
    headers,
    ADMIN_ENROLLMENT_AUTHORIZATION_COOKIE,
    ADMIN_ENROLLMENT_PATH,
    config,
  );
}

function appendTokenCookie(
  request: Request,
  headers: Headers,
  name: string,
  path: string,
  token: string,
  expiresAt: string,
  config: CookieConfig,
): void {
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('The administrator MFA response was invalid.');
  }

  const secure = isSecureCookieRequest(request, config.frontendOrigin);
  const expiryMs = Date.parse(expiresAt);
  const maxAge = Math.floor((expiryMs - Date.now()) / 1000);

  if (!Number.isFinite(expiryMs) || maxAge < 1) {
    throw new Error('The administrator MFA response was invalid.');
  }

  const attributes = [
    `${name}=${token}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}`,
  ];

  if (secure) {
    attributes.push('Secure');
  }

  headers.append('Set-Cookie', attributes.join('; '));
}

function clearTokenCookie(
  request: Request,
  headers: Headers,
  name: string,
  path: string,
  config: CookieConfig,
): void {
  const secure = isSecureCookieRequest(request, config.frontendOrigin);
  const attributes = [
    `${name}=`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];

  if (secure) {
    attributes.push('Secure');
  }

  headers.append('Set-Cookie', attributes.join('; '));
}

function readTokenCookie(cookieHeader: string | null, expectedName: string): string | undefined {
  if (!cookieHeader) {
    return undefined;
  }

  const values = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.slice(0, part.indexOf('=')) === expectedName);

  if (values.length !== 1) {
    return undefined;
  }

  const separator = values[0]?.indexOf('=') ?? -1;

  if (separator < 0) {
    return undefined;
  }

  const token = values[0]?.slice(separator + 1).trim();
  return token && TOKEN_PATTERN.test(token) ? token : undefined;
}

function isSecureCookieRequest(request: Request, frontendOrigin: string): boolean {
  const url = new URL(request.url);

  if (url.origin !== frontendOrigin) {
    throw new Error('The browser session origin is invalid.');
  }

  if (url.protocol === 'https:') {
    return true;
  }

  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';

  if (url.protocol === 'http:' && isLoopback) {
    return false;
  }

  throw new Error('Secure browser sessions require HTTPS.');
}
