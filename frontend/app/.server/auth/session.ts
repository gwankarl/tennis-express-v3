import { ApiRequestError, requestJson } from '../api-client.js';
import type { FrontendServerConfig } from '../env.js';
import { issueSessionCsrfToken } from './request-protection.js';
import { redirect } from 'react-router';

const SESSION_COOKIE_NAME = 'tx_session';
const MAX_SESSION_AGE_SECONDS = 24 * 60 * 60;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface CurrentUser {
  id: string;
  email: string;
}

export type ProtectedUserResult =
  | {
      status: 'authenticated';
      user: CurrentUser;
      csrfToken: string;
      /** Server-only: callers must never include this in loader or action data. */
      sessionToken: string;
    }
  | { status: 'restricted'; csrfToken: string }
  | { status: 'unavailable' };

/** Validates the `/auth/me` response before the account page uses it. */
export function isCurrentUser(value: unknown): value is CurrentUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'email' in value &&
    typeof value.email === 'string'
  );
}

/** Reads only a syntactically valid session cookie. */
export function readSessionToken(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');

    if (separator < 0 || part.slice(0, separator).trim() !== SESSION_COOKIE_NAME) {
      continue;
    }

    const token = part.slice(separator + 1).trim();
    return SESSION_TOKEN_PATTERN.test(token) ? token : undefined;
  }

  return undefined;
}

/**
 * Adds the host-only HttpOnly session cookie. Cookie age is capped at 24 hours
 * and at the backend's absolute session deadline.
 */
export function appendSessionCookie(
  request: Request,
  headers: Headers,
  sessionToken: string,
  expiresAt: string,
  config: FrontendServerConfig,
): void {
  if (!SESSION_TOKEN_PATTERN.test(sessionToken)) {
    throw new Error('The sign-in response was invalid.');
  }

  const secure = assertCookieOrigin(request, config.frontendOrigin);
  const expiryMs = Date.parse(expiresAt);
  const remainingSeconds = Math.floor((expiryMs - Date.now()) / 1000);
  const maxAge = Math.min(MAX_SESSION_AGE_SECONDS, remainingSeconds);

  if (!Number.isFinite(expiryMs) || maxAge < 1) {
    throw new Error('The sign-in response was invalid.');
  }

  const attributes = [
    `${SESSION_COOKIE_NAME}=${sessionToken}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    `Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}`,
  ];

  if (secure) attributes.push('Secure');
  headers.append('Set-Cookie', attributes.join('; '));
}

/** Clears the browser's session cookie using the same path and security scope. */
export function clearSessionCookie(
  request: Request,
  headers: Headers,
  frontendOrigin: string,
): void {
  const secure = assertCookieOrigin(request, frontendOrigin);
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];

  if (secure) attributes.push('Secure');
  headers.append('Set-Cookie', attributes.join('; '));
}

/**
 * Calls `/auth/me` for protected loaders. Invalid sessions redirect and clear
 * their cookie; transport and backend failures return a safe unavailable state.
 */
export async function loadProtectedUser(
  request: Request,
  config: FrontendServerConfig,
): Promise<ProtectedUserResult> {
  const token = readSessionToken(request.headers.get('cookie'));

  if (!token) {
    const headers = new Headers();

    if (request.headers.get('cookie')?.includes(`${SESSION_COOKIE_NAME}=`)) {
      clearSessionCookie(request, headers, config.frontendOrigin);
    }

    throw redirect(loginRedirectUrl(request.url), { headers });
  }

  try {
    const user = await requestJson<CurrentUser>('/auth/me', {
      headers: { authorization: `Bearer ${token}` },
      signal: request.signal,
      validateData: isCurrentUser,
    });

    return {
      status: 'authenticated',
      user,
      csrfToken: issueSessionCsrfToken(request, token, config),
      sessionToken: token,
    };
  } catch (error) {
    if (
      request.signal.aborted ||
      (error instanceof ApiRequestError && error.kind === 'cancelled')
    ) {
      throw error;
    }

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 403 &&
      error.errorCode === 'ACCOUNT_RESTRICTED'
    ) {
      return {
        status: 'restricted',
        csrfToken: issueSessionCsrfToken(request, token, config),
      };
    }

    if (
      error instanceof ApiRequestError &&
      error.kind === 'http' &&
      error.status === 401 &&
      error.errorCode === 'REQUEST_ERROR'
    ) {
      const headers = new Headers();
      clearSessionCookie(request, headers, config.frontendOrigin);
      throw redirect(loginRedirectUrl(request.url), { headers });
    }

    return { status: 'unavailable' };
  }
}

/** Accepts only same-app absolute paths; rejects protocol-relative and backslash forms. */
export function safeReturnTo(value: string | null | undefined): string {
  if (
    !value ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 0x1f)
  ) {
    return '/account';
  }

  try {
    const parsed = new URL(value, 'http://tennis-xpress.local');

    if (parsed.origin !== 'http://tennis-xpress.local') return '/account';
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/account';
  }
}

function loginRedirectUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  const returnTo = safeReturnTo(`${url.pathname}${url.search}`);
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function assertCookieOrigin(request: Request, frontendOrigin: string): boolean {
  const url = new URL(request.url);

  if (url.origin !== frontendOrigin) {
    throw new Error('The browser session origin is invalid.');
  }

  if (url.protocol === 'https:') return true;

  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';

  if (url.protocol === 'http:' && isLoopback) return false;

  throw new Error('Secure browser sessions require HTTPS.');
}
