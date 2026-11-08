import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FrontendServerConfig } from '../env.js';

export type WorkspacePreference = 'buyer' | 'seller';

const COOKIE_NAME = 'tx_workspace';
const COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Reads a valid, unexpired preference only when it belongs to this account. */
export function readWorkspacePreference(
  cookieHeader: string | null,
  userId: string,
  secret: string,
  nowMs = Date.now(),
): WorkspacePreference | undefined {
  const value = readCookie(cookieHeader, COOKIE_NAME);
  if (!value) return undefined;

  const parts = value.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return undefined;

  const workspace = parts[1];
  const encodedUserId = parts[2] ?? '';
  const expiresText = parts[3] ?? '';
  const suppliedSignature = parts[4] ?? '';

  if ((workspace !== 'buyer' && workspace !== 'seller') || !/^\d+$/u.test(expiresText)) {
    return undefined;
  }

  let storedUserId: string;
  try {
    storedUserId = decodeURIComponent(encodedUserId);
  } catch {
    return undefined;
  }

  const expiresAt = Number(expiresText);
  const nowSeconds = Math.floor(nowMs / 1000);

  if (storedUserId !== userId || !Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) {
    return undefined;
  }

  const payload = `v1.${workspace}.${encodedUserId}.${expiresText}`;
  if (!safeEqual(suppliedSignature, sign(secret, `workspace:${payload}`))) {
    return undefined;
  }

  return workspace;
}

/** Sets the host-only preference cookie after a protected form submission. */
export function setWorkspacePreferenceCookie(
  request: Request,
  headers: Headers,
  userId: string,
  workspace: WorkspacePreference,
  config: FrontendServerConfig,
  nowMs = Date.now(),
): void {
  const secure = assertCookieOrigin(request, config.frontendOrigin);
  const expiresAt = Math.floor(nowMs / 1000) + COOKIE_TTL_SECONDS;
  const encodedUserId = encodeURIComponent(userId);
  const payload = `v1.${workspace}.${encodedUserId}.${expiresAt}`;
  const value = `${payload}.${sign(config.csrfSecret, `workspace:${payload}`)}`;

  const attributes = [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_TTL_SECONDS}`,
    `Expires=${new Date(expiresAt * 1000).toUTCString()}`,
  ];

  if (secure) attributes.push('Secure');
  headers.append('Set-Cookie', attributes.join('; '));
}

function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator >= 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }

  return undefined;
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

function assertCookieOrigin(request: Request, frontendOrigin: string): boolean {
  const url = new URL(request.url);

  if (url.origin !== frontendOrigin) {
    throw new Error('The workspace preference origin is invalid.');
  }

  if (url.protocol === 'https:') return true;

  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]';

  if (url.protocol === 'http:' && isLoopback) return false;

  throw new Error('Workspace preference cookies require HTTPS.');
}
