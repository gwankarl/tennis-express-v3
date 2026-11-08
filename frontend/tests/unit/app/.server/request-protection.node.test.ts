import { describe, expect, it, vi } from 'vitest';
import {
  issueCsrfToken,
  withProtectedFormRequest,
} from '~/.server/request-protection.js';

const settings = {
  frontendOrigin: 'http://127.0.0.1:5173',
  csrfSecret: 'test-only-secret-that-is-at-least-32-bytes-long',
};

function createIssuedProtection() {
  const responseHeaders = new Headers();
  const token = issueCsrfToken(new Request(settings.frontendOrigin), responseHeaders, settings);
  const setCookie = responseHeaders.get('set-cookie');

  if (!setCookie) {
    throw new Error('Expected the helper to issue an anonymous cookie.');
  }

  return {
    token,
    cookie: setCookie.split(';', 1)[0] ?? '',
    setCookie,
    cacheControl: responseHeaders.get('cache-control'),
  };
}

function createFormRequest(
  cookie: string,
  token: string | undefined,
  options: {
    origin?: string;
    referer?: string;
    body?: string;
  } = {},
): Request {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    cookie,
  });

  if (options.origin !== undefined) {
    headers.set('origin', options.origin);
  }

  if (options.referer !== undefined) {
    headers.set('referer', options.referer);
  }

  const form = new URLSearchParams();

  if (token !== undefined) {
    form.set('csrfToken', token);
  }

  form.set('email', 'player@example.test');

  return new Request(`${settings.frontendOrigin}/register`, {
    method: 'POST',
    headers,
    body: options.body ?? form.toString(),
  });
}

describe('request protection', () => {
  it('accepts a valid same-origin form and then invokes the backend callback', async () => {
    const issued = createIssuedProtection();
    const backendCall = vi.fn(async (form: URLSearchParams) => form.get('email'));

    await expect(
      withProtectedFormRequest(
        createFormRequest(issued.cookie, issued.token, { origin: settings.frontendOrigin }),
        settings,
        backendCall,
      ),
    ).resolves.toBe('player@example.test');

    expect(backendCall).toHaveBeenCalledOnce();
    expect(issued.setCookie).toContain('HttpOnly');
    expect(issued.setCookie).toContain('SameSite=Lax');
    expect(issued.setCookie).toContain('Path=/');
    expect(issued.setCookie).not.toMatch(/;\s*Domain=/iu);
    expect(issued.setCookie).not.toContain('; Secure');
    expect(issued.cacheControl).toBe('private, no-store');
  });

  it('marks the anonymous cookie Secure for HTTPS origins', () => {
    const responseHeaders = new Headers();

    issueCsrfToken(
      new Request('https://tennis.example'),
      responseHeaders,
      { ...settings, frontendOrigin: 'https://tennis.example' },
    );

    expect(responseHeaders.get('set-cookie')).toContain('; Secure');
  });

  it('uses Referer only when Origin is absent', async () => {
    const issued = createIssuedProtection();
    const backendCall = vi.fn(async () => 'called');

    await expect(
      withProtectedFormRequest(
        createFormRequest(issued.cookie, issued.token, {
          referer: `${settings.frontendOrigin}/register`,
        }),
        settings,
        backendCall,
      ),
    ).resolves.toBe('called');

    expect(backendCall).toHaveBeenCalledOnce();
  });

  it('rejects a cross-origin Origin even when Referer is trusted', async () => {
    const issued = createIssuedProtection();
    const backendCall = vi.fn();

    await expect(
      withProtectedFormRequest(
        createFormRequest(issued.cookie, issued.token, {
          origin: 'https://attacker.example',
          referer: `${settings.frontendOrigin}/register`,
        }),
        settings,
        backendCall,
      ),
    ).rejects.toMatchObject({
      status: 403,
    });

    expect(backendCall).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['mismatched', 'v1.1.invalid'],
  ])('rejects a %s CSRF token without calling the backend', async (_kind, token) => {
    const issued = createIssuedProtection();
    const backendCall = vi.fn();

    await expect(
      withProtectedFormRequest(
        createFormRequest(issued.cookie, token, { origin: settings.frontendOrigin }),
        settings,
        backendCall,
      ),
    ).rejects.toMatchObject({
      status: 403,
    });

    expect(backendCall).not.toHaveBeenCalled();
  });

  it('rejects an expired anonymous cookie and token', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T12:00:00.000Z'));

    try {
      const issued = createIssuedProtection();
      const backendCall = vi.fn();

      vi.setSystemTime(new Date('2026-11-07T12:15:01.000Z'));

      await expect(
        withProtectedFormRequest(
          createFormRequest(issued.cookie, issued.token, { origin: settings.frontendOrigin }),
          settings,
          backendCall,
        ),
      ).rejects.toMatchObject({
        status: 403,
      });

      expect(backendCall).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an oversized body without Content-Length before calling the backend', async () => {
    const issued = createIssuedProtection();
    const backendCall = vi.fn();
    const oversizedForm = `email=${'x'.repeat(16_384)}`;

    await expect(
      withProtectedFormRequest(
        createFormRequest(issued.cookie, issued.token, {
          origin: settings.frontendOrigin,
          body: oversizedForm,
        }),
        settings,
        backendCall,
      ),
    ).rejects.toMatchObject({
      status: 413,
    });

    expect(backendCall).not.toHaveBeenCalled();
  });
});
