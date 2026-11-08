import { describe, expect, it } from 'vitest';
import {
  readWorkspacePreference,
  setWorkspacePreferenceCookie,
} from '~/.server/auth/workspace-preference.js';

const origin = 'http://127.0.0.1:5173';
const config = {
  frontendOrigin: origin,
  csrfSecret: 'workspace-preference-test-secret-with-over-32-bytes',
  backendApiBaseUrl: 'http://127.0.0.1:3000',
  backendApiTimeoutMs: 5000,
};
const userId = '7ad9dc2c-308e-4a1a-8c45-a9e9e3e7b5dc';
const now = Date.parse('2026-11-08T12:00:00.000Z');

function preferenceCookie(workspace: 'buyer' | 'seller', accountId = userId): string {
  const headers = new Headers();
  setWorkspacePreferenceCookie(
    new Request(`${origin}/account`),
    headers,
    accountId,
    workspace,
    config,
    now,
  );

  const cookie = headers.get('set-cookie');
  if (!cookie) throw new Error('Expected preference cookie.');
  return cookie.split(';', 1)[0] ?? '';
}

describe('workspace preference cookie', () => {
  it('reads an explicit preference only for the same account', () => {
    const cookie = preferenceCookie('seller');

    expect(readWorkspacePreference(cookie, userId, config.csrfSecret, now)).toBe('seller');
    expect(
      readWorkspacePreference(cookie, 'another-user-id', config.csrfSecret, now),
    ).toBeUndefined();
  });

  it('ignores a tampered preference', () => {
    const cookie = preferenceCookie('seller');
    const [name, value = ''] = cookie.split('=');
    const lastCharacter = value.at(-1) === 'A' ? 'B' : 'A';
    const tampered = `${name}=${value.slice(0, -1)}${lastCharacter}`;

    expect(readWorkspacePreference(tampered, userId, config.csrfSecret, now)).toBeUndefined();
  });

  it('ignores expired preferences', () => {
    const cookie = preferenceCookie('seller');

    expect(
      readWorkspacePreference(cookie, userId, config.csrfSecret, now + 31 * 24 * 60 * 60 * 1000),
    ).toBeUndefined();
  });

  it('sets a host-only HttpOnly cookie with the local loopback Secure exception', () => {
    const cookie = preferenceCookie('buyer');

    expect(cookie).toMatch(/^tx_workspace=/u);
    const headers = new Headers();
    setWorkspacePreferenceCookie(
      new Request(`${origin}/account`),
      headers,
      userId,
      'buyer',
      config,
      now,
    );

    expect(headers.get('set-cookie')).toContain('HttpOnly');
    expect(headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(headers.get('set-cookie')).toContain('Path=/');
    expect(headers.get('set-cookie')).not.toContain('Domain=');
    expect(headers.get('set-cookie')).not.toContain('Secure');
  });
});
